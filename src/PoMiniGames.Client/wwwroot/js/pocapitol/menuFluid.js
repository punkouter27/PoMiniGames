// PoCapitol's menu fluid: a real stable-fluids solver on WebGPU, drawn behind the menus.
//
// It replaces the fake domain-warped fluid in ui.js's WebGL2 shader where WebGPU exists. The
// solver is Jos Stam's: forces are added to a velocity field, the field is advected along itself
// (semi-Lagrangian), made divergence-free by a pressure solve (20 Jacobi iterations) and
// subtracted of the pressure gradient, and a dye field is carried along by the result. All of it
// is WGSL compute over storage buffers on a 192 x 108 grid; a render pass then draws the dye as
// a thin gold liquid, with a little chromatic dispersion and a specular glint from its slope.
//
//   presses    a button press shoves a jet out of the press point, away from the menu's centre,
//              with a vortex and a puff of dye (ui.js calls `splash`)
//   cursor     moving the pointer over the menu stirs it
//   the rim    the menu panel is a rounded box in the solver's frame: a force draws the fluid
//              toward its edge and swirls it round it, and dye is fed in there, so the dye pools
//              and flows along the rim the way the old shader's rim light traced it
//
// The canvas is half the page's resolution (soft light does not need more) and the loop runs only
// while a menu is up or still fading. The screen wipes stay in ui.js's WebGL canvas; this only
// replaces the fluid. `createMenuFluid` resolves to null when there is no WebGPU, and `alive()`
// turns false if the device is lost or a frame throws, so ui.js falls back to the old shader.
import { gpuDevice } from './gpu.js';

const GX = 192, GY = 108, JACOBI = 20, MAX_SPLATS = 8;

const bilinear = (name, buf, type) => `
fn ${name}(p: vec2f) -> ${type} {
    let q = p - 0.5; let i = vec2i(floor(q)); let f = fract(q);
    return mix(mix(${buf}[idx(i.x, i.y)], ${buf}[idx(i.x + 1, i.y)], f.x),
               mix(${buf}[idx(i.x, i.y + 1)], ${buf}[idx(i.x + 1, i.y + 1)], f.x), f.y);
}`;

const COMMON = `
struct U {
    res: vec2f, dt: f32, time: f32,
    panel: vec4f,           // centre.xy, half-size.xy of the menu, in 0..1 of the canvas
    p: vec4f,               // splat count, on (0..1), aspect (width / height), 0
    sp: array<vec4f, ${MAX_SPLATS}>,   // xy position, zw force in cells/s
    si: array<vec4f, ${MAX_SPLATS}>,   // x radius, y dye, z kind (0 push, 1 swirl)
};
const GX: i32 = ${GX}; const GY: i32 = ${GY};
@group(0) @binding(0) var<uniform> u: U;
fn idx(x: i32, y: i32) -> u32 { return u32(clamp(y, 0, GY - 1) * GX + clamp(x, 0, GX - 1)); }
`;

