// shadows.js — cascaded sun shadows and PCSS-style contact-hardening soft shadows for the r186
// WebGPURenderer / TSL games (PoMarbleRace, PoBrawl, PoEcosystem-style rigs).
//
// WHY THIS EXISTS. One shadow map over a long course is a trade: tight enough to give a marble a
// crisp contact shadow and it covers only a few metres, wide enough to cover the shot and every
// shadow is a smudge. And a fixed PCF kernel gives every shadow the same softness whether the
// caster touches the floor or hangs three metres above it. This module owns the two fixes so a
// game opts in with one call instead of re-deriving them:
//
//   cascades   three's CSMShadowNode (r186 addon): the camera's view is cut into slices, each
//              with its own map fitted to it, so the foreground is sharp and the distance is
//              still shadowed. The cascade centres already snap to whole texels (no crawl while
//              the camera follows). Two cascades by default: every extra one is another full
//              shadow pass (PoEcosystem measured three at a tenth of the frame rate).
//
//   pcss       a shadow filter (assigned to `light.shadow.filterNode`, the hook r186's shadow
//              node reads) that does what Percentage-Closer Soft Shadows do:
//                1. BLOCKER SEARCH   a few raw depth reads around the pixel find how far the
//                                    occluders are (average blocker depth);
//                2. PENUMBRA         penumbra width = (receiver - blocker) distance x the sun's
//                                    angular size, converted to shadow-map texels;
//                3. FILTER           a Vogel-disk PCF at exactly that radius (hardware 2x2
//                                    compare per tap), rotated per pixel by interleaved
//                                    gradient noise so what is left is noise, not banding.
//              A marble resting on the road therefore gets a hard contact line that softens as
//              the shadow lengthens away from it. A pixel with no blocker in the search area
//              returns lit at once, so open ground costs the search only.
//
// COST / RULES. Both are BOOT-TIME decisions: the filter and the shadow node are baked into
// every receiver's program, and r186 cannot resize or dispose a live shadow map without blanking
// frames (the PoBrawl port's lesson). Call applySunShadows() before the first render; to turn it
// off later, use `softness` (a uniform, 0 collapses PCSS to a plain tight PCF).
//
// THREE and TSL are PASSED IN (never imported) so the module loads under node tests; the
// CSMShadowNode class comes in the same way (see platform/3d/postAddons.js).

/**
 * Build the PCSS shadow filter function.
 * @param {object} TSL  the 'three-eco/tsl' namespace
 * @param {{ lightAngle?:number, blockerSamples?:number, filterSamples?:number, searchTexels?:number,
 *           minTexels?:number, maxTexels?:number }} [o]
 *   lightAngle    tangent of the light's angular radius (sun ≈ 0.0047; larger = softer, stylised)
 *   searchTexels  blocker-search radius in shadow texels
 *   minTexels/maxTexels  clamp of the filter radius, in shadow texels
 * @returns {{ filter: Function, softness: object }}  `filter` goes on light.shadow.filterNode;
 *   `softness` is a live uniform (1 = full PCSS, 0 = tight PCF).
 */
export function createPcssFilter(TSL, o = {}) {
    const {
        Fn, If, float, vec2, ivec2, uniform, reference, renderGroup, textureLoad, texture,
        screenCoordinate, interleavedGradientNoise, vogelDiskSample, clamp, max,
    } = TSL;
    const BLOCKERS = o.blockerSamples ?? 8;
    const TAPS = o.filterSamples ?? 12;
    const SEARCH = o.searchTexels ?? 7;
    const MIN_R = o.minTexels ?? 1;
    const MAX_R = o.maxTexels ?? 9;
    const softness = uniform(1);
    const angle = uniform(o.lightAngle ?? 0.06);

    const filter = Fn(({ depthTexture, shadowCoord, shadow }) => {
        const mapSize = reference('mapSize', 'vec2', shadow).setGroup(renderGroup);
        const cam = shadow.camera;
        const width = reference('right', 'float', cam).setGroup(renderGroup).sub(reference('left', 'float', cam).setGroup(renderGroup));
        const range = reference('far', 'float', cam).setGroup(renderGroup).sub(reference('near', 'float', cam).setGroup(renderGroup));
        const texel = vec2(1).div(mapSize);
        const worldPerTexel = width.div(mapSize.x);
        const phi = interleavedGradientNoise(screenCoordinate.xy).mul(6.28318530718);
        const zr = shadowCoord.z;

        // The comparison read goes FIRST: the generator names one sampler per texture after the first
        // read that touches it, and a plain (loaded) read built before it would leave this one with
        // a non-comparison sampler (WGSL: no matching textureSampleCompare). It doubles as the
        // answer where the search finds no blocker.
        const centre = float(texture(depthTexture, shadowCoord.xy).compare(zr)).toVar();

        // 1. blocker search: raw depth reads (textureLoad: no sampler, so no comparison-sampler clash).
        const sum = float(0).toVar();
        const count = float(0).toVar();
        for (let i = 0; i < BLOCKERS; i++) {
            const uv = shadowCoord.xy.add(vogelDiskSample(i, BLOCKERS, phi).mul(SEARCH).mul(texel));
            const d = float(textureLoad(depthTexture, ivec2(uv.mul(mapSize)))).toVar();
            If(d.lessThan(zr.sub(0.0004)), () => { sum.addAssign(d); count.addAssign(1); });
        }

        const lit = float(centre).toVar();
        If(count.greaterThan(0.5), () => {
            // 2. penumbra from the receiver-to-blocker distance, in world units then texels.
            const dist = max(zr.sub(sum.div(count)), 0).mul(range);
            const penumbra = dist.mul(angle).div(worldPerTexel);
            const radius = clamp(penumbra.mul(softness), MIN_R, MAX_R).mul(texel);
            // 3. PCF at that radius.
            const acc = float(0).toVar();
            for (let i = 0; i < TAPS; i++) {
                acc.addAssign(texture(depthTexture, shadowCoord.xy.add(vogelDiskSample(i, TAPS, phi).mul(radius))).compare(zr));
            }
            lit.assign(acc.mul(1 / TAPS));
        });
        return lit;
    });
    return { filter, softness, angle };
}

