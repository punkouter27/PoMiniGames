// pofighter/announcer.js — the match announcer: a cut-out face in the middle of the VS screen
// that calls the two fighters ("Kim! Versus Nick!") with the browser's own speech synthesis
// and moves its jaw in time with the words.
//
// Assets (scripts/pofighter/announcer.py builds both): data/pofighter/announcer.webp, the face
// with the background removed, and announcer.json, the mouth line, the jaw polygon and how far
// the jaw may drop, in the picture's pixels.
//
// Lip sync: every word gets one jaw opening per syllable (a vowel-group count). When the voice
// reports word boundaries, each word's openings restart at its boundary, so the jaw follows the
// real speech; when it does not, or speech is muted, blocked (no user gesture yet, as in the
// attract demo) or unsupported, the same plan runs on its own clock, so the face still "talks".
// Nothing here is sent anywhere: speechSynthesis runs in the browser.

import { isAudible, getVolume } from '../platform/audioBus.js';

const BASE = 'data/pofighter/announcer';
const SYLLABLE_SECONDS = 0.2;
const MAX_SECONDS = 6;   // a voice that never ends still lets the match go on

/** Rough syllable count: vowel groups, a silent final e dropped, at least one. */
export function syllables(word) {
    const w = String(word).toLowerCase().replace(/[^a-z]/g, '').replace(/([^aeiouy])e$/, '$1');
    return Math.max(1, (w.match(/[aeiouy]+/g) ?? []).length);
}

/**
 * The jaw's timeline for a line: { words: [{ text, char, at, plan: [{ at, len }] }], duration }.
 * `at` is seconds from the line's start; each word's plan is relative to the word's own start.
 */
export function mouthPlan(line, rate = 1) {
    const words = [];
    let t = 0;
    for (const m of String(line).matchAll(/\S+/g)) {
        const n = syllables(m[0]);
        const syl = SYLLABLE_SECONDS / rate;
        words.push({ text: m[0], char: m.index, at: t,
            plan: Array.from({ length: n }, (_, i) => ({ at: i * syl, len: syl * 0.85 })) });
        t += n * syl + (/[!?.,]$/.test(m[0]) ? 0.3 : 0.06) / rate;
    }
    return { words, duration: t };
}

/** 0..1: how far the jaw is open `t` seconds into a word's plan. */
export function mouthOpen(plan, t) {
    for (const p of plan) {
        if (t >= p.at && t < p.at + p.len) return Math.sin(((t - p.at) / p.len) * Math.PI);
    }
    return 0;
}

/** The word index that owns character `char` of the line. */
export function wordAt(words, char) {
    let i = 0;
    while (i + 1 < words.length && words[i + 1].char <= char) i++;
    return i;
}

function pickVoice() {
    const voices = globalThis.speechSynthesis?.getVoices?.() ?? [];
    const en = voices.filter(v => /^en/i.test(v.lang));
    return en.find(v => /male|david|guy|daniel|alex|fred|mark/i.test(v.name) && !/female/i.test(v.name))
        ?? en[0] ?? null;
}

