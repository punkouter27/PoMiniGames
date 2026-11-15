import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// What the air and the glass do to the picture on its way to the sensor.
//
//   refraction  a pressure wave bends the light passing through it, so a flash-bang or a grenade
//               throws a ring of distortion outward across the frame; gas and smoke shimmer what
//               is seen through them. One pass, on only while something is bending light.
//   metering    the frame's brightness is measured on the GPU (never read back) and eased two
//               ways at once: a fast average that follows what is on screen now, and a slow one
//               that is what the eye has settled to. The picture is exposed by the ratio, so
//               a flash stops the lens down and it opens back up over a second, and a cut from
//               the lawn into a dark room is dim for a beat before it lifts.
//   flare       anything far brighter than lit stone (lamps at dusk, a muzzle flash, the
//               flash-bang core) puts ghosts on the far side of the lens centre, a halo, and the
//               long horizontal streak of an anamorphic lens.

const VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

export const MAX_WAVES = 4, MAX_HAZES = 4;

const REFRACT = `
    uniform sampler2D tDiffuse;
    uniform vec4 uWave[${MAX_WAVES}];   // centre uv, radius (in frame heights), strength
    uniform vec4 uHaze[${MAX_HAZES}];   // centre uv, radius (in frame heights), strength
    uniform float uAspect, uTime;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }
    void main() {
        vec2 bend = vec2(0.0);
        for (int i = 0; i < ${MAX_WAVES}; i++) {
            if (uWave[i].w <= 0.0) continue;
            vec2 d = (vUv - uWave[i].xy) * vec2(uAspect, 1.0);
            float r = length(d), edge = r - uWave[i].z;
            // A thin shell: compressed air ahead of the front, thin air behind it.
            float shell = exp(-edge * edge * 900.0) * sign(edge + 0.0001);
            bend += (d / max(r, 1e-4)) * shell * uWave[i].w * vec2(1.0 / uAspect, 1.0);
        }
        for (int i = 0; i < ${MAX_HAZES}; i++) {
            if (uHaze[i].w <= 0.0) continue;
            vec2 d = (vUv - uHaze[i].xy) * vec2(uAspect, 1.0);
            float inside = smoothstep(uHaze[i].z, uHaze[i].z * 0.3, length(d));
            vec2 p = vUv * vec2(uAspect, 1.0) * 26.0 + vec2(0.0, -uTime * 1.3);
            bend += (vec2(noise(p), noise(p + 17.3)) - 0.5) * inside * uHaze[i].w;
        }
        gl_FragColor = texture2D(tDiffuse, vUv + bend);
    }`;

// The frame's brightness on a 16 x 16 grid: nine taps a cell, stored as a logarithm so one
// bright lamp does not outweigh a whole dark lawn.
const METER = `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
        float sum = 0.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            vec3 c = texture2D(tDiffuse, vUv + vec2(float(x), float(y)) / 48.0).rgb;
            sum += log(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0) + 0.02);
        }
        gl_FragColor = vec4(sum / 9.0, 0.0, 0.0, 1.0);
    }`;

// One pixel holding both averages: red follows the frame, green is what the eye has settled to.
const ADAPT = `
    uniform sampler2D tMeter, tBefore;
    uniform float uFast, uSlow, uFresh;
    void main() {
        float sum = 0.0, weight = 0.0;
        for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
            vec2 uv = (vec2(float(x), float(y)) + 0.5) / 8.0;
            // Centre-weighted, as a camera meters: the subject matters more than the corners.
            float w = 1.0 - 0.6 * length(uv - 0.5);
            sum += texture2D(tMeter, uv).r * w; weight += w;
        }
        float now = sum / weight;
        vec2 before = texture2D(tBefore, vec2(0.5)).rg;
        gl_FragColor = vec4(mix(mix(before.r, now, uFast), now, uFresh), mix(mix(before.g, now, uSlow), now, uFresh), 0.0, 1.0);
    }`;

