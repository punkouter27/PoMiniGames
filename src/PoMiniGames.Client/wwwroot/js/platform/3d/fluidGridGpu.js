// platform/3d/fluidGridGpu.js — gas and smoke as a fluid on the GPU, for any 3D game.
//
// The same model as fluidGrid.js (read that first for what the layer is for), run as WebGPU compute
// shaders so the High graphics tier can afford a grid four times as fine and a pressure solve with
// three times the passes. Gas let off in a doorway then pools and bends round the stands with far
// less of the blur that a 1.25 m cell gives it.
//
// The scene still wants the CPU's interface: `bytes` for the haze texture, sample() and flow() for
// the sprites and the crowd. The simulation lives on the GPU and a small ring of staging buffers
// carries the result back a couple of frames late, which nothing minds in something this soft. So
// `step()` never waits: it submits the work, and returns true only on a call after a copy has
// landed, which is when the caller has a new texture to upload.
//
// Everything here resolves to null instead of throwing, so the caller can keep the CPU grid.

import { GAS_LIFE_OUT, GAS_LIFE_IN, WIND_SHARE } from './fluidGrid.js';

/** Pressure passes per step. Even, so the warm-started solution always ends in the first buffer. */
const PRESSURE_PASSES = 24;
/** Room for the one-off injections and the sources of a step, and for the people dragging air. */
const MAX_SOURCES = 32, MAX_MOVERS = 64;
/** Staging buffers in the readback ring; a step that finds none free simply skips its copy. */
const RING = 3;
/** The CPU grid's cell counts: the physics constants below were tuned at this resolution. */
const REF_COLS = 64, REF_ROWS = 120;

