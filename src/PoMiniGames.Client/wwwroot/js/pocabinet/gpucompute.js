// pocabinet/gpucompute.js
//
// Opt-in WebGPU compute pipeline & WGSL kernels for PoCabinet (#3 & #10).
// Three r165 + gaussian-splats-3d@0.4.7 keep the main 3D scene on WebGL2, so GPU compute runs
// on a shared WebGPU device when navigator.gpu is enabled ('auto' or 'webgpu' on high tier),
// with automatic non-blocking fallback to WebGL2 / JS stepping when unavailable or disabled.

const WGSL_PARTICLE_STEP = /* wgsl */`
struct Params {
    dt: f32,
    count: u32,
    pad0: u32,
    pad1: u32,
};

// Packed 12 floats (48 bytes) per particle:
// [0..2] pos.xyz, [3] floorY, [4..6] vel.xyz, [7] life, [8] maxLife, [9] s0, [10] s1, [11] a0_drag_grav packed?
// Even simpler and exact: 16 floats (64 bytes, 16-byte aligned!) per particle:
// 0: pos.xyz, life
// 1: vel.xyz, maxLife
// 2: s0, s1, a0, drag
// 3: grav, floorY, sizeOut, alphaOut
struct Particle {
    posLife: vec4<f32>,
    velMax:  vec4<f32>,
    style:   vec4<f32>,
    phys:    vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> compactOut: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= params.count) {
        return;
    }
    var p = particles[i];
    var life = p.posLife.w;
    if (life <= 0.0) {
        p.phys.w = 0.0;
        particles[i] = p;
        compactOut[i] = vec4<f32>(p.posLife.x, p.posLife.y, p.posLife.z, 0.0);
        return;
    }

    let dt = params.dt;
    life = life - dt;
    if (life <= 0.0) {
        p.posLife.w = 0.0;
        p.phys.w = 0.0;
        particles[i] = p;
        compactOut[i] = vec4<f32>(p.posLife.x, p.posLife.y, p.posLife.z, 0.0);
        return;
    }

    let drag = p.style.w;
    let grav = p.phys.x;
    let floorY = p.phys.y;
    let damp = exp(-drag * dt);

    var vel = p.velMax.xyz * damp;
    vel.y = vel.y - grav * dt;

    var pos = p.posLife.xyz + vel * dt;
    if (pos.y < floorY) {
        pos.y = floorY;
        vel.y = -vel.y * 0.3;
    }

    let maxLife = max(1e-4, p.velMax.w);
    let f = clamp(1.0 - life / maxLife, 0.0, 1.0);
    let sizeOut = mix(p.style.x, p.style.y, f);
    let env = select(1.0 - (f - 0.12) / 0.88, f / 0.12, f < 0.12);
    let alphaOut = p.style.z * clamp(env, 0.0, 1.0);

    p.posLife = vec4<f32>(pos, life);
    p.velMax = vec4<f32>(vel, maxLife);
    p.phys.z = sizeOut;
    p.phys.w = alphaOut;
    particles[i] = p;
    // Pack size & alpha cleanly in second half or reconstruct via 2 vec4 if needed; here w stores alpha >= 0 and size encoded:
    compactOut[i] = vec4<f32>(pos, f32(i) * 0.0 + sizeOut);
}
`;

const state = {
    mode: 'auto', // 'auto' | 'webgpu' | 'webgl'
    initPromise: null,
    device: null,
    adapterInfo: null,
    pipeline: null,
    bindLayout: null,
    dispatches: 0,
    failed: false,
};

export function hasWebGpu() {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
}

export function getComputeMode() {
    return state.mode;
}

export function getGpuBackend() {
    if (state.mode === 'webgl' || state.failed) return 'webgl2';
    if (state.device) return 'webgpu';
    return hasWebGpu() ? 'webgpu-pending' : 'webgl2';
}

export function getGpuStats() {
    return {
        mode: state.mode,
        backend: getGpuBackend(),
        ready: !!state.device,
        dispatches: state.dispatches,
        adapter: state.adapterInfo,
    };
}

