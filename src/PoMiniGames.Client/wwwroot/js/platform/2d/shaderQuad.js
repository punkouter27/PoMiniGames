// shaderQuad.js — a full-screen fragment shader on a raw WebGL2 canvas.
//
// HUD liquids, result-glass backdrops, menu shaders and the sand field each hand-rolled the
// same 60 lines: get a webgl2 context, compile two shaders, link, make an empty VAO, draw one
// oversized triangle, look uniforms up by name, survive context loss. This is that once.
//
// The vertex stage is provided (no buffers: gl_VertexID makes the triangle); `vUv` (0..1) is
// passed to the fragment shader. The fragment source must start with `#version 300 es`.

export const FULLSCREEN_VERT = `#version 300 es
out vec2 vUv;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    vUv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Compile + link; returns the program or throws with the info log. */
export function buildProgram(gl, vertSrc, fragSrc) {
    const make = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(s);
            gl.deleteShader(s);
            throw new Error(`shader compile failed: ${log}`);
        }
        return s;
    };
    const vs = make(gl.VERTEX_SHADER, vertSrc);
    const fs = make(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error(`program link failed: ${log}`);
    }
    return prog;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{frag:string, vert?:string, contextOptions?:WebGLContextAttributes,
 *          onLost?:()=>void, onRestored?:()=>void}} o
 * @returns {null | {gl:WebGL2RenderingContext, set:(name:string, ...v:number[])=>void,
 *          texture:(unit:number, name:string, tex:WebGLTexture)=>void,
 *          draw:(w?:number, h?:number)=>void, lost:boolean, dispose:()=>void}}
 *          null when WebGL2 is unavailable or the shader does not compile (callers fall back).
 */
export function createShaderQuad(canvas, o) {
    const gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power',
        ...o.contextOptions,
    });
    if (!gl) return null;

    let prog = null, vao = null, lost = false;
    const locs = new Map();

    function build() {
        try { prog = buildProgram(gl, o.vert ?? FULLSCREEN_VERT, o.frag); }
        catch (err) { console.warn('[shaderQuad]', err.message); prog = null; return false; }
        vao = gl.createVertexArray();
        locs.clear();
        return true;
    }
    if (!build()) return null;

    const loc = (name) => {
        if (!locs.has(name)) locs.set(name, gl.getUniformLocation(prog, name));
        return locs.get(name);
    };

    const onLost = (e) => { e.preventDefault(); lost = true; o.onLost?.(); };
    const onRestored = () => { lost = false; if (build()) o.onRestored?.(); };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    return {
        gl,
        get lost() { return lost; },
        get program() { return prog; },
        /** Set a float uniform (1–4 components). Call between frames; draw() binds the program. */
        set(name, ...v) {
            if (lost || !prog) return;
            gl.useProgram(prog);
            const l = loc(name);
            if (l === null) return;
            switch (v.length) {
                case 1: gl.uniform1f(l, v[0]); break;
                case 2: gl.uniform2f(l, v[0], v[1]); break;
                case 3: gl.uniform3f(l, v[0], v[1], v[2]); break;
                default: gl.uniform4f(l, v[0], v[1], v[2], v[3]); break;
            }
        },
        setInt(name, v) { if (lost || !prog) return; gl.useProgram(prog); const l = loc(name); if (l !== null) gl.uniform1i(l, v); },
        texture(unit, name, tex) {
            if (lost || !prog) return;
            gl.useProgram(prog);
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            const l = loc(name);
            if (l !== null) gl.uniform1i(l, unit);
        },
        draw(w = canvas.width, h = canvas.height) {
            if (lost || !prog) return;
            gl.viewport(0, 0, w, h);
            gl.useProgram(prog);
            gl.bindVertexArray(vao);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        },
        dispose() {
            canvas.removeEventListener('webglcontextlost', onLost);
            canvas.removeEventListener('webglcontextrestored', onRestored);
            if (!lost) {
                if (vao) gl.deleteVertexArray(vao);
                if (prog) gl.deleteProgram(prog);
            }
            prog = vao = null;
        },
    };
}
