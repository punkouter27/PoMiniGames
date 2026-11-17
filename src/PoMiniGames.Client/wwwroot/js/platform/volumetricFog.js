// volumetricFog.js — ray-marched environmental atmosphere, with a cheap fallback (deck idea #4).
//
// Two ways to put air in a scene, chosen by the quality tier:
//
//  1. createVolumetricFog() — HIGH tier. A low-resolution (quarter by default) ray march
//     through an animated 3D noise field: ground-hugging haze, drifting with the wind,
//     thickened by smoke/gas sources and carved hollow by explosion "push" points (a blast
//     shoves the air out of a sphere that slowly refills). The result is composited over
//     the finished frame with alpha, so it sits on top of any engine's own post chain
//     without knowing about it. With a depth texture the march stops at geometry; without
//     one it marches a fixed reach.
//
//  2. FogCards — every other tier and older devices. A handful of camera-facing planes at
//     increasing depths carrying a soft noise texture, depth-TESTED so nearer geometry
//     hides farther cards (the "depth" in depth-fog cards: fog thickens with distance for
//     free). Their texture scrolls with the wind; a blast jolts and thins them; smoke and
//     gas sources become soft billboards at their positions.
//
// Both respect reduced motion by freezing the drift (the air stays, it just stops moving).
// pushFactor() and cardDepths() are pure, for tests.

/** How much of the air a push at `dist` from its centre has removed, `age` seconds after the blast. */
export function pushFactor(dist, radius, age, refill = 2.5) {
    if (!(radius > 0) || age < 0) return 0;
    const inside = Math.max(0, 1 - dist / radius);
    const fade = Math.exp(-age / Math.max(0.1, refill));
    return inside * inside * fade;
}

/** Depths for `count` cards between near and far, denser near the camera (geometric spacing). */
export function cardDepths(count, near, far) {
    const n = Math.max(1, count | 0);
    const out = new Array(n);
    if (n === 1) { out[0] = near; return out; }
    const r = Math.pow(far / near, 1 / (n - 1));
    for (let i = 0; i < n; i++) out[i] = near * Math.pow(r, i);
    return out;
}

function reducedMotion() {
    try { return document.documentElement.dataset.motion === 'reduce'; } catch { return false; }
}

function softTexture(THREE, size = 128, seed = 1) {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, size, size);
    // Overlapping soft blobs: a cheap tileable-enough cloud.
    let s = seed * 9301 + 49297;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < 26; i++) {
        const x = rnd() * size, y = rnd() * size, r = size * (0.12 + rnd() * 0.22);
        for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
            const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
            grad.addColorStop(0, 'rgba(255,255,255,0.22)');
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = grad;
            g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
        }
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}

// ── 2. fallback: depth-fog cards ───────────────────────────────────────

export class FogCards {
    /**
     * @param {any} THREE
     * @param {any} scene
     * @param {{count?:number, near?:number, far?:number, color?:number, clouds?:number}} [opts]
     */
    constructor(THREE, scene, opts = {}) {
        this.THREE = THREE;
        this.scene = scene;
        this.enabled = true;
        this.texture = softTexture(THREE, 128, 3);
        this.cloudTexture = softTexture(THREE, 64, 7);
        this.depths = cardDepths(opts.count ?? 6, opts.near ?? 9, opts.far ?? 70);
        this.color = new THREE.Color(opts.color ?? 0xc8ccd4);
        this.group = new THREE.Group();
        this.group.name = 'po-fog-cards';
        this.group.renderOrder = 5;
        this.cards = this.depths.map((d, i) => {
            // Each card scrolls its own offset, so each needs its own Texture (the image is shared).
            const map = this.texture ? this.texture.clone() : null;
            if (map) map.needsUpdate = true;
            const mat = new THREE.MeshBasicMaterial({
                map, color: this.color, transparent: true, opacity: 0,
                depthWrite: false, depthTest: true, fog: false, toneMapped: true,
            });
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
            mesh.frustumCulled = false;
            mesh.renderOrder = 5;
            this.group.add(mesh);
            return { mesh, mat, depth: d, phase: i * 0.37, jolt: 0, thin: 0 };
        });
        this.clouds = [];
        for (let i = 0; i < (opts.clouds ?? 10); i++) {
            const mat = new THREE.SpriteMaterial({ map: this.cloudTexture, color: 0xd9dbe0, transparent: true, opacity: 0, depthWrite: false, fog: true });
            const s = new THREE.Sprite(mat);
            s.visible = false;
            this.group.add(s);
            this.clouds.push(s);
        }
        this.scroll = 0;
        this._fwd = new THREE.Vector3();
        scene.add(this.group);
    }