export async function ensureWebGpuDevice() {
    if (state.mode === 'webgl' || state.failed) return null;
    if (state.device) return state.device;
    if (!hasWebGpu()) {
        state.failed = true;
        return null;
    }
    if (state.initPromise) return state.initPromise;

    state.initPromise = (async () => {
        try {
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter) {
                state.failed = true;
                return null;
            }
            const device = await adapter.requestDevice();
            device.lost.then(() => {
                if (state.device === device) {
                    state.device = null;
                    state.pipeline = null;
                    state.bindLayout = null;
                    state.initPromise = null;
                }
            });
            state.device = device;
            try {
                const info = adapter.info || (await adapter.requestAdapterInfo?.());
                state.adapterInfo = info ? `${info.vendor || ''} ${info.architecture || ''}`.trim() : 'webgpu';
            } catch {
                state.adapterInfo = 'webgpu';
            }
            return device;
        } catch {
            state.failed = true;
            return null;
        } finally {
            state.initPromise = null;
        }
    })();

    return state.initPromise;
}

export function setComputeMode(mode) {
    const m = mode === 'webgpu' || mode === 'webgl' ? mode : 'auto';
    state.mode = m;
    if (m !== 'webgl' && !state.device && !state.failed) {
        void ensureWebGpuDevice();
    }
    return state.mode;
}

function getParticlePipeline(device) {
    if (state.pipeline && state.device === device) return state.pipeline;
    const module = device.createShaderModule({ code: WGSL_PARTICLE_STEP });
    state.bindLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        ],
    });
    state.pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [state.bindLayout] }),
        compute: { module, entryPoint: 'main' },
    });
    return state.pipeline;
}

/**
 * Asynchronous GPU compute particle stepper paired with a Three.js Pool.
 * Non-blocking: dispatches WGSL compute on WebGPU when active on high tier, reading back via
 * double-buffered staging buffers without stalling the render thread; falls back cleanly to CPU/WebGL2.
 */
export class GpuParticleStepper {
    constructor(maxParticles) {
        this.max = maxParticles;
        this.gpuReady = false;
        this.disposed = false;
        this.storageBuf = null;
        this.outBuf = null;
        this.uniformBuf = null;
        this.staging = [null, null];
        this.mapped = [false, false];
        this.writeIdx = 0;
        this.bindGroup = null;
        this.scratch = new Float32Array(maxParticles * 16);
        this.uniformArr = new ArrayBuffer(16);
        this.uniformF32 = new Float32Array(this.uniformArr);
        this.uniformU32 = new Uint32Array(this.uniformArr);
        this.pendingRead = [null, null];
        this.dispatchedEpoch = [null, null];
    }

