// Voice the officials' radio lines, once, on this machine: every line in
// src/PoMiniGames.Shared/Games/PoCabinetDialogue.cs becomes a small MP3 the game plays through a
// radio filter (wwwroot/js/pocabinet/audio.js radio()). The lines are scripted and fixed, so the
// clips are assets like any other: players download no model and nothing is generated at run time.
//
//   npm ci --prefix scripts/pocabinet            (once; kokoro-js brings onnxruntime, a few hundred MB)
//   node scripts/pocabinet/radio-voices.mjs            voice whatever has no clip yet
//   node scripts/pocabinet/radio-voices.mjs --force    voice every line again
//   node scripts/pocabinet/radio-voices.mjs --check    no model: list lines with no clip, exit 1 if any
//
// Needs ffmpeg on PATH (the MP3 encode). The model is Kokoro-82M (Apache-2.0), run on the CPU
// through kokoro-js; its weights (about 90 MB) are fetched from Hugging Face the first time and
// cached under node_modules. The four voices are stock ones from that model, picked to tell the
// four officials apart: they imitate nobody.
//
// Output, under src/PoMiniGames.Client/wwwroot/audio/pocabinet/:
//   radio.json                        { voices, lines: { officialId: { "the line": "officialId/1a2b3c4d.mp3" } } }
//   radio/<officialId>/<hash>.mp3     16 kHz mono, 32 kbit/s: a radio band is all the game plays of it
//
// A clip's name is a hash of its voice, speed and text, so a changed line or voice gets a new
// file (the service worker caches these by URL) and a clip nothing points at any more is deleted.
// After editing PoCabinetDialogue.cs run this again; until then the new line is shown and
// blipped but not spoken.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const SOURCE = path.join(repo, 'src', 'PoMiniGames.Shared', 'Games', 'PoCabinetDialogue.cs');
const OUT = path.join(repo, 'src', 'PoMiniGames.Client', 'wwwroot', 'audio', 'pocabinet');
const CLIPS = path.join(OUT, 'radio');
const MANIFEST = path.join(OUT, 'radio.json');
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/** Official id -> the stock voice that reads their lines, and how fast. */
const VOICES = {
    'sean-s': { voice: 'am_puck', speed: 1.0 },
    'steve-b': { voice: 'am_onyx', speed: 0.96 },
    'bill-b': { voice: 'am_fenrir', speed: 1.0 },
    'mike-p': { voice: 'am_michael', speed: 0.97 },
};

const args = new Set(process.argv.slice(2));
const force = args.has('--force'), checkOnly = args.has('--check');

