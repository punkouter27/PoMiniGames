import * as THREE from 'three';
import { billboardChunk, softTexture } from './look.js';

// Gas, spray and flash-bangs as soft camera-facing sprites instead of solid spheres and lines.
//
// The world reports each effect as a position, radius and age; it keeps no particles. So every
// sprite here is a pure function of (effect, index, time): nothing to spawn, nothing to leak,
// and a paused game shows a paused cloud.

const GAS_PUFFS = 14, SPRAY_DROPS = 18, FLASH_SPRITES = 6, SMOKE_PUFFS = 26;
// What a cloud leaves behind: gas and smoke do not vanish when the canister is spent, they thin
// into a low haze that hangs for most of a minute and slides off with the wind.
const HAZE_SECONDS = 50, HAZE_PUFFS = 4, HAZE_MAX = 8;
// A dry-powder extinguisher let off in a doorway: a hard white jet, then a cloud that sits.
const PLUME_SECONDS = 11, PLUME_PUFFS = 12, PLUME_MAX = 6;

/**
 * How dense a spent cloud's haze is `age` seconds after the cloud itself went, 0..1: it settles in
 * over the first few seconds and thins steadily to nothing at HAZE_SECONDS.
 */
function hazeDensity(age) {
    if (!(age >= 0) || age >= HAZE_SECONDS) return 0;
    return Math.min(1, age / 4) * (1 - age / HAZE_SECONDS) ** 1.5;
}
/** Calm-day fallback. The scene replaces this with the weather's own wind vector when it has one. */
const CALM = { x: 0.32, z: -0.12 };

function frac(v) { return v - Math.floor(v); }