// The flare is soft by nature, so it is worked out at a quarter of the frame's resolution and
// added on: seventeen taps on a sixteenth of the pixels.
const FLARE = `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uAspect;
    varying vec2 vUv;
    vec3 hot(vec2 uv) {
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
        vec3 c = textureLod(tDiffuse, uv, 0.0).rgb;
        return c * smoothstep(2.0, 4.5, max(c.r, max(c.g, c.b)));
    }
    void main() {
        vec2 across = vec2(0.5) - vUv;
        vec3 flare = vec3(0.0);
        // Ghosts: the bright thing again, on the far side of the centre, tinted by the coatings.
        flare += hot(vUv + across * 2.0) * vec3(0.5, 0.75, 1.0) * 0.5;
        flare += hot(vUv + across * 1.36) * vec3(1.0, 0.8, 0.55) * 0.35;
        flare += hot(vUv + across * 0.62) * vec3(0.7, 1.0, 0.8) * 0.22;
        // The halo: a ring at a fixed radius from the centre.
        vec2 ring = normalize(across * vec2(uAspect, 1.0) + 1e-5) * vec2(1.0 / uAspect, 1.0) * 0.42;
        flare += hot(vUv + across + ring) * vec3(0.9, 0.7, 1.0) * 0.18;
        float fade = 1.0 - smoothstep(0.35, 0.75, length(across));
        // The streak: a long, thin, blue-white smear through every hot point.
        vec3 streak = vec3(0.0);
        for (int i = 1; i <= 7; i++) {
            float reach = float(i * i) * uTexel.x * 3.2, w = 1.0 - float(i) / 8.0;
            streak += (hot(vUv + vec2(reach, 0.0)) + hot(vUv - vec2(reach, 0.0))) * w;
        }
        gl_FragColor = vec4(flare * fade + streak * vec3(0.55, 0.7, 1.0) * 0.09, 1.0);
    }`;

const LENS = `
    uniform sampler2D tDiffuse, tAdapt, tFlare;
    uniform float uFlare, uMeter;
    varying vec2 vUv;
    void main() {
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        if (uFlare > 0.0) c += texture2D(tFlare, vUv).rgb * uFlare;
        if (uMeter > 0.0) {
            vec2 seen = texture2D(tAdapt, vec2(0.5)).rg;
            // Brighter than the eye is used to: stop down. Darker: open up. Never by much.
            c *= mix(1.0, clamp(exp((seen.g - seen.r) * 0.75), 0.62, 1.4), uMeter);
        }
        gl_FragColor = vec4(c, 1.0);
    }`;

class RefractPass extends Pass {
    constructor(uniforms) {
        super();
        this.material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: REFRACT, depthTest: false, depthWrite: false });
        this.quad = new FullScreenQuad(this.material);
    }
    render(renderer, writeBuffer, readBuffer) {
        this.material.uniforms.tDiffuse.value = readBuffer.texture;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this.quad.render(renderer);
    }
    dispose() { this.material.dispose(); this.quad.dispose(); }
}

class LensPass extends Pass {
    constructor() {
        super();
        const make = (uniforms, fragmentShader) => new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader, depthTest: false, depthWrite: false });
        this.meter = make({ tDiffuse: { value: null } }, METER);
        this.adapt = make({ tMeter: { value: null }, tBefore: { value: null }, uFast: { value: 0.1 }, uSlow: { value: 0.01 }, uFresh: { value: 1 } }, ADAPT);
        this.flare = make({ tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) }, uAspect: { value: 1 } }, FLARE);
        this.lens = make({ tDiffuse: { value: null }, tAdapt: { value: null }, tFlare: { value: null }, uFlare: { value: 1 }, uMeter: { value: 1 } }, LENS);
        this.quad = new FullScreenQuad(this.lens);
        const small = size => {
            const t = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: false });
            t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter;
            return t;
        };
        this.grid = small(16);
        this.glare = small(4);
        this.lens.uniforms.tFlare.value = this.glare.texture;
        this.seen = [small(1), small(1)];
        this.at = 0; this.fresh = true; this.metering = true;
        this.adapt.uniforms.tMeter.value = this.grid.texture;
    }
    setSize(w, h) {
        this.flare.uniforms.uTexel.value.set(1 / w, 1 / h); this.flare.uniforms.uAspect.value = w / h;
        this.glare.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    }
    render(renderer, writeBuffer, readBuffer, deltaTime) {
        if (this.metering) {
            const dt = Math.min(0.1, Math.max(0.001, deltaTime || 0.016));
            this.meter.uniforms.tDiffuse.value = readBuffer.texture;
            this.quad.material = this.meter;
            renderer.setRenderTarget(this.grid);
            this.quad.render(renderer);
            const from = this.seen[this.at], to = this.seen[1 - this.at];
            const u = this.adapt.uniforms;
            u.tBefore.value = from.texture;
            // The frame is followed in about a third of a second; the eye settles in about ten.
            u.uFast.value = 1 - Math.exp(-dt * 3.2); u.uSlow.value = 1 - Math.exp(-dt * 0.1);
            u.uFresh.value = this.fresh ? 1 : 0; this.fresh = false;
            this.quad.material = this.adapt;
            renderer.setRenderTarget(to);
            this.quad.render(renderer);
            this.at = 1 - this.at;
            this.lens.uniforms.tAdapt.value = to.texture;
        }
        if (this.lens.uniforms.uFlare.value > 0) {
            this.flare.uniforms.tDiffuse.value = readBuffer.texture;
            this.quad.material = this.flare;
            renderer.setRenderTarget(this.glare);
            this.quad.render(renderer);
        }
        this.lens.uniforms.tDiffuse.value = readBuffer.texture;
        this.quad.material = this.lens;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this.quad.render(renderer);
    }
    dispose() {
        this.meter.dispose(); this.adapt.dispose(); this.lens.dispose(); this.flare.dispose(); this.quad.dispose();
        this.grid.dispose(); this.glare.dispose(); for (const t of this.seen) t.dispose();
    }
}