export function createAnnouncer() {
    const img = typeof Image === 'undefined' ? null : new Image();
    if (img) img.src = `${BASE}.webp`;
    let meta = null;
    fetch(`${BASE}.json`).then(r => (r.ok ? r.json() : null)).then(m => { meta = m; }).catch(() => { });

    let plan = null;
    let shownAt = 0;      // performance.now() of announce()
    let startAt = 0;      // when the speech (or the silent clock) started
    let anchor = null;    // { index, at }: the last word boundary the voice reported
    let doneAt = 0;       // when the line finished (0 while speaking)
    let open = 0, lastFrame = 0;
    let utterance = null;
    let faded = null;     // the picture with its bottom faded out (built on the first draw)

    const finish = () => { if (!doneAt) doneAt = performance.now(); };

    return {
        /** Calls the line; the face appears with it. rate: the voice's speed (fight calls run quicker). */
        announce(line, rate = 1) {
            this.stop();
            plan = mouthPlan(line, rate);
            shownAt = startAt = performance.now();
            anchor = null;
            doneAt = 0;
            const synth = globalThis.speechSynthesis;
            if (!synth || typeof SpeechSynthesisUtterance === 'undefined' || !isAudible('sfx')) return;
            const u = new SpeechSynthesisUtterance(line);
            u.rate = rate;
            u.pitch = 0.85;
            u.volume = Math.max(0, Math.min(1, getVolume()));
            const voice = pickVoice();
            if (voice) u.voice = voice;
            u.onstart = () => { startAt = performance.now(); anchor = null; };
            u.onboundary = e => {
                if (e.name === 'word' || e.name === undefined) anchor = { index: wordAt(plan.words, e.charIndex), at: performance.now() };
            };
            u.onend = finish;
            u.onerror = finish;
            utterance = u;
            synth.cancel();
            synth.speak(u);
        },

        /** True while the line is being spoken (the VS screen waits for it, briefly). */
        get busy() {
            if (!plan || doneAt) return false;
            const age = (performance.now() - startAt) / 1000;
            // No voice, or one that never started: the silent clock decides.
            if (!utterance || !globalThis.speechSynthesis?.speaking) {
                if (age > plan.duration + 0.2) finish();
            }
            if ((performance.now() - shownAt) / 1000 > MAX_SECONDS) finish();
            return !doneAt;
        },

        /** 0..1 jaw opening right now (smoothed). */
        mouth() {
            const now = performance.now();
            let target = 0;
            if (plan && !doneAt) {
                if (anchor) {
                    const w = plan.words[anchor.index];
                    target = mouthOpen(w.plan, (now - anchor.at) / 1000);
                } else {
                    const t = (now - startAt) / 1000;
                    let w = null;
                    for (const x of plan.words) if (x.at <= t) w = x;
                    if (w) target = mouthOpen(w.plan, t - w.at);
                }
            }
            const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0.016;
            lastFrame = now;
            open += (target - open) * Math.min(1, dt * 28);
            return open;
        },

        /**
         * Draws the face with its bottom edge centred at (cx, bottom), `height` tall, fading in as
         * it appears and out after the line. reduced: no rise, no jaw travel beyond a nod.
         */
        draw(ctx, cx, bottom, height, reduced = false) {
            if (!plan || !meta || !img?.complete || !img.naturalWidth) return;
            // Once: the picture with its bottom fading out, so the suit has no hard edge.
            if (!faded) {
                faded = document.createElement('canvas');
                faded.width = img.naturalWidth;
                faded.height = img.naturalHeight;
                const f = faded.getContext('2d');
                f.drawImage(img, 0, 0);
                f.globalCompositeOperation = 'destination-in';
                const fade = f.createLinearGradient(0, faded.height * 0.62, 0, faded.height);
                fade.addColorStop(0, 'rgba(0,0,0,1)');
                fade.addColorStop(1, 'rgba(0,0,0,0)');
                f.fillStyle = fade;
                f.fillRect(0, 0, faded.width, faded.height);
            }
            const age = (performance.now() - shownAt) / 1000;
            const gone = doneAt ? (performance.now() - doneAt) / 1000 : 0;
            const alpha = Math.min(1, age / 0.3) * Math.max(0, 1 - Math.max(0, gone - 0.6) / 0.4);
            if (alpha <= 0) return;
            const rise = reduced ? 0 : (1 - Math.min(1, age / 0.35)) ** 3 * 60;
            const s = height / meta.height;
            const w = meta.width * s;
            ctx.save();
            ctx.globalAlpha = alpha;
            // A spotlight behind him.
            const glow = ctx.createRadialGradient(cx, bottom - height * 0.55, 10, cx, bottom - height * 0.55, height * 0.65);
            glow.addColorStop(0, 'rgba(255,210,63,0.45)');
            glow.addColorStop(1, 'rgba(255,210,63,0)');
            ctx.fillStyle = glow;
            ctx.fillRect(cx - height, bottom - height * 1.3, height * 2, height * 1.3);
            ctx.translate(cx - w / 2, bottom - height + rise);
            ctx.scale(s, s);
            ctx.drawImage(faded, 0, 0);
            const d = this.mouth() * meta.drop * (reduced ? 0.5 : 1);
            if (d > 0.3) {
                const { x, y, half } = meta.mouth;
                // The open mouth: a dark gap with a hint of upper teeth.
                ctx.fillStyle = '#2a0b0e';
                ctx.beginPath();
                ctx.ellipse(x, y + d / 2, half, d / 2 + 1.5, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = 'rgba(232,226,214,0.55)';
                ctx.beginPath();
                ctx.ellipse(x, y + 0.6, half * 0.5, Math.min(1.8, d * 0.2), 0, 0, Math.PI * 2);
                ctx.fill();
                // The jaw, cut from the same picture and dropped by d.
                ctx.save();
                ctx.translate(0, d);
                ctx.beginPath();
                meta.jaw.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
                ctx.closePath();
                ctx.clip();
                ctx.drawImage(faded, 0, 0);
                ctx.restore();
            }
            ctx.restore();
        },

        stop() {
            if (utterance) {
                utterance.onend = utterance.onerror = utterance.onboundary = utterance.onstart = null;
                globalThis.speechSynthesis?.cancel?.();
                utterance = null;
            }
            finish();
        },
    };
}