export function createParticles(scene, capacity = 430) {
    const texture = softTexture('smoke');
    const geometry = new THREE.PlaneGeometry(1, 1);
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    alpha.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aAlpha', alpha);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, fog: true });
    material.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
            .replace('#include <project_vertex>', billboardChunk(false) + '\nvAlpha = aAlpha;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
            .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vAlpha;');
    };
    material.customProgramCacheKey = () => 'pocapitol-particles';
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color());
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.layers.set(1);
    mesh.count = 0;
    scene.add(mesh);

    const pose = new THREE.Object3D(), color = new THREE.Color();
    const gas = new THREE.Color('#d9dccd'), spray = new THREE.Color('#eaa24a'), smoke = new THREE.Color('#bfc0b8'), canister = new THREE.Color('#40454c');
    const residue = new THREE.Color('#cfd1c6'), powder = new THREE.Color('#f2f4f3');
    let n = 0, light = 1;
    // The only memory here: where clouds were, and where an extinguisher went off. Both are keyed
    // to scenario time, so they hold still while the game is paused and clear on a new attempt.
    const hazes = [], plumes = [], seen = new WeakSet();
    let lastTime = 0;
    function add(x, y, z, size, c, a, boost = 1) {
        if (n >= capacity || a <= 0.003) return;
        pose.position.set(x, y, z); pose.scale.set(size, size, 1); pose.updateMatrix();
        mesh.setMatrixAt(n, pose.matrix);
        mesh.setColorAt(n, color.copy(c).multiplyScalar(light * boost));
        alpha.array[n] = Math.min(1, a);
        n++;
    }

    /**
     * Rebuilds every sprite from the world's effect list.
     * @param effects state.effects
     * @param time    seconds of scenario time (stops when paused)
     * @param level   0..1 brightness of the day, so smoke darkens at dusk
     * @param calm    reduced flashing: the flash-bang core stays dim
     * @param wind    the weather's own wind, m/s: gas drifts and thins with it
     */
    function update(effects, time, level, calm, wind = null) {
        n = 0; light = 0.35 + level * 0.65;
        const wx = wind?.x ?? CALM.x, wz = wind?.z ?? CALM.z;
        // The clock running backwards is a new attempt: yesterday's air does not carry over.
        if (time < lastTime) { hazes.length = 0; plumes.length = 0; }
        lastTime = time;
        for (const e of effects) {
            if ((e.type !== 'gas' && e.type !== 'smoke') || seen.has(e)) continue;
            seen.add(e);
            // The haze takes over as the cloud itself fades out.
            hazes.push({ x: e.x, z: e.z, r: (e.r ?? 7) * (e.type === 'smoke' ? 1.5 : 1.25), born: time + Math.max(0, e.life - 2.5), indoors: e.z < 14 });
            if (hazes.length > HAZE_MAX) hazes.shift();
        }
        while (hazes.length && time - hazes[0].born >= HAZE_SECONDS) hazes.shift();
        while (plumes.length && time - plumes[0].born >= PLUME_SECONDS) plumes.shift();
        for (const h of hazes) {
            const age = time - h.born, density = hazeDensity(age);
            if (density <= 0) continue;
            // Indoors there is no wind to take it; outdoors it slides away, slower than the wind.
            const drift = h.indoors ? 0.02 : 0.12, seed = h.x * 0.93 + h.z * 1.61;
            for (let i = 0; i < HAZE_PUFFS; i++) {
                const r1 = frac(Math.sin(seed + i * 12.9898) * 43758.55), r2 = frac(Math.sin(seed + i * 78.233) * 12543.1);
                const angle = r1 * Math.PI * 2, reach = h.r * (0.2 + 0.8 * r2) * (1 + age / HAZE_SECONDS);
                const size = h.r * (1.3 + 0.5 * r1) * (1 + age / HAZE_SECONDS * 0.6);
                add(h.x + Math.cos(angle) * reach + wx * age * drift, 0.75 + r2 * 0.7, h.z + Math.sin(angle) * reach + wz * age * drift,
                    size, residue, 0.2 * density * (0.6 + 0.4 * r1));
            }
        }
        for (const p of plumes) {
            const age = time - p.born;
            if (age < 0) continue;
            const jet = Math.min(1, age / 1.4), fade = Math.min(1, (PLUME_SECONDS - age) / 5);
            for (let i = 0; i < PLUME_PUFFS; i++) {
                const r1 = frac(Math.sin(p.seed + i * 12.9898) * 43758.55), r2 = frac(Math.sin(p.seed + i * 78.233) * 12543.1);
                // Each puff leaves the nozzle in turn, flies out along the jet and then stalls.
                const along = (0.6 + 5.4 * (i + 1) / PLUME_PUFFS) * jet;
                const side = (r1 - 0.5) * (0.4 + along * 0.55) * (1 + age * 0.12);
                const size = 0.5 + along * 0.42 + age * 0.3 * (0.5 + r2);
                add(p.x + p.dx * along - p.dz * side, 1.25 + (r2 - 0.35) * along * 0.3 + age * 0.05, p.z + p.dz * along + p.dx * side,
                    size, powder, Math.min(1, 0.75 * fade * Math.min(1, age * 3 + 0.2) * (0.55 + 0.45 * r2)), 1.2);
            }
        }
        // A stiffer wind tears a cloud apart and carries it further before it fades.
        const spread = 1 + Math.min(1.2, Math.hypot(wx, wz) / 8);
        for (const e of effects) {
            const age = e.span - e.life, seed = e.x * 1.37 + e.z * 0.71;
            if (e.type === 'gas') {
                const grow = Math.min(1, age / 2), fadeIn = Math.min(1, age / 1.2), fadeOut = Math.min(1, e.life / 2.5);
                for (let i = 0; i < GAS_PUFFS; i++) {
                    const r1 = frac(Math.sin(seed + i * 12.9898) * 43758.55), r2 = frac(Math.sin(seed + i * 78.233) * 12543.1);
                    const angle = r1 * Math.PI * 2 + age * 0.08 * (r2 - 0.5);
                    const reach = e.r * (0.15 + 0.85 * Math.sqrt(r2)) * (0.45 + 0.55 * grow) * spread;
                    const rise = 0.35 + (i % 4) * 0.4 + age * (0.05 + r1 * 0.08);
                    const size = e.r * (0.55 + 0.35 * r1) * (0.5 + 0.5 * grow) + age * 0.12;
                    add(e.x + Math.cos(angle) * reach + wx * age, rise + size * 0.25, e.z + Math.sin(angle) * reach + wz * age,
                        size, gas, 0.3 * fadeIn * fadeOut * (0.6 + 0.4 * r2) / spread);
                }
            } else if (e.type === 'grenade') {
                // In flight: a small dark canister on an arc, blinking hotter as the fuse runs.
                const k = Math.min(1, 1 - e.life / e.span);
                const blink = 0.5 + 0.5 * Math.sin(time * 26 + seed);
                add(e.x, 1.1 + Math.sin(Math.PI * k) * 3.2, e.z, 0.16, canister, 1, 0.8 + blink * 1.8);
            } else if (e.type === 'smoke') {
                // A smoke grenade: dozens of big, slow puffs that grow to fill the street and
                // hang until the wind takes them. Much denser than the gas cloud.
                const age = e.span - e.life, grow = Math.min(1, age / 2.4);
                const fade = Math.min(1, e.life / 3.2), fill = Math.min(1, age / 1.1);
                const radius = e.r ?? 7.5;
                for (let i = 0; i < SMOKE_PUFFS; i++) {
                    const r1 = frac(Math.sin(seed + i * 12.9898) * 43758.55), r2 = frac(Math.sin(seed + i * 78.233) * 12543.1);
                    const angle = r1 * Math.PI * 2 + age * 0.05 * (r2 - 0.5);
                    const reach = radius * (0.1 + 0.9 * Math.sqrt(r2)) * (0.35 + 0.65 * grow) * spread;
                    const size = radius * (0.5 + 0.45 * r1) * (0.7 + 0.5 * grow);
                    add(e.x + Math.cos(angle) * reach + wx * age * 0.6, 0.9 + (i % 5) * 0.45 + age * 0.16,
                        e.z + Math.sin(angle) * reach + wz * age * 0.6, size, smoke,
                        Math.min(1, 0.92 * fill * fade * (0.6 + 0.4 * r2) / spread), 1.15);
                }
            } else if (e.type === 'spray') {
                const dx = e.tx - e.x, dz = e.tz - e.z, len = Math.hypot(dx, dz) || 1;
                const sx = -dz / len, sz = dx / len;
                for (let i = 0; i < SPRAY_DROPS; i++) {
                    const t = frac(time * 2.6 + i / SPRAY_DROPS);
                    const wobble = Math.sin(i * 7.31 + seed) * t * 0.35;
                    add(e.x + dx * t + sx * wobble, 1.5 + 0.12 * t - 0.35 * t * t + Math.cos(i * 3.7) * 0.06 * t,
                        e.z + dz * t + sz * wobble, 0.08 + 0.5 * t, spray, 0.5 * (1 - t) * Math.min(1, t * 6));
                }
            } else if (e.type === 'flash') {
                const k = e.life / e.span;
                // The burst: a hot core well above white so the bloom pass catches it.
                add(e.x, 0.7, e.z, 1.2 + (1 - k) * 2.5, gas, k * k, calm ? 1.2 : 9);
                // What it leaves: a low grey smoke that spreads as the light goes.
                for (let i = 0; i < FLASH_SPRITES; i++) {
                    const a = i / FLASH_SPRITES * Math.PI * 2 + seed;
                    const spread = 0.4 + (1 - k) * 1.6;
                    add(e.x + Math.cos(a) * spread, 0.5 + (1 - k) * 0.8, e.z + Math.sin(a) * spread, 1.4 + (1 - k) * 2,
                        smoke, 0.35 * Math.min(1, (1 - k) * 4) * k);
                }
            }
        }
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
        alpha.needsUpdate = true;
    }
    /**
     * An extinguisher discharged at (x, z) along the unit direction (dx, dz), at scenario time
     * `time`. Purely a cloud: it obscures, and nothing in the simulation reads it.
     */
    function plume(x, z, dx, dz, time) {
        plumes.push({ x, z, dx, dz, born: time, seed: x * 1.37 + z * 0.71 + time });
        if (plumes.length > PLUME_MAX) plumes.shift();
    }
    function dispose() {
        scene.remove(mesh); mesh.dispose(); geometry.dispose(); material.dispose(); texture.dispose();
    }
    return { update, plume, dispose };
}