const WGSL = /* wgsl */`
struct P {
    cols: u32, rows: u32, nSrc: u32, nMov: u32,
    x0: f32, z0: f32, cw: f32, cd: f32,
    windX: f32, windZ: f32, dt: f32, settle: f32,
    pull: f32, spread: f32, decayOut: f32, decayIn: f32,
    scale: f32, footX: f32, footZ: f32, pad: f32,
};
@group(0) @binding(0) var<uniform> P_: P;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
// Sources first (x, z, amount, r), then the movers at MAX_SOURCES (x, z, vx, vz).
@group(0) @binding(2) var<storage, read> inputs: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> vel: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> dIn: array<f32>;
@group(0) @binding(5) var<storage, read_write> dOut: array<f32>;
@group(0) @binding(6) var<storage, read> pIn: array<f32>;
@group(0) @binding(7) var<storage, read_write> pOut: array<f32>;
@group(0) @binding(8) var<storage, read_write> divg: array<f32>;

const MAX_SOURCES: u32 = ${MAX_SOURCES}u;

fn at(i: i32, j: i32) -> u32 { return u32(j) * P_.cols + u32(i); }
fn within(i: i32, j: i32) -> bool { return i >= 0 && j >= 0 && i < i32(P_.cols) && j < i32(P_.rows); }
fn solidAt(k: u32) -> bool { return (flags[k] & 1u) != 0u; }
fn insideAt(k: u32) -> bool { return (flags[k] & 2u) != 0u; }

// Neighbour values as the CPU's beside(): a wall gives 'wall', past the edge is 'beyond'.
fn besideV(i: i32, j: i32, wall: vec2<f32>, beyond: vec2<f32>) -> vec2<f32> {
    if (!within(i, j)) { return beyond; }
    let k = at(i, j);
    if (solidAt(k)) { return wall; }
    return vel[k];
}
fn besideP(i: i32, j: i32, wall: f32, beyond: f32) -> f32 {
    if (!within(i, j)) { return beyond; }
    let k = at(i, j);
    if (solidAt(k)) { return wall; }
    return pIn[k];
}
fn besideD(i: i32, j: i32, wall: f32, beyond: f32) -> f32 {
    if (!within(i, j)) { return beyond; }
    let k = at(i, j);
    if (solidAt(k)) { return wall; }
    return dIn[k];
}
fn densAt(a: i32, b: i32) -> f32 {
    if (!within(a, b)) { return 0.0; }
    return dIn[at(a, b)];
}

@compute @workgroup_size(8, 8)
fn inject(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P_.cols || g.y >= P_.rows) { return; }
    let i = i32(g.x); let j = i32(g.y);
    let k = at(i, j);
    if (solidAt(k)) { return; }
    var d = dIn[k];
    for (var s = 0u; s < P_.nSrc; s = s + 1u) {
        let src = inputs[s];
        let ci = (src.x - P_.x0) / P_.cw; let cj = (src.y - P_.z0) / P_.cd;
        let ri = max(1.0, src.w / P_.cw); let rj = max(1.0, src.w / P_.cd);
        let a = (f32(i) + 0.5 - ci) / ri; let b = (f32(j) + 0.5 - cj) / rj;
        let q = a * a + b * b;
        if (q < 1.0) { d = min(1.5, d + src.z * (1.0 - q)); }
    }
    dIn[k] = d;
}

@compute @workgroup_size(8, 8)
fn relax(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P_.cols || g.y >= P_.rows) { return; }
    let i = i32(g.x); let j = i32(g.y);
    let k = at(i, j);
    if (solidAt(k)) { vel[k] = vec2<f32>(0.0, 0.0); return; }
    var v = vel[k];
    var t = vec2<f32>(P_.windX, P_.windZ);
    if (insideAt(k)) { t = vec2<f32>(0.0, 0.0); }
    v = v + (t - v) * P_.settle;
    // A person drags the air over the patch the CPU grid's one cell stands for, in step order.
    let px = P_.x0 + (f32(i) + 0.5) * P_.cw; let pz = P_.z0 + (f32(j) + 0.5) * P_.cd;
    for (var m = 0u; m < P_.nMov; m = m + 1u) {
        let mv = inputs[MAX_SOURCES + m];
        if (abs(mv.x - px) <= P_.footX && abs(mv.y - pz) <= P_.footZ) {
            v = v + (mv.zw - v) * P_.pull;
        }
    }
    vel[k] = v;
}

@compute @workgroup_size(8, 8)
fn divergence(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P_.cols || g.y >= P_.rows) { return; }
    let i = i32(g.x); let j = i32(g.y);
    let k = at(i, j);
    if (solidAt(k)) { divg[k] = 0.0; return; }
    let me = vel[k];
    let zero = vec2<f32>(0.0, 0.0);
    let l = besideV(i - 1, j, zero, me); let r = besideV(i + 1, j, zero, me);
    let u = besideV(i, j - 1, zero, me); let b = besideV(i, j + 1, zero, me);
    divg[k] = (r.x - l.x) / (2.0 * P_.cw) + (b.y - u.y) / (2.0 * P_.cd);
}

@compute @workgroup_size(8, 8)
fn jacobi(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P_.cols || g.y >= P_.rows) { return; }
    let i = i32(g.x); let j = i32(g.y);
    let k = at(i, j);
    if (solidAt(k)) { return; }
    let here = pIn[k];
    let sum = besideP(i - 1, j, here, 0.0) + besideP(i + 1, j, here, 0.0)
            + besideP(i, j - 1, here, 0.0) + besideP(i, j + 1, here, 0.0);
    pOut[k] = (sum - divg[k] * P_.scale) / 4.0;
}

@compute @workgroup_size(8, 8)
fn project(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P_.cols || g.y >= P_.rows) { return; }
    let i = i32(g.x); let j = i32(g.y);
    let k = at(i, j);
    if (solidAt(k)) { return; }
    let here = pIn[k];
    let gx = (besideP(i + 1, j, here, 0.0) - besideP(i - 1, j, here, 0.0)) / (2.0 * P_.cw);
    let gz = (besideP(i, j + 1, here, 0.0) - besideP(i, j - 1, here, 0.0)) / (2.0 * P_.cd);
    vel[k] = vel[k] - vec2<f32>(gx, gz);
}

@compute @workgroup_size(8, 8)
fn advect(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P_.cols || g.y >= P_.rows) { return; }
    let i = i32(g.x); let j = i32(g.y);
    let k = at(i, j);
    if (solidAt(k)) { dOut[k] = 0.0; return; }
    let v = vel[k];
    let sx = P_.x0 + (f32(i) + 0.5) * P_.cw - v.x * P_.dt;
    let sz = P_.z0 + (f32(j) + 0.5) * P_.cd - v.y * P_.dt;
    let fx = (sx - P_.x0) / P_.cw - 0.5; let fz = (sz - P_.z0) / P_.cd - 0.5;
    let a = i32(floor(fx)); let b = i32(floor(fz));
    let tx = fx - floor(fx); let tz = fz - floor(fz);
    var value = (densAt(a, b) * (1.0 - tx) + densAt(a + 1, b) * tx) * (1.0 - tz)
              + (densAt(a, b + 1) * (1.0 - tx) + densAt(a + 1, b + 1) * tx) * tz;
    let here = dIn[k];
    let around = besideD(i - 1, j, here, 0.0) + besideD(i + 1, j, here, 0.0)
               + besideD(i, j - 1, here, 0.0) + besideD(i, j + 1, here, 0.0);
    value = value + (around / 4.0 - here) * P_.spread;
    if (insideAt(k)) { value = value * P_.decayIn; } else { value = value * P_.decayOut; }
    if (value < 0.002) { value = 0.0; }
    dOut[k] = value;
}
`;

