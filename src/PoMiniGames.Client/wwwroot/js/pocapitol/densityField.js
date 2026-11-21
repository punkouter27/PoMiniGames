// The crowd-pressure field behind the density overlay: people per square metre, smoothed, as a
// texture the overlay's sheet raises into terrain, draws contour lines on and sends crush ripples
// across (overlay.js).
//
// On WebGPU a compute pass does the work. The crowd's positions are written to a storage buffer;
// one dispatch splats them into a fixed-point grid with atomics (bilinear, the same kernel
// analysis.js uses for its 4 Hz grid), one converts it to people/m², and four dispatches of a
// 3x3 binomial blur round it into hills. The result is copied to a mappable buffer and read back
// asynchronously, a few frames apart: the frame never waits for it, and the sheet simply keeps
// the last field it has until the next one lands.
//
// Where there is no WebGPU (or on the lowest quality tier) the same field is made on the CPU
// from the grid analysis.js has already built, with the same blur. The grid is 64 x 122 cells, so
// either path costs a fraction of a millisecond. Whichever produced it, the displayed field eases
// toward the newest one so terrain rises and settles rather than jumping at 4 Hz.
//
// Crush ripples: `sources` lists up to six crush-risk cells (analysis.js's risk flag), the most
// packed first and kept apart, for the sheet to send rings out from.
import * as THREE from 'three-eco/webgpu';
import { CROWD_SIZE } from './world.js';
import { gpuDevice, reducedMotion, qualityTier } from './gpu.js';

const EVERY = 4;                 // frames between field updates
const FIXED = 4096;              // fixed-point scale for the atomic splat
const MAX_SOURCES = 6, SOURCE_GAP = 5;   // cells

function blurKernel(name, from, to) {
    return `
@compute @workgroup_size(64) fn ${name}(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x; let cols = i32(u.cols); let rows = i32(u.rows);
    if (i >= u.cols * u.rows) { return; }
    let x = i32(i) % cols; let z = i32(i) / cols;
    var sum = 0.0;
    for (var dz = -1; dz <= 1; dz++) {
        for (var dx = -1; dx <= 1; dx++) {
            let xx = clamp(x + dx, 0, cols - 1); let zz = clamp(z + dz, 0, rows - 1);
            let w = f32((2 - abs(dx)) * (2 - abs(dz))) / 16.0;
            sum += ${from}[u32(zz * cols + xx)] * w;
        }
    }
    ${to}[i] = sum;
}`;
}

const WGSL = `
struct U { cols: u32, rows: u32, n: u32, pad: u32, x0: f32, z0: f32, cell: f32, scale: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> pts: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> acc: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> fa: array<f32>;
@group(0) @binding(4) var<storage, read_write> fb: array<f32>;

@compute @workgroup_size(64) fn clear(@builtin(global_invocation_id) id: vec3u) {
    if (id.x < u.cols * u.rows) { atomicStore(&acc[id.x], 0u); }
}
fn put(ix: i32, iz: i32, w: f32) {
    if (ix < 0 || iz < 0 || ix >= i32(u.cols) || iz >= i32(u.rows)) { return; }
    atomicAdd(&acc[u32(iz) * u.cols + u32(ix)], u32(w * ${FIXED}.0 + 0.5));
}
@compute @workgroup_size(64) fn splat(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= u.n) { return; }
    let p = pts[id.x];
    let fx = (p.x - u.x0) / u.cell - 0.5; let fz = (p.y - u.z0) / u.cell - 0.5;
    let ix = i32(floor(fx)); let iz = i32(floor(fz));
    let tx = fx - floor(fx); let tz = fz - floor(fz);
    put(ix, iz, (1.0 - tx) * (1.0 - tz)); put(ix + 1, iz, tx * (1.0 - tz));
    put(ix, iz + 1, (1.0 - tx) * tz);     put(ix + 1, iz + 1, tx * tz);
}
@compute @workgroup_size(64) fn resolve(@builtin(global_invocation_id) id: vec3u) {
    if (id.x < u.cols * u.rows) { fa[id.x] = f32(atomicLoad(&acc[id.x])) / ${FIXED}.0 * u.scale; }
}
${blurKernel('blurAB', 'fa', 'fb')}
${blurKernel('blurBA', 'fb', 'fa')}
`;

