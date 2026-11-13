// pocabinet/uishader.js
//
// Hardware-accelerated UI backdrop shader canvas (#6 & #10) for PoCabinet Start/Lobby cards:
// renders flowing indigo/apex-amber glassmorphism aurora fields, micro-grain, and pointer-click
// shockwaves. Uses a zero-copy WebGPU WGSL render pipeline when navigator.gpu succeeds (mode
// 'auto' or 'webgpu'), falling back seamlessly to WebGL2 GLSL.

const WGSL_UI = /* wgsl */`
struct Uniforms {
    resTime : vec4<f32>,   // width, height, timeSec, pulse
    pointer : vec4<f32>,   // uv.x, uv.y, rippleU, rippleV
    ripple  : vec4<f32>,   // rippleAgeSec, rippleStrength, darkMode, pad
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vsMain(@builtin(vertex_index) idx: u32) -> VsOut {
    var p = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0)
    );
    var out: VsOut;
    let xy = p[idx];
    out.pos = vec4<f32>(xy, 0.0, 1.0);
    out.uv = xy * 0.5 + 0.5;
    return out;
}

fn hash21(p: vec2<f32>) -> f32 {
    let q = fract(p * vec2<f32>(123.34, 456.21));
    let d = dot(q, q + 45.32);
    return fract(d * (q.x + q.y));
}

@fragment
fn fsMain(in: VsOut) -> @location(0) vec4<f32> {
    let res = max(u.resTime.xy, vec2<f32>(1.0));
    let asp = res.x / res.y;
    let t = u.resTime.z;
    let pulse = u.resTime.w;
    var uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);

    // Expanding pointer ripple refractive warp
    let rAge = u.ripple.x;
    let rStr = u.ripple.y;
    if (rAge > 0.0 && rAge < 1.35 && rStr > 0.01) {
        let dVec = (uv - u.pointer.zw) * vec2<f32>(asp, 1.0);
        let dist = length(dVec);
        let front = rAge * 0.85;
        let band = exp(-pow((dist - front) * 16.0, 2.0)) * (1.0 - rAge / 1.35) * rStr;
        uv = uv + (dVec / max(dist, 0.001)) * band * 0.018;
    }

    let p = (uv - 0.5) * vec2<f32>(asp, 1.0);
    let m = (u.pointer.xy - 0.5) * vec2<f32>(asp, 1.0);
    let ptrDist = length(p - m);

    let w1 = sin(p.x * 2.6 + t * 0.45 + cos(p.y * 2.1 - t * 0.31));
    let w2 = cos(p.y * 3.1 - t * 0.37 + sin(p.x * 1.9 + t * 0.24));
    let silk = 0.5 + 0.5 * (w1 * 0.55 + w2 * 0.45);

    // Dark telemetry glass palette with cobalt-indigo flow & warm apex highlight
    let baseDark = vec3<f32>(0.035, 0.055, 0.125);
    let cobalt   = vec3<f32>(0.10, 0.21, 0.48);
    let apexGold = vec3<f32>(0.88, 0.42, 0.14);
    var col = mix(baseDark, cobalt, silk * 0.72);
    let ribbon = pow(max(0.0, 1.0 - abs(p.y - p.x * 0.32 + sin(p.x * 3.0 - t * 0.6) * 0.12) * 3.4), 3.0);
    col = col + apexGold * ribbon * (0.20 + pulse * 0.28);

    // Interactive pointer aura
    let aura = exp(-ptrDist * ptrDist * 5.5);
    col = col + vec3<f32>(0.22, 0.38, 0.78) * aura * (0.28 + pulse * 0.3);

    // Subtle film micro-grain & radial vignette
    let grain = (hash21(in.uv * res + fract(t) * 13.0) - 0.5) * 0.015;
    let vig = 1.0 - dot(p * 0.65, p * 0.65);
    col = col * clamp(vig, 0.38, 1.05) + grain;
    return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;

const GLSL_VERT = `#version 300 es
out vec2 vUv;
void main() {
    vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
    vUv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
}`;

const GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform vec4 uResTime;
uniform vec4 uPointer;
uniform vec4 uRipple;

float hash21(vec2 p) {
    vec2 q = fract(p * vec2(123.34, 456.21));
    q += dot(q, q + 45.32);
    return fract(q.x * q.y);
}

void main() {
    vec2 res = max(uResTime.xy, vec2(1.0));
    float asp = res.x / res.y;
    float t = uResTime.z;
    float pulse = uResTime.w;
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y);

    float rAge = uRipple.x;
    float rStr = uRipple.y;
    if (rAge > 0.0 && rAge < 1.35 && rStr > 0.01) {
        vec2 dVec = (uv - uPointer.zw) * vec2(asp, 1.0);
        float dist = length(dVec);
        float front = rAge * 0.85;
        float band = exp(-pow((dist - front) * 16.0, 2.0)) * (1.0 - rAge / 1.35) * rStr;
        uv += (dVec / max(dist, 0.001)) * band * 0.018;
    }

    vec2 p = (uv - 0.5) * vec2(asp, 1.0);
    vec2 m = (uPointer.xy - 0.5) * vec2(asp, 1.0);
    float ptrDist = length(p - m);

    float w1 = sin(p.x * 2.6 + t * 0.45 + cos(p.y * 2.1 - t * 0.31));
    float w2 = cos(p.y * 3.1 - t * 0.37 + sin(p.x * 1.9 + t * 0.24));
    float silk = 0.5 + 0.5 * (w1 * 0.55 + w2 * 0.45);

    vec3 baseDark = vec3(0.035, 0.055, 0.125);
    vec3 cobalt   = vec3(0.10, 0.21, 0.48);
    vec3 apexGold = vec3(0.88, 0.42, 0.14);
    vec3 col = mix(baseDark, cobalt, silk * 0.72);
    float ribbon = pow(max(0.0, 1.0 - abs(p.y - p.x * 0.32 + sin(p.x * 3.0 - t * 0.6) * 0.12) * 3.4), 3.0);
    col += apexGold * ribbon * (0.20 + pulse * 0.28);

    float aura = exp(-ptrDist * ptrDist * 5.5);
    col += vec3(0.22, 0.38, 0.78) * aura * (0.28 + pulse * 0.3);

    float grain = (hash21(vUv * res + fract(t) * 13.0) - 0.5) * 0.015;
    float vig = 1.0 - dot(p * 0.65, p * 0.65);
    col = col * clamp(vig, 0.38, 1.05) + grain;
    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

let active = null;

function createWebGL2Pass(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) return null;
    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            gl.deleteShader(s);
            return null;
        }
        return s;
    };
    const vs = compile(gl.VERTEX_SHADER, GLSL_VERT);
    const fs = compile(gl.FRAGMENT_SHADER, GLSL_FRAG);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        gl.deleteProgram(prog);
        return null;
    }
    const vao = gl.createVertexArray();
    const uResTime = gl.getUniformLocation(prog, 'uResTime');
    const uPointer = gl.getUniformLocation(prog, 'uPointer');
    const uRipple = gl.getUniformLocation(prog, 'uRipple');

    return {
        backend: 'webgl2',
        draw(uData, w, h) {
            gl.viewport(0, 0, w, h);
            gl.useProgram(prog);
            gl.bindVertexArray(vao);
            gl.uniform4f(uResTime, uData[0], uData[1], uData[2], uData[3]);
            gl.uniform4f(uPointer, uData[4], uData[5], uData[6], uData[7]);
            gl.uniform4f(uRipple, uData[8], uData[9], uData[10], uData[11]);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        },
        dispose() {
            gl.deleteVertexArray(vao);
            gl.deleteProgram(prog);
        },
    };
}

async function createWebGpuPass(canvas) {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
        if (!adapter) return null;
        const device = await adapter.requestDevice();
        const context = canvas.getContext('webgpu');
        if (!context) return null;
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: 'opaque' });
        const module = device.createShaderModule({ code: WGSL_UI });
        const uniformBuf = device.createBuffer({
            size: 48,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const pipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vsMain' },
            fragment: { module, entryPoint: 'fsMain', targets: [{ format }] },
            primitive: { topology: 'triangle-list' },
        });
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
        });
        let disposed = false;
        return {
            backend: 'webgpu',
            draw(uData) {
                if (disposed) return;
                device.queue.writeBuffer(uniformBuf, 0, uData);
                const enc = device.createCommandEncoder();
                const pass = enc.beginRenderPass({
                    colorAttachments: [{
                        view: context.getCurrentTexture().createView(),
                        loadOp: 'clear',
                        clearValue: { r: 0.04, g: 0.06, b: 0.13, a: 1 },
                        storeOp: 'store',
                    }],
                });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, bindGroup);
                pass.draw(3, 1, 0, 0);
                pass.end();
                device.queue.submit([enc.finish()]);
            },
            dispose() {
                disposed = true;
                uniformBuf.destroy();
            },
        };
    } catch {
        return null;
    }
}

export async function mountUiShader(canvasId, mode = 'auto') {
    const canvas = typeof canvasId === 'string' ? document.getElementById(canvasId) : canvasId;
    if (!canvas) return null;
    if (active && active.canvas === canvas) {
        active.mode = mode || 'auto';
        return active.backend;
    }
    unmountUiShader();

    const state = {
        canvas,
        mode: mode || 'auto',
        pass: null,
        backend: 'none',
        raf: 0,
        ro: null,
        disposed: false,
        t0: performance.now(),
        px: 0.5, py: 0.35, tx: 0.5, ty: 0.35,
        rx: 0.5, ry: 0.5, rippleT: -10, rippleStrength: 0,
        pulse: 0,
        u: new Float32Array(12),
    };
    active = state;

    const resize = () => {
        if (state.disposed) return;
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(1.5, window.devicePixelRatio || 1);
        canvas.width = Math.max(2, Math.round((rect.width || window.innerWidth || 800) * dpr));
        canvas.height = Math.max(2, Math.round((rect.height || window.innerHeight || 600) * dpr));
    };
    resize();

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    const root = canvas.closest('.pocabinet-root') || window;
    const onMove = (e) => {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        state.tx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        state.ty = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    };
    const onDown = (e) => {
        onMove(e);
        state.rx = state.tx;
        state.ry = state.ty;
        state.rippleT = performance.now();
        state.rippleStrength = 1;
        state.pulse = Math.max(state.pulse, 0.7);
    };
    root.addEventListener('pointermove', onMove, { passive: true });
    root.addEventListener('pointerdown', onDown, { passive: true });
    if (typeof ResizeObserver === 'function') {
        let roRaf = 0;
        state.ro = new ResizeObserver(() => {
            if (roRaf) cancelAnimationFrame(roRaf);
            roRaf = requestAnimationFrame(() => { roRaf = 0; resize(); });
        });
        state.ro.observe(canvas);
    }

    state.cleanupListeners = () => {
        root.removeEventListener('pointermove', onMove);
        root.removeEventListener('pointerdown', onDown);
        state.ro?.disconnect();
    };

    if (state.mode !== 'webgl') {
        state.pass = await createWebGpuPass(canvas);
    }
    if (!state.pass && !state.disposed) {
        state.pass = createWebGL2Pass(canvas);
    }
    if (!state.pass || state.disposed) {
        if (active === state) unmountUiShader();
        return null;
    }
    state.backend = state.pass.backend;
    canvas.dataset.shaderBackend = state.backend;

    const frame = (now) => {
        if (state.disposed || !state.pass) return;
        state.px += (state.tx - state.px) * 0.08;
        state.py += (state.ty - state.py) * 0.08;
        state.pulse *= 0.94;
        const rAge = (now - state.rippleT) / 1000;
        const u = state.u;
        u[0] = canvas.width; u[1] = canvas.height;
        u[2] = reduced ? 0 : (now - state.t0) / 1000;
        u[3] = state.pulse;
        u[4] = state.px; u[5] = state.py;
        u[6] = state.rx; u[7] = state.ry;
        u[8] = rAge > 0 && rAge < 1.35 ? rAge : 0;
        u[9] = state.rippleStrength;
        u[10] = 1; u[11] = 0;
        try {
            state.pass.draw(u, canvas.width, canvas.height);
        } catch {
            unmountUiShader();
            return;
        }
        if (!reduced) state.raf = requestAnimationFrame(frame);
    };
    state.raf = requestAnimationFrame(frame);
    return state.backend;
}

export function setUiShaderMode(mode) {
    if (!active) return;
    const next = mode === 'webgpu' || mode === 'webgl' ? mode : 'auto';
    if (active.mode === next) return;
    const canvas = active.canvas;
    unmountUiShader();
    void mountUiShader(canvas, next);
}

export function pulseUiShader(strength = 0.85) {
    if (!active) return;
    active.rx = active.tx;
    active.ry = active.ty;
    active.rippleT = performance.now();
    active.rippleStrength = Math.min(1.5, Math.max(0.2, Number(strength) || 0.85));
    active.pulse = Math.max(active.pulse, active.rippleStrength);
}

export function unmountUiShader() {
    if (!active) return;
    const s = active;
    active = null;
    s.disposed = true;
    cancelAnimationFrame(s.raf);
    s.cleanupListeners?.();
    s.pass?.dispose();
}
