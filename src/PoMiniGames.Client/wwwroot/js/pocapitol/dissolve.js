// PoCapitol's end-of-attempt dissolve: the last frame comes apart into particles that drift to
// where the crowd stood.
//
// The moment an attempt is completed or failed, index.js calls `startDissolve` straight after the
// frame has been rendered. The WebGL canvas is copied into a small 2D canvas in that same task
// (before the browser presents and clears it), and every pixel of that copy becomes a particle:
// 150 to 220 thousand of them, one per sample of the frame, so at the first instant they draw the
// picture that was there. A WebGPU compute pass then moves them. They peel away from the left
// edge in a sweep, drift on a swirling flow, and are drawn into a heat map of the attempt (the
// same person-seconds grid the report's aftermath map is made from, laid out as the route from
// left to right), their colour turning from the picture's to the heat ramp as they settle. A dark
// backdrop rises behind them as the scene is taken apart and everything fades out by 1.7 s, just
// before the shared end card (1.8 s) takes over.
//
// It is decoration, so it stands down: no WebGPU, reduced motion, the lowest quality tier, a
// hidden tab or the spectator demo (which shows no end card) all skip it. Any failure removes the
// canvas and the GPU buffers and the game carries on.
import { gpuDevice, reducedMotion, qualityTier } from './gpu.js';

const DURATION = 1.7;
const COUNTS = { high: 220000, medium: 150000 };

const common = access => `
struct U {
    time: f32, dt: f32, fade: f32, backdrop: f32,
    res: vec2f, grid: vec2f,        // canvas pixels; particle grid columns and rows
    count: u32, pad0: u32, size: f32, pad1: f32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, ${access}> st: array<vec4f>;      // xy position, zw velocity (0..1 of the canvas)
@group(0) @binding(2) var<storage, read> tgt: array<vec4f>;           // xy where it settles, z heat 0..1
@group(0) @binding(3) var<storage, read> pix: array<u32>;             // the frame's colour, packed rgba8
fn hash(n: u32) -> f32 {
    var x = n * 747796405u + 2891336453u;
    x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
    x = (x >> 22u) ^ x;
    return f32(x) / 4294967295.0;
}
fn homeOf(i: u32) -> vec2f {
    let gx = u32(u.grid.x);
    return (vec2f(f32(i % gx), f32(i / gx)) + 0.5) / u.grid;
}
fn delayOf(i: u32) -> f32 { return (homeOf(i).x * 0.4 + hash(i) * 0.22) * 0.5; }
`;

const COMPUTE = `${common('read_write')}
@compute @workgroup_size(64) fn step(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    if (i >= u.count) { return; }
    let lt = u.time - delayOf(i);
    var s = st[i];
    if (lt >= 0.0) {
        let h = hash(i + 7919u);
        let settle = smoothstep(0.3, 0.8, lt);
        // A swirling flow carries them off; the pull toward the heat map takes over as it grows.
        let flow = vec2f(sin(s.y * 9.0 + u.time * 2.1 + h * 6.28), cos(s.x * 7.0 - u.time * 1.7 + h * 6.28));
        var v = s.zw + (flow * 0.55 * smoothstep(0.0, 0.25, lt) + vec2f(0.03, -0.22) * (1.0 - settle)) * u.dt;
        v += (tgt[i].xy - s.xy) * 15.0 * settle * u.dt;
        v *= 1.0 / (1.0 + u.dt * (1.2 + 6.5 * settle));
        s = vec4f(s.xy + v * u.dt, v);
        st[i] = s;
    }
}
`;