const SIM = `${COMMON}
@group(0) @binding(1) var<storage, read_write> velA: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> velB: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> prA: array<f32>;
@group(0) @binding(4) var<storage, read_write> prB: array<f32>;
@group(0) @binding(5) var<storage, read_write> divf: array<f32>;
@group(0) @binding(6) var<storage, read_write> dyeA: array<f32>;
@group(0) @binding(7) var<storage, read_write> dyeB: array<f32>;
${bilinear('bilVel', 'velA', 'vec2f')}
${bilinear('bilDye', 'dyeA', 'f32')}

fn inside(id: vec3u) -> bool { return i32(id.x) < GX && i32(id.y) < GY; }
fn cellOf(id: vec3u) -> u32 { return id.y * u32(GX) + id.x; }

// Signed distance to the menu panel in an aspect-corrected frame (rounded box).
fn panelSd(uv: vec2f) -> f32 {
    let a = vec2f(u.p.z, 1.0);
    let q = abs((uv - u.panel.xy) * a) - u.panel.zw * a + 0.012;
    return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - 0.012;
}

@compute @workgroup_size(8, 8) fn forces(@builtin(global_invocation_id) id: vec3u) {
    if (!inside(id)) { return; }
    let c = cellOf(id);
    let uv = (vec2f(id.xy) + 0.5) / vec2f(f32(GX), f32(GY));
    var v = velA[c];
    var dye = dyeA[c];
    let n = i32(u.p.x);
    for (var k = 0; k < n; k++) {
        var d = uv - u.sp[k].xy; d.x *= u.p.z;
        let g = exp(-dot(d, d) / (u.si[k].x * u.si[k].x));
        if (u.si[k].z < 0.5) { v += u.sp[k].zw * g; }
        else { v += vec2f(-d.y, d.x) / max(length(d), 0.004) * u.sp[k].z * g; }
        dye += u.si[k].y * g;
    }
    // The rim: draw toward the panel's edge, swirl round it, feed dye in along it.
    let sd = panelSd(uv);
    let e = 0.004;
    let grad = normalize(vec2f(panelSd(uv + vec2f(e, 0.0)) - panelSd(uv - vec2f(e, 0.0)),
                               panelSd(uv + vec2f(0.0, e)) - panelSd(uv - vec2f(0.0, e))) + 1e-5);
    let near = exp(-(sd * sd) / 0.01);
    v += (-grad * sd * 260.0 * near + vec2f(-grad.y, grad.x) * 14.0 * exp(-(sd * sd) / 0.0025)) * u.dt * u.p.y;
    let along = atan2((uv.y - u.panel.y), (uv.x - u.panel.x) * u.p.z);
    let feed = 0.55 + 0.45 * sin(along * 3.0 + u.time * 0.7) * sin(along * 5.0 - u.time * 0.4);
    dye += u.p.y * 0.8 * u.dt * exp(-(sd * sd) / 0.000324) * feed;
    // Walls are still, and a little drag keeps it calm.
    if (id.x == 0u || id.y == 0u || id.x == u32(GX) - 1u || id.y == u32(GY) - 1u) { v = vec2f(0.0); }
    v = clamp(v / (1.0 + u.dt * 0.9), vec2f(-160.0), vec2f(160.0));
    velA[c] = v;
    dyeA[c] = min(dye, 2.0);
}
@compute @workgroup_size(8, 8) fn advectVel(@builtin(global_invocation_id) id: vec3u) {
    if (!inside(id)) { return; }
    let c = cellOf(id);
    velB[c] = bilVel(vec2f(id.xy) + 0.5 - u.dt * velA[c]);
}
@compute @workgroup_size(8, 8) fn divergence(@builtin(global_invocation_id) id: vec3u) {
    if (!inside(id)) { return; }
    let x = i32(id.x); let y = i32(id.y);
    divf[cellOf(id)] = 0.5 * (velB[idx(x + 1, y)].x - velB[idx(x - 1, y)].x + velB[idx(x, y + 1)].y - velB[idx(x, y - 1)].y);
    prA[cellOf(id)] = 0.0;
}
@compute @workgroup_size(8, 8) fn jacobiAB(@builtin(global_invocation_id) id: vec3u) {
    if (!inside(id)) { return; }
    let x = i32(id.x); let y = i32(id.y);
    prB[cellOf(id)] = (prA[idx(x - 1, y)] + prA[idx(x + 1, y)] + prA[idx(x, y - 1)] + prA[idx(x, y + 1)] - divf[cellOf(id)]) * 0.25;
}
@compute @workgroup_size(8, 8) fn jacobiBA(@builtin(global_invocation_id) id: vec3u) {
    if (!inside(id)) { return; }
    let x = i32(id.x); let y = i32(id.y);
    prA[cellOf(id)] = (prB[idx(x - 1, y)] + prB[idx(x + 1, y)] + prB[idx(x, y - 1)] + prB[idx(x, y + 1)] - divf[cellOf(id)]) * 0.25;
}
@compute @workgroup_size(8, 8) fn project(@builtin(global_invocation_id) id: vec3u) {
    if (!inside(id)) { return; }
    let x = i32(id.x); let y = i32(id.y);
    velA[cellOf(id)] = velB[cellOf(id)] - 0.5 * vec2f(prA[idx(x + 1, y)] - prA[idx(x - 1, y)], prA[idx(x, y + 1)] - prA[idx(x, y - 1)]);
}
@compute @workgroup_size(8, 8) fn advectDye(@builtin(global_invocation_id) id: vec3u) {
    if (!inside(id)) { return; }
    let c = cellOf(id);
    dyeB[c] = bilDye(vec2f(id.xy) + 0.5 - u.dt * velA[c]) * exp(-u.dt * 0.32);
}
@compute @workgroup_size(8, 8) fn copyDye(@builtin(global_invocation_id) id: vec3u) {
    if (!inside(id)) { return; }
    dyeA[cellOf(id)] = dyeB[cellOf(id)];
}
`;

