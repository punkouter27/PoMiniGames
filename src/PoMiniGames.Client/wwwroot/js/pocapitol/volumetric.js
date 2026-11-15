import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Lit air: the haze, gas and powder between the camera and the scene, ray-marched.
//
// For every pixel a ray is walked from the lens to whatever solid thing the pixel shows, in a
// dozen steps. At each step the air has a density (a thin ground haze everywhere, plus whatever
// the gas grid holds there) and is lit by the sky and by every small light in reach: the light
// bars, the scaffold floods, the portico lamps, a flash-bang, a muzzle flash. What is scattered
// toward the lens is added to the picture and what the air absorbs is taken away, so a strobe
// throws red and blue through a gas cloud, and the floods stand as cones in the evening haze.
//
// It runs at half resolution with a different starting offset every frame; the temporal pass
// that follows averages the offsets away. It is skipped entirely on frames with no gas and no
// light worth scattering, which is most of the afternoon.

export const MAX_LIGHTS = 8;
const STEPS = 12, REACH = 70;

const VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const MARCH = `
    uniform sampler2D tDepth, tGas;
    uniform mat4 uInvViewProjJ;
    uniform vec3 uCamera, uAmbient;
    uniform vec4 uGasRect, uLightAt[${MAX_LIGHTS}];
    uniform vec3 uLightColor[${MAX_LIGHTS}];
    uniform int uLights;
    uniform float uHaze, uTime, uGas;
    varying vec2 vUv;
    float gasAt(vec3 p) {
        vec2 uv = (p.xz - uGasRect.xy) * uGasRect.zw;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
        // Gas is heavy: thick at the knees, gone a little above head height.
        return textureLod(tGas, uv, 0.0).r * exp(-max(p.y - 0.4, 0.0) / 1.9);
    }
    void main() {
        float z = texture2D(tDepth, vUv).r;
        vec4 far = uInvViewProjJ * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
        vec3 ray = far.xyz / far.w - uCamera;
        float span = min(length(ray), ${REACH.toFixed(1)});
        vec3 dir = normalize(ray);
        float stride = span / ${STEPS.toFixed(1)};
        float start = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 37.0, vec2(12.9898, 78.233))) * 43758.5453);
        vec3 light = vec3(0.0);
        float clear = 1.0;
        for (int i = 0; i < ${STEPS}; i++) {
            vec3 p = uCamera + dir * (float(i) + start) * stride;
            float gas = uGas > 0.0 ? gasAt(p) * uGas : 0.0;
            // The standing haze lies low too, so a crane shot does not look through a wall of it.
            float air = uHaze * exp(-max(p.y, 0.0) / 9.0) + gas * 0.22;
            if (air <= 0.00002) continue;
            vec3 lit = uAmbient * gas * 0.22;
            for (int k = 0; k < ${MAX_LIGHTS}; k++) {
                if (k >= uLights) break;
                vec3 to = uLightAt[k].xyz - p;
                float d2 = dot(to, to), range = uLightAt[k].w;
                float window = clamp(1.0 - d2 / (range * range), 0.0, 1.0);
                lit += uLightColor[k] * (window * window / (1.0 + d2)) * air;
            }
            light += lit * clear * stride;
            clear *= exp(-air * stride * 0.9);
        }
        gl_FragColor = vec4(light, 1.0 - clear);
    }`;

const BLEND = `
    uniform sampler2D tDiffuse, tAir;
    varying vec2 vUv;
    void main() {
        vec4 scene = texture2D(tDiffuse, vUv), air = texture2D(tAir, vUv);
        gl_FragColor = vec4(scene.rgb * (1.0 - air.a * 0.85) + air.rgb, scene.a);
    }`;

class AirPass extends Pass {
    constructor(uniforms) {
        super();
        this.march = new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: MARCH, depthTest: false, depthWrite: false });
        this.blend = new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null }, tAir: { value: null } }, vertexShader: VERTEX, fragmentShader: BLEND, depthTest: false, depthWrite: false });
        this.quad = new FullScreenQuad(this.march);
        this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        this.blend.uniforms.tAir.value = this.target.texture;
    }
    setSize(w, h) { this.target.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); }
    render(renderer, writeBuffer, readBuffer) {
        this.quad.material = this.march;
        renderer.setRenderTarget(this.target);
        this.quad.render(renderer);
        this.blend.uniforms.tDiffuse.value = readBuffer.texture;
        this.quad.material = this.blend;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this.quad.render(renderer);
    }
    dispose() { this.march.dispose(); this.blend.dispose(); this.quad.dispose(); this.target.dispose(); }
}

/**
 * @param depthTexture  solid-geometry depth
 * @param invViewProj   the shared (jittered) inverse view-projection matrix from temporal.js
 */
export function createVolumetric(depthTexture, invViewProj) {
    const blank = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat);
    blank.needsUpdate = true;
    const uniforms = {
        tDepth: { value: depthTexture }, tGas: { value: blank }, uInvViewProjJ: { value: invViewProj },
        uCamera: { value: new THREE.Vector3() }, uAmbient: { value: new THREE.Color(1, 1, 1) },
        uGasRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uLightAt: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) },
        uLightColor: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
        uLights: { value: 0 }, uHaze: { value: 0 }, uTime: { value: 0 }, uGas: { value: 0 },
    };
    const pass = new AirPass(uniforms);
    pass.enabled = false;
    let allowed = true;
    return {
        pass,
        setAllowed(value) { allowed = value; if (!value) pass.enabled = false; },
        /** The gas grid's density as a texture, and the ground it covers. */
        setGas(texture, rect) {
            uniforms.tGas.value = texture ?? blank;
            if (rect) uniforms.uGasRect.value.set(rect.x0, rect.z0, 1 / rect.w, 1 / rect.d);
        },
        /**
         * Once a frame.
         * @param lights   three.js point lights; the brightest MAX_LIGHTS that are on are used
         * @param ambient  THREE.Color: the sky's own light on the gas
         * @param haze     density of the standing haze, per metre
         * @param gas      0 when the grid is empty, else how strongly it is drawn
         */
        update(camera, lights, ambient, haze, gas, time) {
            let n = 0;
            for (const light of lights) {
                if (n >= MAX_LIGHTS) break;
                if (!(light.intensity > 0.5)) continue;
                uniforms.uLightAt.value[n].set(light.position.x, light.position.y, light.position.z, light.distance || 40);
                // Candela to "how much of it a metre of haze throws at the lens".
                // A flash-bang is fifty times a lamp; uncapped it would white out every cloud near it.
                const k = Math.min(light.intensity, 320) * 0.05;
                uniforms.uLightColor.value[n].set(light.color.r * k, light.color.g * k, light.color.b * k);
                n++;
            }
            uniforms.uLights.value = n;
            uniforms.uCamera.value.copy(camera.position);
            uniforms.uAmbient.value.copy(ambient);
            uniforms.uHaze.value = n > 0 ? haze : 0;
            uniforms.uGas.value = gas;
            uniforms.uTime.value = time;
            pass.enabled = allowed && (n > 0 || gas > 0);
        },
        dispose() { pass.dispose(); blank.dispose(); },
    };
}