    setEnabled(on) {
        this.enabled = !!on;
        this.group.visible = this.enabled;
    }

    /**
     * @param {number} dt seconds
     * @param {any} camera PerspectiveCamera
     * @param {{density?:number, windX?:number, windZ?:number, color?:any,
     *          pushes?: Array<{x:number,z:number,radius:number,age:number}>,
     *          clouds?: Array<{x:number,y:number,z:number,r:number,a:number}>}} air
     */
    update(dt, camera, air = {}) {
        if (!this.enabled || !camera) return;
        const calm = reducedMotion();
        const density = Math.max(0, Math.min(1, air.density ?? 0.3));
        if (air.color) this.color.copy(air.color);
        const wx = air.windX ?? 0, wz = air.windZ ?? 0;
        if (!calm) this.scroll += dt * 0.004 * Math.hypot(wx, wz) + dt * 0.003;
        camera.getWorldDirection(this._fwd);
        const fov = (camera.fov ?? 60) * Math.PI / 180;
        const aspect = camera.aspect ?? 1.6;
        // A blast near the camera jolts the cards and thins them for a moment.
        let jolt = 0, thin = 0;
        for (const p of air.pushes ?? []) {
            const d = Math.hypot(p.x - camera.position.x, p.z - camera.position.z);
            const f = pushFactor(d, (p.radius ?? 10) * 3, p.age ?? 0, 1.8);
            jolt += f; thin = Math.max(thin, f);
        }
        for (const c of this.cards) {
            c.jolt += (jolt - c.jolt) * Math.min(1, dt * 8);
            c.thin += (thin - c.thin) * Math.min(1, dt * (thin > c.thin ? 12 : 1.5));
            const d = c.depth;
            const h = 2 * d * Math.tan(fov / 2) * 1.15;
            c.mesh.position.copy(camera.position).addScaledVector(this._fwd, d);
            c.mesh.quaternion.copy(camera.quaternion);
            c.mesh.scale.set(h * aspect, h, 1);
            // Farther cards carry more of the fog; the whole stack follows `density`.
            const share = 0.35 + 0.65 * (d - this.depths[0]) / Math.max(1, this.depths[this.depths.length - 1] - this.depths[0]);
            c.mat.opacity = Math.min(0.55, density * 0.42 * share * (1 - 0.8 * c.thin));
            c.mat.color.copy(this.color);
            if (c.mat.map) {
                c.mat.map.offset.set(this.scroll * Math.sign(wx || 1) + c.phase + c.jolt * 0.08, c.phase * 0.5 + this.scroll * 0.3);
            }
        }
        let i = 0;
        for (const src of air.clouds ?? []) {
            if (i >= this.clouds.length) break;
            const s = this.clouds[i++];
            s.visible = true;
            s.position.set(src.x, src.y, src.z);
            s.scale.setScalar(Math.max(0.5, src.r) * 2.2);
            s.material.opacity = Math.max(0, Math.min(0.75, src.a ?? 0.5));
        }
        for (; i < this.clouds.length; i++) this.clouds[i].visible = false;
    }

    dispose() {
        this.scene.remove(this.group);
        for (const c of this.cards) { c.mesh.geometry.dispose(); c.mat.map?.dispose(); c.mat.dispose(); }
        for (const s of this.clouds) s.material.dispose();
        this.texture?.dispose();
        this.cloudTexture?.dispose();
    }
}

// ── 1. high tier: low-resolution ray march ─────────────────────────────