const DRAW = `${COMMON}
@group(0) @binding(1) var<storage, read> dye: array<f32>;
${bilinear('bilDye', 'dye', 'f32')}
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return V(vec4f(p * 2.0 - 1.0, 0.0, 1.0), vec2f(p.x, 1.0 - p.y));
}
@fragment fn fs(v: V) -> @location(0) vec4f {
    let cell = v.uv * vec2f(f32(GX), f32(GY));
    let d = bilDye(cell);
    let gx = bilDye(cell + vec2f(1.5, 0.0)) - bilDye(cell - vec2f(1.5, 0.0));
    let gy = bilDye(cell + vec2f(0.0, 1.5)) - bilDye(cell - vec2f(0.0, 1.5));
    let g = vec2f(gx, gy);
    // Three samples bent by slightly different amounts: red, green and blue part company at edges.
    let dr = bilDye(cell + g * 0.9);
    let db = bilDye(cell - g * 0.9);
    let nrm = normalize(vec3f(-g * 1.6, 1.0));
    let spec = pow(max(dot(nrm, normalize(vec3f(-0.45, 0.55, 0.7))), 0.0), 18.0) * clamp(length(g) * 2.0, 0.0, 1.0);
    let tint = vec3f(0.95, 0.78, 0.46);
    var rgb = vec3f(dr, d, db) * tint * 0.7 + spec * vec3f(1.0, 0.92, 0.75) * 0.8;
    rgb = 1.0 - exp(-rgb * 1.5);
    let a = clamp(max(max(dr, d), db) * 0.45 + spec * 0.45, 0.0, 0.75);
    return vec4f(rgb * u.p.y, a * u.p.y);
}
`;

/**
 * @param {HTMLElement} root the element the menus live in; the canvas goes in it, behind them
 * @param {{ panel: () => (Element | null), onLost?: () => void }} o
 * @returns {Promise<null | { canvas: HTMLCanvasElement, wake(): void, splash(x: number, y: number, strength?: number): void, alive(): boolean, dispose(): void }>}
 */
