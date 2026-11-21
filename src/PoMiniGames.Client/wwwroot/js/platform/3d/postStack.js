// postStack.js — the shared HDR front half of a WebGPU/TSL game's post chain: scene pass →
// SSGI → SSR → TRAA → auto-exposure → lens flare + anamorphic streaks, tier-gated, returning ONE
// linear-HDR node. The game keeps its own back half (bloom, GTAO, colour grade, tone map, FXAA):
// "add, don't replace". PoMarbleRace and PoBrawl both build on this.
//
//   const stack = createPostStack(POST_LIB, renderer, scene, camera, { tier, lit });
//   let out = stack.node;                       // linear HDR, already anti-aliased + exposed
//   ... bloom(out) / grade / renderOutput(...)  // the game's own look
//   if (!stack.antialiased) out = fxaa(out);    // FXAA stays the LOW-tier path
//   each frame:  stack.update();                // exposure readback + dynamic resolution
//
// WHY ONE MODULE. Every one of these passes needs the same inputs (a single-sample scene pass
// with depth, velocity, normals), the same tier policy and the same teardown. Written per game
// they drift; written once the second game costs a dozen lines.
//
// TIERS (PoQuality / <html data-gfx>), decided at build time because each pass is a different
// shader graph and r186 compiles a graph per output:
//   low     nothing here. A plain scene pass; the game falls back to FXAA.
//   medium  TRAA (replaces MSAA) + auto-exposure + lens flare + anamorphic streaks.
//   high    + SSGI (screen-space bounce light + AO) + SSR (reflections of shiny surfaces).
// `?postOff=ssgi,ssr,traa,exposure,flare,streak,dynres` (or `all`) switches passes off for A/B
// cost measurements without touching code.
//
// WHAT IS AND IS NOT FROM r186:
//   TRAA, SSGI, SSR, lensflare   three's addons (platform/3d/postAddons.js), used as shipped.
//   anamorphic streak            mine: r186 has no AnamorphicNode. A bright-pass at 1/4 res and
//                                one wide horizontal exponential blur, tinted cool, added back.
//   auto-exposure                mine: r186 has none. A 32x18 log-luminance target is rendered
//                                from the resolved frame (each texel averages a 4x4 grid of
//                                taps), read back ASYNCHRONOUSLY every few frames (a few hundred
//                                floats, no pipeline stall), averaged, and the exposure uniform
//                                eases toward key/avg with separate up/down speeds like an eye.
//                                The multiplier is clamped to a narrow band and softened by
//                                `strength`, so each game's authored look stays recognisable and
//                                only big luminance swings (a tunnel, a flash) are balanced.
//   dynamic resolution           platform/renderBudget.js owns the p95 frame-time ladder; this
//                                reads its rung's resScale and moves the renderer pixel ratio
//                                (scaled from the stage's own base ratio), and TRAA - which runs
//                                at the drawing-buffer size - reconstructs the detail. The
//                                ladder is capped by the PoQuality tier, so a low tier never
//                                climbs above its ceiling.
//
// RULES FROM THE PoBrawl PORT: the scene pass is single-sample (TRAA replaces MSAA; GTAO and SSGI
// need a sampleable depth); shadow maps are never resized here; a pass output sampled by a later
// stage goes through convertToTexture; THREE and TSL are passed in, never imported.
import { RenderBudget, percentile as percentileOf } from '../renderBudget.js';

const NONE = Object.freeze({ traa: false, exposure: false, flare: false, streak: false, ssgi: false, ssr: false, dynres: false });
const BY_TIER = {
    low: NONE,
    medium: { ...NONE, traa: true, exposure: true, flare: true, streak: true, dynres: true },
    high: { traa: true, exposure: true, flare: true, streak: true, ssgi: true, ssr: true, dynres: true },
};

/** The tier name for this page: <html data-gfx> (PoQuality writes it), else PoQuality, else medium. */
export function currentTier() {
    try {
        const t = document.documentElement.dataset.gfx || window.PoQuality?.tier?.();
        return t === 'high' || t === 'medium' || t === 'low' ? t : 'medium';
    } catch { return 'medium'; }
}

