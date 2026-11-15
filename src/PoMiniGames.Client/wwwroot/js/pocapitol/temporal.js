import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Temporal anti-aliasing and motion blur for PoCapitol, and the motion vectors both read.
//
// The camera's projection is nudged by a fraction of a pixel every frame (an eight-point Halton
// sequence), so over eight frames each pixel has been sampled at eight places inside itself.
// The resolve pass blends each new frame into a history of the old ones, which is what removes
// the stair-steps, and also what averages out the per-frame noise of the screen-space passes
// that run before it (diffuse bounce, reflections, the ray-marched haze).
//
// To find where a pixel was last frame it needs motion vectors. Two sources:
//   the camera   every pixel's world position is rebuilt from the depth buffer and projected with
//                last frame's camera, which is exact for everything that does not move
//   the people   one box per person, drawn into a small velocity target with this frame's and
//                last frame's position, so a surge through the frame carries its own motion
// The same vectors drive the motion blur, so a camera whip and a running crowd both smear along
// the way they actually moved.

const HALTON = [[0.5, 0.3333], [0.25, 0.6667], [0.75, 0.1111], [0.125, 0.4444], [0.625, 0.7778], [0.375, 0.2222], [0.875, 0.5556], [0.0625, 0.8889]];

/** How far the camera is nudged this frame, in pixels from the pixel centre, each in -0.5..0.5. */
export function jitterOffset(frame) {
    const h = HALTON[((frame % HALTON.length) + HALTON.length) % HALTON.length];
    return [h[0] - 0.5, h[1] - 0.5];
}

const VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

// Where this pixel was a frame ago, in uv. Shared by the resolve and the blur.
const MOTION = `
    uniform sampler2D tDepth, tVelocity;
    uniform mat4 uInvViewProjJ, uViewProj, uPrevViewProj;
    vec2 motionAt(vec2 uv) {
        vec4 person = texture2D(tVelocity, uv);
        if (person.a > 0.5) return person.xy;
        float z = texture2D(tDepth, uv).r;
        vec4 world = uInvViewProjJ * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
        world /= world.w;
        vec4 now = uViewProj * world, before = uPrevViewProj * world;
        if (before.w <= 0.0) return vec2(0.0);
        return (now.xy / now.w - before.xy / before.w) * 0.5;
    }`;

const RESOLVE = `
    uniform sampler2D tDiffuse, tHistory;
    uniform vec2 uTexel;
    uniform float uBlend;
    varying vec2 vUv;
    ${MOTION}
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    // The history is read between its pixels every frame the camera moves, and a plain bilinear
    // read there blurs it a little more each time. A Catmull-Rom read (five taps) keeps its edges.
    vec3 historyAt(vec2 uv) {
        vec2 at = uv / uTexel, base = floor(at - 0.5) + 0.5, f = at - base;
        vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
        vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
        vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
        vec2 w3 = f * f * (-0.5 + 0.5 * f);
        vec2 w12 = w1 + w2;
        vec2 t0 = (base - 1.0) * uTexel, t3 = (base + 2.0) * uTexel, t12 = (base + w2 / w12) * uTexel;
        float a = w12.x * w0.y, b = w0.x * w12.y, c = w12.x * w12.y, d = w3.x * w12.y, e = w12.x * w3.y;
        vec3 sum = textureLod(tHistory, vec2(t12.x, t0.y), 0.0).rgb * a + textureLod(tHistory, vec2(t0.x, t12.y), 0.0).rgb * b
            + textureLod(tHistory, t12, 0.0).rgb * c + textureLod(tHistory, vec2(t3.x, t12.y), 0.0).rgb * d
            + textureLod(tHistory, vec2(t12.x, t3.y), 0.0).rgb * e;
        return max(sum / (a + b + c + d + e), 0.0);
    }
    void main() {
        vec3 now = texture2D(tDiffuse, vUv).rgb;
        // What this pixel could plausibly be: the range of its eight neighbours this frame. A
        // history colour outside that range is something that has moved away, and is pulled in.
        vec3 lo = now, hi = now;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            vec3 c = textureLod(tDiffuse, vUv + vec2(float(x), float(y)) * uTexel, 0.0).rgb;
            lo = min(lo, c); hi = max(hi, c);
        }
        vec2 motion = motionAt(vUv), was = vUv - motion;
        float blend = uBlend;
        if (was.x < 0.0 || was.x > 1.0 || was.y < 0.0 || was.y > 1.0) blend = 0.0;
        // Fast motion trusts the history less, so a whip pan stays sharp where it lands.
        blend *= mix(1.0, 0.7, clamp(length(motion / uTexel) / 40.0, 0.0, 1.0));
        vec3 old = clamp(historyAt(was), lo, hi);
        // Weighted by brightness, so one spark above white does not flicker the pixels round it.
        float wn = (1.0 - blend) / (1.0 + luma(now)), wo = blend / (1.0 + luma(old));
        gl_FragColor = vec4((now * wn + old * wo) / max(wn + wo, 1e-5), 1.0);
    }`;

