// PoCapitol's aftermath map: a small, separate 3D view for the end-of-attempt report.
//
// It shows the route as a landscape: where the crowd stood over the attempt rises out of the
// ground as a glowing heat field, and the police line's position over time is drawn as thin
// pulsing bands across it. It runs on its own WebGPURenderer (three r186, imported as
// 'three-eco/webgpu', so it sits beside the r165 engine on the same page), on its own canvas,
// and nothing here touches the simulation.
//
// The look is layered node materials written in TSL: lawn, paved forecourt and polished
// marble mixed by masks, then the heat ramp, then the front-line bands. One TSL compute pass
// turns the raw person-seconds into the field the ground samples.
//
// Compute only exists on the WebGPU backend. WebGPURenderer falls back to its WebGL2 backend
// where there is no WebGPU, and r186's WebGL backend cannot hand a compute-written storage
// buffer to a fragment shader (it has no read-only storage binding), so there the same blur
// and log curve run on the CPU into a half-float texture. The picture is the same either way;
// the grid is a few thousand cells, so the CPU path is cheap.
import * as THREE from 'three-eco/webgpu';
import {
    Fn, abs, clamp, color, exp, float, floor, fract, int, instanceIndex, instancedArray, log, max, mix,
    mx_fractal_noise_float, mx_noise_float, normalize, positionGeometry, positionWorld, sin, smoothstep,
    step, storage, texture, time, transformNormalToView, vec2, vec3, vec4,
} from 'three-eco/tsl';

const BLUR_PASSES = 6;        // 3x3 binomial passes: about a 2-cell sigma, so single-cell spikes read as pools
const LOG_GAIN = 9;           // how hard the log curve lifts the faint trails against the hot spots
const RELIEF = 1.5;           // metres of ground displacement at the hottest cell
const PLINTH = 0.1;           // marble walls: thickness is 0.45, height below
const WALL_HEIGHT = 0.8;
const MAX_BANDS = 40;
const BAND_GAP = 1.4;         // metres: closer samples of the line's path are one band, not a smear
const CLEAR = 0x0d1520;       // the same night-blue the report's 2D map sits on

/**
 * Raw person-seconds to the field the ground shows, on the CPU: scale by a high percentile so a
 * few hot cells do not flatten everything else, blur, then log. The compute pass does exactly
 * this on the GPU; the maths is kept identical so the two backends agree.
 */
function normalise(heat) {
    const sorted = Float32Array.from(heat).sort();
    const top = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))] || sorted[sorted.length - 1] || 1;
    const out = new Float32Array(heat.length);
    for (let i = 0; i < heat.length; i++) out[i] = Math.min(1.5, Math.max(0, heat[i]) / top);
    return out;
}

function blurCpu(field, cols, rows) {
    let a = field, b = new Float32Array(field.length);
    const w = [1, 2, 1];
    for (let pass = 0; pass < BLUR_PASSES; pass++) {
        for (let z = 0; z < rows; z++) {
            for (let x = 0; x < cols; x++) {
                let sum = 0;
                for (let dz = -1; dz <= 1; dz++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = Math.min(cols - 1, Math.max(0, x + dx)), zz = Math.min(rows - 1, Math.max(0, z + dz));
                        sum += a[zz * cols + xx] * w[dx + 1] * w[dz + 1];
                    }
                }
                b[z * cols + x] = sum / 16;
            }
        }
        [a, b] = [b, a];
    }
    for (let i = 0; i < a.length; i++) a[i] = Math.log(1 + LOG_GAIN * a[i]) / Math.log(1 + LOG_GAIN);
    return a;
}

