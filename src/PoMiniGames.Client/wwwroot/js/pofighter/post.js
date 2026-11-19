// pofighter/post.js — the fight's finishing pass: bloom, a colour grade, film grain, and a short
// chromatic split on a heavy blow.
//
// The fight draws on a 2D canvas. On the 'high' quality tier (data-gfx) a WebGL2 canvas laid over
// it takes that frame as a texture and draws it again through one fragment shader
// (platform/2d/shaderQuad.js). Bright pixels (sparks, flashes, the windows) bleed light around
// them; shadows lean cool and highlights warm; a faint grain keeps the gradients from banding.
// Anywhere else (medium/low tier, no WebGL2, a lost context) the overlay is hidden and the 2D
// canvas shows as it always did, so the pass is never load-bearing.
//
// Reduced motion keeps the grade and drops the chromatic split and the grain's flicker;
// reduced flashing (data-reduce-flashing) halves the bloom.

import { createShaderQuad } from '../platform/2d/shaderQuad.js';

const FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uTime, uBloom, uSplit, uGrain;

vec3 bright(vec2 uv) {
    vec3 c = texture(uTex, uv).rgb;
    float l = max(c.r, max(c.g, c.b));
    return c * smoothstep(0.6, 1.0, l);
}

void main() {
    vec2 d = vUv - 0.5;
    vec3 c;
    if (uSplit > 0.0) {
        vec2 off = d * uSplit * 0.014;
        c = vec3(texture(uTex, vUv + off).r, texture(uTex, vUv).g, texture(uTex, vUv - off).b);
    } else {
        c = texture(uTex, vUv).rgb;
    }
    // Bloom: two rings of twelve taps around the pixel, bright parts only.
    vec3 b = vec3(0.0);
    for (int i = 0; i < 12; i++) {
        float a = float(i) * 0.5236;
        vec2 dir = vec2(cos(a), sin(a)) * uTexel;
        b += bright(vUv + dir * 6.0) * 0.6;
        b += bright(vUv + dir * 14.0) * 0.4;
    }
    c += b / 12.0 * uBloom;
    // Grade: cool shadows, warm highlights, a touch of contrast.
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c * vec3(0.95, 0.98, 1.06), c * vec3(1.05, 1.0, 0.94), smoothstep(0.2, 0.8, l));
    c = (c - 0.5) * 1.06 + 0.5;
    float n = fract(sin(dot(vUv * vec2(1733.0, 911.0) + uTime, vec2(12.9898, 78.233))) * 43758.5453);
    c += (n - 0.5) * uGrain;
    outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const tier = () => document.documentElement.dataset.gfx ?? 'high';
const reduced = () => document.documentElement.dataset.motion === 'reduce'
    || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Lays the pass over `source` (the fight's 2D canvas). Returns { present(now), kick(amount),
 * dispose() }: present() after each 2D frame, kick() on a heavy blow (0..1).
 */
export function createPostPass(source) {
    const overlay = document.createElement('canvas');
    overlay.className = source.className;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.pointerEvents = 'none';
    overlay.hidden = true;
    source.after(overlay);
    let quad = null, tex = null, split = 0, failed = false;

    function init() {
        quad = createShaderQuad(overlay, { frag: FRAG, contextOptions: { alpha: false, powerPreference: 'high-performance' },
            onLost: () => { overlay.hidden = true; }, onRestored: () => { tex = null; } });
        if (!quad) { failed = true; return false; }
        return true;
    }

    function texture(gl) {
        if (tex) return tex;
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    return {
        /** Draws the post-processed frame, or hides the overlay when the pass is off. */
        present(now) {
            const on = tier() === 'high' && !failed && source.width > 0 && (quad || init());
            if (!on || quad.lost) { overlay.hidden = true; return; }
            const gl = quad.gl;
            if (overlay.width !== source.width || overlay.height !== source.height) {
                overlay.width = source.width;
                overlay.height = source.height;
            }
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            quad.texture(0, 'uTex', texture(gl));
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            const calm = reduced();
            const soft = document.documentElement.hasAttribute('data-reduce-flashing');
            quad.set('uTexel', 1 / source.width, 1 / source.height);
            quad.set('uTime', calm ? 0 : (now % 100));
            quad.set('uBloom', soft ? 0.55 : 1.1);
            quad.set('uSplit', calm ? 0 : split);
            quad.set('uGrain', 0.035);
            quad.draw(overlay.width, overlay.height);
            split *= 0.85;
            if (split < 0.02) split = 0;
            overlay.hidden = false;
        },
        /** A heavy blow: a brief colour split (0..1). */
        kick(amount) { split = Math.max(split, Math.min(1, amount)); },
        dispose() {
            if (tex && quad && !quad.lost) quad.gl.deleteTexture(tex);
            quad?.dispose();
            overlay.remove();
        },
    };
}