const BLUR = `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uShutter, uTime;
    varying vec2 vUv;
    ${MOTION}
    void main() {
        vec2 motion = motionAt(vUv) * uShutter;
        float reach = length(motion / uTexel);
        vec4 base = texture2D(tDiffuse, vUv);
        // A slow pan stays sharp: only what crosses a few pixels in the shutter's time is smeared.
        if (reach < 3.0) { gl_FragColor = base; return; }
        // Never further than a thirtieth of the frame, however hard the camera is thrown.
        motion *= min(1.0, 0.033 / max(length(motion), 1e-5));
        float start = fract(sin(dot(vUv / uTexel + fract(uTime) * 61.0, vec2(12.9898, 78.233))) * 43758.5453);
        vec4 sum = vec4(0.0);
        for (int i = 0; i < 8; i++) {
            float t = (float(i) + start) / 8.0 - 0.5;
            // A tap that lands off the frame has nothing to give: counting the clamped edge pixel
            // instead drags streaks in from the border on every pan.
            vec2 tap = vUv + motion * t;
            float inside = step(0.0, tap.x) * step(tap.x, 1.0) * step(0.0, tap.y) * step(tap.y, 1.0);
            sum += vec4(textureLod(tDiffuse, tap, 0.0).rgb, 1.0) * inside;
        }
        gl_FragColor = vec4(sum.a > 0.0 ? sum.rgb / sum.a : base.rgb, base.a);
    }`;

// The resolved frame on its way out, with back the little crispness that averaging frames costs.
const COPY = `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        vec3 around = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb
            + texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
        // Held to the range of the neighbours, so an edge is firmer but never rings.
        vec3 sharp = c + (c - around * 0.25) * 0.55;
        gl_FragColor = vec4(clamp(sharp, c * 0.6, c * 1.6 + 0.02), 1.0);
    }`;