    initBuffers(device) {
        if (this.disposed || this.storageBuf) return;
        const pipeline = getParticlePipeline(device);
        const bytes = this.max * 16 * 4;
        const outBytes = this.max * 4 * 4;
        this.storageBuf = device.createBuffer({
            size: bytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        this.outBuf = device.createBuffer({
            size: outBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        this.uniformBuf = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        for (let i = 0; i < 2; i++) {
            this.staging[i] = device.createBuffer({
                size: bytes,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            });
        }
        this.bindGroup = device.createBindGroup({
            layout: state.bindLayout,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuf } },
                { binding: 1, resource: { buffer: this.storageBuf } },
                { binding: 2, resource: { buffer: this.outBuf } },
            ],
        });
        this.pipeline = pipeline;
        this.gpuReady = true;
    }

    /**
     * Dispatch WGSL particle kinematics when WebGPU is enabled & active for this quality tier.
     * Applies any completed async readback first and dispatches this frame's step. Returns true if
     * WebGPU handled the dispatch (CPU still keeps live attributes tight via readback or hybrid).
     */
    dispatch(pool, dt) {
        if (this.disposed || state.mode === 'webgl' || state.failed) return false;
        if (!state.device) {
            if (!state.initPromise && hasWebGpu()) void ensureWebGpuDevice();
            return false;
        }
        if (!this.gpuReady) this.initBuffers(state.device);
        if (!this.gpuReady) return false;

        const n = this.max;
        const sc = this.scratch;
        for (let i = 0; i < n; i++) {
            const o = i * 16;
            const k = i * 3;
            sc[o] = pool.pos[k]; sc[o + 1] = pool.pos[k + 1]; sc[o + 2] = pool.pos[k + 2]; sc[o + 3] = pool.life[i];
            sc[o + 4] = pool.vel[k]; sc[o + 5] = pool.vel[k + 1]; sc[o + 6] = pool.vel[k + 2]; sc[o + 7] = pool.maxLife[i];
            sc[o + 8] = pool.s0[i]; sc[o + 9] = pool.s1[i]; sc[o + 10] = pool.a0[i]; sc[o + 11] = pool.drag[i];
            sc[o + 12] = pool.grav[i]; sc[o + 13] = pool.floor[i]; sc[o + 14] = pool.size[i]; sc[o + 15] = pool.alpha[i];
        }

        const device = state.device;
        this.uniformF32[0] = dt;
        this.uniformU32[1] = n;
        device.queue.writeBuffer(this.uniformBuf, 0, this.uniformArr);
        device.queue.writeBuffer(this.storageBuf, 0, sc);

        const slot = this.writeIdx & 1;
        this.writeIdx++;
        if (this.mapped[slot]) return false;

        const enc = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.dispatchWorkgroups(Math.ceil(n / 64));
        pass.end();
        enc.copyBufferToBuffer(this.storageBuf, 0, this.staging[slot], 0, n * 16 * 4);
        device.queue.submit([enc.finish()]);
        state.dispatches++;

        this.mapped[slot] = true;
        const epochSnap = pool.slotEpoch ? new Uint32Array(pool.slotEpoch) : null;
        this.staging[slot].mapAsync(GPUMapMode.READ).then(() => {
            if (this.disposed) {
                this.staging[slot]?.unmap();
                this.mapped[slot] = false;
                return;
            }
            const view = new Float32Array(this.staging[slot].getMappedRange());
            this.pendingRead[slot] = new Float32Array(view);
            this.dispatchedEpoch[slot] = epochSnap;
            this.staging[slot].unmap();
            this.mapped[slot] = false;
        }).catch(() => {
            this.mapped[slot] = false;
        });
        return true;
    }

    /** Drain the freshest GPU-computed particle snapshot into `pool` if available. */
    consumeLatest(pool) {
        const readSlot = this.pendingRead[(this.writeIdx + 1) & 1] ? ((this.writeIdx + 1) & 1) : (this.writeIdx & 1);
        const arr = this.pendingRead[readSlot];
        if (!arr) return false;
        const epochs = this.dispatchedEpoch[readSlot];
        this.pendingRead[0] = null;
        this.pendingRead[1] = null;
        this.dispatchedEpoch[0] = null;
        this.dispatchedEpoch[1] = null;
        const curEpoch = pool.slotEpoch;
        const n = this.max;
        let live = 0;
        for (let i = 0; i < n; i++) {
            if (epochs && curEpoch && epochs[i] !== curEpoch[i]) {
                if (pool.life[i] > 0) live++;
                continue;
            }
            const o = i * 16;
            const life = arr[o + 3];
            pool.life[i] = life;
            if (life <= 0) {
                pool.alpha[i] = 0;
                continue;
            }
            live++;
            const k = i * 3;
            pool.pos[k] = arr[o]; pool.pos[k + 1] = arr[o + 1]; pool.pos[k + 2] = arr[o + 2];
            pool.vel[k] = arr[o + 4]; pool.vel[k + 1] = arr[o + 5]; pool.vel[k + 2] = arr[o + 6];
            pool.size[i] = arr[o + 14];
            pool.alpha[i] = arr[o + 15];
        }
        pool.live = live;
        const a = pool.geom.attributes;
        a.position.needsUpdate = true;
        a.aSize.needsUpdate = true;
        a.aAlpha.needsUpdate = true;
        if (pool.spawned) { a.aColor.needsUpdate = true; a.aSeed.needsUpdate = true; pool.spawned = false; }
        return true;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.gpuReady = false;
        this.storageBuf?.destroy();
        this.outBuf?.destroy();
        this.uniformBuf?.destroy();
        for (const s of this.staging) s?.destroy();
        this.storageBuf = this.outBuf = this.uniformBuf = null;
        this.staging = [null, null];
        this.bindGroup = null;
    }
}
