import * as THREE from 'three-eco/webgpu';
import * as TSL from 'three-eco/tsl';
import { makeTarget, tap } from './nodes.js';

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
//
// r186 NOTE: the passes are node graphs now (see nodes.js). This file builds the nodes; post.js
// draws them. Depth is read straight from the scene target's depth texture; WebGPU's clip-space
// depth is already 0..1, the WebGL2 backend's is -1..1, so `ndcZ` converts for the backend in use.

const HALTON = [[0.5, 0.3333], [0.25, 0.6667], [0.75, 0.1111], [0.125, 0.4444], [0.625, 0.7778], [0.375, 0.2222], [0.875, 0.5556], [0.0625, 0.8889]];

/** How far the camera is nudged this frame, in pixels from the pixel centre, each in -0.5..0.5. */
export function jitterOffset(frame) {
    const h = HALTON[((frame % HALTON.length) + HALTON.length) % HALTON.length];
    return [h[0] - 0.5, h[1] - 0.5];
}

/**
 * @param renderer      the WebGPURenderer
 * @param camera        the scene camera (jittered while this is on)
 * @param depthTexture  solid-geometry depth, drawn with the same jittered camera
 * @param ndcZ          (depth node) => clip-space z for this backend
 */
export function createTemporal(renderer, camera, depthTexture, ndcZ, capacity = 720) {
    const { Fn, vec2, vec3, vec4, float, mix, clamp, max, min, length, step, select, If, uniform, texture } = TSL;
    const matrices = { invViewProj: new THREE.Matrix4(), viewProj: new THREE.Matrix4(), prevViewProj: new THREE.Matrix4() };
    const uInvViewProjJ = uniform(matrices.invViewProj), uViewProj = uniform(matrices.viewProj), uPrevViewProj = uniform(matrices.prevViewProj);
    const uTexel = uniform(new THREE.Vector2(1, 1));
    const depth = texture(depthTexture);

    // ---- the people's own motion: boxes drawn into a half-size target
    const geometry = new THREE.BoxGeometry(0.62, 1.86, 0.62);
    geometry.translate(0, 0.93, 0);
    const now = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const before = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    now.setUsage(THREE.DynamicDrawUsage); before.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aNow', now); geometry.setAttribute('aBefore', before);
    const uNear = uniform(0.1), uFar = uniform(420);
    const material = new THREE.NodeMaterial();
    material.depthTest = true; material.depthWrite = true; material.fog = false; material.toneMapped = false;
    {
        const aNow = TSL.attribute('aNow', 'vec3'), aBefore = TSL.attribute('aBefore', 'vec3');
        const vNow = TSL.varying(uViewProj.mul(vec4(TSL.positionGeometry.add(aNow), 1)), 'vVelNow');
        const vBefore = TSL.varying(uPrevViewProj.mul(vec4(TSL.positionGeometry.add(aBefore), 1)), 'vVelBefore');
        material.vertexNode = TSL.cameraProjectionMatrix.mul(TSL.cameraViewMatrix).mul(vec4(TSL.positionGeometry.add(aNow), 1));
        material.fragmentNode = TSL.Fn(() => {
            // Only where the scene's own surface is inside the box: the person, not the lawn seen
            // past their shoulder.
            const solid = TSL.perspectiveDepthToViewZ(depth.sample(TSL.screenUV).r, uNear, uFar).negate();
            const box = TSL.positionView.z.negate();
            solid.lessThan(box.sub(0.05)).or(solid.greaterThan(box.add(0.8))).or(vBefore.w.lessThanEqual(0)).discard();
            return vec4(vNow.xy.div(vNow.w).sub(vBefore.xy.div(vBefore.w)).mul(0.5), 0, 1);
        })();
    }
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.frustumCulled = false; mesh.count = 0;
    const proxies = new THREE.Scene();
    proxies.add(mesh);
    const velocity = makeTarget(1, 1, { depth: true, filter: THREE.NearestFilter });
    const velocityTex = texture(velocity.texture);

    // ---- where this pixel was a frame ago, in uv
    const motionAt = Fn(([uv]) => {
        const person = tap(velocityTex, uv);
        const z = depth.sample(uv).r;
        const world = uInvViewProjJ.mul(vec4(uv.mul(2).sub(1), ndcZ(z), 1)).toVar();
        world.assign(world.div(world.w));
        const nowP = uViewProj.mul(world), beforeP = uPrevViewProj.mul(world);
        const cam = select(beforeP.w.lessThanEqual(0), vec2(0), nowP.xy.div(nowP.w).sub(beforeP.xy.div(beforeP.w)).mul(0.5));
        return select(person.a.greaterThan(0.5), person.xy, cam);
    });

    const luma = c => c.dot(vec3(0.2126, 0.7152, 0.0722));
    const uBlend = uniform(0.88);

    /**
     * The history blend. `nowTex` is this frame's colour, `histTex` the resolved frame before it.
     * Returns the new resolved colour.
     */
    const resolve = (nowTex, histTex) => Fn(() => {
        const uv = TSL.screenUV;
        const nowC = tap(nowTex, uv).rgb;
        // What this pixel could plausibly be: the range of its eight neighbours this frame. A
        // history colour outside that range is something that has moved away, and is pulled in.
        const lo = nowC.toVar(), hi = nowC.toVar();
        for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
            const c = tap(nowTex, uv.add(vec2(x, y).mul(uTexel))).rgb;
            lo.assign(min(lo, c)); hi.assign(max(hi, c));
        }
        const motion = motionAt(uv).toVar(), was = uv.sub(motion).toVar();
        const blend = uBlend.toVar();
        If(was.x.lessThan(0).or(was.x.greaterThan(1)).or(was.y.lessThan(0)).or(was.y.greaterThan(1)), () => { blend.assign(0); });
        // Fast motion trusts the history less, so a whip pan stays sharp where it lands.
        blend.mulAssign(mix(1, 0.7, clamp(length(motion.div(uTexel)).div(40), 0, 1)));
        // The history is read between its pixels every frame the camera moves, and a plain bilinear
        // read there blurs it a little more each time. A Catmull-Rom read (five taps) keeps its edges.
        const at = was.div(uTexel), base = TSL.floor(at.sub(0.5)).add(0.5), f = at.sub(base);
        const w0 = f.mul(f.mul(f.mul(-0.5).add(1)).sub(0.5));
        const w1 = f.mul(f).mul(f.mul(1.5).sub(2.5)).add(1);
        const w2 = f.mul(f.mul(f.mul(-1.5).add(2)).add(0.5));
        const w3 = f.mul(f).mul(f.mul(0.5).sub(0.5));
        const w12 = w1.add(w2);
        const t0 = base.sub(1).mul(uTexel), t3 = base.add(2).mul(uTexel), t12 = base.add(w2.div(w12)).mul(uTexel);
        const a = w12.x.mul(w0.y), b = w0.x.mul(w12.y), c = w12.x.mul(w12.y), d = w3.x.mul(w12.y), e = w12.x.mul(w3.y);
        const sum = tap(histTex, vec2(t12.x, t0.y)).rgb.mul(a).add(tap(histTex, vec2(t0.x, t12.y)).rgb.mul(b))
            .add(tap(histTex, t12).rgb.mul(c)).add(tap(histTex, vec2(t3.x, t12.y)).rgb.mul(d)).add(tap(histTex, vec2(t12.x, t3.y)).rgb.mul(e));
        const history = max(sum.div(a.add(b).add(c).add(d).add(e)), 0);
        const old = clamp(history, lo, hi);
        // Weighted by brightness, so one spark above white does not flicker the pixels round it.
        const wn = blend.oneMinus().div(luma(nowC).add(1)), wo = blend.div(luma(old).add(1));
        return vec4(nowC.mul(wn).add(old.mul(wo)).div(max(wn.add(wo), 1e-5)), 1);
    })();

    /** The resolved frame on its way out, with back the little crispness that averaging frames costs. */
    const sharpen = tex => TSL.Fn(() => {
        const uv = TSL.screenUV;
        const c = tap(tex, uv).rgb;
        const around = tap(tex, uv.add(vec2(uTexel.x, 0))).rgb.add(tap(tex, uv.sub(vec2(uTexel.x, 0))).rgb)
            .add(tap(tex, uv.add(vec2(0, uTexel.y))).rgb).add(tap(tex, uv.sub(vec2(0, uTexel.y))).rgb);
        // Held to the range of the neighbours, so an edge is firmer but never rings.
        const sharp = c.add(c.sub(around.mul(0.25)).mul(0.55));
        return vec4(clamp(sharp, c.mul(0.6), c.mul(1.6).add(0.02)), 1);
    })();

    const uShutter = uniform(0.5), uTime = uniform(0);
    const blurNode = tex => TSL.Fn(() => {
        const uv = TSL.screenUV;
        const motion = motionAt(uv).mul(uShutter).toVar();
        const reach = length(motion.div(uTexel));
        const base = tap(tex, uv);
        const out = base.toVar();
        // A slow pan stays sharp: only what crosses a few pixels in the shutter's time is smeared.
        If(reach.greaterThanEqual(3), () => {
            // Never further than a thirtieth of the frame, however hard the camera is thrown.
            motion.mulAssign(min(1, float(0.033).div(max(length(motion), 1e-5))));
            const start = TSL.fract(TSL.sin(TSL.dot(uv.div(uTexel).add(TSL.fract(uTime).mul(61)), vec2(12.9898, 78.233))).mul(43758.5453));
            const sum = vec4(0).toVar();
            for (let i = 0; i < 8; i++) {
                const t = start.add(i).div(8).sub(0.5);
                // A tap that lands off the frame has nothing to give: counting the clamped edge pixel
                // instead drags streaks in from the border on every pan.
                const tapUv = uv.add(motion.mul(t));
                const inside = step(0, tapUv.x).mul(step(tapUv.x, 1)).mul(step(0, tapUv.y)).mul(step(tapUv.y, 1));
                sum.addAssign(vec4(tap(tex, tapUv).rgb, 1).mul(inside));
            }
            out.assign(vec4(select(sum.a.greaterThan(0), sum.rgb.div(sum.a), base.rgb), base.a));
        });
        return out;
    })();

    const steady = new THREE.Matrix4(), jittered = new THREE.Matrix4();
    const last = new Map();
    let frame = 0, on = true, width = 1, height = 1, primed = false, fresh = true, blurOn = false;

    return {
        matrices, motionAt, resolve, sharpen, blurNode, velocity,
        uniforms: { uBlend, uTexel, uTime },
        consumeFresh() { const was = fresh; fresh = false; return was; },
        get blurOn() { return blurOn; },
        enabled: () => on,
        setEnabled(value) { on = value; fresh = true; if (!value) blurOn = false; },
        setSize(w, h) {
            width = w; height = h; uTexel.value.set(1 / w, 1 / h);
            velocity.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
            fresh = true;
        },
        /** Draw the people's velocity boxes. */
        drawVelocity() {
            const clearA = renderer.getClearAlpha(), autoClear = renderer.autoClear;
            const clear = renderer.getClearColor(new THREE.Color());
            renderer.setRenderTarget(velocity);
            renderer.setClearColor(0x000000, 0); renderer.autoClear = true;
            renderer.clear();
            if (mesh.count > 0) renderer.render(proxies, camera);
            renderer.setClearColor(clear, clearA); renderer.autoClear = autoClear;
        },
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
         * Once a frame, after `jitter` and before the passes are drawn.
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
            uNear.value = camera.near; uFar.value = camera.far;
            let n = 0;
            if (on) {
                for (const p of people) {
                    if (n >= capacity) break;
                    const was = last.get(p.key);
                    const i = n * 3;
                    now.array[i] = p.x; now.array[i + 1] = p.y; now.array[i + 2] = p.z;
                    // Someone seen for the first time, or who jumped (a new attempt), has no motion.
                    const jumped = !was || Math.hypot(p.x - was.x, p.z - was.z) > 3;
                    before.array[i] = jumped ? p.x : was.x; before.array[i + 1] = jumped ? p.y : was.y; before.array[i + 2] = jumped ? p.z : was.z;
                    if (was) { was.x = p.x; was.y = p.y; was.z = p.z; } else last.set(p.key, { x: p.x, y: p.y, z: p.z });
                    n++;
                }
                now.needsUpdate = before.needsUpdate = true;
            }
            mesh.count = n;
            // A 1/120 s shutter at any frame rate: half a frame's travel at 60, a quarter at 30.
            uShutter.value = Math.min(0.6, 0.4 * (1 / 60) / Math.max(dt, 1 / 240));
            uTime.value = time;
            // Below about 24 frames a second each frame is too far from the last for a smear between
            // them to read as motion: it reads as a broken picture. The blur stands down until the
            // frame rate is back.
            blurOn = on && !still && dt < 0.042;
        },
        /** After a camera cut the history is a different picture. */
        cut() { fresh = true; primed = false; },
        dispose() {
            velocity.dispose();
            geometry.dispose(); material.dispose(); mesh.dispose();
        },
    };
}