/** Boxes standing in for people, drawn only into the velocity target. */
function createProxies(capacity, depthTexture) {
    const geometry = new THREE.BoxGeometry(0.62, 1.86, 0.62);
    geometry.translate(0, 0.93, 0);
    const now = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const before = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    now.setUsage(THREE.DynamicDrawUsage); before.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aNow', now); geometry.setAttribute('aBefore', before);
    const material = new THREE.ShaderMaterial({
        uniforms: {
            tDepth: { value: depthTexture }, uViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
            uSize: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.1 }, uFar: { value: 420 },
        },
        vertexShader: `
            attribute vec3 aNow, aBefore;
            uniform mat4 uViewProj, uPrevViewProj;
            varying vec4 vNow, vBefore;
            void main() {
                vec4 world = vec4(position + aNow, 1.0);
                vNow = uViewProj * world;
                vBefore = uPrevViewProj * vec4(position + aBefore, 1.0);
                gl_Position = projectionMatrix * viewMatrix * world;
            }`,
        fragmentShader: `
            #include <packing>
            uniform sampler2D tDepth;
            uniform vec2 uSize;
            uniform float uNear, uFar;
            varying vec4 vNow, vBefore;
            void main() {
                // Only where the scene's own surface is inside the box: the person, not the lawn
                // seen past their shoulder.
                float solid = -perspectiveDepthToViewZ(texture2D(tDepth, gl_FragCoord.xy / uSize).r, uNear, uFar);
                float box = -perspectiveDepthToViewZ(gl_FragCoord.z, uNear, uFar);
                if (solid < box - 0.05 || solid > box + 0.8 || vBefore.w <= 0.0) discard;
                gl_FragColor = vec4((vNow.xy / vNow.w - vBefore.xy / vBefore.w) * 0.5, 0.0, 1.0);
            }`,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.frustumCulled = false; mesh.count = 0;
    const scene = new THREE.Scene();
    scene.add(mesh);
    return { scene, mesh, now, before, material, geometry };
}

class VelocityPass extends Pass {
    constructor(proxies, camera) {
        super();
        this.needsSwap = false;
        this.proxies = proxies; this.camera = camera;
        this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
        this.target.texture.minFilter = this.target.texture.magFilter = THREE.NearestFilter;
        this.clear_ = new THREE.Color();
    }
    setSize(w, h) {
        this.target.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
        this.proxies.material.uniforms.uSize.value.set(Math.max(1, w >> 1), Math.max(1, h >> 1));
    }
    render(renderer) {
        const alpha = renderer.getClearAlpha(), auto = renderer.autoClear;
        renderer.getClearColor(this.clear_);
        renderer.setRenderTarget(this.target);
        renderer.setClearColor(0x000000, 0); renderer.autoClear = true;
        renderer.clear();
        if (this.proxies.mesh.count > 0) renderer.render(this.proxies.scene, this.camera);
        renderer.setClearColor(this.clear_, alpha); renderer.autoClear = auto;
    }
    dispose() { this.target.dispose(); }
}

class ResolvePass extends Pass {
    constructor(uniforms) {
        super();
        this.material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: RESOLVE, depthTest: false, depthWrite: false });
        this.copy = new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null }, uTexel: uniforms.uTexel }, vertexShader: VERTEX, fragmentShader: COPY, depthTest: false, depthWrite: false });
        this.quad = new FullScreenQuad(this.material);
        this.history = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
        this.at = 0; this.fresh = true;
    }
    setSize(w, h) { for (const t of this.history) t.setSize(w, h); this.fresh = true; }
    /** Forget the history: after a cut the last frame is a different picture. */
    reset() { this.fresh = true; }
    render(renderer, writeBuffer, readBuffer) {
        const u = this.material.uniforms, from = this.history[this.at], to = this.history[1 - this.at];
        u.tDiffuse.value = readBuffer.texture; u.tHistory.value = from.texture;
        const blend = u.uBlend.value;
        if (this.fresh) { u.uBlend.value = 0; this.fresh = false; }
        this.quad.material = this.material;
        renderer.setRenderTarget(to);
        this.quad.render(renderer);
        u.uBlend.value = blend;
        this.copy.uniforms.tDiffuse.value = to.texture;
        this.quad.material = this.copy;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this.quad.render(renderer);
        this.at = 1 - this.at;
    }
    dispose() { this.material.dispose(); this.copy.dispose(); this.quad.dispose(); for (const t of this.history) t.dispose(); }
}

class BlurPass extends Pass {
    constructor(uniforms) {
        super();
        this.material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: BLUR, depthTest: false, depthWrite: false });
        this.quad = new FullScreenQuad(this.material);
    }
    render(renderer, writeBuffer, readBuffer) {
        this.material.uniforms.tDiffuse.value = readBuffer.texture;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this.quad.render(renderer);
    }
    dispose() { this.material.dispose(); this.quad.dispose(); }
}

/**
 * @param camera        the scene camera (jittered while this is on)
 * @param depthTexture  solid-geometry depth, drawn with the same jittered camera
 * @returns `velocity`, `resolve` and `blur` passes to add to the composer in that order, and the
 *          matrices other depth-reading passes share (`matrices.invViewProj` is the jittered one)
 */
