import * as THREE from 'three-eco/webgpu';
import * as TSL from 'three-eco/tsl';
import { makeTarget, makeQuad, drawQuad, tap } from './nodes.js';

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

/**
 * @param renderer      the WebGPURenderer
 * @param depthTexture  solid-geometry depth
 * @param invViewProj   the shared (jittered) inverse view-projection matrix from temporal.js
 * @param ndcZ          (depth node) => clip-space z for this backend
 */
export function createVolumetric(renderer, depthTexture, invViewProj, ndcZ) {
    const { vec2, vec3, vec4, float, exp, max, min, dot, normalize, length, clamp, Loop, If, Continue, uniform, texture } = TSL;
    const blank = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat);
    blank.needsUpdate = true;
    const state = {
        camera: new THREE.Vector3(), ambient: new THREE.Color(1, 1, 1), gasRect: new THREE.Vector4(0, 0, 1, 1),
        lightAt: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()),
        lightColor: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()),
    };
    const uInvViewProjJ = uniform(invViewProj), uCamera = uniform(state.camera), uAmbient = uniform(state.ambient), uGasRect = uniform(state.gasRect);
    const uLightAt = TSL.uniformArray(state.lightAt, 'vec4'), uLightColor = TSL.uniformArray(state.lightColor, 'vec3');
    const uLights = uniform(0, 'int'), uHaze = uniform(0), uTime = uniform(0), uGas = uniform(0);
    const gasTex = texture(blank), depth = texture(depthTexture);

    const gasAt = p => {
        const uv = p.xz.sub(uGasRect.xy).mul(uGasRect.zw);
        // Gas is heavy: thick at the knees, gone a little above head height.
        const inside = TSL.step(0, uv.x).mul(TSL.step(uv.x, 1)).mul(TSL.step(0, uv.y)).mul(TSL.step(uv.y, 1));
        return tap(gasTex, uv).r.mul(exp(max(p.y.sub(0.4), 0).negate().div(1.9))).mul(inside);
    };
    const march = TSL.Fn(() => {
        const uv = TSL.screenUV;
        const z = depth.sample(uv).r;
        const far = uInvViewProjJ.mul(vec4(uv.mul(2).sub(1), ndcZ(z), 1));
        const ray = far.xyz.div(far.w).sub(uCamera);
        const span = min(length(ray), REACH);
        const dir = normalize(ray);
        const stride = span.div(STEPS);
        const start = TSL.fract(TSL.sin(TSL.dot(TSL.screenCoordinate.add(TSL.fract(uTime).mul(37)), vec2(12.9898, 78.233))).mul(43758.5453));
        const light = vec3(0).toVar(), clear = float(1).toVar();
        Loop(STEPS, ({ i }) => {
            const p = uCamera.add(dir.mul(float(i).add(start).mul(stride)));
            const gas = uGas.greaterThan(0).select(gasAt(p).mul(uGas), 0);
            // The standing haze lies low too, so a crane shot does not look through a wall of it.
            const air = uHaze.mul(exp(max(p.y, 0).negate().div(9))).add(gas.mul(0.22));
            If(air.lessThanEqual(0.00002), () => { Continue(); });
            const lit = uAmbient.mul(gas).mul(0.22).toVar();
            for (let k = 0; k < MAX_LIGHTS; k++) {
                const to = uLightAt.element(k).xyz.sub(p);
                const d2 = dot(to, to), range = uLightAt.element(k).w;
                const window = clamp(d2.div(range.mul(range)).oneMinus(), 0, 1);
                lit.addAssign(uLightColor.element(k).mul(window.mul(window).div(d2.add(1)).mul(air)).mul(uLights.greaterThan(k).select(1, 0)));
            }
            light.addAssign(lit.mul(clear).mul(stride));
            clear.mulAssign(exp(air.mul(stride).mul(0.9).negate()));
        });
        return vec4(light, clear.oneMinus());
    })();

    const target = makeTarget(1, 1);
    const quad = makeQuad(march);
    let allowed = true, active = false;
    return {
        /** The marched haze, half the frame's size: colour scattered toward the lens, and how much it hides. */
        target,
        active: () => active,
        setAllowed(value) { allowed = value; if (!value) active = false; },
        setSize(w, h) { target.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); },
        draw() { drawQuad(renderer, quad, target); },
        /** The gas grid's density as a texture, and the ground it covers. */
        setGas(texture_, rect) {
            gasTex.value = texture_ ?? blank;
            if (rect) state.gasRect.set(rect.x0, rect.z0, 1 / rect.w, 1 / rect.d);
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
                state.lightAt[n].set(light.position.x, light.position.y, light.position.z, light.distance || 40);
                // Candela to "how much of it a metre of haze throws at the lens".
                // A flash-bang is fifty times a lamp; uncapped it would white out every cloud near it.
                const k = Math.min(light.intensity, 320) * 0.05;
                state.lightColor[n].set(light.color.r * k, light.color.g * k, light.color.b * k);
                n++;
            }
            uLights.value = n;
            state.camera.copy(camera.position);
            state.ambient.copy(ambient);
            uHaze.value = n > 0 ? haze : 0;
            uGas.value = gas;
            uTime.value = time;
            active = allowed && (n > 0 || gas > 0);
        },
        dispose() { quad.material.dispose(); target.dispose(); blank.dispose(); },
    };
}