const MAX_PUSH = 4;
const MAX_SOURCE = 4;

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const MARCH_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tDepth;
uniform float uHasDepth, uTime, uDensity, uHeight, uReach;
uniform vec2 uWind;
uniform vec3 uCamera, uColor, uSunDir, uSunColor;
uniform mat4 uInvViewProj;
uniform vec4 uPush[${MAX_PUSH}];      // xyz centre, w radius (0 = unused)
uniform float uPushAmt[${MAX_PUSH}];  // 0..1 how hollow
uniform vec4 uSource[${MAX_SOURCE}];  // xyz centre, w radius — smoke/gas thickening
uniform float uSourceAmt[${MAX_SOURCE}];
varying vec2 vUv;
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){ return 0.55 * noise(p) + 0.3 * noise(p * 2.03) + 0.15 * noise(p * 4.1); }
float densityAt(vec3 p){
  vec3 q = p * 0.07 + vec3(uWind.x, 0.0, uWind.y) * uTime * 0.02;
  float d = uDensity * exp(-max(p.y, 0.0) / uHeight) * smoothstep(0.25, 0.85, fbm(q));
  for (int k = 0; k < ${MAX_SOURCE}; k++) {
    if (uSource[k].w <= 0.0) continue;
    float r = length(p - uSource[k].xyz) / uSource[k].w;
    d += uSourceAmt[k] * max(0.0, 1.0 - r * r) * (0.6 + 0.4 * fbm(q * 3.0));
  }
  for (int k = 0; k < ${MAX_PUSH}; k++) {
    if (uPush[k].w <= 0.0) continue;
    float r = length(p - uPush[k].xyz) / uPush[k].w;
    d *= 1.0 - uPushAmt[k] * max(0.0, 1.0 - r * r);
  }
  return d;
}
void main(){
  float z = uHasDepth > 0.5 ? texture2D(tDepth, vUv).r : 1.0;
  vec4 w = uInvViewProj * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec3 ray = w.xyz / w.w - uCamera;
  float span = min(length(ray), uReach);
  vec3 dir = normalize(ray);
  const int STEPS = 16;
  float stride = span / float(STEPS);
  float jitter = hash(vec3(gl_FragCoord.xy, uTime));
  float trans = 1.0;
  vec3 light = vec3(0.0);
  float phase = 0.55 + 0.45 * pow(max(dot(dir, uSunDir), 0.0), 6.0);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = uCamera + dir * (float(i) + jitter) * stride;
    float d = densityAt(p) * stride;
    if (d <= 0.0001) continue;
    light += trans * d * (uColor + uSunColor * phase * 0.6);
    trans *= exp(-d);
    if (trans < 0.03) break;
  }
  gl_FragColor = vec4(light, 1.0 - trans);
}`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D tFog;
varying vec2 vUv;
void main(){ vec4 f = texture2D(tFog, vUv); gl_FragColor = vec4(f.rgb / max(f.a, 0.001), f.a); }`;

/**
 * High-tier ray-marched air. Call render() after the engine has drawn its frame to the
 * canvas (or to `target`); it draws the fog into a small target and blends it on top.
 * @param {{ THREE:any, renderer:any, camera:any, depthTexture?:any, resolution?:number,
 *           density?:number, height?:number, reach?:number, color?:number }} opts
 */