/**
 * Give a shadow-casting DirectionalLight cascades and/or PCSS. Call BEFORE the first render.
 *
 * @param {{THREE:object, TSL:object, CSMShadowNode?:Function}} lib
 * @param {object} light  DirectionalLight with castShadow = true, already added to the scene
 * @param {{ tier?:'low'|'medium'|'high', cascades?:number, maxFar?:number, splits?:number[],
 *           lightMargin?:number, pcss?:object|false, csm?:boolean, renderer?:object }} [o]
 *   low: nothing. medium: PCSS only on the single map. high: CSM + PCSS.
 *   splits  cascade boundaries as fractions of maxFar (the last, 1, is implied)
 * @returns {{ csm: object|null, pcss: object|null, tier: string, updateFrustums: ()=>void,
 *             setSoftness: (v:number)=>void, dispose: ()=>void }}
 */
export function applySunShadows(lib, light, o = {}) {
    const { TSL, CSMShadowNode } = lib;
    const tier = o.tier ?? 'medium';
    const out = { csm: null, pcss: null, tier, updateFrustums() {}, setSoftness() {}, dispose() {} };
    if (tier === 'low' || !light?.shadow) return out;

    // PCSS reads raw depth (textureLoad) for its blocker search. On WebGPURenderer's WebGL2 fallback a depth
    // texture that is also compare-sampled is a sampler2DShadow, and GLSL has no texelFetch for it ("'texelFetch'
    // : no matching overloaded function found", the Marble Race shader error). So the fallback keeps the tight
    // PCF; pass the renderer for it to be detected.
    const webgl = !!o.renderer?.backend?.isWebGLBackend;
    if (o.pcss !== false && !webgl) {
        out.pcss = createPcssFilter(TSL, o.pcss || {});
        light.shadow.filterNode = out.pcss.filter;
        out.setSoftness = (v) => { out.pcss.softness.value = v; };
    }

    if (tier === 'high' && o.csm !== false && typeof CSMShadowNode === 'function') {
        const cascades = o.cascades ?? 2;
        const maxFar = o.maxFar ?? 140;
        const splits = o.splits ?? [0.3];
        // CSMShadowNode clones light.shadow per cascade, and a clone does not carry filterNode.
        if (out.pcss) {
            const base = light.shadow;
            const proto = Object.getPrototypeOf(base);
            base.clone = function cloneWithFilter(...a) {
                const c = proto.clone.apply(this, a);
                c.filterNode = this.filterNode;
                return c;
            };
        }
        const csm = new CSMShadowNode(light, {
            cascades, maxFar, mode: 'custom', lightMargin: o.lightMargin ?? 120,
            customSplitsCallback: (n, near, far, breaks) => {
                for (let i = 0; i < n - 1; i++) breaks.push(splits[i] ?? (i + 1) / n);
                breaks.push(1);
            },
        });
        light.shadow.shadowNode = csm;
        out.csm = csm;
        out.updateFrustums = () => { if (csm.camera) csm.updateFrustums(); };
        out.dispose = () => { try { csm.dispose(); } catch { /* already gone */ } };
    }
    return out;
}
