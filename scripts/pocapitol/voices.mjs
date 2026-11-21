// Voices PoCapitol's police loudhailer lines (LINES in js/pocapitol/loudhailer.js) once, offline.
//
//   npm ci --prefix scripts/pocapitol         (once; kokoro-js brings Transformers.js and ONNX Runtime)
//   node scripts/pocapitol/voices.mjs          voice the lines that have no clip yet
//   node scripts/pocapitol/voices.mjs --check  no model: list lines with no clip, exit 1 if any
//   node scripts/pocapitol/voices.mjs --force  voice every line again
//
// The model is Kokoro-82M (Apache-2.0) run on the CPU through kokoro-js, which is Transformers.js
// over ONNX Runtime; its weights (about 90 MB) come from Hugging Face the first time and are
// cached under node_modules. Players download no model: they get the MP3s. Needs ffmpeg on PATH,
// which also gives the clips their megaphone sound (a narrow band, driven into a soft clip).
//
// Output, under src/PoMiniGames.Client/wwwroot/audio/pocapitol/:
//   hailer.json                   { lines: { cue: "hailer/<cue>-<hash>.mp3" } }
//   hailer/<cue>-<hash>.mp3       22 kHz mono, 40 kbit/s
// The hash covers the voice and the text, so an edited line gets a new file (the service worker
// caches by URL) and a clip nothing points at any more is deleted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const OUT = path.join(repo, 'src', 'PoMiniGames.Client', 'wwwroot', 'audio', 'pocapitol');
const CLIPS = path.join(OUT, 'hailer');
const MANIFEST = path.join(OUT, 'hailer.json');
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const SPEED = 0.95;

const { LINES } = await import(pathToFileURL(path.join(repo, 'src', 'PoMiniGames.Client', 'wwwroot', 'js', 'pocapitol', 'loudhailer.js')).href);
const args = new Set(process.argv.slice(2));

function fnv(text) {
    let h = 0x811c9dc5;
    for (const byte of Buffer.from(text, 'utf8')) { h ^= byte; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}
const fileOf = (cue, line) => `hailer/${cue}-${fnv(`${line.voice}|${SPEED}|${line.text}`)}.mp3`;

function wav(samples, rate) {
    const buf = Buffer.alloc(44 + samples.length * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
    for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
    return buf;
}

const wanted = Object.fromEntries(Object.entries(LINES).map(([cue, line]) => [cue, fileOf(cue, line)]));
const missing = Object.entries(wanted).filter(([, file]) => args.has('--force') || !fs.existsSync(path.join(OUT, file)));

if (args.has('--check')) {
    let listed = {};
    try { listed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).lines ?? {}; } catch { /* none yet */ }
    const bad = Object.entries(wanted).filter(([cue, file]) => listed[cue] !== file || !fs.existsSync(path.join(OUT, file)));
    for (const [cue] of bad) console.log(`no clip: ${cue}: "${LINES[cue].text}"`);
    console.log(`${Object.keys(wanted).length} lines, ${bad.length} without a clip`);
    process.exit(bad.length ? 1 : 0);
}

if (missing.length) {
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { throw new Error('ffmpeg is not on PATH'); }
    const { KokoroTTS } = await import('kokoro-js');
    const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'cpu' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocapitol-hailer-'));
    fs.mkdirSync(CLIPS, { recursive: true });
    try {
        for (const [cue, file] of missing) {
            const line = LINES[cue];
            const audio = await tts.generate(line.text, { voice: line.voice, speed: SPEED });
            const source = path.join(tmp, `${cue}.wav`);
            fs.writeFileSync(source, wav(audio.audio, audio.sampling_rate));
            // A megaphone: nothing under 500 Hz or over 3.6 kHz, pushed into a soft clip, then
            // levelled so every order is as loud as the others.
            execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', source,
                '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,highpass=f=500,lowpass=f=3600,volume=6dB,asoftclip=type=tanh,loudnorm=I=-16:TP=-1.5',
                '-ar', '22050', '-ac', '1', '-b:a', '40k', path.join(OUT, file)]);
            console.log(`voiced ${cue}: "${line.text}"`);
        }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Clips nothing points at any more go.
const keep = new Set(Object.values(wanted).map(f => path.basename(f)));
for (const name of fs.existsSync(CLIPS) ? fs.readdirSync(CLIPS) : []) if (!keep.has(name)) fs.rmSync(path.join(CLIPS, name));
fs.writeFileSync(MANIFEST, JSON.stringify({ lines: wanted }, null, 2) + '\n');
console.log(`${Object.keys(wanted).length} lines in ${path.relative(repo, MANIFEST)}`);
