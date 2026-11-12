import * as THREE from 'three';
import { billboardChunk, softTexture } from './look.js';

// Gas, spray and flash-bangs as soft camera-facing sprites instead of solid spheres and lines.
//
// The world reports each effect as a position, radius and age; it keeps no particles. So every
// sprite here is a pure function of (effect, index, time): nothing to spawn, nothing to leak,
// and a paused game shows a paused cloud.

const GAS_PUFFS = 14, SPRAY_DROPS = 18, FLASH_SPRITES = 6;
/** Calm-day fallback. The scene replaces this with the weather's own wind vector when it has one. */
const CALM = { x: 0.32, z: -0.12 };

function frac(v) { return v - Math.floor(v); }

export function createParticles(scene, capacity = 320) {
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
    let n = 0, light = 1;
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
    function dispose() {
        scene.remove(mesh); mesh.dispose(); geometry.dispose(); material.dispose(); texture.dispose();
    }
    return { update, dispose };
}