export async function createMenuFluid(root, { panel, onLost }) {
    const device = await gpuDevice();
    if (!device) return null;
    let canvas = null, context = null, disposed = false, dead = false, running = 0;
    try {
        canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '1' });
        context = canvas.getContext('webgpu');
        if (!context) return null;
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: 'premultiplied' });

        const simModule = device.createShaderModule({ code: SIM });
        const drawModule = device.createShaderModule({ code: DRAW });
        for (const m of [simModule, drawModule]) {
            const bad = (await m.getCompilationInfo()).messages.find(x => x.type === 'error');
            if (bad) throw new Error(`WGSL: ${bad.message} (line ${bad.lineNum})`);
        }
        const S = GPUShaderStage.COMPUTE;
        const simLayout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S, buffer: { type: 'uniform' } },
            ...[1, 2, 3, 4, 5, 6, 7].map(binding => ({ binding, visibility: S, buffer: { type: 'storage' } })),
        ] });
        const drawLayout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        ] });
        const simPipe = entryPoint => device.createComputePipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [simLayout] }), compute: { module: simModule, entryPoint } });
        const p = {
            forces: simPipe('forces'), advectVel: simPipe('advectVel'), divergence: simPipe('divergence'),
            ab: simPipe('jacobiAB'), ba: simPipe('jacobiBA'), project: simPipe('project'),
            advectDye: simPipe('advectDye'), copyDye: simPipe('copyDye'),
        };
        const drawPipe = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [drawLayout] }),
            vertex: { module: drawModule, entryPoint: 'vs' },
            fragment: {
                module: drawModule, entryPoint: 'fs',
                targets: [{ format, blend: {
                    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
            },
            primitive: { topology: 'triangle-list' },
        });

        const cells = GX * GY;
        const make = (size, usage = GPUBufferUsage.STORAGE) => device.createBuffer({ size, usage });
        const uniformFloats = 4 + 4 + 4 + MAX_SPLATS * 8;
        const uniform = make(uniformFloats * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        const bufs = [make(cells * 8), make(cells * 8), make(cells * 4), make(cells * 4), make(cells * 4), make(cells * 4), make(cells * 4)];
        const simBind = device.createBindGroup({ layout: simLayout, entries: [
            { binding: 0, resource: { buffer: uniform } },
            ...bufs.map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
        ] });
        const drawBind = device.createBindGroup({ layout: drawLayout, entries: [
            { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: bufs[5] } },
        ] });
        const params = new Float32Array(uniformFloats);
        const groups = [Math.ceil(GX / 8), Math.ceil(GY / 8)];

        const queue = [];       // splats waiting for the next step
        let on = 0, last = performance.now(), clock = 0, mouse = null, ambientAt = 0;
        const abort = new AbortController();

        // ------------------------------------------------------------ input
        const toUv = (x, y) => {
            const b = root.getBoundingClientRect();
            return [(x - b.left) / Math.max(1, b.width), (y - b.top) / Math.max(1, b.height)];
        };
        const push = s => { if (queue.length < MAX_SPLATS) queue.push(s); };
        root.addEventListener('pointermove', e => {
            if (!panel()) return;
            const [x, y] = toUv(e.clientX, e.clientY), t = performance.now();
            if (mouse && t - mouse.t < 120) {
                const dt = Math.max(0.008, (t - mouse.t) / 1000);
                const fx = (x - mouse.x) * GX / dt * 0.55, fy = (y - mouse.y) * GX / dt * 0.55;
                if (Math.hypot(fx, fy) > 2) push({ x, y, fx: Math.max(-120, Math.min(120, fx)), fy: Math.max(-120, Math.min(120, fy)), r: 0.035, dye: 0.12, kind: 0 });
            }
            mouse = { x, y, t };
            wake();
        }, { passive: true, signal: abort.signal });

        // ------------------------------------------------------------ a step and a frame
        function step(dt) {
            params[0] = GX; params[1] = GY; params[2] = dt; params[3] = clock;
            const el = panel();
            if (el) {
                const r = el.getBoundingClientRect(), b = root.getBoundingClientRect();
                params.set([(r.left + r.width / 2 - b.left) / b.width, (r.top + r.height / 2 - b.top) / b.height, r.width / 2 / b.width, r.height / 2 / b.height], 4);
            }
            params[8] = queue.length; params[9] = on; params[10] = canvas.width / Math.max(1, canvas.height);
            queue.forEach((s, i) => {
                params.set([s.x, s.y, s.kind === 1 ? s.fx : s.fx, s.kind === 1 ? 0 : s.fy], 12 + i * 4);
                params.set([s.r, s.dye, s.kind, 0], 12 + MAX_SPLATS * 4 + i * 4);
            });
            queue.length = 0;
            device.queue.writeBuffer(uniform, 0, params);

            const enc = device.createCommandEncoder();
            const pass = enc.beginComputePass();
            pass.setBindGroup(0, simBind);
            const run = pipe => { pass.setPipeline(pipe); pass.dispatchWorkgroups(groups[0], groups[1]); };
            run(p.forces); run(p.advectVel); run(p.divergence);
            for (let i = 0; i < JACOBI / 2; i++) { run(p.ab); run(p.ba); }
            run(p.project); run(p.advectDye); run(p.copyDye);
            pass.end();
            const render = enc.beginRenderPass({ colorAttachments: [{
                view: context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
            render.setPipeline(drawPipe); render.setBindGroup(0, drawBind); render.draw(3);
            render.end();
            device.queue.submit([enc.finish()]);
        }

        function frame(now) {
            running = 0;
            if (disposed || dead) return;
            try {
                const dt = Math.min(0.033, Math.max(0.001, (now - last) / 1000));
                last = now; clock += dt;
                const el = panel();
                on += ((el ? 1 : 0) - on) * 0.14;
                const w = Math.max(2, Math.round(root.clientWidth * 0.5)), h = Math.max(2, Math.round(root.clientHeight * 0.5));
                if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
                // A slow ambient stir so a menu nobody touches still moves.
                if (el && clock > ambientAt) {
                    ambientAt = clock + 1.4;
                    const a = Math.random() * 6.283;
                    push({ x: 0.5 + 0.45 * Math.cos(a), y: 0.5 + 0.4 * Math.sin(a), fx: -Math.sin(a) * 26, fy: Math.cos(a) * 26, r: 0.05, dye: 0.05, kind: 0 });
                }
                step(dt);
                if (el || on > 0.004 || queue.length) running = requestAnimationFrame(frame);
            } catch (error) {
                fail(error);
            }
        }
        function wake() { if (!running && !disposed && !dead) { last = performance.now(); running = requestAnimationFrame(frame); } }
        function fail(error) {
            if (dead) return;
            dead = true;
            console.warn('[PoCapitol] menu fluid stopped, using the shader fallback:', error?.message ?? error);
            canvas?.remove();
            onLost?.();
        }
        device.lost.then(() => fail(new Error('device lost')));
        root.prepend(canvas);

        return {
            canvas,
            wake,
            alive: () => !dead && !disposed,
            /** A press at a screen position: a jet out of it, away from the menu's centre, with a vortex and dye. */
            splash(x, y, strength = 1) {
                if (dead) return;
                const [ux, uy] = toUv(x, y);
                const el = panel(), b = root.getBoundingClientRect();
                let dx = 0, dy = -1;
                if (el) {
                    const r = el.getBoundingClientRect();
                    dx = x - (r.left + r.width / 2); dy = y - (r.top + r.height / 2);
                    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
                }
                const k = 110 * strength * (b.width > 0 ? 1 : 0);
                push({ x: ux, y: uy, fx: dx * k, fy: dy * k, r: 0.045, dye: 0.9 * strength, kind: 0 });
                push({ x: ux, y: uy, fx: (Math.random() < 0.5 ? -1 : 1) * 70 * strength, fy: 0, r: 0.07, dye: 0.2 * strength, kind: 1 });
                wake();
            },
            dispose() {
                if (disposed) return;
                disposed = true;
                abort.abort();
                if (running) cancelAnimationFrame(running);
                canvas?.remove();
                try { for (const b of [uniform, ...bufs]) b.destroy(); context.unconfigure(); } catch { /* device already gone */ }
            },
        };
    } catch (error) {
        console.warn('[PoCapitol] menu fluid unavailable, using the shader fallback:', error?.message ?? error);
        canvas?.remove();
        return null;
    }
}