export function createLens() {
    const refractUniforms = {
        tDiffuse: { value: null }, uAspect: { value: 1 }, uTime: { value: 0 },
        uWave: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
        uHaze: { value: Array.from({ length: MAX_HAZES }, () => new THREE.Vector4()) },
    };
    const refract = new RefractPass(refractUniforms);
    refract.enabled = false;
    const lens = new LensPass();
    const centre = new THREE.Vector3(), rim = new THREE.Vector3(), right = new THREE.Vector3();
    let allowed = true, flare = true;

    /** Where a world sphere lands on screen: its centre in uv and its radius in frame heights. */
    function onScreen(camera, x, y, z, radius, out) {
        centre.set(x, y, z);
        right.setFromMatrixColumn(camera.matrixWorld, 0);
        rim.copy(centre).addScaledVector(right, radius);
        centre.project(camera); rim.project(camera);
        if (centre.z > 1 || centre.z < -1) return false;
        out.x = centre.x * 0.5 + 0.5; out.y = centre.y * 0.5 + 0.5;
        out.z = Math.abs(rim.x - centre.x) * 0.5 * camera.aspect;
        return true;
    }
    return {
        refract, lens,
        setAllowed(value) { allowed = value; if (!value) refract.enabled = false; },
        /** Level 2 and up: flare and metering. Below that the pass is off altogether. */
        setLens(on, withFlare = true) { lens.enabled = on; flare = withFlare; },
        /**
         * Once a frame.
         * @param waves  [{ x, y, z, radius, strength }]: pressure fronts, world metres
         * @param hazes  [{ x, y, z, radius, strength }]: clouds that shimmer what is behind them
         * @param calm   reduced motion: nothing bends, and the exposure does not pump
         */
        update(camera, waves, hazes, time, calm) {
            refractUniforms.uAspect.value = camera.aspect; refractUniforms.uTime.value = time;
            let any = false;
            for (let i = 0; i < MAX_WAVES; i++) {
                const slot = refractUniforms.uWave.value[i], w = waves[i];
                slot.w = 0;
                if (!w || calm || !onScreen(camera, w.x, w.y, w.z, w.radius, slot)) continue;
                slot.w = w.strength; any = any || w.strength > 0.0005;
            }
            for (let i = 0; i < MAX_HAZES; i++) {
                const slot = refractUniforms.uHaze.value[i], h = hazes[i];
                slot.w = 0;
                if (!h || calm || !onScreen(camera, h.x, h.y, h.z, h.radius, slot)) continue;
                slot.w = h.strength; any = any || h.strength > 0.0002;
            }
            refract.enabled = allowed && any;
            lens.lens.uniforms.uFlare.value = flare && !calm ? 1 : 0;
            lens.lens.uniforms.uMeter.value = calm ? 0 : 1;
            lens.metering = !calm;
            if (calm) lens.fresh = true;
        },
        dispose() { refract.dispose(); lens.dispose(); },
    };
}