/** 3x3 binomial blur, `passes` times (an even number), on the CPU. */
function blurCpu(source, cols, rows, passes, scratch) {
    let a = scratch[0], b = scratch[1];
    a.set(source);
    for (let p = 0; p < passes; p++) {
        for (let z = 0; z < rows; z++) {
            const z0 = Math.max(0, z - 1) * cols, z1 = z * cols, z2 = Math.min(rows - 1, z + 1) * cols;
            for (let x = 0; x < cols; x++) {
                const xl = Math.max(0, x - 1), xr = Math.min(cols - 1, x + 1);
                b[z1 + x] = (a[z0 + xl] + 2 * a[z0 + x] + a[z0 + xr] + 2 * (a[z1 + xl] + 2 * a[z1 + x] + a[z1 + xr]) + a[z2 + xl] + 2 * a[z2 + x] + a[z2 + xr]) / 16;
            }
        }
        [a, b] = [b, a];
    }
    return a;
}

export function createDensityField({ cols, rows, x0, z0, cell }) {
    const n = cols * rows, area = cell * cell;
    const target = new Float32Array(n), shown = new Float32Array(n);
    const scratch = [new Float32Array(n), new Float32Array(n)];
    const half = new Uint16Array(n);
    const texture = new THREE.DataTexture(half, cols, rows, THREE.RedFormat, THREE.HalfFloatType);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const sources = [];
    let frame = 0, primed = false, disposed = false, gpu = null, gpuTried = false, failures = 0, backend = 'cpu';

    // ------------------------------------------------------------ the compute path
    async function initGpu() {
        gpuTried = true;
        try {
            const device = await gpuDevice();
            if (!device || disposed) return;
            const module = device.createShaderModule({ code: WGSL });
            const info = await module.getCompilationInfo();
            const bad = info.messages.find(m => m.type === 'error');
            if (bad) throw new Error(`WGSL: ${bad.message} (line ${bad.lineNum})`);
            const S = GPUShaderStage.COMPUTE;
            const layout = device.createBindGroupLayout({ entries: [
                { binding: 0, visibility: S, buffer: { type: 'uniform' } },
                { binding: 1, visibility: S, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: S, buffer: { type: 'storage' } },
                { binding: 3, visibility: S, buffer: { type: 'storage' } },
                { binding: 4, visibility: S, buffer: { type: 'storage' } },
            ] });
            const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
            const pipe = entryPoint => device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
            const pipes = { clear: pipe('clear'), splat: pipe('splat'), resolve: pipe('resolve'), ab: pipe('blurAB'), ba: pipe('blurBA') };
            const buf = (size, usage) => device.createBuffer({ size, usage });
            const uniform = buf(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
            const points = buf(CROWD_SIZE * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
            const acc = buf(n * 4, GPUBufferUsage.STORAGE);
            const fa = buf(n * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
            const fb = buf(n * 4, GPUBufferUsage.STORAGE);
            const readback = buf(n * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
            const bind = device.createBindGroup({ layout, entries: [uniform, points, acc, fa, fb].map((buffer, binding) => ({ binding, resource: { buffer } })) });
            const head = new ArrayBuffer(32), headU = new Uint32Array(head), headF = new Float32Array(head);
            headU[0] = cols; headU[1] = rows;
            headF[4] = x0; headF[5] = z0; headF[6] = cell; headF[7] = 1 / area;
            const xz = new Float32Array(CROWD_SIZE * 2);
            let busy = false;
            gpu = {
                dispose() { for (const b of [uniform, points, acc, fa, fb, readback]) b.destroy(); },
                /** Splat the crowd and blur it; returns false while the last read-back is still in flight. */
                run(people) {
                    if (busy) return false;
                    let count = 0;
                    for (const c of people) {
                        if (c.health <= 0 || count >= CROWD_SIZE) continue;
                        xz[count * 2] = c.x; xz[count * 2 + 1] = c.z; count++;
                    }
                    headU[2] = count;
                    device.queue.writeBuffer(uniform, 0, head);
                    if (count) device.queue.writeBuffer(points, 0, xz, 0, count * 2);
                    const enc = device.createCommandEncoder();
                    const pass = enc.beginComputePass();
                    pass.setBindGroup(0, bind);
                    const groups = Math.ceil(n / 64);
                    pass.setPipeline(pipes.clear); pass.dispatchWorkgroups(groups);
                    if (count) { pass.setPipeline(pipes.splat); pass.dispatchWorkgroups(Math.ceil(count / 64)); }
                    pass.setPipeline(pipes.resolve); pass.dispatchWorkgroups(groups);
                    for (let i = 0; i < 2; i++) {
                        pass.setPipeline(pipes.ab); pass.dispatchWorkgroups(groups);
                        pass.setPipeline(pipes.ba); pass.dispatchWorkgroups(groups);
                    }
                    pass.end();
                    enc.copyBufferToBuffer(fa, 0, readback, 0, n * 4);
                    device.queue.submit([enc.finish()]);
                    busy = true;
                    readback.mapAsync(GPUMapMode.READ).then(() => {
                        if (!disposed) target.set(new Float32Array(readback.getMappedRange()));
                        readback.unmap();
                        primed = true; failures = 0;
                    }).catch(() => { if (++failures > 3) failMode('read-back failed'); })
                        .finally(() => { busy = false; });
                    return true;
                },
            };
            device.lost.then(() => failMode('device lost'));
            backend = 'webgpu';
        } catch (error) {
            console.warn('[PoCapitol] density compute unavailable, using the CPU field:', error?.message ?? error);
            gpu = null;
        }
    }
    function failMode(why) {
        if (gpu) console.warn('[PoCapitol] density compute stopped:', why);
        try { gpu?.dispose(); } catch { /* already gone */ }
        gpu = null; backend = 'cpu'; gpuTried = true;
    }

    // ------------------------------------------------------------ sources of crush ripples
    function findSources(analysis) {
        sources.length = 0;
        if (!analysis?.risk) return;
        const cand = [];
        for (let i = 0; i < n; i++) if (analysis.risk[i]) cand.push(i);
        cand.sort((a, b) => analysis.density[b] - analysis.density[a]);
        for (const i of cand) {
            const cx = i % cols, cz = (i / cols) | 0;
            if (sources.some(s => Math.hypot(s.cx - cx, s.cz - cz) < SOURCE_GAP)) continue;
            sources.push({ cx, cz, x: x0 + (cx + 0.5) * cell, z: z0 + (cz + 0.5) * cell });
            if (sources.length >= MAX_SOURCES) break;
        }
    }

    return {
        texture, sources,
        backend: () => backend,
        /**
         * Call every frame the sheet is up. `state` has the people, `analysis` the grid analysis.js
         * keeps, `dt` is the frame's seconds.
         */
        update(state, analysis, dt) {
            if (disposed) return;
            try {
                const low = qualityTier() === 'low';
                if (!gpuTried && !low && navigator.gpu) initGpu();
                if (frame++ % EVERY === 0) {
                    let issued = false;
                    if (gpu && !low) issued = gpu.run(state?.companions ?? []);
                    if (!gpu && analysis?.density) {
                        target.set(blurCpu(analysis.density, cols, rows, 2, scratch));
                        primed = true;
                    }
                    if (issued || !gpu) findSources(analysis);
                }
                if (!primed) return;
                // Ease toward the newest field; reduced motion takes it as it comes.
                const k = reducedMotion() ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * 9);
                let moved = false;
                for (let i = 0; i < n; i++) {
                    const d = target[i] - shown[i];
                    if (d > 0.002 || d < -0.002) { shown[i] += d * k; moved = true; } else if (d !== 0) { shown[i] = target[i]; moved = true; }
                }
                if (moved) {
                    for (let i = 0; i < n; i++) half[i] = THREE.DataUtils.toHalfFloat(shown[i]);
                    texture.needsUpdate = true;
                }
            } catch (error) {
                if (!disposed && ++failures < 4) console.warn('[PoCapitol] density field failed:', error);
                else failMode('repeated errors');
            }
        },
        dispose() {
            disposed = true;
            try { gpu?.dispose(); } catch { /* device already gone */ }
            gpu = null;
            texture.dispose();
        },
    };
}