function halfTexture(field, cols, rows) {
    const data = new Uint16Array(field.length);
    for (let i = 0; i < field.length; i++) data[i] = THREE.DataUtils.toHalfFloat(Math.min(1, field[i]));
    const tex = new THREE.DataTexture(data, cols, rows, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

/**
 * Compute path: the same blur and curve as `blurCpu`, as ping-ponging compute nodes over two
 * storage buffers and a final pass into the buffer the material reads.
 */
async function blurGpu(renderer, field, cols, rows) {
    const n = cols * rows;
    const a = instancedArray(field, 'float');
    const b = instancedArray(n, 'float');
    const out = instancedArray(n, 'float');
    const w = [1, 2, 1];
    const cell = () => {
        const f = float(instanceIndex);
        const z = floor(f.div(cols));
        return { x: f.sub(z.mul(cols)), z };
    };
    const at = (buf, x, z) => buf.element(int(z.mul(cols).add(x)));
    const blur = (from, to) => Fn(() => {
        const { x, z } = cell();
        let sum = float(0);
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                const xx = clamp(x.add(dx), 0, cols - 1), zz = clamp(z.add(dz), 0, rows - 1);
                sum = sum.add(at(from, xx, zz).mul(w[dx + 1] * w[dz + 1] / 16));
            }
        }
        to.element(instanceIndex).assign(sum);
    })().compute(n);
    const finish = Fn(() => {
        const v = a.element(instanceIndex);
        out.element(instanceIndex).assign(log(v.mul(LOG_GAIN).add(1)).div(Math.log(1 + LOG_GAIN)).min(1));
    })().compute(n);
    const passes = [];
    for (let i = 0; i < BLUR_PASSES / 2; i++) passes.push(blur(a, b), blur(b, a));
    passes.push(finish);
    for (const pass of passes) await renderer.computeAsync(pass);
    return storage(out.value, 'float', n).toReadOnly();
}

/** Ramp for the heat: dark violet through red and orange to a pale hot yellow. */
function heatRamp(h) {
    const c0 = color(0x2a0a52), c1 = color(0x8a1c70), c2 = color(0xd8432f), c3 = color(0xfb9b15), c4 = color(0xfff3a0);
    let c = mix(c0, c1, smoothstep(0.0, 0.28, h));
    c = mix(c, c2, smoothstep(0.22, 0.52, h));
    c = mix(c, c3, smoothstep(0.48, 0.78, h));
    return mix(c, c4, smoothstep(0.74, 1.0, h));
}

/** Veined polished marble, shared by the floor under the building and every wall and column. */
const marbleColor = Fn(([p]) => {
    const n = mx_fractal_noise_float(p.mul(0.11), 4, 2.0, 0.5);
    const base = mix(color(0xe7e1d6), color(0xb9c0c8), n.mul(0.5).add(0.5).clamp(0, 1));
    const warp = sin(p.x.mul(0.21).add(p.z.mul(0.13)).add(p.y.mul(0.4)).add(n.mul(7.0)));
    const vein = smoothstep(0.0, 0.07, abs(warp)).oneMinus();
    const fine = smoothstep(0.0, 0.03, abs(sin(p.x.mul(0.5).sub(p.z.mul(0.37)).add(n.mul(16.0))))).oneMinus();
    return mix(base, color(0x59606c), vein.mul(0.55).add(fine.mul(0.2)).clamp(0, 0.7));
});

function marbleMaterial() {
    const m = new THREE.MeshStandardNodeMaterial();
    m.colorNode = marbleColor(positionWorld);
    m.roughnessNode = mx_fractal_noise_float(positionWorld.mul(0.35), 2, 2.0, 0.5).mul(0.12).add(0.2);
    m.metalness = 0.0;
    return m;
}

function box(min, max, p) {
    // Soft-edged rectangle mask on (x, z).
    const edge = 0.12;
    const mx = smoothstep(min.x - edge, min.x + edge, p.x).mul(smoothstep(max.x - edge, max.x + edge, p.x).oneMinus());
    const mz = smoothstep(min.z - edge, min.z + edge, p.y).mul(smoothstep(max.z - edge, max.z + edge, p.y).oneMinus());
    return mx.mul(mz);
}