const DRAW = `${common('read')}
struct V { @builtin(position) pos: vec4f, @location(0) col: vec4f };
fn ramp(h: f32) -> vec3f {
    var c = mix(vec3f(0.16, 0.04, 0.32), vec3f(0.54, 0.11, 0.44), smoothstep(0.0, 0.28, h));
    c = mix(c, vec3f(0.85, 0.26, 0.18), smoothstep(0.22, 0.52, h));
    c = mix(c, vec3f(0.98, 0.61, 0.08), smoothstep(0.48, 0.78, h));
    return mix(c, vec3f(1.0, 0.95, 0.63), smoothstep(0.74, 1.0, h));
}
@vertex fn vs(@builtin(vertex_index) vi: u32) -> V {
    let i = vi / 6u; let k = vi % 6u;
    var corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
    let s = st[i];
    let heat = tgt[i].z;
    let m = smoothstep(0.45, 1.25, u.time - delayOf(i));
    let px = unpack4x8unorm(pix[i]).rgb;
    let rgb = mix(px, ramp(heat), m);
    let a = mix(1.0, 0.3 + 0.5 * heat, m) * u.fade;
    // The sample is as big as its share of the frame at first, then shrinks to a mote.
    let size = u.size * mix(1.0, 0.5 + 0.5 * heat, m);
    let ndc = vec2f(s.x * 2.0 - 1.0, 1.0 - s.y * 2.0) + corners[k] * 0.5 * size / u.res * 2.0;
    return V(vec4f(ndc, 0.0, 1.0), vec4f(rgb * a, a));
}
@fragment fn fs(v: V) -> @location(0) vec4f { return v.col; }
`;

/**
 * Capture the frame now and play the dissolve over it.
 *
 * @param {{ source: HTMLCanvasElement, host: HTMLElement, heat: { data: ArrayLike<number>, cols: number, rows: number },
 *           demo?: boolean }} o `source` is the game's canvas, just rendered; `host` is the scene
 *           element the effect's canvas is put in (above the scene, below the menus and cards).
 * @returns {null | { dispose(): void }} null when it is skipped
 */