function postEarnAll() {
    try { return new URLSearchParams(globalThis.location?.search ?? '').get('postEarn') === 'all'; } catch { return false; }
}

function postOff() {
    try {
        const v = new URLSearchParams(globalThis.location?.search ?? '').get('postOff');
        return v ? v.split(',').map((s) => s.trim().toLowerCase()) : [];
    } catch { return []; }
}

/** Which passes a tier gets, after `?postOff=` and the caller's overrides. Pure; exported for tests. */
export function featuresFor(tier, overrides = {}, off = []) {
    const f = { ...(BY_TIER[tier] ?? NONE), ...overrides };
    for (const k of off) {
        if (k === 'all') return { ...NONE };
        if (k in f) f[k] = false;
    }
    return f;
}

const reducedMotion = () => {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduce'; } catch { return false; }
};
const reduceFlashing = () => { try { return !!window.PoQuality?.reduceFlashing?.(); } catch { return false; } };

/**
 * @param {{THREE:object, TSL:object, addons:{traa:Function, ssgi:Function, ssr:Function, lensflare:Function}}} lib
 * @param {object} renderer  WebGPURenderer
 * @param {object} scene
 * @param {object} camera    PerspectiveCamera
 * @param {{ tier?:string, features?:object,
 *           lit?:(color:object, scenePass:object)=>object,
 *           exposure?:{ key?:number, strength?:number, min?:number, max?:number, up?:number, down?:number },
 *           flare?:{ gain?:number, threshold?:number }, streak?:{ gain?:number, threshold?:number },
 *           gi?:{ intensity?:number, ao?:number, radius?:number, scale?:number },
 *           reflections?:{ intensity?:number, maxDistance?:number, scale?:number, quality?:number },
 *           metalRough?:boolean, samples?:number, type?:number, velocity?:'mrt'|'camera', budget?:object|null, onScale?:(s:number)=>void }} [opts]
 *   lit         hook to modify the scene colour BEFORE it is resolved (e.g. multiply in AO), so the
 *               edit is anti-aliased with the rest of the frame
 *   metalRough  write material metalness/roughness to an MRT target so SSR reflects only shiny surfaces
 *   budget      an existing RenderBudget to follow (else the stack makes one)
 *   onScale     override how a resolution scale is applied (default: renderer.setPixelRatio)
 */