export async function createAftermathMap(canvas, {
    heat, cols, rows, rect, areas = [], obstacles = [], columns = [], frontPath = [], reducedMotion = false, forceWebGL = false,
}) {
    const none = { dispose() {} };
    let renderer = null;
    const owned = [];                 // geometries, materials and textures to free
    let disposed = false;
    let observer = null, intersection = null, onVisibility = null;
    let cleanup = () => {};

    try {
        if (!canvas || !heat || !(cols > 0) || !(rows > 0) || !rect) throw new Error('aftermath: missing input');
        const own = o => { owned.push(o); return o; };

        renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
        await renderer.init();
        if (disposed) { renderer.dispose(); return none; }
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        renderer.setClearColor(CLEAR, 1);
        const gpu = !!renderer.backend?.isWebGPUBackend;

        // The field the ground samples, from whichever path the backend allows.
        const field = normalise(heat);
        let heatAt;
        if (gpu) {
            const read = await blurGpu(renderer, field, cols, rows);
            const cellAt = (x, z) => read.element(int(clamp(z, 0, rows - 1).mul(cols).add(clamp(x, 0, cols - 1))));
            // Bilinear by hand: a storage buffer has no sampler. Cell centres sit half a cell in.
            heatAt = (u, v) => {
                const gx = u.mul(cols).sub(0.5), gz = v.mul(rows).sub(0.5);
                const x0 = floor(gx), z0 = floor(gz), fx = gx.sub(x0), fz = gz.sub(z0);
                const top = mix(cellAt(x0, z0), cellAt(x0.add(1), z0), fx);
                const bottom = mix(cellAt(x0, z0.add(1)), cellAt(x0.add(1), z0.add(1)), fx);
                return mix(top, bottom, fz);
            };
        } else {
            const tex = own(halfTexture(blurCpu(field, cols, rows), cols, rows));
            heatAt = (u, v) => texture(tex, vec2(u, v)).r;
        }

        const { x0, z0, w, d } = rect;
        const cx = x0 + w / 2, cz = z0 + d / 2;
        const uvOf = p => ({ u: p.x.sub(x0).div(w), v: p.z.sub(z0).div(d) });

        // ── Ground ────────────────────────────────────────────────────────────
        const ground = own(new THREE.PlaneGeometry(w, d, cols * 2, rows * 2));
        ground.rotateX(-Math.PI / 2);
        ground.translate(cx, 0, cz);

        const marbleAreas = areas.filter(a => a.z < 15);
        const gm = new THREE.MeshStandardNodeMaterial();
        own(gm);
        const g = positionGeometry;                  // world space: the mesh sits at the origin
        const pxz = vec2(g.x, g.z);
        const { u, v } = uvOf(g);
        const h = heatAt(u, v).toVar('aftermathHeat');
        gm.positionNode = positionGeometry.add(vec3(0, h.pow(1.15).mul(RELIEF), 0));

        // Normals from the field's gradient, since the displacement is in the vertex stage only.
        const du = 1 / cols, dv = 1 / rows;
        const hx = heatAt(u.add(du), v).sub(heatAt(u.sub(du), v));
        const hz = heatAt(u, v.add(dv)).sub(heatAt(u, v.sub(dv)));
        const slope = RELIEF / (2 * (w / cols));
        gm.normalNode = transformNormalToView(normalize(vec3(hx.mul(-slope), 1, hz.mul(-slope * (w / cols) / (d / rows)))));

        // Lawn: big patches of two greens, fine speckle, faint mowing stripes.
        const patch = mx_fractal_noise_float(vec3(pxz.mul(0.06), 3.1), 3, 2.0, 0.5).mul(0.5).add(0.5);
        const speck = mx_noise_float(vec3(pxz.mul(3.4), 0.7)).mul(0.5).add(0.5);
        const mow = step(0.5, fract(g.x.mul(0.07))).mul(0.07).add(0.96);
        const grass = mix(color(0x2c5726), color(0x6f9338), patch).mul(speck.mul(0.35).add(0.82)).mul(mow);

        // Paving: the forecourt strip, with joints every 2.5 m.
        const joint = fract(pxz.div(2.5));
        const mortar = step(0.03, joint.x).mul(step(0.03, joint.y));
        const slab = mx_noise_float(vec3(floor(pxz.div(2.5)), 4.2)).mul(0.05);
        const paved = mix(color(0x6d6a64), color(0xa7a197).add(slab), mortar);
        const pavedMask = smoothstep(-12.5, -11.5, g.x).mul(smoothstep(11.5, 12.5, g.x).oneMinus())
            .mul(smoothstep(11.5, 12.5, g.z)).mul(smoothstep(71, 73, g.z).oneMinus());

        // Under the building: dark stone outside the rooms, polished marble inside them.
        const stone = color(0x3b3f46).mul(mx_noise_float(vec3(pxz.mul(0.5), 9.0)).mul(0.25).add(0.9));
        const insideBuilding = smoothstep(14.5, 15.5, g.z).oneMinus();
        let marbleMask = float(0);
        for (const a of marbleAreas) {
            marbleMask = max(marbleMask, box({ x: a.x - a.w / 2, z: a.z - a.d / 2 }, { x: a.x + a.w / 2, z: a.z + a.d / 2 }, pxz));
        }
        marbleMask = marbleMask.mul(insideBuilding);

        let albedo = mix(grass, paved, pavedMask);
        albedo = mix(albedo, stone, insideBuilding);
        albedo = mix(albedo, marbleColor(vec3(g.x, 0, g.z)), marbleMask);
        let rough = mix(grass.r.mul(0.0).add(0.88), mix(float(0.55), float(0.72), mortar), pavedMask);
        rough = mix(rough, float(0.6), insideBuilding);
        rough = mix(rough, mx_fractal_noise_float(vec3(pxz.mul(0.35), 1.0), 2, 2.0, 0.5).mul(0.1).add(0.16), marbleMask);

        // Heat on top: a ramp whose cover grows with the field, glowing where it is hottest.
        const cover = smoothstep(0.04, 0.22, h).mul(0.9);
        const ramp = heatRamp(h);
        albedo = mix(albedo, ramp, cover);
        rough = mix(rough, float(0.45), cover);
        const glow = ramp.mul(smoothstep(0.45, 1.0, h).mul(1.2).add(smoothstep(0.05, 0.4, h).mul(0.35)));

        // The police line: one thin band per sampled position, pulsing in the order it stood there.
        const clock = reducedMotion ? float(0.9) : time;
        let bands = float(0);
        const kept = [];
        for (const p of [...frontPath].filter(q => Number.isFinite(q?.z)).sort((a, b) => a.z - b.z)) {
            if (!kept.length || p.z - kept[kept.length - 1].z >= BAND_GAP) kept.push(p);
        }
        const step_ = Math.max(1, Math.ceil(kept.length / MAX_BANDS));
        for (let i = 0; i < kept.length; i += step_) {
            const { z, t } = kept[i];
            const along = g.z.sub(z).div(0.2);
            const pulse = sin(clock.mul(2.4).sub(t * 9)).mul(0.35).add(0.65);
            bands = bands.add(exp(along.mul(along).negate()).mul(pulse));
        }
        const edgeFade = smoothstep(0, 5, g.x.sub(x0)).mul(smoothstep(0, 5, g.x.negate().add(x0 + w)));
        bands = bands.mul(edgeFade).mul(frontPath.length ? 1 : 0);
        const bandColor = color(0x6fd2ff);
        albedo = mix(albedo, bandColor, bands.clamp(0, 1).mul(0.35));
        const emissive = glow.add(bandColor.mul(bands).mul(1.3));

        gm.colorNode = albedo;
        gm.roughnessNode = rough;
        gm.emissiveNode = emissive;
        gm.metalness = 0.0;

        const scene = new THREE.Scene();
        scene.fog = new THREE.Fog(CLEAR, 220, 460);
        const groundMesh = new THREE.Mesh(ground, gm);
        groundMesh.receiveShadow = true;
        groundMesh.frustumCulled = false;            // displaced in the vertex stage
        scene.add(groundMesh);

        // ── Architecture: one marble material over three instanced meshes ─────────
        const marble = own(marbleMaterial());
        const unit = own(new THREE.BoxGeometry(1, 1, 1));
        unit.translate(0, 0.5, 0);
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3();
        const place = (mesh, i, x, y, z, sx, sy, sz) => {
            mesh.setMatrixAt(i, m4.compose(t.set(x, y, z), q, s.set(sx, sy, sz)));
        };
        const walls = [];
        const thick = 0.45;
        for (const a of marbleAreas) {
            const hw = a.w / 2, hd = a.d / 2;
            walls.push([a.x, a.z - hd, a.w + thick, thick], [a.x, a.z + hd, a.w + thick, thick],
                [a.x - hw, a.z, thick, a.d - thick], [a.x + hw, a.z, thick, a.d - thick]);
        }
        const addInstances = (geometry, list, fit, shadow = true) => {
            if (!list.length) return;
            const mesh = new THREE.InstancedMesh(geometry, marble, list.length);
            list.forEach((item, i) => fit(mesh, i, item));
            mesh.castShadow = shadow;
            mesh.receiveShadow = true;
            mesh.instanceMatrix.needsUpdate = true;
            scene.add(mesh);
        };
        addInstances(unit, walls, (mesh, i, [x, z, sx, sz]) => place(mesh, i, x, PLINTH * 0, z, sx, WALL_HEIGHT, sz));
        const shaft = own(new THREE.CylinderGeometry(0.5, 0.58, 1, 18));
        shaft.translate(0, 0.5, 0);
        addInstances(shaft, columns, (mesh, i, c) => {
            const hgt = Math.min(c.height ?? 6, 9) * 0.32;
            place(mesh, i, c.x, 0, c.z, 1.15, hgt, 1.15);
        });
        addInstances(unit, obstacles, (mesh, i, o) => place(mesh, i, o.x, 0, o.z, o.w, Math.min(o.h ?? 2, 4.5) * 0.7, o.d));

        // ── Light and camera ──────────────────────────────────────────────────
        scene.add(new THREE.HemisphereLight(0xa9c3e6, 0x2b3024, 0.9));
        const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
        sun.position.set(cx - 70, 110, cz + 50);
        sun.target.position.set(cx, 0, cz);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        const reach = Math.hypot(w, d) / 2;
        Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 10, far: 320 });
        sun.shadow.bias = -0.0005;
        sun.shadow.normalBias = 0.3;
        scene.add(sun, sun.target);

        const camera = new THREE.PerspectiveCamera(36, 1, 1, 900);
        const target = new THREE.Vector3(cx, 0, cz - d * 0.02);
        const place3 = elapsed => {
            // A slow sweep rather than a full orbit: the back of the building is not interesting.
            const swing = reducedMotion ? -0.42 : -0.42 + Math.sin(elapsed * 0.1) * 0.55;
            const aspect = camera.aspect;
            const dist = Math.max(d * 0.95, (w * 1.35) / Math.min(1.2, aspect)) * 1.22;
            const elev = 0.82;
            camera.position.set(
                target.x + Math.sin(swing) * Math.cos(elev) * dist,
                Math.sin(elev) * dist,
                target.z + Math.cos(swing) * Math.cos(elev) * dist);
            camera.lookAt(target);
        };

        let width = 0, height = 0;
        const resize = () => {
            const cw = canvas.clientWidth, ch = canvas.clientHeight;
            if (!cw || !ch || (cw === width && ch === height)) return;
            width = cw; height = ch;
            renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
            renderer.setSize(cw, ch, false);
            camera.aspect = cw / ch;
            camera.updateProjectionMatrix();
        };
        resize();

        let onscreen = true;
        const start = performance.now();
        const frame = () => {
            if (disposed) return;
            resize();
            if (!width) return;
            place3(reducedMotion ? 0 : (performance.now() - start) / 1000);
            renderer.render(scene, camera);
        };
        const sync = () => {
            const run = onscreen && !document.hidden && !disposed;
            if (reducedMotion) {
                // Nothing moves, so draw once whenever the view comes back or is resized.
                renderer.setAnimationLoop(null);
                if (run) frame();
            } else {
                renderer.setAnimationLoop(run ? frame : null);
            }
        };

        await renderer.compileAsync(scene, camera);
        if (disposed) { renderer.dispose(); return none; }

        observer = new ResizeObserver(() => { resize(); if (reducedMotion && !disposed) frame(); });
        observer.observe(canvas);
        intersection = new IntersectionObserver(entries => {
            onscreen = entries[entries.length - 1].isIntersecting;
            sync();
        });
        intersection.observe(canvas);
        onVisibility = () => sync();
        document.addEventListener('visibilitychange', onVisibility);
        sync();

        cleanup = () => {
            observer?.disconnect();
            intersection?.disconnect();
            if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
            renderer.setAnimationLoop(null);
            for (const o of owned) o.dispose?.();
            for (const child of scene.children) {
                if (child.isInstancedMesh) child.dispose?.();
            }
            renderer.dispose();
        };

        return {
            backend: gpu ? 'webgpu' : 'webgl2',
            dispose() {
                if (disposed) return;
                disposed = true;
                try { cleanup(); } catch (e) { console.warn('aftermath: dispose failed', e); }
            },
        };
    } catch (e) {
        console.warn('aftermath: map unavailable', e);
        disposed = true;
        try { cleanup(); renderer?.dispose(); } catch { /* the view is optional */ }
        return none;
    }
}