export function createVolumetricFog(opts) {
    const { THREE, renderer, camera } = opts;
    const scale = Math.max(0.125, Math.min(1, opts.resolution ?? 0.25));
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.floor(size.x * scale)), Math.max(1, Math.floor(size.y * scale)), {
        type: THREE.HalfFloatType, depthBuffer: false,
    });
    const pushes = [];
    const sources = [];
    const uniforms = {
        tDepth: { value: opts.depthTexture ?? null },
        uHasDepth: { value: opts.depthTexture ? 1 : 0 },
        uTime: { value: 0 },
        uDensity: { value: opts.density ?? 0.05 },
        uHeight: { value: opts.height ?? 8 },
        uReach: { value: opts.reach ?? 90 },
        uWind: { value: new THREE.Vector2() },
        uCamera: { value: new THREE.Vector3() },
        uColor: { value: new THREE.Color(opts.color ?? 0xb8c0cc) },
        uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
        uSunColor: { value: new THREE.Color(1, 0.92, 0.8) },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPush: { value: Array.from({ length: MAX_PUSH }, () => new THREE.Vector4()) },
        uPushAmt: { value: new Float32Array(MAX_PUSH) },
        uSource: { value: Array.from({ length: MAX_SOURCE }, () => new THREE.Vector4()) },
        uSourceAmt: { value: new Float32Array(MAX_SOURCE) },
    };
    const march = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: MARCH_FRAG, depthTest: false, depthWrite: false });
    const composite = new THREE.ShaderMaterial({
        uniforms: { tFog: { value: rt.texture } }, vertexShader: VERT, fragmentShader: COMPOSITE_FRAG,
        transparent: true, depthTest: false, depthWrite: false,
        blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    const quad = new THREE.Mesh(quadGeo, march);
    quad.frustumCulled = false;
    const quadScene = new THREE.Scene();
    quadScene.add(quad);
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    let time = 0;

    return {
        /** A blast: hollow the air in a sphere that refills over a couple of seconds. */
        push(x, y, z, radius) {
            pushes.push({ x, y, z, radius, age: 0 });
            if (pushes.length > MAX_PUSH) pushes.shift();
        },
        /** Smoke/gas sources this frame (replaces the list). */
        setSources(list) {
            sources.length = 0;
            for (const s of list ?? []) { if (sources.length < MAX_SOURCE) sources.push(s); }
        },
        setWind(x, z) { uniforms.uWind.value.set(x, z); },
        setSun(dir, color) { if (dir) uniforms.uSunDir.value.copy(dir).normalize(); if (color) uniforms.uSunColor.value.copy(color); },
        setDensity(d) { uniforms.uDensity.value = Math.max(0, d); },
        setSize(w, h) { rt.setSize(Math.max(1, Math.floor(w * scale)), Math.max(1, Math.floor(h * scale))); },
        render(dt, target = null) {
            if (!reducedMotion()) time += dt;
            uniforms.uTime.value = time;
            uniforms.uCamera.value.copy(camera.position);
            uniforms.uInvViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
            for (let k = 0; k < MAX_PUSH; k++) {
                const p = pushes[k];
                if (p) {
                    p.age += dt;
                    uniforms.uPush.value[k].set(p.x, p.y, p.z, p.radius);
                    uniforms.uPushAmt.value[k] = pushFactor(0, 1, p.age);
                } else { uniforms.uPush.value[k].set(0, 0, 0, 0); uniforms.uPushAmt.value[k] = 0; }
            }
            while (pushes.length && pushes[0].age > 8) pushes.shift();
            for (let k = 0; k < MAX_SOURCE; k++) {
                const s = sources[k];
                uniforms.uSource.value[k].set(s?.x ?? 0, s?.y ?? 0, s?.z ?? 0, s ? s.r : 0);
                uniforms.uSourceAmt.value[k] = s ? Math.max(0, s.a ?? 0.5) * 0.25 : 0;
            }
            const prev = renderer.getRenderTarget();
            const auto = renderer.autoClear;
            renderer.autoClear = true;
            quad.material = march;
            renderer.setRenderTarget(rt);
            renderer.render(quadScene, quadCam);
            renderer.autoClear = false;
            quad.material = composite;
            renderer.setRenderTarget(target ?? prev);
            renderer.render(quadScene, quadCam);
            renderer.autoClear = auto;
            renderer.setRenderTarget(prev);
        },
        dispose() { rt.dispose(); march.dispose(); composite.dispose(); quadGeo.dispose(); },
    };
}

/**
 * Pick the right air for the device: the ray march on the high tier with WebGL2, fog cards
 * otherwise. Returns { kind: 'march'|'cards', impl }.
 */
export function createAtmosphere(opts) {
    let tier = 'high';
    try { tier = window.PoQuality?.tier?.() || 'high'; } catch { /* default */ }
    const gl2 = !!opts.renderer?.capabilities?.isWebGL2;
    if (tier === 'high' && gl2 && !opts.forceCards) {
        try { return { kind: 'march', impl: createVolumetricFog(opts) }; }
        catch { /* shader or target unsupported: fall through to cards */ }
    }
    return { kind: 'cards', impl: new FogCards(opts.THREE, opts.scene, opts) };
}

if (typeof window !== 'undefined') {
    window.PoVolumetricFog = { pushFactor, cardDepths, FogCards, createVolumetricFog, createAtmosphere };
}