/** Which of the shared bindings each kernel uses; the auto layout drops the rest. */
const USES = {
    inject: [0, 1, 2, 4],
    relax: [0, 1, 2, 3],
    divergence: [0, 1, 3, 8],
    jacobi: [0, 1, 6, 7, 8],
    project: [0, 1, 3, 6],
    advect: [0, 1, 3, 4, 5],
};

/**
 * @param rect     { x0, z0, w, d }: the ground the grid covers, in world metres
 * @param cols     cells across x
 * @param rows     cells along z
 * @param blocked  (x, z) => true where gas cannot be
 * @param indoors  (x, z) => true where there is no wind
 * @returns the CPU grid's interface plus dispose(), lost() and gpu: true, or null when this
 *          browser or machine cannot run it; it never rejects
 */
export async function createGpuFluidGrid({ x0 = -40, z0 = -56, w = 80, d = 152 } = {}, cols = 128, rows = 240, blocked = () => false, indoors = (x, z) => z < 14.5,
    { lifeOut = GAS_LIFE_OUT, lifeIn = GAS_LIFE_IN, windShare = WIND_SHARE } = {}) {
    let device = null;
    try {
        if (typeof navigator === 'undefined' || !navigator.gpu) return null;
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return null;
        device = await adapter.requestDevice();
        return await build(device, { x0, z0, w, d }, cols, rows, blocked, indoors, { lifeOut, lifeIn, windShare });
    } catch (err) {
        console.warn('GPU fluid grid unavailable:', err);
        try { device?.destroy(); } catch { /* nothing to free */ }
        return null;
    }
}

