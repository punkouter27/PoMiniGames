import * as THREE from 'three-eco/webgpu';
import * as TSL from 'three-eco/tsl';
import { makeTarget, makeQuad, drawQuad, tap, hash12, vnoise2 } from './nodes.js';

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
//
// r186: each is a node graph drawn by post.js (see nodes.js). `refractNode`, `meter`, `flare` and
// `combineNode` below are the four steps; `update` is the per-frame state, unchanged.

export const MAX_WAVES = 4, MAX_HAZES = 4;

export function createLens(renderer) {
    // Stand-in textures the steps are compiled against; the real ones are swapped in each frame.
    const dummy = makeTarget(1, 1);
    const { Fn, vec2, vec3, vec4, float, length, exp, sign, max, normalize, smoothstep, clamp, log, mix, Loop, If, Continue, uniform, texture } = TSL;
    const waves = Array.from({ length: MAX_WAVES }, () => new THREE.Vector4());
    const hazes = Array.from({ length: MAX_HAZES }, () => new THREE.Vector4());
    const uWave = TSL.uniformArray(waves, 'vec4'), uHaze = TSL.uniformArray(hazes, 'vec4');
    const uAspect = uniform(1), uTime = uniform(0), uTexel = uniform(new THREE.Vector2(1, 1));
    const luma = c => c.dot(vec3(0.2126, 0.7152, 0.0722));

    // ---- refraction
    const refractNode = tex => Fn(() => {
        const uv = TSL.screenUV;
        const bend = vec2(0).toVar();
        for (let i = 0; i < MAX_WAVES; i++) {
            const w = uWave.element(i);
            const d = uv.sub(w.xy).mul(vec2(uAspect, 1));
            const r = length(d), edge = r.sub(w.z);
            // A thin shell: compressed air ahead of the front, thin air behind it.
            const shell = exp(edge.mul(edge).mul(-900)).mul(sign(edge.add(0.0001)));
            bend.addAssign(d.div(max(r, 1e-4)).mul(shell).mul(w.w).mul(vec2(uAspect.reciprocal(), 1)).mul(w.w.greaterThan(0).select(1, 0)));
        }
        for (let i = 0; i < MAX_HAZES; i++) {
            const h = uHaze.element(i);
            const d = uv.sub(h.xy).mul(vec2(uAspect, 1));
            const inside = smoothstep(h.z, h.z.mul(0.3), length(d));
            const p = uv.mul(vec2(uAspect, 1)).mul(26).add(vec2(0, uTime.mul(-1.3)));
            bend.addAssign(vec2(vnoise2(p), vnoise2(p.add(17.3))).sub(0.5).mul(inside).mul(h.w).mul(h.w.greaterThan(0).select(1, 0)));
        }
        return tap(tex, uv.add(bend));
    })();

    // ---- metering: the frame's brightness on a 16 x 16 grid, nine taps a cell, stored as a
    // logarithm so one bright lamp does not outweigh a whole dark lawn
    const meterSrc = texture(dummy.texture);
    const meterNode = Fn(() => {
        const uv = TSL.screenUV;
        const sum = float(0).toVar();
        for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
            const c = tap(meterSrc, uv.add(vec2(x, y).div(48))).rgb;
            sum.addAssign(log(max(luma(c), 0).add(0.02)));
        }
        return vec4(sum.div(9), 0, 0, 1);
    })();

    // One pixel holding both averages: red follows the frame, green is what the eye has settled to.
    const gridTex = texture(dummy.texture), beforeTex = texture(dummy.texture);
    const uFast = uniform(0.1), uSlow = uniform(0.01), uFresh = uniform(1);
    const adaptNode = Fn(() => {
        const sum = float(0).toVar(), weight = float(0).toVar();
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const uv = vec2((x + 0.5) / 8, (y + 0.5) / 8);
            // Centre-weighted, as a camera meters: the subject matters more than the corners.
            const w = length(uv.sub(0.5)).mul(-0.6).add(1);
            sum.addAssign(tap(gridTex, uv).r.mul(w)); weight.addAssign(w);
        }
        const now = sum.div(weight);
        const before = tap(beforeTex, vec2(0.5)).rg;
        return vec4(mix(mix(before.r, now, uFast), now, uFresh), mix(mix(before.g, now, uSlow), now, uFresh), 0, 1);
    })();

    // ---- the flare: soft by nature, so it is worked out at a quarter of the frame's resolution and
    // added on: seventeen taps on a sixteenth of the pixels
    const flareSrc = texture(dummy.texture);
    const hot = uv => {
        const inside = TSL.step(0, uv.x).mul(TSL.step(uv.x, 1)).mul(TSL.step(0, uv.y)).mul(TSL.step(uv.y, 1));
        const c = tap(flareSrc, uv).rgb;
        return c.mul(smoothstep(2.0, 4.5, max(c.r, max(c.g, c.b)))).mul(inside);
    };
    const flareNode = Fn(() => {
        const uv = TSL.screenUV;
        const across = vec2(0.5).sub(uv);
        const flare = vec3(0).toVar();
        // Ghosts: the bright thing again, on the far side of the centre, tinted by the coatings.
        flare.addAssign(hot(uv.add(across.mul(2.0))).mul(vec3(0.5, 0.75, 1.0)).mul(0.5));
        flare.addAssign(hot(uv.add(across.mul(1.36))).mul(vec3(1.0, 0.8, 0.55)).mul(0.35));
        flare.addAssign(hot(uv.add(across.mul(0.62))).mul(vec3(0.7, 1.0, 0.8)).mul(0.22));
        // The halo: a ring at a fixed radius from the centre.
        const ring = normalize(across.mul(vec2(uAspect, 1)).add(1e-5)).mul(vec2(uAspect.reciprocal(), 1)).mul(0.42);
        flare.addAssign(hot(uv.add(across).add(ring)).mul(vec3(0.9, 0.7, 1.0)).mul(0.18));
        const fade = smoothstep(0.35, 0.75, length(across)).oneMinus();
        // The streak: a long, thin, blue-white smear through every hot point.
        const streak = vec3(0).toVar();
        for (let i = 1; i <= 7; i++) {
            const reach = uTexel.x.mul(i * i * 3.2), w = 1 - i / 8;
            streak.addAssign(hot(uv.add(vec2(reach, 0))).add(hot(uv.sub(vec2(reach, 0)))).mul(w));
        }
        return vec4(flare.mul(fade).add(streak.mul(vec3(0.55, 0.7, 1.0)).mul(0.09)), 1);
    })();

    const uFlare = uniform(1), uMeter = uniform(1);
    const adaptSeen = texture(dummy.texture), glareTex = texture(dummy.texture);
    /** The lens's colour step: flare added, then exposed by how far the frame is from what the eye has settled to. */
    const combineNode = tex => Fn(() => {
        const uv = TSL.screenUV;
        const c = tap(tex, uv).rgb.toVar();
        c.addAssign(tap(glareTex, uv).rgb.mul(uFlare));
        const seen = tap(adaptSeen, vec2(0.5)).rg;
        // Brighter than the eye is used to: stop down. Darker: open up. Never by much.
        c.mulAssign(mix(1, clamp(exp(seen.g.sub(seen.r).mul(0.75)), 0.62, 1.4), uMeter));
        return vec4(c, 1);
    })();

    const small = size => { const t = makeTarget(size, size); return t; };
    const grid = small(16), glare = small(4), seen = [small(1), small(1)];
    gridTex.value = grid.texture; glareTex.value = glare.texture;
    const meterQuad = makeQuad(meterNode), adaptQuad = makeQuad(adaptNode), flareQuad = makeQuad(flareNode);
    let at = 0, fresh = true, metering = true, allowed = true, flare = true, lensOn = true, refractOn = false;
    adaptSeen.value = seen[0].texture;

    /** Where a world sphere lands on screen: its centre in uv and its radius in frame heights. */
    const centre = new THREE.Vector3(), rim = new THREE.Vector3(), right = new THREE.Vector3();
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
        refractNode, combineNode,
        /** True on a frame where something is bending light. */
        refractActive: () => refractOn,
        /** True when the lens step has anything to do beyond the tone map (flare or metering). */
        lensActive: () => lensOn,
        setAllowed(value) { allowed = value; if (!value) refractOn = false; },
        /** Level 2 and up: flare and metering. Below that the step is off altogether. */
        setLens(on, withFlare = true) { lensOn = on; flare = withFlare; },
        setSize(w, h) {
            uTexel.value.set(1 / w, 1 / h); uAspect.value = w / h;
            glare.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
        },
        /**
         * Meters the frame and draws the flare, from `srcTex` (a texture of the frame so far).
         * Call before the frame's combine step.
         */
        measure(srcTex, deltaTime) {
            if (metering && lensOn) {
                const dt = Math.min(0.1, Math.max(0.001, deltaTime || 0.016));
                meterSrc.value = srcTex;
                drawQuad(renderer, meterQuad, grid);
                const from = seen[at], to = seen[1 - at];
                beforeTex.value = from.texture;
                // The frame is followed in about a third of a second; the eye settles in about ten.
                uFast.value = 1 - Math.exp(-dt * 3.2); uSlow.value = 1 - Math.exp(-dt * 0.1);
                uFresh.value = fresh ? 1 : 0; fresh = false;
                drawQuad(renderer, adaptQuad, to);
                at = 1 - at;
                adaptSeen.value = to.texture;
            }
            if (uFlare.value > 0 && lensOn) {
                flareSrc.value = srcTex;
                drawQuad(renderer, flareQuad, glare);
            }
        },
        /**
         * Once a frame.
         * @param waves  [{ x, y, z, radius, strength }]: pressure fronts, world metres
         * @param hazes  [{ x, y, z, radius, strength }]: clouds that shimmer what is behind them
         * @param calm   reduced motion: nothing bends, and the exposure does not pump
         */
        update(camera, waveList, hazeList, time, calm) {
            uAspect.value = camera.aspect; uTime.value = time;
            let any = false;
            for (let i = 0; i < MAX_WAVES; i++) {
                const slot = waves[i], w = waveList[i];
                slot.w = 0;
                if (!w || calm || !onScreen(camera, w.x, w.y, w.z, w.radius, slot)) continue;
                slot.w = w.strength; any = any || w.strength > 0.0005;
            }
            for (let i = 0; i < MAX_HAZES; i++) {
                const slot = hazes[i], h = hazeList[i];
                slot.w = 0;
                if (!h || calm || !onScreen(camera, h.x, h.y, h.z, h.radius, slot)) continue;
                slot.w = h.strength; any = any || h.strength > 0.0002;
            }
            refractOn = allowed && any;
            uFlare.value = flare && !calm ? 1 : 0;
            uMeter.value = calm ? 0 : 1;
            metering = !calm;
            if (calm) fresh = true;
        },
        dispose() {
            for (const q of [meterQuad, adaptQuad, flareQuad]) q.material.dispose();
            grid.dispose(); glare.dispose(); for (const t of seen) t.dispose();
        },
    };
}