export function createTemporal(camera, depthTexture, capacity = 720) {
    const proxies = createProxies(capacity, depthTexture);
    const velocity = new VelocityPass(proxies, camera);
    const matrices = { invViewProj: new THREE.Matrix4(), viewProj: new THREE.Matrix4(), prevViewProj: new THREE.Matrix4() };
    const shared = {
        tDepth: { value: depthTexture }, tVelocity: { value: velocity.target.texture },
        uInvViewProjJ: { value: matrices.invViewProj }, uViewProj: { value: matrices.viewProj }, uPrevViewProj: { value: matrices.prevViewProj },
        uTexel: { value: new THREE.Vector2(1, 1) },
    };
    const resolve = new ResolvePass({ ...shared, tDiffuse: { value: null }, tHistory: { value: null }, uBlend: { value: 0.88 } });
    const blur = new BlurPass({ ...shared, tDiffuse: { value: null }, uShutter: { value: 0.5 }, uTime: { value: 0 } });
    proxies.material.uniforms.uViewProj.value = matrices.viewProj;
    proxies.material.uniforms.uPrevViewProj.value = matrices.prevViewProj;
    const steady = new THREE.Matrix4(), jittered = new THREE.Matrix4();
    const last = new Map();
    let frame = 0, on = true, width = 1, height = 1, primed = false;

    return {
        velocity, resolve, blur, matrices,
        setEnabled(value) { on = value; velocity.enabled = resolve.enabled = value; if (!value) blur.enabled = false; resolve.reset(); },
        enabled: () => on,
        setSize(w, h) { width = w; height = h; shared.uTexel.value.set(1 / w, 1 / h); },
        /**
         * Nudges the camera for this frame. Call once the camera is placed and before anything
         * copies its projection. With the pass off it only refreshes the projection.
         */
        jitter() {
            camera.updateProjectionMatrix();
            steady.copy(camera.projectionMatrix);
            if (!on) return;
            const [jx, jy] = jitterOffset(frame++);
            camera.projectionMatrix.elements[8] += jx * 2 / width;
            camera.projectionMatrix.elements[9] += jy * 2 / height;
            camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        },
        /**
         * Once a frame, after `jitter` and before the composer renders.
         * @param people  everyone on screen as `{ key, x, y, z }`, feet on the ground
         * @param dt      frame time in seconds; `still` freezes the blur (paused, reduced motion)
         */
        update(people, dt, time, still) {
            camera.updateMatrixWorld();
            if (primed) matrices.prevViewProj.copy(matrices.viewProj);
            matrices.viewProj.multiplyMatrices(steady, camera.matrixWorldInverse);
            if (!primed) { matrices.prevViewProj.copy(matrices.viewProj); primed = true; }
            jittered.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
            matrices.invViewProj.copy(jittered).invert();
            const u = proxies.material.uniforms;
            u.uNear.value = camera.near; u.uFar.value = camera.far;
            let n = 0;
            if (on) {
                for (const p of people) {
                    if (n >= capacity) break;
                    const was = last.get(p.key);
                    const i = n * 3;
                    proxies.now.array[i] = p.x; proxies.now.array[i + 1] = p.y; proxies.now.array[i + 2] = p.z;
                    // Someone seen for the first time, or who jumped (a new attempt), has no motion.
                    const jumped = !was || Math.hypot(p.x - was.x, p.z - was.z) > 3;
                    proxies.before.array[i] = jumped ? p.x : was.x; proxies.before.array[i + 1] = jumped ? p.y : was.y; proxies.before.array[i + 2] = jumped ? p.z : was.z;
                    if (was) { was.x = p.x; was.y = p.y; was.z = p.z; } else last.set(p.key, { x: p.x, y: p.y, z: p.z });
                    n++;
                }
                proxies.now.needsUpdate = proxies.before.needsUpdate = true;
            }
            proxies.mesh.count = n;
            // A 1/120 s shutter at any frame rate: half a frame's travel at 60, a quarter at 30.
            blur.material.uniforms.uShutter.value = Math.min(0.6, 0.4 * (1 / 60) / Math.max(dt, 1 / 240));
            blur.material.uniforms.uTime.value = time;
            // Below about 24 frames a second each frame is too far from the last for a smear between
            // them to read as motion: it reads as a broken picture. The blur stands down until the
            // frame rate is back.
            blur.enabled = on && !still && dt < 0.042;
        },
        /** After a camera cut the history is a different picture. */
        cut() { resolve.reset(); primed = false; },
        dispose() {
            velocity.dispose(); resolve.dispose(); blur.dispose();
            proxies.geometry.dispose(); proxies.material.dispose(); proxies.mesh.dispose();
        },
    };
}