async function build(device, rect, cols, rows, blocked, indoors, { lifeOut, lifeIn, windShare }) {
    const { x0, z0, w, d } = rect;
    const n = cols * rows, cw = w / cols, cd = d / rows;
    // The CPU grid's cell is the unit its constants were tuned in. Diffusion per step scales with
    // cell area, a person's drag covers a CPU cell's worth of ground, and `mass` counts cells.
    const refCw = w / REF_COLS, refCd = d / REF_ROWS;
    const spreadScale = (cw / refCw) * (cd / refCd);
    const massScale = (REF_COLS * REF_ROWS) / n;

    const flags = new Uint32Array(n);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const x = x0 + (i + 0.5) * cw, z = z0 + (j + 0.5) * cd;
        flags[j * cols + i] = (blocked(x, z) ? 1 : 0) | (indoors(x, z) ? 2 : 0);
    }

    const STORE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const make = (size, usage) => device.createBuffer({ size, usage });
    const flagBuf = make(n * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(flagBuf, 0, flags);
    const uni = make(80, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const inputBuf = make((MAX_SOURCES + MAX_MOVERS) * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const velBuf = make(n * 8, STORE);
    const dens = [make(n * 4, STORE), make(n * 4, STORE)];
    const pres = [make(n * 4, STORE), make(n * 4, STORE)];
    const divBuf = make(n * 4, STORE);
    const all = [flagBuf, uni, inputBuf, velBuf, ...dens, ...pres, divBuf];

    const module = device.createShaderModule({ code: WGSL });
    const pipes = {};
    await Promise.all(Object.keys(USES).map(async (name) => {
        pipes[name] = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: name } });
    }));

    /** A bind group for one kernel, with the buffers it uses as named in `slots`. */
    const group = (name, slots) => device.createBindGroup({
        layout: pipes[name].getBindGroupLayout(0),
        entries: USES[name].map((binding) => ({ binding, resource: { buffer: slots[binding] } })),
    });
    const common = { 0: uni, 1: flagBuf, 2: inputBuf, 3: velBuf, 8: divBuf };
    // Density alternates between its two buffers each step; pressure between them each pass.
    const bind = {
        relax: group('relax', common),
        divergence: group('divergence', common),
        project: group('project', { ...common, 6: pres[0] }),
        jacobi: [group('jacobi', { ...common, 6: pres[0], 7: pres[1] }), group('jacobi', { ...common, 6: pres[1], 7: pres[0] })],
        inject: [0, 1].map((p) => group('inject', { ...common, 4: dens[p] })),
        advect: [0, 1].map((p) => group('advect', { ...common, 4: dens[p], 5: dens[1 - p] })),
    };
    const groupsX = Math.ceil(cols / 8), groupsY = Math.ceil(rows / 8);

    const stagingSize = n * 4 + n * 8;
    const ring = Array.from({ length: RING }, () => ({
        buf: make(stagingSize, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST), busy: false,
    }));

    let dead = false, disposed = false;
    device.lost.then((info) => { dead = true; if (!disposed) console.warn('GPU gas grid device lost:', info?.message); });
    device.addEventListener('uncapturederror', (e) => { dead = true; console.warn('GPU gas grid error:', e.error?.message); });

    // The CPU copy, refreshed from each readback that lands.
    const density = new Float32Array(n), vx = new Float32Array(n), vz = new Float32Array(n);
    const bytes = new Uint8Array(n);
    let mass = 0, fresh = false, epoch = 0, cur = 0;
    let injected = 0, queued = [];
    const uniData = new ArrayBuffer(80), uniU = new Uint32Array(uniData), uniF = new Float32Array(uniData);
    const inputData = new Float32Array((MAX_SOURCES + MAX_MOVERS) * 4);

    const at = (i, j) => j * cols + i;
    const within = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows;
    const open = (i, j) => within(i, j) && !(flags[at(i, j)] & 1);

    /** Density at a world point, 0 where the grid does not reach (from the last copy to land). */
    function sample(x, z) {
        const fx = (x - x0) / cw - 0.5, fz = (z - z0) / cd - 0.5;
        const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
        const get = (a, b) => (a >= 0 && b >= 0 && a < cols && b < rows ? density[at(a, b)] : 0);
        return (get(i, j) * (1 - tx) + get(i + 1, j) * tx) * (1 - tz) + (get(i, j + 1) * (1 - tx) + get(i + 1, j + 1) * tx) * tz;
    }

    /** Queues `amount` of density over a disc of radius `r` metres; it enters on the next step. */
    function inject(x, z, amount, r = 2) {
        if (queued.length >= MAX_SOURCES) return;
        queued.push({ x, z, amount, r });
        mass += amount; injected += amount;
    }

    function land(slot, mine, injectedThen) {
        slot.buf.mapAsync(GPUMapMode.READ).then(() => {
            if (dead || disposed) { slot.busy = false; return; }
            if (mine === epoch) {
                const all32 = new Float32Array(slot.buf.getMappedRange());
                density.set(all32.subarray(0, n));
                let sum = 0;
                for (let k = 0; k < n; k++) {
                    const v = density[k];
                    bytes[k] = Math.min(255, v * 255);
                    vx[k] = all32[n + 2 * k]; vz[k] = all32[n + 2 * k + 1];
                    sum += v;
                }
                // What was let go since this copy was taken is not in it yet.
                mass = sum * 0.001 * massScale + (injected - injectedThen);
                fresh = true;
            }
            slot.buf.unmap();
            slot.busy = false;
        }, () => { slot.busy = false; });
    }

    /**
     * One step of `dt` seconds, submitted without waiting.
     * @param sources  [{ x, z, rate, r }]: density per second being released, and over what radius
     * @param wind     { x, z } in m/s
     * @param movers   [{ x, z, vx, vz }]: people on the move, who drag the air with them
     * @returns true when a new copy landed since the last call, so `bytes` changed
     */
    function step(dt, sources = [], wind = { x: 0, z: 0 }, movers = []) {
        const landed = () => { const f = fresh; fresh = false; return f; };
        if (dead || disposed) return false;
        for (const s of sources) inject(s.x, s.z, (s.rate ?? 1) * dt, s.r ?? 2);
        if (mass < 1e-4) return landed();

        const nSrc = queued.length, nMov = Math.min(MAX_MOVERS, movers.length);
        queued.forEach((s, q) => inputData.set([s.x, s.z, s.amount, s.r], q * 4));
        for (let m = 0; m < nMov; m++) {
            const mv = movers[m];
            inputData.set([mv.x, mv.z, mv.vx ?? 0, mv.vz ?? 0], (MAX_SOURCES + m) * 4);
        }
        queued = [];
        device.queue.writeBuffer(inputBuf, 0, inputData);

        uniU[0] = cols; uniU[1] = rows; uniU[2] = nSrc; uniU[3] = nMov;
        uniF[4] = x0; uniF[5] = z0; uniF[6] = cw; uniF[7] = cd;
        uniF[8] = wind.x * windShare; uniF[9] = wind.z * windShare; uniF[10] = dt;
        uniF[11] = 1 - Math.exp(-dt * 1.5);
        uniF[12] = Math.min(1, dt * 4);
        uniF[13] = Math.min(0.2, dt * 0.55) * spreadScale;
        uniF[14] = Math.exp(-dt / lifeOut); uniF[15] = Math.exp(-dt / lifeIn);
        uniF[16] = cw * cd; uniF[17] = refCw / 2; uniF[18] = refCd / 2;
        device.queue.writeBuffer(uni, 0, uniData);

        const enc = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        const run = (name, bg) => { pass.setPipeline(pipes[name]); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(groupsX, groupsY); };
        if (nSrc) run('inject', bind.inject[cur]);
        run('relax', bind.relax);
        run('divergence', bind.divergence);
        for (let p = 0; p < PRESSURE_PASSES; p++) run('jacobi', bind.jacobi[p & 1]);
        run('project', bind.project);
        run('advect', bind.advect[cur]);
        pass.end();
        cur ^= 1;

        const slot = ring.find((s) => !s.busy);
        if (slot) {
            slot.busy = true;
            enc.copyBufferToBuffer(dens[cur], 0, slot.buf, 0, n * 4);
            enc.copyBufferToBuffer(velBuf, 0, slot.buf, n * 4, n * 8);
        }
        device.queue.submit([enc.finish()]);
        if (slot) land(slot, epoch, injected);
        return landed();
    }

    function reset() {
        epoch++;
        const zeros = new Float32Array(n * 2);
        for (const b of [...dens, ...pres, divBuf]) device.queue.writeBuffer(b, 0, zeros, 0, n);
        device.queue.writeBuffer(velBuf, 0, zeros);
        density.fill(0); vx.fill(0); vz.fill(0); bytes.fill(0);
        mass = 0; queued = []; fresh = false;
    }

    function dispose() {
        disposed = true;
        for (const s of ring) s.buf.destroy();
        for (const b of all) b.destroy();
        device.destroy();
    }

    return {
        rect: { x0, z0, w, d }, cols, rows, bytes, step, inject, sample, reset, dispose, gpu: true,
        /** Whether anything is in the air at all. */
        active: () => mass >= 1e-4,
        /** The air's velocity at a world point, m/s (from the last copy to land). */
        flow(x, z) {
            const i = Math.floor((x - x0) / cw), j = Math.floor((z - z0) / cd);
            return open(i, j) ? { x: vx[at(i, j)], z: vz[at(i, j)] } : { x: 0, z: 0 };
        },
        /** True once the device is gone or errored: the caller should fall back to the CPU grid. */
        lost: () => dead,
    };
}