export function startDissolve({ source, host, heat, demo = false }) {
    const tier = qualityTier();
    const count = COUNTS[tier];
    if (demo || !count || !navigator.gpu || reducedMotion() || document.hidden || !source?.width || !host) return null;

    // The frame, taken at once and sized to one pixel per particle.
    let pixels, gw, gh;
    try {
        gw = Math.round(Math.sqrt(count * source.width / source.height));
        gh = Math.round(count / gw);
        const grab = document.createElement('canvas');
        grab.width = gw; grab.height = gh;
        const g2 = grab.getContext('2d', { willReadFrequently: true });
        g2.drawImage(source, 0, 0, gw, gh);
        pixels = new Uint32Array(g2.getImageData(0, 0, gw, gh).data.buffer.slice(0));
    } catch (error) {
        console.warn('[PoCapitol] dissolve could not capture the frame:', error);
        return null;
    }
    const n = gw * gh;

    // Where they settle: the route laid out left to right, drawn from the heat grid by its CDF.
    const { cols, rows } = heat;
    const cdf = new Float64Array(cols * rows);
    let total = 0, peak = 0;
    for (let i = 0; i < cdf.length; i++) {
        const v = Math.max(0, +heat.data[i] || 0);
        total += v; cdf[i] = total; if (v > peak) peak = v;
    }
    const box = source.width / source.height;
    const mapW = Math.min(0.86, 1.5 / box), mapH = mapW * box / 1.9;   // the route is 1.9 times as long as it is wide
    const targets = new Float32Array(n * 4), start = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
        let cell, hot = 0;
        if (total > 0) {
            const r = Math.random() * total;
            let lo = 0, hi = cdf.length - 1;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
            cell = lo; hot = Math.sqrt(Math.max(0, +heat.data[cell]) / peak);
        } else cell = Math.floor(Math.random() * cdf.length);
        // Route z runs across the screen, x down it. Each cell is jittered and softened a little.
        const cx = (cell % cols + Math.random()) / cols, cz = (Math.floor(cell / cols) + Math.random()) / rows;
        const soft = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.004;
        targets[i * 4] = 0.5 + (cz - 0.5) * mapW + soft();
        targets[i * 4 + 1] = 0.5 + (cx - 0.5) * mapH + soft();
        targets[i * 4 + 2] = hot;
        start[i * 4] = ((i % gw) + 0.5) / gw; start[i * 4 + 1] = (Math.floor(i / gw) + 0.5) / gh;
    }

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.pcDissolve = '1';
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(2, Math.round(host.clientWidth * dpr)); canvas.height = Math.max(2, Math.round(host.clientHeight * dpr));
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '2' });

    let disposed = false, raf = 0, resources = [];
    function dispose() {
        if (disposed) return;
        disposed = true;
        if (raf) cancelAnimationFrame(raf);
        canvas.remove();
        try { for (const r of resources) r.destroy?.(); } catch { /* device gone */ }
        resources = [];
    }

    (async () => {
        const device = await gpuDevice();
        if (!device || disposed) { dispose(); return; }
        const context = canvas.getContext('webgpu');
        if (!context) { dispose(); return; }
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: 'premultiplied' });
        const compute = device.createShaderModule({ code: COMPUTE }), draw = device.createShaderModule({ code: DRAW });
        for (const m of [compute, draw]) {
            const bad = (await m.getCompilationInfo()).messages.find(x => x.type === 'error');
            if (bad) throw new Error(`WGSL: ${bad.message} (line ${bad.lineNum})`);
        }
        if (disposed) return;
        const buffer = (size, usage, data) => {
            const b = device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
            if (data) device.queue.writeBuffer(b, 0, data);
            resources.push(b); return b;
        };
        const uniform = buffer(48, GPUBufferUsage.UNIFORM);
        const state = buffer(n * 16, GPUBufferUsage.STORAGE, start);
        const tgt = buffer(n * 16, GPUBufferUsage.STORAGE, targets);
        const pix = buffer(n * 4, GPUBufferUsage.STORAGE, pixels);
        const entries = [uniform, state, tgt, pix].map((b, binding) => ({ binding, resource: { buffer: b } }));
        const S = GPUShaderStage;
        const layout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S.COMPUTE | S.VERTEX, buffer: { type: 'uniform' } },
            { binding: 1, visibility: S.COMPUTE, buffer: { type: 'storage' } },
            { binding: 2, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
        ] });
        const drawLayout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S.VERTEX, buffer: { type: 'uniform' } },
            { binding: 1, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
        ] });
        const stepPipe = device.createComputePipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module: compute, entryPoint: 'step' } });
        const drawPipe = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [drawLayout] }),
            vertex: { module: draw, entryPoint: 'vs' },
            fragment: { module: draw, entryPoint: 'fs', targets: [{ format, blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
            primitive: { topology: 'triangle-list' },
        });
        const computeBind = device.createBindGroup({ layout, entries });
        const drawBind = device.createBindGroup({ layout: drawLayout, entries });
        const head = new Float32Array(12), headU = new Uint32Array(head.buffer);
        const cell = Math.max(canvas.width / gw, canvas.height / gh) * 1.15;
        head[4] = canvas.width; head[5] = canvas.height; head[6] = gw; head[7] = gh; headU[8] = n; head[10] = cell;

        host.append(canvas);
        device.lost.then(dispose);
        let t = 0, last = performance.now();
        const frame = now => {
            raf = 0;
            if (disposed) return;
            try {
                const dt = Math.min(0.033, Math.max(0.001, (now - last) / 1000));
                last = now; t += dt;
                if (t >= DURATION) { dispose(); return; }
                const out = 1 - Math.min(1, Math.max(0, (t - 1.1) / 0.55)), rise = Math.min(1, t / 0.6);
                head[0] = t; head[1] = dt; head[2] = out * out * (3 - 2 * out);
                head[3] = 0.82 * rise * rise * (3 - 2 * rise) * head[2];
                device.queue.writeBuffer(uniform, 0, head);
                const enc = device.createCommandEncoder();
                const pass = enc.beginComputePass();
                pass.setPipeline(stepPipe); pass.setBindGroup(0, computeBind); pass.dispatchWorkgroups(Math.ceil(n / 64));
                pass.end();
                const bd = head[3];
                const render = enc.beginRenderPass({ colorAttachments: [{
                    view: context.getCurrentTexture().createView(),
                    clearValue: { r: 0.02 * bd, g: 0.03 * bd, b: 0.05 * bd, a: bd }, loadOp: 'clear', storeOp: 'store' }] });
                render.setPipeline(drawPipe); render.setBindGroup(0, drawBind); render.draw(6 * n);
                render.end();
                device.queue.submit([enc.finish()]);
                raf = requestAnimationFrame(frame);
            } catch (error) {
                console.warn('[PoCapitol] dissolve stopped:', error);
                dispose();
            }
        };
        raf = requestAnimationFrame(frame);
    })().catch(error => { console.warn('[PoCapitol] dissolve unavailable:', error?.message ?? error); dispose(); });

    return { dispose };
}
