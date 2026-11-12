// PoCapitol's interface layer: sound, motion and a glass-and-fluid shader for the menus.
//
// Everything here is applied from outside Blazor, by event delegation on the game's root element,
// so no .razor markup has to know about it:
//
//   sound      Web Audio cues on the platform's 'ui' bus: a tick on hover, a low press and a rising
//              confirm on click, and a swept whoosh when a menu opens or leaves. Each is panned by
//              where on screen the control sits and pitched a little by which control it is.
//   motion     Web Animations: buttons dip on press and spring back with overshoot, lift and brighten
//              on hover, menus rise in out of a blur, and when Blazor removes a menu a ghost of it is
//              kept just long enough to slide out. Animations use the individual `translate` and
//              `scale` properties, so they compose with the CSS transforms the panels already have.
//   shader     One WebGL2 pass behind the menus: a domain-warped fluid height field, a refracting
//              rim around the panel with chromatic dispersion (red, green and blue bend by slightly
//              different amounts), and shockwave ripples from every press. It runs only while a menu
//              is on screen.
//
// All of it stands down for reduced motion; the shader also for the lowest quality tier.

const BUTTON = 'button, a[href], [role="radio"], [role="tab"], .rz-button, .rz-selectbar-item, summary';
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime, uOn;
uniform vec4 uPanel;      // x, y, width, height in canvas pixels, origin top-left
uniform vec4 uRip[4];     // x, y, start time, strength
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
    return v;
}
float box(vec2 p, vec2 boxHalf, float r) {
    vec2 q = abs(p) - boxHalf + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Height of the fluid at a pixel: slow domain-warped noise plus the ripples spreading from presses.
float height(vec2 px) {
    vec2 uv = px / uRes.y * 2.4;
    float t = uTime * 0.11;
    vec2 warp = vec2(fbm(uv + vec2(0.0, t)), fbm(uv + vec2(5.2, 1.3) - t));
    float h = fbm(uv + 2.2 * warp + t);
    for (int i = 0; i < 4; i++) {
        float age = uTime - uRip[i].z;
        if (age > 0.0 && age < 1.8) {
            float r = length(px - uRip[i].xy), front = age * 560.0;
            h += 0.45 * uRip[i].w * sin((r - front) * 0.07) * exp(-abs(r - front) * 0.028) * exp(-age * 2.0);
        }
    }
    return h;
}

void main() {
    vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
    vec2 centre = uPanel.xy + uPanel.zw * 0.5;
    float d = box(px - centre, uPanel.zw * 0.5, 10.0);
    float h = height(px);
    vec2 slope = vec2(dFdx(h), dFdy(h));
    float inside = smoothstep(1.5, -1.5, d);

    // Chromatic dispersion: three samples of the same caustic bent by slightly different amounts.
    vec3 bend = vec3(1.0, 1.07, 1.14);
    vec3 caustic = smoothstep(0.62, 1.0, 0.5 + 0.5 * sin((h + slope.x * 22.0 * bend) * 19.0 + uTime * 0.9));

    // The refracting rim: a light band hugging the edge, its three colours offset along the normal.
    vec3 rim = vec3(exp(-pow(abs(d) / 5.0, 2.0)), exp(-pow((abs(d) - 2.0) / 5.0, 2.0)), exp(-pow((abs(d) - 4.0) / 5.0, 2.0)));
    float ripple = max(0.0, h - 0.62);

    vec3 gold = vec3(0.86, 0.69, 0.4);
    vec3 rgb = caustic * gold * 0.2 * (0.35 + 0.65 * inside) + rim * vec3(1.0, 0.88, 0.66) * (0.3 + 0.55 * h) + ripple * vec3(0.9, 0.8, 0.6);
    float alpha = 0.04 + 0.09 * inside * dot(caustic, vec3(0.33)) + max(rim.r, max(rim.g, rim.b)) * 0.42 + ripple * 0.3;
    outColor = vec4(rgb * uOn, alpha * uOn);   // premultiplied
}`;

export function createUiFx(root) {
    const quietRoute = /[?&]kiosk=/.test(location.search);
    const bus = window.PoAudioBus;
    let out = null;
    const output = () => {
        if (out || quietRoute) return out;
        try { out = bus?.busSync?.('ui') ?? null; } catch { out = null; }
        return out;
    };
    const live = () => { const o = output(); return o && !bus.isMuted?.() ? o : null; };

    // -------------------------------------------------------------- sound
    function voice(o, { from, to = from, type = 'sine', volume = 0.08, seconds = 0.06, at = 0, pan = 0 }) {
        const ctx = o.context, t = ctx.currentTime + at;
        const osc = ctx.createOscillator(), gain = ctx.createGain(), panner = ctx.createStereoPanner?.();
        osc.type = type;
        osc.frequency.setValueAtTime(from, t);
        if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + seconds);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(volume, t + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
        osc.connect(gain);
        if (panner) { panner.pan.value = pan; gain.connect(panner).connect(o); } else gain.connect(o);
        osc.start(t); osc.stop(t + seconds + 0.03);
    }
    function whoosh(o, { rising, volume = 0.05, seconds = 0.3, pan = 0 }) {
        const ctx = o.context, t = ctx.currentTime;
        const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate), data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain(), panner = ctx.createStereoPanner?.();
        source.buffer = buffer; filter.type = 'bandpass'; filter.Q.value = 1.6;
        filter.frequency.setValueAtTime(rising ? 300 : 2600, t);
        filter.frequency.exponentialRampToValueAtTime(rising ? 2600 : 260, t + seconds);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(volume, t + seconds * 0.4);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
        source.connect(filter).connect(gain);
        if (panner) { panner.pan.value = pan; gain.connect(panner).connect(o); } else gain.connect(o);
        source.start(t); source.stop(t + seconds + 0.02);
    }
    const panOf = el => {
        const r = el.getBoundingClientRect(), w = root.getBoundingClientRect();
        return Math.max(-0.6, Math.min(0.6, ((r.left + r.width / 2 - w.left) / Math.max(1, w.width) * 2 - 1) * 0.6));
    };
    // Which control it is nudges the pitch, so a row of buttons is a row of slightly different notes.
    const pitchOf = el => {
        let h = 0; for (const ch of (el.textContent || el.id || el.tagName)) h = (h * 31 + ch.charCodeAt(0)) | 0;
        return 1 + ((h >>> 0) % 7) * 0.035;
    };
    const primary = el => el.matches('.rz-primary, [class*="rz-primary"]');
    let hoverAt = 0;
    const cue = {
        hover(el) {
            const o = live(), now = performance.now();
            if (!o || now - hoverAt < 70) return;
            hoverAt = now;
            voice(o, { from: 1500 * pitchOf(el), to: 1850 * pitchOf(el), volume: 0.022, seconds: 0.035, pan: panOf(el) });
        },
        press(el) {
            const o = live(); if (!o) return;
            o.context.resume?.();
            voice(o, { from: 260, to: 150, type: 'triangle', volume: 0.1, seconds: 0.06, pan: panOf(el) });
        },
        confirm(el) {
            const o = live(); if (!o) return;
            const k = pitchOf(el), pan = panOf(el);
            if (primary(el)) {
                voice(o, { from: 523 * k, type: 'triangle', volume: 0.08, seconds: 0.16, pan });
                voice(o, { from: 784 * k, type: 'triangle', volume: 0.08, seconds: 0.26, at: 0.07, pan });
                voice(o, { from: 1568 * k, volume: 0.025, seconds: 0.4, at: 0.07, pan });
            } else voice(o, { from: 660 * k, to: 940 * k, type: 'triangle', volume: 0.07, seconds: 0.09, pan });
        },
        /** A switch, radio or checkbox latches: two short notes falling over each other. */
        toggle(el) {
            const o = live(); if (!o) return;
            const k = pitchOf(el), pan = panOf(el);
            voice(o, { from: 880 * k, to: 660 * k, type: 'triangle', volume: 0.06, seconds: 0.07, pan });
            voice(o, { from: 440 * k, type: 'sine', volume: 0.045, seconds: 0.1, at: 0.04, pan });
        },
        open(pan) {
            const o = live(); if (!o) return;
            whoosh(o, { rising: true, pan });
            voice(o, { from: 988, type: 'triangle', volume: 0.04, seconds: 0.2, at: 0.12, pan });
            voice(o, { from: 1319, type: 'triangle', volume: 0.035, seconds: 0.3, at: 0.18, pan });
        },
        close(pan) {
            const o = live(); if (!o) return;
            whoosh(o, { rising: false, volume: 0.045, seconds: 0.28, pan });
            voice(o, { from: 494, to: 330, type: 'triangle', volume: 0.04, seconds: 0.2, pan });
        },
    };

    // -------------------------------------------------------------- the fluid shader
    let gl = null, program = null, canvas = null, uniforms = null, running = 0, on = 0;
    const ripples = [[0, 0, -9, 0], [0, 0, -9, 0], [0, 0, -9, 0], [0, 0, -9, 0]];
    let rippleNext = 0, panelBox = [0, 0, 0, 0], start = performance.now();
    const lowTier = () => window.PoQuality?.tier?.() === 'low';
    function initShader() {
        if (gl || calm() || lowTier()) return;
        canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '2' });
        gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, powerPreference: 'low-power' });
        if (!gl) { canvas = null; return; }
        const compile = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source); gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
            return shader;
        };
        try {
            program = gl.createProgram();
            gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
            gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        } catch (error) {
            console.warn('[PoCapitol] menu shader unavailable:', error);
            gl = null; canvas = null; return;
        }
        gl.useProgram(program);
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        // One oversized triangle covers the screen with no diagonal seam.
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const at = gl.getAttribLocation(program, 'aPos');
        gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
        uniforms = Object.fromEntries(['uRes', 'uTime', 'uOn', 'uPanel', 'uRip'].map(name => [name, gl.getUniformLocation(program, name)]));
        root.prepend(canvas);
    }
    function frame() {
        running = 0;
        if (!gl) return;
        const panel = currentPanel();
        on += ((panel ? 1 : 0) - on) * 0.14;
        const time = (performance.now() - start) / 1000;
        const busy = panel || on > 0.01 || ripples.some(r => time - r[2] < 1.8);
        // Half resolution is plenty for soft light.
        const w = Math.max(2, Math.round(root.clientWidth * 0.5)), h = Math.max(2, Math.round(root.clientHeight * 0.5));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
        if (panel) {
            const r = panel.getBoundingClientRect(), b = root.getBoundingClientRect(), k = w / Math.max(1, b.width);
            panelBox = [(r.left - b.left) * k, (r.top - b.top) * k, r.width * k, r.height * k];
        }
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        if (busy) {
            gl.uniform2f(uniforms.uRes, w, h); gl.uniform1f(uniforms.uTime, time); gl.uniform1f(uniforms.uOn, on);
            gl.uniform4f(uniforms.uPanel, ...panelBox);
            gl.uniform4fv(uniforms.uRip, ripples.flat());
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            running = requestAnimationFrame(frame);
        }
    }
    function wake() { if (gl && !running) running = requestAnimationFrame(frame); }
    function ripple(x, y, strength = 1) {
        if (!gl || !canvas) return;
        const b = root.getBoundingClientRect(), k = canvas.width / Math.max(1, b.width);
        ripples[rippleNext] = [(x - b.left) * k, (y - b.top) * k, (performance.now() - start) / 1000, strength];
        rippleNext = (rippleNext + 1) % ripples.length;
        wake();
    }
    const currentPanel = () => root.querySelector(':scope > .pc-panel');

    // -------------------------------------------------------------- motion
    const spring = 'cubic-bezier(0.2, 0.9, 0.3, 1.25)', settle = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
    const held = new WeakMap();
    function dip(el, event) {
        if (calm()) return;
        held.get(el)?.cancel();
        held.set(el, el.animate([{ scale: 1 }, { scale: 0.94 }], { duration: 90, fill: 'forwards', easing: 'ease-out' }));
        // A ring of light spreads from the fingertip, drawn in a layer of its own rather than inside
        // the button, because Blazor owns the button's children.
        const r = el.getBoundingClientRect();
        const ring = document.createElement('i');
        const size = Math.max(r.width, r.height) * 1.8;
        Object.assign(ring.style, {
            position: 'fixed', left: `${event.clientX - size / 2}px`, top: `${event.clientY - size / 2}px`, width: `${size}px`, height: `${size}px`,
            borderRadius: '50%', pointerEvents: 'none', zIndex: '2147483000',
            background: 'radial-gradient(circle, transparent 38%, rgba(240,205,130,0.55) 48%, transparent 62%)',
        });
        document.body.append(ring);
        ring.animate([{ transform: 'scale(0.15)', opacity: 0.95 }, { transform: 'scale(1)', opacity: 0 }], { duration: 520, easing: settle }).finished
            .then(() => ring.remove(), () => ring.remove());
        ripple(event.clientX, event.clientY, 1);
    }
    function release(el) {
        const pressed = held.get(el);
        if (!pressed) return;
        held.delete(el);
        if (calm()) { pressed.cancel(); return; }
        el.animate([{ scale: 0.94 }, { scale: 1.035, offset: 0.55 }, { scale: 1 }], { duration: 360, easing: spring });
        pressed.cancel();
    }
    const lifted = new WeakMap();
    function lift(el, up) {
        if (calm()) return;
        lifted.get(el)?.cancel();
        const to = up ? { translate: '0 -1px', filter: 'brightness(1.14)' } : { translate: '0 0', filter: 'brightness(1)' };
        lifted.set(el, el.animate([up ? { translate: '0 0', filter: 'brightness(1)' } : { translate: '0 -1px', filter: 'brightness(1.14)' }, to], { duration: 160, fill: up ? 'forwards' : 'none', easing: 'ease-out' }));
    }
    function enter(panel) {
        if (calm()) return;
        panel.animate([
            { translate: '0 22px', scale: '0.985', filter: 'blur(12px)', opacity: 0 },
            { translate: '0 0', scale: '1', filter: 'blur(0)', opacity: 1 },
        ], { duration: 460, easing: settle });
        // Whatever is inside rises a beat after its frame: heading first, then the rest.
        [...panel.children].slice(0, 12).forEach((child, i) => child.animate([
            { translate: '0 10px', opacity: 0 }, { translate: '0 0', opacity: 1 },
        ], { duration: 380, delay: 90 + i * 32, easing: settle, fill: 'backwards' }));
    }
    // Blazor removes a menu the moment its state changes. A cloned ghost of it, kept where it stood,
    // slides away; the shader's rim keeps tracing it until the ghost is gone.
    function leave(node, box) {
        if (calm() || !box) return;
        const ghost = node.cloneNode(true);
        ghost.removeAttribute('id');
        ghost.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
        const wrap = document.createElement('div');
        wrap.setAttribute('aria-hidden', 'true'); wrap.inert = true;
        Object.assign(wrap.style, { position: 'absolute', zIndex: '3', pointerEvents: 'none', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
        Object.assign(ghost.style, { position: 'static', transform: 'none', width: '100%', height: '100%', maxHeight: 'none', margin: '0', left: 'auto', top: 'auto' });
        wrap.append(ghost);
        root.append(wrap);
        const toLeft = node.classList.contains('pc-intro');
        wrap.animate([
            { translate: '0 0', scale: '1', filter: 'blur(0)', opacity: 1 },
            { translate: toLeft ? '-70px 0' : '0 14px', scale: toLeft ? '0.99' : '0.96', filter: 'blur(10px)', opacity: 0 },
        ], { duration: 340, easing: 'cubic-bezier(0.5, 0, 0.8, 0.4)', fill: 'forwards' }).finished.then(() => wrap.remove(), () => wrap.remove());
        cue.close(Math.max(-0.5, Math.min(0.5, ((box.left + box.width / 2) / Math.max(1, root.clientWidth) * 2 - 1) * 0.5)));
    }

    // -------------------------------------------------------------- wiring
    const controller = new AbortController();
    const on_ = (type, fn, options) => root.addEventListener(type, fn, { ...options, signal: controller.signal });
    const target = e => e.target.closest?.(BUTTON);
    on_('pointerover', e => {
        const el = target(e);
        if (!el || el.disabled || el.contains(e.relatedTarget)) return;
        lift(el, true); cue.hover(el);
    });
    on_('pointerout', e => { const el = target(e); if (el && !el.contains(e.relatedTarget)) { lift(el, false); release(el); el.style.rotate = ''; } });
    on_('pointerdown', e => { const el = target(e); if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true') { dip(el, e); cue.press(el); } });
    on_('pointerup', e => { const el = target(e); if (el) release(el); });
    on_('pointercancel', e => { const el = target(e); if (el) release(el); });
    // A control leans a couple of degrees toward the cursor: enough to feel alive, not enough to
    // move its hit box. Mice only; a finger would drag the control under itself.
    const TILT = 3.2;
    on_('pointermove', e => {
        if (e.pointerType !== 'mouse' || calm()) return;
        const el = target(e);
        if (!el || el.disabled) return;
        const r = el.getBoundingClientRect();
        const lean = ((e.clientX - r.left) / Math.max(1, r.width) - 0.5) * TILT;
        el.style.rotate = `${lean.toFixed(2)}deg`;
    });
    on_('click', e => {
        const el = target(e);
        if (!el || el.disabled) return;
        // A control that latches should sound like it latched, not like it navigated.
        if (el.matches('[role="switch"], [role="radio"], [aria-checked], input[type="checkbox"]')) cue.toggle(el);
        else cue.confirm(el);
    });
    // Keyboard users get the same press: Enter or Space dips the control from its own centre,
    // so the microinteraction is not mouse-only.
    on_('keydown', e => {
        if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
        const el = target(e);
        if (!el || el.disabled) return;
        const r = el.getBoundingClientRect();
        dip(el, { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
        cue.press(el);
    }, { capture: true });
    on_('keyup', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = target(e);
        if (el) release(el);
    });

    let lastPanel = null, lastBox = null;
    // The last good position of the menu: when it is removed it is already out of the document.
    function track() {
        const panel = currentPanel();
        if (panel) {
            const r = panel.getBoundingClientRect(), b = root.getBoundingClientRect();
            lastBox = { left: r.left - b.left, top: r.top - b.top, width: r.width, height: r.height };
        }
        lastPanel = panel;
    }
    const watcher = new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node.nodeType === 1 && node.classList.contains('pc-panel')) {
                    initShader(); wake(); enter(node);
                    cue.open(panOf(node));
                }
            }
            for (const node of record.removedNodes) {
                if (node.nodeType === 1 && node.classList.contains('pc-panel') && node === lastPanel) { leave(node, lastBox); lastPanel = null; wake(); }
            }
        }
        track();
    });
    watcher.observe(root, { childList: true });
    // Positions are sampled while a menu is up, so a panel that resizes is still ghosted where it was.
    const sampler = setInterval(track, 120);
    track();
    if (currentPanel()) { initShader(); wake(); }

    return {
        /** A shockwave through the fluid from a screen position, for events outside the menus. */
        ripple,
        dispose() {
            controller.abort(); watcher.disconnect(); clearInterval(sampler);
            if (running) cancelAnimationFrame(running);
            canvas?.remove();
            gl?.getExtension('WEBGL_lose_context')?.loseContext();
            gl = null;
        },
    };
}