/** The pools, read out of the C# source: { officialId: [line, ...] } (each line once, in file order). */
function readPools() {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const heads = [...src.matchAll(/\["([a-z0-9-]+)"\]\s*=\s*new Dictionary<DialogueKind/g)];
    if (!heads.length) throw new Error(`no official pools found in ${SOURCE}`);
    const pools = {};
    heads.forEach((head, k) => {
        const block = src.slice(head.index, k + 1 < heads.length ? heads[k + 1].index : src.length);
        const lines = [];
        for (const pool of block.matchAll(/\[DialogueKind\.\w+\]\s*=\s*new\[\]\s*\{([\s\S]*?)\}/g)) {
            for (const lit of pool[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
                const text = lit[1].replace(/\\(["\\])/g, '$1');
                if (text && !lines.includes(text)) lines.push(text);
            }
        }
        pools[head[1]] = lines;
    });
    return pools;
}

/** FNV-1a (32 bit) of the UTF-8 bytes, as 8 hex digits. */
function fnv(text) {
    let h = 0x811c9dc5;
    for (const byte of Buffer.from(text, 'utf8')) {
        h ^= byte;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

const clipOf = (id, text) => {
    const v = VOICES[id];
    return `${id}/${fnv(`${v.voice}|${v.speed}|${text}`)}.mp3`;
};

/** Cut the silence off both ends, level it to a common loudness, fade the ends. */
function tidy(samples, rate) {
    // A low threshold and a long lead: a line that opens on a soft consonant ("Fake", "Spin")
    // starts well under the level of its vowels, and a tight trim cuts the consonant off.
    const quiet = 0.004, pad = Math.round(rate * 0.07);
    let a = 0, b = samples.length - 1;
    while (a < b && Math.abs(samples[a]) < quiet) a++;
    while (b > a && Math.abs(samples[b]) < quiet) b--;
    a = Math.max(0, a - pad); b = Math.min(samples.length - 1, b + pad);
    const out = Float32Array.from(samples.subarray(a, b + 1));
    let sum = 0, peak = 0;
    for (const s of out) { sum += s * s; peak = Math.max(peak, Math.abs(s)); }
    const rms = Math.sqrt(sum / Math.max(1, out.length));
    const gain = Math.min(0.1 / Math.max(1e-6, rms), 0.89 / Math.max(1e-6, peak));
    const fade = Math.min(Math.round(rate * 0.006), out.length >> 1);
    for (let i = 0; i < out.length; i++) {
        const edge = Math.min(1, i / fade, (out.length - 1 - i) / fade);
        out[i] *= gain * edge;
    }
    return out;
}

function wav(samples, rate) {
    const buf = Buffer.alloc(44 + samples.length * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
    for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
    return buf;
}

const pools = readPools();
for (const id of Object.keys(pools)) if (!VOICES[id]) throw new Error(`official "${id}" has lines but no voice: add it to VOICES`);
const wanted = {};
let total = 0;
for (const [id, lines] of Object.entries(pools)) {
    wanted[id] = Object.fromEntries(lines.map(text => [text, clipOf(id, text)]));
    total += lines.length;
}
const missing = [];
for (const [id, lines] of Object.entries(wanted)) {
    for (const [text, file] of Object.entries(lines)) {
        if (force || !fs.existsSync(path.join(CLIPS, file))) missing.push({ id, text, file });
    }
}

if (checkOnly) {
    let listed = {};
    try { listed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).lines || {}; } catch { /* no manifest yet */ }
    const unlisted = [];
    for (const [id, lines] of Object.entries(wanted)) {
        for (const [text, file] of Object.entries(lines)) if (listed[id]?.[text] !== file) unlisted.push({ id, text });
    }
    const bad = new Map([...missing, ...unlisted].map(m => [`${m.id}|${m.text}`, m]));
    for (const m of bad.values()) console.log(`no clip: ${m.id}: "${m.text}"`);
    console.log(`${total} lines, ${bad.size} without a clip`);
    process.exit(bad.size ? 1 : 0);
}

if (missing.length) {
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { throw new Error('ffmpeg is not on PATH'); }
    const { KokoroTTS } = await import('kokoro-js');
    const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'cpu' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocabinet-radio-'));
    try {
        for (const [k, m] of missing.entries()) {
            const v = VOICES[m.id];
            const audio = await tts.generate(m.text, { voice: v.voice, speed: v.speed });
            const clean = tidy(audio.audio, audio.sampling_rate);
            const seconds = clean.length / audio.sampling_rate;
            if (seconds < 0.3) throw new Error(`"${m.text}" came out ${seconds.toFixed(2)} s long: not speech`);
            const src = path.join(tmp, 'line.wav');
            fs.writeFileSync(src, wav(clean, audio.sampling_rate));
            const dst = path.join(CLIPS, m.file);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ar', '16000', '-ac', '1',
                '-c:a', 'libmp3lame', '-b:a', '32k', '-map_metadata', '-1', '-write_xing', '0', '-id3v2_version', '0', dst]);
            console.log(`${String(k + 1).padStart(3)}/${missing.length} ${m.id} ${seconds.toFixed(2)} s ${(fs.statSync(dst).size / 1024).toFixed(1)} KB  ${m.text}`);
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// Clips nothing points at any more (a line that was reworded or cut, a voice that changed).
const keep = new Set(Object.values(wanted).flatMap(lines => Object.values(lines)));
let removed = 0, bytes = 0;
for (const id of fs.existsSync(CLIPS) ? fs.readdirSync(CLIPS) : []) {
    const dir = path.join(CLIPS, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
        if (keep.has(`${id}/${name}`)) bytes += fs.statSync(path.join(dir, name)).size;
        else { fs.rmSync(path.join(dir, name)); removed++; }
    }
    if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(MANIFEST, JSON.stringify({
    about: 'PoCabinet radio lines, voiced once by scripts/pocabinet/radio-voices.mjs. Do not edit by hand.',
    model: MODEL,
    voices: VOICES,
    lines: wanted,
}, null, 2) + '\n');
console.log(`${total} lines, ${missing.length} voiced now, ${removed} old clips removed, ${(bytes / 1024).toFixed(0)} KB of clips`);