export function createPostStack(lib, renderer, scene, camera, opts = {}) {
    const { THREE, TSL, addons } = lib;
    const {
        Fn, vec2, vec3, vec4, float, uniform, dot, max, clamp, mix, log2, exp2, pass, mrt, output, velocity,
        normalView, materialMetalness, materialRoughness, convertToTexture, rtt, uv, getViewPosition,
        cameraWorldMatrix, cameraProjectionMatrixInverse,
    } = TSL;

    const tier = opts.tier ?? currentTier();
    const feat = featuresFor(tier, opts.features, postOff());
    const disposables = [];
    const out = {
        tier, features: feat, antialiased: false, active: false,
        scenePass: null, mrt: null, node: null, depthNode: null, viewZ: null, scale: 1,
        exposureNow: 1, avgLuminance: NaN,
    };

    // ── scene pass ─────────────────────────────────────────────────────────
    // Velocity source. 'mrt' (default): every material writes its own motion vector to an MRT
    // attachment, so moving objects reproject exactly. 'camera': NO MRT at all; motion is rebuilt
    // from depth and last frame's camera, so only the camera's own motion is compensated (a moving
    // object leans on TRAA's neighbourhood clamp). PoBrawl uses it: its warm-up compiles every program
    // with compileAsync, and r186 builds those without the MRT outputs (a colour-target-without-output
    // validation error on every material), so a multi-attachment target cannot be used there.
    const cameraVelocity = opts.velocity === 'camera';
    if (cameraVelocity) feat.ssr = false;           // SSR needs a normal buffer, which is an MRT attachment
    const needTraa = feat.traa;
    const needNormals = (feat.ssgi || feat.ssr) && !cameraVelocity;
    const needMetalRough = feat.ssr && opts.metalRough !== false;
    // TRAA / SSGI / SSR need a single-sample pass; without them the caller keeps its own MSAA choice.
    const passOpts = (needTraa || feat.ssgi || feat.ssr) ? { samples: 0 } : (opts.samples !== undefined ? { samples: opts.samples } : {});
    const scenePass = pass(scene, camera, passOpts);
    // The pass only gives its target these on its first render, and the extra attachments are cloned
    // from the first one as they are asked for below, so a caller that warms shaders up against the
    // target before then (PoBrawl) needs them set now: a target that later changes sample count or
    // type is a different render context and every material would be built twice.
    if (opts.type !== undefined) scenePass.renderTarget.texture.type = opts.type;
    if (passOpts.samples !== undefined) scenePass.renderTarget.samples = passOpts.samples;
    // TRAA reprojects with velocity; SSGI/SSR read normals; SSR wants metalness/roughness. Each
    // extra attachment costs bandwidth, so only the tiers that use one write it.
    if ((needTraa && !cameraVelocity) || needNormals) {
        const layout = { output };
        if (needTraa && !cameraVelocity) layout.velocity = velocity;
        if (needNormals) layout.normal = normalView;
        if (needMetalRough) layout.metalrough = vec2(materialMetalness, materialRoughness);
        out.mrt = mrt(layout);
        scenePass.setMRT(out.mrt);
    }
    out.scenePass = scenePass;
    out.depthNode = scenePass.getTextureNode('depth');
    out.viewZ = scenePass.getViewZNode?.() ?? null;
    disposables.push(scenePass);

    // Runtime gates for the two heavy passes. A gated pass neither renders (its updateBefore is
    // skipped, so the GPU is not touched) nor shows (its weight uniform is 0); the graph itself is
    // unchanged, so flipping a gate never recompiles anything. SSGI follows the budget ladder's
    // ao flag; SSR is asked for by the game (a wet or glossy scene) and needs a high rung.
    // 'earned' is the third gate: SSGI (~6 ms) and SSR (~1 ms by timestamp, far more in frame rate) start OFF
    // and are switched on only after the measured frame time has shown clear headroom for a sustained
    // period, and shed at once when it has not (see earnPasses below). `?postEarn=all` forces both on.
    const earnedOpt = opts.earned !== false && !postEarnAll();
    const gate = { ssgi: true, ssr: opts.reflections?.enabled !== false, budgetAo: true, budgetHigh: true, earnGi: !earnedOpt, earnSr: !earnedOpt };
    const uGi = uniform(1), uSr = uniform(1);
    const gateNode = (node) => {
      const run = node.updateBefore;
      // The first few runs always go through: the pass sizes its targets (SSR's blur chain is built
      // with mips) and compiles its programs in updateBefore, and a pass that has never run is a
      // 1x1 texture with a 5-level mip request, which is a validation error when it is sampled.
      let warm = 3;
      node.updateBefore = function gated(...a) { if (warm > 0) { warm--; return run.apply(this, a); } if (node.__on !== false) return run.apply(this, a); };
    };

    let color = scenePass.getTextureNode('output');
    if (typeof opts.lit === 'function') color = opts.lit(color, scenePass) ?? color;

    // ── SSGI: screen-space bounce light + ambient occlusion ───────────────
    if (feat.ssgi) {
        try {
            const g = opts.gi ?? {};
            const gi = addons.ssgi(color, out.depthNode, needNormals ? scenePass.getTextureNode('normal') : null, camera);
            gi.sliceCount.value = 1;
            gi.stepCount.value = 8;                  // temporal filtering is on: 1 slice is the "low" preset
            gi.radius.value = g.radius ?? 8;
            gi.giIntensity.value = 1;                // scaled in the composite below, where the albedo guess lives
            gi.aoIntensity.value = 1;
            gi.thickness.value = 1.2;
            // SSGI sizes itself to the full drawing buffer and measured ~33 ms on an integrated GPU at
            // 1.3 Mpx. Bounce light and AO are low-frequency, so it runs at a fraction of the frame
            // (default 0.5 per axis, a quarter of the pixels) and the composite below reads it bilinearly.
            const gs = g.scale ?? 0.5;
            const fullSize = gi.setSize;
            gi.setSize = function setScaledSize(w, h) { fullSize.call(this, Math.max(1, Math.round(w * gs)), Math.max(1, Math.round(h * gs))); };
            const lit = color;
            const giGain = float(g.intensity ?? 0.6);
            const aoGain = float(g.ao ?? 0.55);
            // The albedo is not in a G-buffer here, so the lit colour stands in for it: bounce light
            // tints what is already coloured, and never brightens a black pixel.
            color = vec4(
                lit.rgb.mul(mix(float(1), mix(float(1), gi.a, uGi), aoGain)).add(lit.rgb.mul(gi.rgb).mul(giGain).mul(uGi)),
                lit.a,
            );
            gateNode(gi);
            disposables.push(gi);
            out.ssgi = gi;
        } catch (err) { feat.ssgi = false; console.warn('[postStack] SSGI unavailable:', err?.message || err); }
    }

    // ── SSR: reflections of shiny surfaces ─────────────────────────────────
    if (feat.ssr) {
        try {
            const r = opts.reflections ?? {};
            const mr = needMetalRough ? scenePass.getTextureNode('metalrough') : null;
            const sr = addons.ssr(convertToTexture(color), out.depthNode, scenePass.getTextureNode('normal'), {
                metalnessNode: mr ? mr.r : null,
                roughnessNode: mr ? mr.g : null,
                reflectNonMetals: true,
                camera,
            });
            sr.maxDistance.value = r.maxDistance ?? 60;
            sr.thickness.value = 0.6;
            sr.intensity.value = r.intensity ?? 0.8;
            sr.quality.value = r.quality ?? 0.35;
            sr.resolutionScale = r.scale ?? 0.5;       // the ray march is the cost; half-res reflections read fine
            const base = color;
            color = vec4(base.rgb.add(sr.rgb.mul(uSr)), base.a);
            gateNode(sr);
            disposables.push(sr);
            out.ssr = sr;
        } catch (err) { feat.ssr = false; console.warn('[postStack] SSR unavailable:', err?.message || err); }
    }

    // ── TRAA: temporal anti-aliasing (replaces MSAA) ───────────────────────
    let camVel = null;
    let resolved = color;
    if (feat.traa) {
        try {
            let velTex;
            if (cameraVelocity) {
                // Motion from depth + the previous camera (unjittered view-projection, set in update()).
                const curVP = uniform(new THREE.Matrix4());
                const prevVP = uniform(new THREE.Matrix4());
                const vel = Fn(() => {
                    const depth = out.depthNode.sample(uv()).r;
                    const world = cameraWorldMatrix.mul(vec4(getViewPosition(uv(), depth, cameraProjectionMatrixInverse), 1));
                    const c = curVP.mul(world);
                    const p = prevVP.mul(world);
                    return vec4(c.xy.div(c.w).sub(p.xy.div(p.w)), 0, 1);
                })();
                velTex = rtt(vel);
                disposables.push(velTex);
                const vp = new THREE.Matrix4();
                let primed = false;
                camVel = () => {
                    camera.updateMatrixWorld();
                    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
                    prevVP.value.copy(primed ? curVP.value : vp);
                    curVP.value.copy(vp);
                    primed = true;
                };
            } else velTex = scenePass.getTextureNode('velocity');
            const t = addons.traa(color, out.depthNode, velTex, camera);
            resolved = t;
            out.traa = t;
            out.antialiased = true;
            disposables.push(t);
        } catch (err) { feat.traa = false; console.warn('[postStack] TRAA unavailable:', err?.message || err); }
    }
    // The resolved frame as a sampleable texture, for the exposure meter and the flare.
    const sampled = () => (out.traa ? out.traa.getTextureNode() : convertToTexture(resolved));

    // ── auto-exposure (luminance reduction) ────────────────────────────────
    const uExposure = uniform(1);
    let meter = null;
    if (feat.exposure) {
        const E = opts.exposure ?? {};
        const src = sampled();
        const LUMA = vec3(0.2126, 0.7152, 0.0722);
        const W = 32, H = 18, G = 4;
        const logLum = Fn(() => {
            // This texel's cell of the frame, as a G x G grid of taps (bilinear, so ~ the cell mean).
            const cell = vec2(1 / W, 1 / H);
            const origin = uv().sub(cell.mul(0.5));
            const acc = float(0).toVar();
            for (let y = 0; y < G; y++) {
                for (let x = 0; x < G; x++) {
                    const p = origin.add(cell.mul(vec2((x + 0.5) / G, (y + 0.5) / G)));
                    const l = dot(src.sample(p).rgb, LUMA);
                    // Clamp the top: a few emissive pixels must not drag the whole frame dark.
                    acc.addAssign(log2(max(l, 0.0005).min(24)));
                }
            }
            return vec4(acc.div(G * G), 0, 0, 1);
        })();
        const target = rtt(logLum, W, H, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false });
        target.renderTarget.texture.minFilter = THREE.NearestFilter;
        target.renderTarget.texture.magFilter = THREE.NearestFilter;
        meter = {
            target, W, H, busy: false, frame: 0, goal: 1,
            key: E.key ?? 0.2, strength: E.strength ?? 0.5, lo: E.min ?? 0.8, hi: E.max ?? 1.25,
            up: E.up ?? 1.2, down: E.down ?? 2.6,
        };
        disposables.push(target);
    }

    // ── lens flare + anamorphic streak (additive, after exposure) ──────────
    let hdr = resolved;
    // The meter target only updates while it is reachable from the output graph, so it is read with a
    // weight no one can fold away (a uniform that stays 0): the pixels are used on the CPU, not here.
    const uZero = uniform(0);
    if (feat.exposure) hdr = vec4(resolved.rgb.mul(uExposure).add(meter.target.sample(vec2(0.5)).rgb.mul(uZero)), resolved.a);
    const uFlare = uniform(1);
    if (feat.flare) {
        try {
            const f = opts.flare ?? {};
            const fl = addons.lensflare(sampled(), {
                threshold: f.threshold ?? 1.6, ghostSamples: 3, ghostSpacing: 0.3, ghostAttenuationFactor: 22,
                downSampleRatio: 4, ghostTint: vec3(0.75, 0.88, 1.0),
            });
            hdr = vec4(hdr.rgb.add(fl.rgb.mul(uFlare).mul(f.gain ?? 0.35)), hdr.a);
            disposables.push(fl);
            out.flare = fl;
        } catch (err) { feat.flare = false; console.warn('[postStack] lens flare unavailable:', err?.message || err); }
    }
    const uStreak = uniform(1);
    if (feat.streak) {
        try {
            const s = opts.streak ?? {};
            const src = sampled();
            const thr = float(s.threshold ?? 1.3);
            // 1) bright pass at 1/4 resolution with a soft knee.
            const bright = Fn(() => {
                const c = src.sample(uv()).rgb;
                const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
                const k = clamp(l.sub(thr).div(thr.mul(0.6)), 0, 1);
                return vec4(c.mul(k.mul(k)), 1);
            })();
            const brightTex = rtt(bright, null, null, { resolutionScale: 0.25 });
            // 2) one wide horizontal exponential blur of it, in A's own texels (cool tint).
            const TAPS = 14, STRIDE = 7;
            const streakGraph = Fn(() => {
                const px = float(1).div(float(brightTex.size().x));
                const acc = vec3(0).toVar();
                for (let i = -TAPS; i <= TAPS; i++) {
                    const w = Math.exp(-Math.abs(i) / (TAPS * 0.45));
                    acc.addAssign(brightTex.sample(uv().add(vec2(px.mul(i * STRIDE), 0))).rgb.mul(w));
                }
                return vec4(acc.mul(1 / (TAPS * 1.2)).mul(vec3(0.42, 0.62, 1.0)), 1);
            })();
            const streakTex = rtt(streakGraph, null, null, { resolutionScale: 0.25 });
            hdr = vec4(hdr.rgb.add(streakTex.rgb.mul(uStreak).mul(s.gain ?? 0.5)), hdr.a);
            disposables.push(brightTex, streakTex);
        } catch (err) { feat.streak = false; console.warn('[postStack] streak unavailable:', err?.message || err); }
    }

    out.node = hdr;
    out.active = !!(feat.traa || feat.exposure || feat.flare || feat.streak || feat.ssgi || feat.ssr);

    // ── dynamic resolution ─────────────────────────────────────────────────
    let baseDpr = (typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : 1) || 1;
    let appliedScale = 1;
    let budget = null;
    const applyScale = (s) => {
        if (opts.onScale) opts.onScale(s);
        else { try { renderer.setPixelRatio(baseDpr * s); } catch { /* lost context */ } }
        out.scale = s;
    };
    if (feat.dynres && !reducedMotion()) {
        budget = opts.budget ?? new RenderBudget({
            tier: () => tier,
            onChange: (rung) => {
                // Quantised to the ladder's own rungs: each move reallocates every pass target, so it
                // must be rare. The rung's maxDpr caps the stage's ratio as well as scaling it.
                const s = Math.min(1, (Math.min(baseDpr, rung.maxDpr) * rung.resScale) / baseDpr);
                if (Math.abs(s - appliedScale) > 0.01) { appliedScale = s; applyScale(s); }
                gate.budgetAo = !!rung.ao;
                gate.budgetHigh = rung.index >= 4;
                applyGates();
            },
        });
    }
    out.budget = budget;
    const applyGates = () => {
        const gi = feat.ssgi && gate.ssgi && gate.budgetAo && gate.earnGi;
        const sr = feat.ssr && gate.ssr && gate.budgetHigh && gate.earnSr;
        if (out.ssgi) { out.ssgi.__on = gi; uGi.value = gi ? 1 : 0; }
        if (out.ssr) { out.ssr.__on = sr; uSr.value = sr ? 1 : 0; }
        out.gates = { ssgi: gi, ssr: sr };
    };
    applyGates();
    /** Ask for (or release) the reflections pass: a scene that has nothing glossy to show should not pay for it. */
    out.setReflections = (on) => { gate.ssr = !!on; applyGates(); };
    out.setGlobalIllumination = (on) => { gate.ssgi = !!on; applyGates(); };

    // ── earned passes ──────────────────────────────────────────────────────
    // Frame-time governor for the two dear passes. Wall-clock frame times (what the player feels, and
    // the only number that includes everything the GPU timestamp misses) go into a 90-frame ring; a
    // p95 is read every 30 frames. Enabling needs EARN_READS consecutive reads under the headroom
    // line (SSGI: p95 <= 22 ms, i.e. its ~6 ms still lands above 30 FPS; SSR: p95 <= 19 ms, only
    // after SSGI is on and has been judged on its own). Shedding is immediate: one read of p95
    // over 34 ms drops the newest pass, and a pass that was shed is barred for a cooldown that
    // doubles each time (20 s, 40 s ... 5 min), so a borderline machine settles instead of flapping.
    // Reduced motion / frames above 250 ms (a shader build, a tab switch) are not evidence.
    const EARN = { ring: new Float64Array(90), n: 0, cur: 0, since: 0, good: 0, scratch: new Float64Array(90), cool: { gi: 0, sr: 0 }, backoff: { gi: 20000, sr: 20000 } };
    const earnFrame = (ms, now) => {
        if (!(ms > 0) || ms > 250) return;
        EARN.ring[EARN.cur] = ms; EARN.cur = (EARN.cur + 1) % 90; if (EARN.n < 90) EARN.n++;
        // A fresh ring after a gate flip would be judged on the old cost, so shedding looks at the last 30.
        if (++EARN.since < 30 || EARN.n < 30) return;
        EARN.since = 0;
        const recent = Math.min(EARN.n, 90);
        const p95 = percentileOf(EARN.ring, recent, 0.95, EARN.scratch);
        out.earnedP95 = p95;
        const wantGi = feat.ssgi && gate.ssgi && gate.budgetAo, wantSr = feat.ssr && gate.ssr && gate.budgetHigh;
        const clear = () => { EARN.n = 0; EARN.cur = 0; EARN.since = 0; EARN.good = 0; };
        if (p95 > 34) {
            // Shed the newest pass first (SSR, then SSGI).
            const which = gate.earnSr ? 'sr' : gate.earnGi ? 'gi' : null;
            if (which) {
                if (which === 'sr') gate.earnSr = false; else gate.earnGi = false;
                EARN.cool[which] = now + EARN.backoff[which];
                EARN.backoff[which] = Math.min(300000, EARN.backoff[which] * 2);
                applyGates(); clear();
            }
            EARN.good = 0;
            return;
        }
        if (!gate.earnGi && wantGi && p95 <= 22 && now >= EARN.cool.gi) {
            if (++EARN.good >= 6) { gate.earnGi = true; applyGates(); clear(); }
        } else if ((gate.earnGi || !wantGi) && !gate.earnSr && wantSr && p95 <= 19 && now >= EARN.cool.sr) {
            // SSGI has been judged on its own at least once: n was cleared when it came on.
            if (++EARN.good >= 6) { gate.earnSr = true; applyGates(); clear(); }
        } else EARN.good = 0;
    };

    // ── per frame ──────────────────────────────────────────────────────────
    let last = 0;
    const m = meter;
    out.meter = m;
    out.update = function update() {
        const now = performance.now();
        const dt = last ? Math.min(0.25, (now - last) / 1000) : 0.016;
        const ms = last ? now - last : 0;
        last = now;
        if (budget && ms > 0) budget.frame(ms);
        if (earnedOpt && (feat.ssgi || feat.ssr) && !document.hidden) earnFrame(ms, now);
        if (camVel) camVel();

        uFlare.value = reduceFlashing() ? 0.35 : 1;
        uStreak.value = reduceFlashing() ? 0.3 : 1;

        if (!m) return;
        // Kick a readback every 6th frame unless one is already in flight.
        if (!m.busy && (m.frame++ % 6) === 0) {
            m.busy = true;
            renderer.readRenderTargetPixelsAsync(m.target.renderTarget, 0, 0, m.W, m.H).then((px) => {
                let sum = 0, n = 0;
                for (let i = 0; i < px.length; i += 4) { const v = px[i]; if (Number.isFinite(v)) { sum += v; n++; } }
                m.err = null;
                if (n) {
                    const avg = Math.pow(2, sum / n);
                    out.avgLuminance = avg;
                    const want = Math.pow(m.key / Math.max(avg, 1e-3), m.strength);
                    m.goal = Math.min(m.hi, Math.max(m.lo, want));
                }
            }).catch((e) => { m.err = String(e?.message || e); }).finally(() => { m.busy = false; });
        }
        // Eye adaptation: brightening (goal > now) is slower than the pupil closing on a flash.
        const calm = reducedMotion() ? 0.35 : 1;
        const rate = (m.goal < out.exposureNow ? m.down : m.up) * calm;
        out.exposureNow += (m.goal - out.exposureNow) * (1 - Math.exp(-rate * dt));
        uExposure.value = out.exposureNow;
    };

    /** The stage resized/re-set its pixel ratio: remember it as the 100% point and re-apply the scale. */
    out.resync = function resync(dpr) {
        baseDpr = dpr || baseDpr;
        if (appliedScale !== 1) applyScale(appliedScale);
    };

    out.dispose = function dispose() {
        for (const d of disposables) { try { d.dispose?.(); } catch { /* already gone */ } }
        disposables.length = 0;
    };
    return out;
}
