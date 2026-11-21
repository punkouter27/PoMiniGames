import * as THREE from 'three-eco/webgpu';
import * as TSL from 'three-eco/tsl';
import { makeTarget, tap } from './nodes.js';

// Hundreds of small lights for the price of one draw call.
//
// A real three.js light costs every lit pixel in the scene, which is why the scene has a dozen
// and one of them stands in for all four police cars. These do not work that way. Each light is
// a camera-facing quad just big enough to cover its own reach; the fragment shader rebuilds the
// world position and facing of whatever solid surface is under each pixel from the depth buffer,
// and adds the light that surface would receive. A light therefore costs only the pixels it can
// reach, and five hundred of them are one instanced draw.
//
// What uses it: a phone screen in front of everyone filming, phones held up across the far crowd
// once the light goes, each lamp post, each police light bar, and every round in flight.
//
// r186: the quads are drawn (additively) into a target of their own, which the frame then adds
// in (post.js). On r165 they were drawn straight onto the frame; the sum is the same.

/**
 * @param renderer      the WebGPURenderer
 * @param camera        the scene camera
 * @param depthTexture  solid-geometry depth
 * @param sceneTex      a texture node of the lit frame the lights read the surface colour from
 * @param invViewProj   the shared (jittered) inverse view-projection matrix from temporal.js
 * @param ndcZ          (depth node) => clip-space z for this backend
 */
export function createSmallLights(renderer, camera, depthTexture, sceneTex, invViewProj, ndcZ, capacity = 640) {
    const { vec2, vec3, vec4, float, dot, cross, normalize, clamp, max, min, select, uniform, texture } = TSL;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const at = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    at.setUsage(THREE.DynamicDrawUsage); color.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aAt', at); geometry.setAttribute('aColor', color);
    const depth = texture(depthTexture);
    const uInvViewProjJ = uniform(invViewProj);

    const material = new THREE.NodeMaterial();
    Object.assign(material, { transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false, blending: THREE.AdditiveBlending });
    {
        const aAt = TSL.attribute('aAt', 'vec4'), aColor = TSL.attribute('aColor', 'vec3');
        const vAt = TSL.varying(aAt, 'vLightAt'), vColor = TSL.varying(aColor, 'vLightColor');
        // Pulled toward the lens by its own reach, so the quad still covers the light's sphere when
        // the camera is standing inside it. A light wholly behind the lens reaches nothing on screen.
        material.vertexNode = TSL.Fn(() => {
            const centre = TSL.cameraViewMatrix.mul(vec4(aAt.xyz, 1)).toVar();
            const behind = centre.z.sub(aAt.w).greaterThan(0);
            centre.xy.addAssign(TSL.positionGeometry.xy.mul(aAt.w).mul(2));
            centre.z.assign(min(centre.z.add(aAt.w), -0.12));
            return select(behind, vec4(2, 2, 2, 1), TSL.cameraProjectionMatrix.mul(centre));
        })();
        material.fragmentNode = TSL.Fn(() => {
            const uv = TSL.screenUV;
            const world = uInvViewProjJ.mul(vec4(uv.mul(2).sub(1), ndcZ(depth.sample(uv).r), 1));
            const p = world.xyz.div(world.w);
            const to = vAt.xyz.sub(p);
            const d2 = dot(to, to), reach = vAt.w;
            d2.greaterThan(reach.mul(reach)).discard();
            // The surface's facing, from how its position changes across the pixel.
            const n = normalize(cross(TSL.dFdx(p), TSL.dFdy(p)));
            const facing = clamp(dot(n, to.mul(TSL.inverseSqrt(max(d2, 1e-4)))), 0, 1).mul(0.8).add(0.2);
            const window = d2.div(reach.mul(reach)).oneMinus();
            // What the surface is: its own lit colour with the brightness taken out, near enough.
            const scene = tap(sceneTex, uv).rgb;
            const albedo = clamp(scene.div(dot(scene, vec3(0.2126, 0.7152, 0.0722)).add(0.25)), 0, 1.6);
            return vec4(vColor.mul(albedo).mul(facing).mul(window).mul(window).div(d2.mul(0.6).add(1)), 1);
        })();
    }
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.frustumCulled = false; mesh.count = 0;
    const lights = new THREE.Scene();
    lights.add(mesh);
    const target = makeTarget(1, 1);
    let n = 0, allowed = true, active = false;
    return {
        capacity, target,
        /** True on a frame with anything to draw. */
        active: () => active,
        setAllowed(value) { allowed = value; if (!value) active = false; },
        setSize(w, h) { target.setSize(w, h); },
        /** Start this frame's list. */
        begin() { n = 0; },
        /** One light: where, how far it reaches (metres), its colour and how bright. */
        add(x, y, z, reach, r, g, b, power = 1) {
            if (n >= capacity || power <= 0.01) return;
            at.array[n * 4] = x; at.array[n * 4 + 1] = y; at.array[n * 4 + 2] = z; at.array[n * 4 + 3] = reach;
            color.array[n * 3] = r * power; color.array[n * 3 + 1] = g * power; color.array[n * 3 + 2] = b * power;
            n++;
        },
        /** Upload the list. Returns how many lights are lit. */
        end() {
            mesh.count = n;
            if (n) { at.needsUpdate = true; color.needsUpdate = true; }
            active = allowed && n > 0;
            return n;
        },
        /** Draws this frame's lights into the target (cleared to black first). */
        draw() {
            const clearA = renderer.getClearAlpha(), autoClear = renderer.autoClear, clear = renderer.getClearColor(new THREE.Color());
            renderer.setRenderTarget(target);
            renderer.setClearColor(0x000000, 0); renderer.autoClear = true;
            renderer.clear();
            renderer.autoClear = false;
            renderer.render(lights, camera);
            renderer.setClearColor(clear, clearA); renderer.autoClear = autoClear;
        },
        dispose() { geometry.dispose(); material.dispose(); mesh.dispose(); target.dispose(); },
    };
}
