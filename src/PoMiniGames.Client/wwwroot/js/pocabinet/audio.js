// pocabinet/audio.js
//
// Web Audio engine for PoCabinet. Zero dependencies, zero assets: every sound is
// synthesized (periodic waves, filtered noise), which keeps wwwroot small and the
// service-worker precache untouched.
//
// Autoplay policy: an AudioContext must be created or resumed inside a user
// gesture. init() is called from the page's "Start race" click (or the first
// gesture: index.js unlocks it on the first pointer or key press); every other entry point
// no-ops until then.
//
// Graph:  voices ─┬──────────────────────────► sfx bus ─┐
//                 └► reverb send ─► convolver A ─► wet A ┤
//                                 └► convolver B ─► wet B ┤
//         music.js score ─► music bus ───────────────────┴► slow-mo lowpass ─► compressor
//                                                            ─► master ─► out
//
//   • music — the adaptive score (music.js, owned here): race state in through setMusic and
//     musicStinger, ducked by the player engine's load and by every impact, off with the
//     `music` setting (setMusicEnabled). Its bus joins before the slow-mo lowpass, so the
//     photo-finish slow motion dips it with everything else; the app's volume and mute
//     and the pause duck are the master's.
//   • acoustic space — the engine, rivals, squeal, scrape, pops and impacts also feed a
//     convolution reverb whose impulse responses are made here at init (decaying stereo
//     noise, one shape per zone: 'stand' a big wide slap off the grandstand, 'metal' a tight
//     bright ring under the gantry, a bridge or between close walls, 'open' near-dry open
//     air, 'room' a small damped bedroom (the toy track: short, dark, carpet and curtains)).
//     setAcoustics(zone, wet) each frame (acoustics.js picks the zone): a new zone is
//     loaded into whichever convolver is silent and the two crossfade, so a switch never
//     clicks.
//   • surface — under the tyres: gravel crunch (a looped grain buffer whose playback rate
//     follows speed), sand drag (low hiss and soft grains), a grass swish, wet-tarmac hiss
//     in the rain and a splash through a puddle (setSurface).
//   • slipstream — setDraft(0..1) from scene.fx.draft: in a tow the wind dips and goes
//     muffled and the engine runs a touch freer; pulling out of one, the wind roars back
//     with a whoosh from the side the car pulled out to.
//
//   • player engine — a V8-ish PeriodicWave (firing order on the 8th harmonic of
//     the cam cycle, cross-plane half-orders for the burble) through a load-driven
//     waveshaper and lowpass, plus AM'd exhaust grit and a gear whine. A virtual
//     six-speed gearbox (the physics has none) turns speed into RPM: upshifts dip
//     the note and pop, lifting off at high RPM crackles, and on the grid the
//     throttle revs it in neutral.
//   • rivals — one lighter voice per other car through an HRTF PannerNode placed
//     where the car is drawn (inverse distance rolloff, duller with distance), pitch-shifted
//     for Doppler from the radial velocity between car and camera (PannerNode no longer does
//     Doppler). race.js hands over only the nearest few; voices that drop out are pooled
//     and reused, so the nearest-N set churning round a pack does not rebuild HRTF nodes.
//   • the bedroom (setRoom: terrain.js isRoom, the 'bedroom' theme) — the toy track: tyres
//     click over the plastic segment seams (seams(), counted along the lap by acoustics.js;
//     the nearest rivals click too, quieter, from where they are), impacts and the rail
//     scrape go plastic-on-plastic, and acoustics.js picks the 'room' reverb.
//   • road + wind noise — rises with speed²; a short slapback delay on the engine
//     swells as the car nears a barrier, panned to that side.
//   • squeal, wall scrape, kerb buzz, impacts (optionally positional; loudness, brightness,
//     pitch and length follow the impact energy, timbre the material), rain on the
//     roof, camera shutters, and the UI pings (countdown, blip,
//     lap chime, fanfare).
//   • slow motion — one control: pulls the master lowpass down and every engine's
//     pitch with it (the photo-finish moment in race.js).
//   • crowd — a positional murmur bed at the grandstand that swells
//     with excitement, plus one-shot cheers (formant-filtered noise and "woo"
//     sweeps). Every exhaust pop (player crackle/shift, rival downshift) is also
//     queued as an event so race.js can put a flame on that car (takePops).
//
// All continuous controls are setTargetAtTime, so per-frame calls never click.

import { Music } from './music.js';
import { lcg, clamp01 } from './util.js';
import { KMH_PER_UNIT, MAX_SPEED } from './physics.js';

let ctx = null;            // AudioContext, created on first user gesture
let master = null;         // master GainNode (mix level, app volume / mute, pause duck)
let bus = null;            // everything feeds this
let slowFilter = null;     // slow-mo lowpass
let noiseBuffer = null;    // 2 s of white noise, shared by every noise source
let engineWave = null;     // PeriodicWave shared by player + rival engines
let driveCurve = null;     // WaveShaper curve for the player engine
let engine = null;         // player engine voice
let road = null;           // { roadGain, windGain, windPan }
let squeal = null;         // { gain, band }
let scrape = null;         // { gain }
let kerb = null;           // { osc, gain }
let rain = null;           // { gain }
let wallFx = null;         // { wet, pan }
let crowd = null;          // { gain, panner, f1 } grandstand murmur
let musicBus = null;       // the score's bus (joins the sfx bus at the slow-mo lowpass)
let music = null;          // music.js Music
let musicEnabled = true;   // the `music` setting (applied whenever the score exists)
let hitBus = null;         // one-shots (impacts, pops, positional cheers): sfx bus + reverb send
let verb = null;           // { send, rivalSend, slots: [{ conv, wet, zone }], active, switchAt }
let irs = null;            // zone → impulse-response AudioBuffer
let surf = null;           // tyre-surface beds (setSurface)
let draftAmt = 0;          // slipstream 0..1 (setDraft)
let draftPeak = 0;
let lastWhoosh = 0;
const rivals = new Map();  // id -> rival voice
const pops = [];           // exhaust-pop events for the flame visuals: { id, strength }

const VOLUME = 0.7;        // the game's mix level under the app's volume
let suspended = false;     // pause-menu duck (distinct from browser suspend)
let hidden = false;        // the tab is in the background
let slowAmount = 0;
let lastShutter = 0;
let lastImpact = 0;
let roomMode = false;      // the bedroom toy track (setRoom): plastic seams, plastic impacts
let seamBus = null;        // seam clicks of the ear car: sfx bus + a little room
let seamClicks = null;     // a few pre-rendered plastic ticks (AudioBuffers)

// ── Virtual gearbox (render-only; physics.js has no gears) ──────────────────
const IDLE_RPM = 950;
const REDLINE = 8200;
const SHIFT_UP = 7700;
const SHIFT_DOWN = 3700;
const GEAR_TOP_KMH = [66, 108, 150, 192, 236, 292];

const player = {
    gear: 1, rpm: IDLE_RPM, load: 0, throttle: 0, lastThrottle: 0,
    lastT: 0, lastCrackle: 0, active: false,
};

/**
 * Speed → gear + RPM with hysteresis. `state.gear` persists between calls.
 * Returns the shift direction this call (+1 up, −1 down, 0 none).
 */
function gearbox(state, kmh, throttle) {
    const rpmIn = g => kmh / GEAR_TOP_KMH[g - 1] * REDLINE;
    const before = state.gear || 1;
    let g = before;
    while (g < 6 && rpmIn(g) > SHIFT_UP) g++;
    while (g > 1 && rpmIn(g) < SHIFT_DOWN && rpmIn(g - 1) < SHIFT_UP - 600) g--;
    state.gear = g;
    let rpm = rpmIn(g);
    // Clutch slip off the line: first gear under ~40 km/h revs with the throttle.
    if (g === 1 && kmh < 40) rpm = Math.max(rpm, IDLE_RPM + throttle * 4200 * (1 - kmh / 40));
    state.rpm = Math.min(REDLINE, Math.max(IDLE_RPM, rpm));
    return g === before ? 0 : (g > before ? 1 : -1);
}

// ── Setup ────────────────────────────────────────────────────────────────────

function makeNoiseBuffer(context) {
    const length = context.sampleRate * 2;
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    const rnd = lcg(0x2f6b1d);
    for (let i = 0; i < length; i++) data[i] = rnd() * 2 - 1;
    return buffer;
}

/**
 * The engine timbre. Fundamental = one cam cycle (RPM / 120), so a V8's four
 * firings per crank turn land on harmonic 8. The half-orders (2, 4, 6, 12…) are
 * what a cross-plane crank's uneven firing adds: that is the burble.
 */
function makeEngineWave(context) {
    const N = 64;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    const strong = { 1: 0.08, 2: 0.25, 3: 0.12, 4: 0.55, 5: 0.1, 6: 0.3, 7: 0.1, 8: 1.0, 10: 0.3, 12: 0.45, 14: 0.2, 16: 0.6, 20: 0.18, 24: 0.35, 32: 0.25, 40: 0.12, 48: 0.1 };
    let seed = 7;
    for (let n = 1; n < N; n++) {
        seed = (seed * 16807) % 2147483647;
        const sign = (seed & 1) ? 1 : -1;
        const amp = strong[n] ?? 0.15 / Math.pow(n, 1.1);
        imag[n] = amp * sign;
    }
    return context.createPeriodicWave(real, imag);
}

function makeDriveCurve() {
    const n = 1024;
    const curve = new Float32Array(n);
    const k = 2.4;
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
        const x = i / (n - 1) * 2 - 1;
        curve[i] = Math.tanh(k * x) / norm;
    }
    return curve;
}

function noiseSource(loop = true) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = loop;
    return src;
}

function filter(type, freq, q = 0.8) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
}

function gainNode(value = 0) {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
}

function buildPlayerEngine() {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(engineWave);
    osc.frequency.value = IDLE_RPM / 120;
    const osc2 = ctx.createOscillator();
    osc2.setPeriodicWave(engineWave);
    osc2.frequency.value = IDLE_RPM / 120;
    osc2.detune.value = 11;
    const osc2Gain = gainNode(0.45);

    const pre = gainNode(0.8);
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve;
    shaper.oversample = '2x';
    const lp = filter('lowpass', 600, 1.1);
    const shift = gainNode(1);       // shift dips
    const out = gainNode(0);         // engine level

    osc.connect(pre);
    osc2.connect(osc2Gain);
    osc2Gain.connect(pre);
    pre.connect(shaper);
    shaper.connect(lp);

    // Exhaust grit: band-passed noise, amplitude-modulated at the firing frequency.
    const grit = noiseSource();
    const gritBand = filter('bandpass', 400, 1.4);
    const gritGain = gainNode(0);
    const am = ctx.createOscillator();
    am.type = 'sine';
    am.frequency.value = IDLE_RPM / 15;
    const amDepth = gainNode(0.03);
    am.connect(amDepth);
    amDepth.connect(gritGain.gain);
    grit.connect(gritBand);
    gritBand.connect(gritGain);
    gritGain.connect(lp);

    lp.connect(shift);
    shift.connect(out);
    out.connect(bus);
    out.connect(verb.send);

    // Gear whine: tracks road speed, not RPM, so it carries on straight through shifts.
    const whine = ctx.createOscillator();
    whine.type = 'sine';
    whine.frequency.value = 200;
    const whineGain = gainNode(0);
    whine.connect(whineGain);
    whineGain.connect(bus);

    // Barrier slapback: a short feedback delay fed from the engine, panned to the wall side.
    const delay = ctx.createDelay(0.2);
    delay.delayTime.value = 0.028;
    const fb = gainNode(0.32);
    const wet = gainNode(0);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    out.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    if (pan) { wet.connect(pan); pan.connect(bus); } else wet.connect(bus);
    wallFx = { wet, pan };

    for (const s of [osc, osc2, grit, am, whine]) s.start();
    return { osc, osc2, pre, lp, shift, out, gritGain, am, amDepth, gritBand, whine, whineGain };
}

function buildBeds() {
    // Road rumble + wind: two noise beds, both scale with speed².
    const src = noiseSource();
    const roadLp = filter('lowpass', 420, 0.7);
    const roadGain = gainNode(0);
    const windBand = filter('bandpass', 1100, 0.5);
    const windLp = filter('lowpass', 9000, 0.7);   // the slipstream muffles the wind
    const windGain = gainNode(0);
    src.connect(roadLp); roadLp.connect(roadGain); roadGain.connect(bus);
    src.connect(windBand); windBand.connect(windLp); windLp.connect(windGain); windGain.connect(bus);
    src.start();
    road = { roadGain, windGain, windBand, windLp };

    // Tire squeal: noise through a resonant bandpass whose centre wobbles.
    const sq = noiseSource();
    const band = filter('bandpass', 1700, 7);
    const sqGain = gainNode(0);
    sq.connect(band); band.connect(sqGain); sqGain.connect(bus); sqGain.connect(verb.send);
    sq.start();
    squeal = { gain: sqGain, band };

    // Wall scrape: bright grinding noise.
    const sc = noiseSource();
    const scBand = filter('bandpass', 2600, 2.5);
    const scGain = gainNode(0);
    sc.connect(scBand); scBand.connect(scGain); scGain.connect(bus); scGain.connect(verb.send);
    sc.start();
    scrape = { gain: scGain, band: scBand };

    // Kerb buzz: a square wave at a speed-dependent rate, low-passed into a rumble.
    const k = ctx.createOscillator();
    k.type = 'square';
    k.frequency.value = 30;
    const kLp = filter('lowpass', 360, 1.5);
    const kGain = gainNode(0);
    k.connect(kLp); kLp.connect(kGain); kGain.connect(bus);
    k.start();
    kerb = { osc: k, gain: kGain };

    // Rain on the roof.
    const r = noiseSource();
    const rHp = filter('highpass', 500, 0.5);
    const rLp = filter('lowpass', 5200, 0.5);
    const rGain = gainNode(0);
    r.connect(rHp); rHp.connect(rLp); rLp.connect(rGain); rGain.connect(bus);
    r.start();
    rain = { gain: rGain };
}

// ── Acoustic space: procedural impulse responses + two crossfaded convolvers ──

/**
 * Per zone: length, tail decay (s, time constant), onset build (diffuse density rising), tail
 * brightness (one-pole coefficient, 1 = unfiltered), early reflections [t, left, right] and
 * metallic rings [Hz, decay s, amplitude].
 */
const IR_SHAPES = {
    // Open country: a short soft bloom off the ground, almost dry.
    open: { dur: 0.45, decay: 0.07, build: 0.004, bright: 0.18, tail: 0.6, early: [[0.011, 0.35, 0.3]], rings: [], seed: 11 },
    // The grandstand: a big wide slap off the stand face, a second off the roof, a long dark tail.
    stand: {
        dur: 2.2, decay: 0.42, build: 0.06, bright: 0.28, tail: 0.5,
        early: [[0.048, 0.9, 0.25], [0.063, 0.3, 0.85], [0.112, 0.55, 0.6], [0.171, 0.35, 0.3], [0.236, 0.2, 0.22]],
        rings: [], seed: 23,
    },
    // Steel overhead or close walls: dense flutter taps, a short bright ring.
    metal: {
        dur: 0.75, decay: 0.11, build: 0.002, bright: 0.9, tail: 0.55,
        early: [[0.004, 0.8, 0.4], [0.009, 0.4, 0.8], [0.0135, 0.65, 0.35], [0.019, 0.3, 0.6], [0.0245, 0.45, 0.25],
            [0.031, 0.2, 0.4], [0.038, 0.3, 0.18], [0.046, 0.14, 0.22]],
        rings: [[1180, 0.16, 0.05], [2470, 0.12, 0.04], [3890, 0.09, 0.03], [5230, 0.07, 0.022]], seed: 37,
    },
    // The bedroom (the toy track): walls a couple of metres off, carpet, bed and curtains soaking
    // it up. Quick floor and wall taps, a short dark tail, no ring; the faint 85 Hz is the room's
    // own boxy mode.
    room: {
        dur: 0.42, decay: 0.055, build: 0.0015, bright: 0.11, tail: 0.7,
        early: [[0.0026, 0.5, 0.45], [0.0071, 0.42, 0.2], [0.0094, 0.18, 0.4], [0.0138, 0.26, 0.22], [0.0192, 0.14, 0.2]],
        rings: [[85, 0.09, 0.03]], seed: 53,
    },
};

function makeIR(shape) {
    const sr = ctx.sampleRate;
    const n = Math.ceil(shape.dur * sr);
    const buf = ctx.createBuffer(2, n, sr);
    const unit = lcg(shape.seed);
    const rnd = () => unit() * 2 - 1;
    const fadeFrom = Math.floor(n * 0.9);
    for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            const env = Math.exp(-t / shape.decay) * Math.min(1, t / shape.build);
            lp += (rnd() * env - lp) * shape.bright;
            d[i] = lp * shape.tail;
        }
        for (const [t, l, r] of shape.early) {
            const at = Math.round(t * sr), g = ch === 0 ? l : r;
            for (let k = 0; k < 64 && at + k < n; k++) d[at + k] += rnd() * g * Math.exp(-k / 10);
        }
        for (const [f, tc, amp] of shape.rings) {
            const w = 2 * Math.PI * f / sr, ph = ch * 1.3 + f * 0.001;
            const len = Math.min(n, Math.ceil(tc * 7 * sr));
            for (let i = 0; i < len; i++) d[i] += amp * Math.sin(w * i + ph) * Math.exp(-i / (tc * sr)) * Math.min(1, i / 96);
        }
        for (let i = fadeFrom; i < n; i++) d[i] *= (n - i) / (n - fadeFrom);
    }
    return buf;
}

function buildReverb() {
    irs = {};
    for (const z of Object.keys(IR_SHAPES)) irs[z] = makeIR(IR_SHAPES[z]);
    const send = gainNode(1);
    const rivalSend = gainNode(0.6);
    rivalSend.connect(send);
    const slots = ['open', 'stand'].map(zone => {
        const conv = ctx.createConvolver();
        conv.buffer = irs[zone];
        const wet = gainNode(0);
        send.connect(conv); conv.connect(wet); wet.connect(bus);
        return { conv, wet, zone };
    });
    verb = { send, rivalSend, slots, active: 0, switchAt: -10 };
    // One-shots: to the mix and into the room.
    hitBus = gainNode(1);
    hitBus.connect(bus);
    hitBus.connect(send);
}

/** Tyre-surface beds: gravel grains, sand drag, grass swish, wet hiss. All silent until setSurface. */
function buildSurface() {
    // A grain buffer: 2 s of sparse, randomly bright noise ticks (~70 a second at rate 1). Looped
    // with a playback rate that follows speed, the grains come faster (and brighter) as the car does.
    const sr = ctx.sampleRate, n = sr * 2;
    const gb = ctx.createBuffer(1, n, sr);
    const d = gb.getChannelData(0);
    const rnd = lcg(0x5eed);
    for (let g = 0; g < 140; g++) {
        const at = Math.floor(rnd() * (n - 800)), len = Math.floor(sr * (0.003 + rnd() * 0.01));
        const amp = 0.3 + rnd() * 0.7, bright = 0.25 + rnd() * 0.7;
        let lp = 0;
        for (let k = 0; k < len; k++) {
            lp += ((rnd() * 2 - 1) - lp) * bright;
            d[at + k] += lp * amp * Math.exp(-k / (len * 0.3));
        }
    }
    const grains = ctx.createBufferSource();
    grains.buffer = gb;
    grains.loop = true;
    const gravelBand = filter('bandpass', 2200, 0.6);
    const gravel = gainNode(0);
    grains.connect(gravelBand); gravelBand.connect(gravel); gravel.connect(bus);
    const sandGrainLp = filter('lowpass', 1500, 0.7);
    const sandGrains = gainNode(0);
    grains.connect(sandGrainLp); sandGrainLp.connect(sandGrains); sandGrains.connect(bus);

    const src = noiseSource();
    const rumbleLp = filter('lowpass', 260, 0.8);
    const rumble = gainNode(0);             // the car's floor rumbling over stones
    src.connect(rumbleLp); rumbleLp.connect(rumble); rumble.connect(bus);
    const sandLp = filter('lowpass', 620, 0.6);
    const sand = gainNode(0);               // sand dragging at the tyres: a low hiss
    src.connect(sandLp); sandLp.connect(sand); sand.connect(bus);
    const grassBand = filter('bandpass', 950, 0.5);
    const grass = gainNode(0);
    src.connect(grassBand); grassBand.connect(grass); grass.connect(bus);
    const wetHp = filter('highpass', 2400, 0.6);
    const wetLp = filter('lowpass', 7000, 0.5);
    const wet = gainNode(0);                // spray off wet tarmac; a puddle opens it up
    src.connect(wetHp); wetHp.connect(wetLp); wetLp.connect(wet); wet.connect(bus);
    grains.start(); src.start();
    surf = { grains, gravel, gravelBand, sandGrains, rumble, sand, grass, wet, wetHp, wetLp };
}

// ── The toy track: plastic segment seams under the tyres ────────────────────

const SEAM_CLICK_VARIANTS = 4;
const SEAM_WHEELBASE = 18;   // sim units, front axle to rear: the rear tyres hit the same seam this much later

/**
 * A few short plastic ticks, rendered once: a hard transient (the tyre dropping into the joint)
 * and the stiff, quickly-damped modes of a moulded track piece. ~30 ms each, peak-normalised.
 */
function buildSeams() {
    const sr = ctx.sampleRate;
    const rnd = lcg(0x5ea4);
    seamClicks = [];
    for (let v = 0; v < SEAM_CLICK_VARIANTS; v++) {
        const n = Math.ceil(sr * 0.03);
        const buf = ctx.createBuffer(1, n, sr);
        const d = buf.getChannelData(0);
        const j = () => 0.9 + rnd() * 0.2;
        const modes = [[720 * j(), 0.008, 0.35], [1680 * j(), 0.0055, 0.55], [2950 * j(), 0.004, 0.4], [4800 * j(), 0.0025, 0.25]];
        const phase = modes.map(() => rnd() * Math.PI * 2);
        let lp = 0, peak = 1e-6;
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            lp += ((rnd() * 2 - 1) - lp) * 0.6;
            let s = lp * Math.exp(-t / 0.0012) * 0.9;
            for (let m = 0; m < modes.length; m++) {
                const [f, tc, a] = modes[m];
                s += a * Math.sin(2 * Math.PI * f * t + phase[m]) * Math.exp(-t / tc);
            }
            d[i] = s * Math.min(1, i / 6);
            peak = Math.max(peak, Math.abs(d[i]));
        }
        for (let i = 0; i < n; i++) d[i] /= peak;
        seamClicks.push(buf);
    }
    seamBus = gainNode(1);
    seamBus.connect(bus);
    const send = gainNode(0.5);
    seamBus.connect(send);
    send.connect(verb.send);
}

/** One plastic tick at `at` (context time) into `dest`. Two nodes, released when it ends. */
function seamClick(at, level, rate, dest) {
    const src = ctx.createBufferSource();
    src.buffer = seamClicks[Math.floor(Math.random() * SEAM_CLICK_VARIANTS)];
    src.playbackRate.value = rate;
    const g = gainNode(level);
    src.connect(g);
    g.connect(dest);
    src.start(at);
}

/** Schedule `count` seams (front + rear axle each) evenly over the next `span` seconds. */
function seamRun(count, speed, span, level, dest) {
    const u = Math.abs(Number(speed) || 0);
    if (u < 3) return;
    const s01 = Math.min(1, u / MAX_SPEED);
    const t0 = ctx.currentTime + 0.012;     // a hair of lookahead: never schedule in the past
    const rear = Math.min(0.3, SEAM_WHEELBASE / u);
    // Faster is a harder knock: louder and a touch brighter (the tick played a little quicker).
    const lvl = level * (0.3 + 0.7 * s01);
    const rate = (0.88 + 0.28 * s01) * (1 - slowAmount * 0.4);
    const n = Math.min(6, count);
    for (let i = 0; i < n; i++) {
        const at = t0 + span * i / n;
        seamClick(at, lvl * (0.8 + Math.random() * 0.4), rate * (0.95 + Math.random() * 0.1), dest);
        seamClick(at + rear, lvl * (0.6 + Math.random() * 0.3), rate * (0.93 + Math.random() * 0.1), dest);
    }
}

/**
 * The ear car's tyres crossed `count` toy-track seams since the last call, at `speed` (sim
 * units/s), spread over `span` seconds (the frame). Room tracks only (setRoom); acoustics.js
 * counts the seams along the lap.
 */
export function seams(count, speed, span = 1 / 60) {
    if (!ctx || !seamBus || !roomMode || !player.active || !(count > 0)) return;
    seamRun(count, speed, Math.min(0.1, Math.max(0, Number(span) || 0)), 0.16, seamBus);
}

/**
 * The bedroom's toy track (terrain.js isRoom) or not: seams click, impacts go plastic, the rail
 * scrape is a lower plastic scuff. Safe before init (applied when the context exists).
 */
export function setRoom(on) {
    roomMode = !!on;
    applyRoomTimbre();
}

function applyRoomTimbre() {
    if (!ctx || !scrape?.band) return;
    const t = ctx.currentTime;
    scrape.band.frequency.setTargetAtTime(roomMode ? 1750 : 2600, t, 0.05);
    scrape.band.Q.setTargetAtTime(roomMode ? 1.5 : 2.5, t, 0.05);
}

/** Create/resume the AudioContext. Must be called from a user-gesture call path. */
export function init() {
    try {
        if (!ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return false;
            ctx = new Ctx();
            noiseBuffer = makeNoiseBuffer(ctx);
            engineWave = makeEngineWave(ctx);
            driveCurve = makeDriveCurve();

            master = gainNode(0);
            applyMasterGain();
            const comp = ctx.createDynamicsCompressor();
            comp.threshold.value = -16;
            comp.knee.value = 12;
            comp.ratio.value = 4;
            comp.attack.value = 0.004;
            comp.release.value = 0.2;
            slowFilter = filter('lowpass', 20000, 0.7);
            bus = gainNode(1);
            bus.connect(slowFilter);
            slowFilter.connect(comp);
            comp.connect(master);
            master.connect(ctx.destination);
            musicBus = gainNode(1);
            musicBus.connect(slowFilter);

            buildReverb();
            engine = buildPlayerEngine();
            buildBeds();
            buildSurface();
            buildSeams();
            buildCrowd();
            applyRoomTimbre();
            try {
                music = new Music(ctx, noiseBuffer, musicBus);
                music.setEnabled(musicEnabled);
                music.setPaused(suspended);
            } catch { music = null; /* the race runs without a score */ }
        }
        if (ctx.state === 'suspended') void ctx.resume();
        return true;
    } catch {
        return false;
    }
}

// This engine keeps its own AudioContext (world-space panners and a listener on the
// car), so it is not under the app's master gain and follows the app-wide volume and
// mute by asking the shared bus.
function applyMasterGain() {
    if (!master) return;
    const app = window.PoAudioBus;
    const appMuted = app?.isMuted?.() === true;
    const appVolume = app?.getVolume?.() ?? 1;
    const target = (suspended || hidden || appMuted) ? 0 : VOLUME * appVolume;
    master.gain.setTargetAtTime(target, ctx.currentTime, 0.05);
}
if (typeof window !== 'undefined') {
    window.addEventListener('po-audio-change', () => { if (ctx) applyMasterGain(); });
}

/** Pause-menu duck: true = silence everything without tearing down nodes. */
export function setSuspended(s) {
    suspended = !!s;
    if (ctx) applyMasterGain();
    music?.setPaused(suspended || hidden);
}

/** The tab went to the background (or came back): silent while hidden, whatever the race is doing. */
export function setHidden(h) {
    hidden = !!h;
    if (ctx) applyMasterGain();
    music?.setPaused(suspended || hidden);
}

/** The `music` setting: the adaptive score on or off (fades; no notes are booked while off). */
export function setMusicEnabled(on) {
    musicEnabled = on !== false;
    music?.setEnabled(musicEnabled);
}

// ── Player engine ────────────────────────────────────────────────────────────

/**
 * Drive the player's engine. Called every render frame.
 *   speedKmh — the player car's speed
 *   throttle — 0..1 pedal (drives load: brightness, drive, level)
 *   phase    — 'race' (follow the car), 'grid' (neutral revs before GO),
 *              'off' (fade out: replay, results, teardown)
 * The gearbox runs even before the AudioContext exists, so the gauge's gear
 * readout and shift lights work with sound off.
 */
export function updateEngine(speedKmh, throttle = 0, phase = 'race') {
    const kmh = Math.max(0, Number(speedKmh) || 0);
    const thr = clamp01(Number(throttle) || 0);
    const now = ctx ? ctx.currentTime : performance.now() / 1000;
    const dt = player.lastT ? Math.min(0.1, Math.max(0, now - player.lastT)) : 0;
    player.lastT = now;
    player.load += (thr - player.load) * (1 - Math.exp(-dt * 9));
    player.active = phase !== 'off';

    let shifted = 0;
    if (phase === 'grid') {
        player.gear = 1;
        const target = IDLE_RPM + player.load * 6600;
        player.rpm += (target - player.rpm) * (1 - Math.exp(-dt * (target > player.rpm ? 7 : 3)));
    } else {
        shifted = gearbox(player, kmh, thr);
    }

    if (!ctx || !engine) { player.lastThrottle = thr; return; }
    const t = ctx.currentTime;
    const pitch = 1 - slowAmount * 0.42;
    const rpm = player.rpm;
    const r01 = (rpm - IDLE_RPM) / (REDLINE - IDLE_RPM);
    const load = player.load;
    const base = rpm / 120 * pitch;
    const tc = shifted ? 0.03 : 0.05;
    engine.osc.frequency.setTargetAtTime(base, t, tc);
    engine.osc2.frequency.setTargetAtTime(base, t, tc);
    engine.am.frequency.setTargetAtTime(rpm / 15 * pitch, t, tc);
    engine.gritBand.frequency.setTargetAtTime(rpm / 15 * 2.2 * pitch, t, 0.06);
    // In a tow the engine runs a touch freer: less strain in the drive, a little more top end.
    engine.lp.frequency.setTargetAtTime((320 + rpm * 0.22 + load * rpm * 0.34) * (1 + draftAmt * 0.18), t, 0.06);
    engine.pre.gain.setTargetAtTime((0.55 + load * 1.3) * (1 - draftAmt * 0.16), t, 0.06);
    engine.amDepth.gain.setTargetAtTime(0.02 + load * 0.07, t, 0.08);
    const level = player.active ? (0.09 + r01 * 0.06) * (0.55 + load * 0.45) : 0;
    engine.out.gain.setTargetAtTime(level, t, player.active ? 0.08 : 0.25);

    const s01 = Math.min(1, kmh / 280);
    engine.whine.frequency.setTargetAtTime((180 + s01 * 1100) * pitch, t, 0.08);
    engine.whineGain.gain.setTargetAtTime(player.active && phase === 'race' ? s01 * 0.012 * (0.4 + load) : 0, t, 0.1);
    road.roadGain.gain.setTargetAtTime(player.active && phase === 'race' ? s01 * s01 * 0.09 : 0, t, 0.12);
    road.windGain.gain.setTargetAtTime(player.active && phase === 'race' ? s01 * s01 * 0.05 * (1 - draftAmt * 0.65) : 0, t, 0.12);
    road.windBand.frequency.setTargetAtTime(700 + s01 * 1400, t, 0.2);
    // The score ducks under a working engine (sidechain style; impacts punch it separately).
    music?.duck(player.active && phase === 'race' ? load * (0.5 + 0.5 * r01) : 0);

    if (shifted > 0 && player.active) {
        engine.shift.gain.cancelScheduledValues(t);
        engine.shift.gain.setValueAtTime(1, t);
        engine.shift.gain.linearRampToValueAtTime(0.3, t + 0.04);
        engine.shift.gain.linearRampToValueAtTime(1, t + 0.14);
        crackle(2, 0.06, 0.7);
        pops.push({ id: 'player', strength: 0.5 });
    }
    // Downshift under braking: a heel-and-toe blip (the note jumps, then settles) and a pop.
    if (shifted < 0 && player.active && phase === 'race' && thr < 0.2 && kmh > 60) {
        engine.shift.gain.cancelScheduledValues(t);
        engine.shift.gain.setValueAtTime(1, t);
        engine.shift.gain.linearRampToValueAtTime(1.35, t + 0.03);
        engine.shift.gain.linearRampToValueAtTime(1, t + 0.16);
        engine.osc.detune.cancelScheduledValues(t);
        engine.osc.detune.setValueAtTime(0, t);
        engine.osc.detune.linearRampToValueAtTime(260, t + 0.04);
        engine.osc.detune.linearRampToValueAtTime(0, t + 0.2);
        crackle(3, 0.12, 0.65);
        pops.push({ id: 'player', strength: 0.6 });
    }
    // Lift-off overrun: throttle snapped shut at high RPM → exhaust crackle.
    if (player.active && phase === 'race' && player.lastThrottle > 0.55 && thr < 0.1 && rpm > 4800
        && t - player.lastCrackle > 0.8) {
        player.lastCrackle = t;
        crackle(4 + Math.floor(Math.random() * 5), 0.55, 1);
        pops.push({ id: 'player', strength: 1 });
    }
    player.lastThrottle = thr;
}

/** Gear, RPM and redline for the glass gauge. */
export function engineState() {
    return { gear: player.gear, rpm: player.rpm, redline: REDLINE, idle: IDLE_RPM };
}

/** Exhaust pops since the last call — race.js turns each into a flame on that car. */
export function takePops() {
    return pops.splice(0, pops.length);
}

/** A burst of short exhaust pops spread over `spread` seconds (optionally into a panner). */
function crackle(count, spread, strength, dest) {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    for (let i = 0; i < count; i++) {
        const t = t0 + Math.random() * spread;
        const dur = 0.012 + Math.random() * 0.025;
        const src = noiseSource(false);
        const band = filter('bandpass', 700 + Math.random() * 2000, 0.9);
        const g = gainNode(0);
        const peak = (0.12 + Math.random() * 0.2) * strength;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(band); band.connect(g); g.connect(dest || hitBus || bus);
        src.start(t, Math.random() * 1.5, dur + 0.02);
        if (Math.random() < 0.35) sweep(95, 55, 0.05, 'sine', peak * 0.8, t, dest);
    }
}

/** One oscillator sweep with an exponential decay — thumps, pops, chirps. */
function sweep(f0, f1, dur, type, peak, at, dest) {
    if (!ctx) return;
    const t = at ?? ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = gainNode(0);
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(dest || hitBus || bus);
    o.start(t);
    o.stop(t + dur + 0.03);
}

/** A noise burst through a filter. */
function burst(type, freq, q, dur, peak, at, dest) {
    if (!ctx) return;
    const t = at ?? ctx.currentTime;
    const src = noiseSource(false);
    const f = filter(type, freq, q);
    const g = gainNode(0);
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(dest || hitBus || bus);
    src.start(t, Math.random() * 1.5, dur + 0.03);
}

// ── Continuous effects ───────────────────────────────────────────────────────

/** Tire squeal. `amount` 0..1 (true = 1); pitch rises with speed. */
export function setSqueal(amount, speedKmh = 150) {
    if (!ctx || !squeal) return;
    const a = amount === true ? 1 : clamp01(Number(amount) || 0);
    const t = ctx.currentTime;
    squeal.gain.gain.setTargetAtTime(a * 0.07, t, 0.06);
    const s01 = Math.min(1, (Number(speedKmh) || 0) / 280);
    squeal.band.frequency.setTargetAtTime((1350 + s01 * 700 + Math.sin(t * 23) * 90) * (1 - slowAmount * 0.4), t, 0.05);
}

/** Metal-on-barrier grind while the car rides the wall. */
export function setScrape(amount) {
    if (!ctx || !scrape) return;
    scrape.gain.gain.setTargetAtTime(clamp01(amount) * 0.06, ctx.currentTime, 0.05);
}

/** Kerb buzz. The rate follows speed, as stripes pass under the tyres faster. */
export function setKerb(on, speedKmh) {
    if (!ctx || !kerb) return;
    const t = ctx.currentTime;
    kerb.osc.frequency.setTargetAtTime((22 + (Number(speedKmh) || 0) * 0.18) * (1 - slowAmount * 0.4), t, 0.03);
    kerb.gain.gain.setTargetAtTime(on ? 0.1 : 0, t, on ? 0.015 : 0.05);
}

/** Barrier proximity: 0..1 slapback, panned to `side` (−1 left … +1 right). */
export function setWallProximity(amount, side) {
    if (!ctx || !wallFx) return;
    const t = ctx.currentTime;
    const a = clamp01(Number(amount) || 0);
    wallFx.wet.gain.setTargetAtTime(a * 0.55, t, 0.08);
    if (wallFx.pan) wallFx.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, Number(side) || 0)) * 0.8, t, 0.1);
}

/** Rain on the roof, 0..1. */
export function setRain(level) {
    if (!ctx || !rain) return;
    rain.gain.gain.setTargetAtTime(clamp01(Number(level) || 0) * 0.035, ctx.currentTime, 0.6);
}

/** Slow motion 0..1: lowpass the whole mix and drop every engine's pitch. */
export function setSlowMo(amount) {
    slowAmount = clamp01(Number(amount) || 0);
    if (!ctx || !slowFilter) return;
    const cutoff = 20000 * Math.pow(650 / 20000, slowAmount);
    slowFilter.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.08);
}

/** Silence everything race-owned (engine, beds, rivals). Rain belongs to the weather (environment.js). */
export function silenceRace() {
    updateEngine(0, 0, 'off');
    setSqueal(0);
    setScrape(0);
    setKerb(false, 0);
    setWallProximity(0, 0);
    setSlowMo(0);
    updateRivals([]);
    setCrowd(0);
    setSurface('road', 0, false, 0);
    setDraft(0, 0);
    music?.stop();
    pops.length = 0;
}

// ── Music, acoustic space, surface, slipstream (acoustics.js drives these per frame) ──

/** The score's race state: { phase: 'off'|'grid'|'race'|'finish', battle 0..1, finalLap }. */
export function setMusic(state) {
    if (!ctx || !music) return;
    try { music.update(state); } catch { /* never let the score kill the race */ }
}

/** An overtake by the car heard up close: stinger + sweep. */
export function musicStinger() {
    try { music?.stinger(); } catch { /* decoration */ }
}

/**
 * The room the ear is in: zone 'open' | 'stand' | 'metal' | 'room', wet 0..1 (reverb send level).
 * A new zone loads into the convolver that has been silent at least a second, then the two
 * crossfade; the switch is held off until then, so flicking between zones never clicks.
 */
export function setAcoustics(zone, wet) {
    if (!ctx || !verb || !irs?.[zone]) return;
    const t = ctx.currentTime;
    const w = clamp01(Number(wet) || 0);
    if (zone !== verb.slots[verb.active].zone && t - verb.switchAt > 1) {
        const next = 1 - verb.active;
        const s = verb.slots[next];
        if (s.zone !== zone) { s.conv.buffer = irs[zone]; s.zone = zone; }
        verb.active = next;
        verb.switchAt = t;
    }
    verb.slots.forEach((s, i) => s.wet.gain.setTargetAtTime(i === verb.active ? w : 0, t, 0.18));
}

/**
 * What the ear car's tyres are on: kind 'road' | 'gravel' | 'sand' | 'grass', its speed,
 * whether the tarmac is wet, and how deep into a puddle it is (0..1). The kerb buzz is setKerb.
 */
export function setSurface(kind, speedKmh, wet = false, puddle = 0) {
    if (!ctx || !surf) return;
    const t = ctx.currentTime;
    const kmh = Math.max(0, Number(speedKmh) || 0);
    const s01 = Math.min(1, kmh / 250);
    const moving = kmh > 3 ? 1 : 0;
    const slow = 1 - slowAmount * 0.4;
    const on = k => (kind === k ? moving : 0);
    // Gravel: grains come faster with speed (rate ∝ speed), the floor rumbles over the stones.
    surf.grains.playbackRate.setTargetAtTime((0.35 + 1.9 * s01) * slow, t, 0.08);
    surf.gravel.gain.setTargetAtTime(on('gravel') * (0.12 + 0.3 * s01), t, 0.05);
    surf.gravelBand.frequency.setTargetAtTime((1500 + 1600 * s01) * slow, t, 0.1);
    surf.rumble.gain.setTargetAtTime((on('gravel') + on('sand') * 0.6) * (0.05 + 0.1 * s01), t, 0.06);
    // Sand: a low drag hiss and soft, muffled grains.
    surf.sand.gain.setTargetAtTime(on('sand') * (0.04 + 0.1 * s01), t, 0.08);
    surf.sandGrains.gain.setTargetAtTime(on('sand') * 0.12 * s01, t, 0.08);
    surf.grass.gain.setTargetAtTime(on('grass') * (0.012 + 0.04 * s01), t, 0.08);
    // Wet tarmac: spray hiss with speed; a puddle throws a fuller, lower splash.
    const p = clamp01(Number(puddle) || 0);
    const wetOn = wet && kind === 'road' ? moving : 0;
    surf.wet.gain.setTargetAtTime(wetOn * (s01 * s01 * 0.05 + p * s01 * 0.09), t, p > 0 ? 0.03 : 0.15);
    surf.wetHp.frequency.setTargetAtTime(2400 - p * 1700, t, 0.05);
}

/**
 * Slipstream 0..1 for the ear car (scene.fx.draft). In the tow the wind dips and goes muffled
 * (updateEngine reads the amount too: wind level, engine freer); pulling out of a real tow,
 * the wind roars back with a whoosh, panned to `side` (−1 left … +1 right: where the car went).
 */
export function setDraft(amount, side = 0) {
    const d = clamp01(Number(amount) || 0);
    draftAmt = d;
    if (!ctx || !road) return;
    const t = ctx.currentTime;
    road.windLp.frequency.setTargetAtTime(9000 * Math.pow(750 / 9000, d), t, d > draftPeak ? 0.25 : 0.08);
    if (d > draftPeak) draftPeak = d;
    if (draftPeak > 0.4 && d < 0.15) {
        if (t - lastWhoosh > 1.2 && player.active) {
            lastWhoosh = t;
            whoosh(Math.min(1, draftPeak), side);
        }
        draftPeak = d;
    }
}

/** Air rushing back: band-passed noise sweeping up and away. */
function whoosh(strength, side) {
    const t = ctx.currentTime;
    const src = noiseSource(false);
    const f = filter('bandpass', 420, 0.9);
    f.frequency.setValueAtTime(420, t);
    f.frequency.exponentialRampToValueAtTime(2600, t + 0.35);
    f.frequency.exponentialRampToValueAtTime(1200, t + 0.8);
    const g = gainNode(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09 * strength, t + 0.14);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.85);
    src.connect(f); f.connect(g);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { pan.pan.value = Math.max(-1, Math.min(1, Number(side) || 0)) * 0.7; g.connect(pan); pan.connect(bus); } else g.connect(bus);
    src.start(t, Math.random() * 1.2, 0.9);
}

// ── Rivals: positional engines with Doppler ──────────────────────────────────

/** Sim units between two toy-track segment joints (the bedroom): ~7 seams a second at full speed. */
export const SEAM_SPACING = 20;
const SOUND_SPEED = 60;          // world units/s: tuned so a pass-by bends, not warbles
const listenerPos = { x: 0, y: 0, z: 0 };
const listenerVel = { x: 0, y: 0, z: 0 };

function makePanner() {
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 3;
    p.rolloffFactor = 1.1;
    p.maxDistance = 400;
    return p;
}

function setPannerPosition(p, x, y, z, snap = false) {
    const t = ctx.currentTime;
    if (p.positionX) {
        if (snap) {
            for (const [a, val] of [[p.positionX, x], [p.positionY, y], [p.positionZ, z]]) { a.cancelScheduledValues(t); a.setValueAtTime(val, t); }
            return;
        }
        p.positionX.setTargetAtTime(x, t, 0.02);
        p.positionY.setTargetAtTime(y, t, 0.02);
        p.positionZ.setTargetAtTime(z, t, 0.02);
    } else {
        p.setPosition(x, y, z);
    }
}

/**
 * Place the listener (the camera). pos/fwd/up are {x,y,z}; vel is the camera's
 * velocity in world units/s (drives Doppler).
 */
export function updateListener(pos, fwd, up, vel) {
    if (pos) { listenerPos.x = pos.x; listenerPos.y = pos.y; listenerPos.z = pos.z; }
    if (vel) { listenerVel.x = vel.x; listenerVel.y = vel.y; listenerVel.z = vel.z; }
    if (!ctx || !pos || !fwd) return;
    const l = ctx.listener;
    const t = ctx.currentTime;
    const u = up || { x: 0, y: 1, z: 0 };
    try {
        if (l.positionX) {
            l.positionX.setTargetAtTime(pos.x, t, 0.02);
            l.positionY.setTargetAtTime(pos.y, t, 0.02);
            l.positionZ.setTargetAtTime(pos.z, t, 0.02);
            l.forwardX.setTargetAtTime(fwd.x, t, 0.02);
            l.forwardY.setTargetAtTime(fwd.y, t, 0.02);
            l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
            l.upX.setTargetAtTime(u.x, t, 0.02);
            l.upY.setTargetAtTime(u.y, t, 0.02);
            l.upZ.setTargetAtTime(u.z, t, 0.02);
        } else {
            l.setPosition(pos.x, pos.y, pos.z);
            l.setOrientation(fwd.x, fwd.y, fwd.z, u.x, u.y, u.z);
        }
    } catch { /* listener is best-effort */ }
}

const RIVAL_SPARES = 3;           // faded-out voices kept for reuse (the nearest-N set churns in a pack)
const SEAM_NEAR = 7;              // world units: a rival this close is heard clicking over the seams
const SEAM_RIVALS = 2;            // and at most this many at once
const spareRivals = [];
let lastRivalStamp = 0;

/** A rival engine: oscillator → lowpass → gain → HRTF panner. Reuses a parked voice when one is spare. */
function makeRivalVoice(r) {
    const spare = spareRivals.pop();
    if (spare) {
        clearTimeout(spare.detachTimer);
        if (spare.detached) { spare.g.connect(spare.panner); spare.detached = false; }
        spare.state = { gear: 1, rpm: IDLE_RPM };
        spare.lastKmh = 0; spare.seamAcc = 0; spare.doppler = 1;
        setPannerPosition(spare.panner, r.x, r.y || 0.5, r.z, true);   // no sweep from where it was last
        return spare;
    }
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(engineWave);
    osc.frequency.value = IDLE_RPM / 120;
    const lp = filter('lowpass', 900, 0.9);
    const g = gainNode(0);
    const panner = makePanner();
    osc.connect(lp); lp.connect(g); g.connect(panner); panner.connect(bus); panner.connect(verb.rivalSend);
    osc.start();
    setPannerPosition(panner, r.x, r.y || 0.5, r.z, true);
    return { osc, lp, g, panner, state: { gear: 1, rpm: IDLE_RPM }, lastKmh: 0, seen: 0, seamAcc: 0, doppler: 1, detached: false, detachTimer: 0 };
}

/** Fade a rival out; park it for reuse (its panner unhooked once silent, so HRTF stops working), else release it. */
function dropRival(id, v) {
    rivals.delete(id);
    try {
        const t = ctx.currentTime;
        v.g.gain.setTargetAtTime(0, t, 0.05);
        if (spareRivals.length < RIVAL_SPARES) {
            spareRivals.push(v);
            v.detachTimer = window.setTimeout(() => {
                try { v.g.disconnect(); v.detached = true; } catch { /* gone */ }
            }, 400);
            return;
        }
        v.osc.stop(t + 0.3);
        window.setTimeout(() => { try { v.panner.disconnect(); } catch { /* gone */ } }, 400);
    } catch { /* already stopped */ }
}

/**
 * Every other car's engine, in world units: [{ id, x, y, z, vx, vy?, vz, kmh }] (race.js sends
 * the nearest few). Each sits where the car is drawn; Doppler is worked out here from the
 * radial velocity between car and listener. Cars missing from the list fade out and are released.
 */
export function updateRivals(list) {
    if (!ctx) return;
    const stamp = performance.now();
    const dt = lastRivalStamp ? Math.min(0.1, Math.max(0, (stamp - lastRivalStamp) / 1000)) : 0;
    lastRivalStamp = stamp;
    const t = ctx.currentTime;
    let clicking = 0;
    for (const r of list || []) {
        let v = rivals.get(r.id);
        if (!v) { v = makeRivalVoice(r); rivals.set(r.id, v); }
        v.seen = stamp;
        const kmh = Math.max(0, Number(r.kmh) || 0);
        const accel = kmh - v.lastKmh;
        v.lastKmh = kmh;
        const shift = gearbox(v.state, kmh, accel > 0 ? 1 : 0);
        // A rival braking hard for a corner pops on the downshift, from where it is.
        if (shift < 0 && accel < -0.4 && kmh > 70 && Math.random() < 0.6) {
            crackle(2 + Math.floor(Math.random() * 3), 0.1, 0.8, v.panner);
            pops.push({ id: r.id, strength: 0.6 });
        }

        const dx = r.x - listenerPos.x, dy = (r.y || 0) - listenerPos.y, dz = r.z - listenerPos.z;
        const d = Math.hypot(dx, dy, dz) || 1;
        const nx = dx / d, ny = dy / d, nz = dz / d;
        // Radial speeds along listener → car: the car receding (vs > 0) drops the note, the
        // listener closing on it (vl > 0) raises it. Smoothed a touch so a close pass bends, not snaps.
        const vs = (r.vx || 0) * nx + (r.vy || 0) * ny + (r.vz || 0) * nz;
        const vl = listenerVel.x * nx + listenerVel.y * ny + listenerVel.z * nz;
        const target = Math.min(1.5, Math.max(0.65, (SOUND_SPEED + vl) / Math.max(1, SOUND_SPEED + vs)));
        v.doppler += (target - v.doppler) * (dt > 0 ? 1 - Math.exp(-dt * 14) : 1);

        const pitch = v.doppler * (1 - slowAmount * 0.42);
        v.osc.frequency.setTargetAtTime(v.state.rpm / 120 * pitch, t, 0.05);
        const r01 = (v.state.rpm - IDLE_RPM) / (REDLINE - IDLE_RPM);
        // Air takes the top off a far car (the panner's rolloff handles the level).
        const air = Math.min(1, Math.max(0.45, 1.1 - d / 300));
        v.lp.frequency.setTargetAtTime((500 + v.state.rpm * 0.35) * air, t, 0.08);
        v.g.gain.setTargetAtTime(0.16 + r01 * 0.14, t, 0.1);
        setPannerPosition(v.panner, r.x, r.y || 0.5, r.z);

        // The toy track: a rival close by clicks over the seams too, quieter, from where it is.
        if (roomMode && seamClicks && dt > 0) {
            const u = kmh / KMH_PER_UNIT;
            v.seamAcc += u * dt;
            if (v.seamAcc > SEAM_SPACING * 6) v.seamAcc %= SEAM_SPACING;
            let n = 0;
            while (v.seamAcc >= SEAM_SPACING) { v.seamAcc -= SEAM_SPACING; n++; }
            if (n > 0 && d < SEAM_NEAR && clicking < SEAM_RIVALS) {
                clicking++;
                seamRun(n, u, dt, 0.1 * (1 - d / SEAM_NEAR * 0.5), v.panner);
            }
        }
    }
    for (const [id, v] of rivals) if (v.seen !== stamp) dropRival(id, v);
}

// ── Crowd: grandstand murmur + cheers ────────────────────────────────────────

/** Two vowel-ish formants over noise, slowly amplitude-wandering: a crowd you are near. */
function buildCrowd() {
    const src = noiseSource();
    const f1 = filter('bandpass', 520, 1.6), f2 = filter('bandpass', 1450, 2.2);
    const mix = gainNode(1);
    const wander = ctx.createOscillator();
    wander.frequency.value = 0.37;
    const wanderDepth = gainNode(0.25);
    wander.connect(wanderDepth);
    wanderDepth.connect(mix.gain);
    src.connect(f1); src.connect(f2);
    f1.connect(mix); f2.connect(mix);
    const gain = gainNode(0);
    const panner = makePanner();
    panner.refDistance = 8;
    mix.connect(gain); gain.connect(panner); panner.connect(bus);
    src.start(); wander.start();
    crowd = { gain, panner, f1 };
}

/**
 * The grandstand bed: `level` 0..1 excitement (0 = no crowd on this track, or no
 * race), `pos` its world position. Called every frame by race.js.
 */
export function setCrowd(level, pos) {
    if (!ctx || !crowd) return;
    const t = ctx.currentTime;
    const l = clamp01(Number(level) || 0);
    crowd.gain.gain.setTargetAtTime(l > 0 ? 0.05 + l * 0.22 : 0, t, 0.35);
    crowd.f1.frequency.setTargetAtTime(480 + l * 220, t, 0.4);
    if (pos) setPannerPosition(crowd.panner, pos.x, pos.y ?? 2, pos.z);
}

/**
 * A cheer: a swell of shouting noise and a handful of rising "woo" voices.
 * `strength` 0..1; `pos` makes it positional (the grandstand), null = all around.
 */
export function cheer(strength = 1, pos = null) {
    if (!ctx) return;
    const s = Math.min(1, Math.max(0.1, Number(strength) || 0));
    const t = ctx.currentTime;
    const dest = oneShotDest(pos) || bus;
    const dur = 1.4 + s * 1.6;
    for (const [freq, q] of [[600, 1.2], [1300, 1.8], [2500, 2.5]]) {
        const src = noiseSource(false);
        const f = filter('bandpass', freq, q);
        const g = gainNode(0);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.16 * s, t + 0.25);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(f); f.connect(g); g.connect(dest);
        src.start(t, Math.random() * 1.2, dur + 0.05);
    }
    const voices = 3 + Math.round(s * 5);
    for (let i = 0; i < voices; i++) {
        const at = t + Math.random() * 0.5;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        const f0 = 240 + Math.random() * 260;
        o.frequency.setValueAtTime(f0, at);
        o.frequency.exponentialRampToValueAtTime(f0 * (1.5 + Math.random() * 0.5), at + 0.35);
        o.frequency.exponentialRampToValueAtTime(f0 * 1.1, at + 0.9);
        const band = filter('bandpass', 900 + Math.random() * 600, 3);
        const g = gainNode(0);
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.025 * s, at + 0.1);
        g.gain.exponentialRampToValueAtTime(0.001, at + 1);
        o.connect(band); band.connect(g); g.connect(dest);
        o.start(at);
        o.stop(at + 1.05);
    }
}

// ── One-shots ────────────────────────────────────────────────────────────────

/** Route a one-shot through a temporary panner when it has a world position. */
function oneShotDest(pos) {
    if (!pos) return null;
    const p = makePanner();
    setPannerPosition(p, pos.x, pos.y ?? 0.5, pos.z);
    p.connect(hitBus || bus);
    window.setTimeout(() => { try { p.disconnect(); } catch { /* gone */ } }, 1500);
    return p;
}

/**
 * A crash. `strength` 0..1 is the impact energy as race.js scales it (wall closing speed, or the
 * contact's relative speed); kind 'wall' | 'car'. Loudness, brightness, pitch and length all
 * follow it: a brush is a dull, short, low tap, a big hit a bright, long crunch. The material is
 * the track's: tarmac-and-steel (a thump, a crunch, a metal ring) or, on the bedroom's toy
 * track, plastic on plastic (plasticImpact). `pos` (world units) makes it positional — a rival's
 * shunt heard from where it happened.
 */
export function impact(strength, kind = 'wall', pos = null) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastImpact < 0.09) return;
    lastImpact = t;
    const s = Math.min(1, Math.max(0.1, Number(strength) || 0));
    const dest = oneShotDest(pos);
    const car = kind === 'car';
    // The score flinches with a hit near the ear (one heard from afar barely moves it).
    music?.hit(pos ? s * 0.35 : s);
    if (roomMode) { plasticImpact(s, car, t, dest); return; }
    // Energy shapes the timbre around the old fixed voicing (which it matches near s ≈ 0.65).
    const pitch = 0.85 + 0.25 * s;          // harder → the thump lands higher
    const bright = 0.55 + 0.7 * s;          // and the crunch opens up
    const len = 0.7 + 0.5 * s;              // and rings on longer
    sweep((car ? 170 : 115) * pitch, car ? 70 : 42, 0.2 * len, 'sine', 0.3 * s, t, dest);
    burst('lowpass', (car ? 2400 : 1600) * bright, 0.7, 0.14 * len, 0.28 * s, t, dest);
    burst('bandpass', (car ? 3200 : 2300) * (0.8 + 0.35 * s), 6, (car ? 0.12 : 0.08) * len, 0.12 * s * (0.5 + 0.6 * s), t + 0.01, dest);
    if (car) sweep(2100, 1900, 0.18 * len, 'triangle', 0.02 * s, t + 0.01, dest);
    else if (s > 0.6) burst('bandpass', 4200, 3, 0.18 * len, 0.05 * (s - 0.6) / 0.4, t + 0.02, dest);  // a big hit's barrier shudder
}

/**
 * Plastic on plastic (the toy track): a 4 cm car is all shell and no mass, so no thump — a sharp
 * click, the hollow modes of the shell (car on car: two shells, a double clack) or of the long
 * moulded rail (lower, woodier 'tock'), and on a hard hit the loose bits rattling after.
 */
function plasticImpact(s, car, t, dest) {
    const pitch = 0.88 + 0.3 * s;
    const len = 0.6 + 0.7 * s;
    const j = () => 0.94 + Math.random() * 0.12;
    // The click: the moment of contact, brighter the harder it is.
    burst('bandpass', (2400 + 2600 * s) * j(), 1.1, 0.01 + 0.012 * s, 0.26 * s, t, dest);
    // A little body: the track piece or shell flexing.
    burst('lowpass', 700 + 600 * s, 0.8, 0.035 * len, 0.1 * s, t, dest);
    const modes = car ? [1180, 2470, 3960] : [640, 1390, 2280];
    const decays = car ? [0.045, 0.03, 0.018] : [0.07, 0.045, 0.028];
    const amps = car ? [0.07, 0.05, 0.03] : [0.085, 0.05, 0.028];
    for (let k = 0; k < modes.length; k++) {
        const f = modes[k] * pitch * j();
        sweep(f, f * 0.97, decays[k] * len, k ? 'sine' : 'triangle', amps[k] * s, t + 0.001, dest);
    }
    if (car) {
        // The other shell, a few ms later and a touch higher.
        const at = t + 0.006 + Math.random() * 0.008;
        burst('bandpass', (3000 + 2400 * s) * j(), 1.3, 0.009 + 0.01 * s, 0.18 * s, at, dest);
        const f = 1420 * pitch * j();
        sweep(f, f * 0.97, 0.035 * len, 'triangle', 0.05 * s, at, dest);
    }
    // Hard hits: the wheels and loose bits chatter on for a moment.
    const rattles = s > 0.45 ? Math.round((s - 0.45) * 8) : 0;
    for (let i = 0; i < rattles; i++) {
        const at = t + 0.025 + i * (0.018 + Math.random() * 0.02);
        burst('highpass', 2600 + Math.random() * 2200, 0.8, 0.006 + Math.random() * 0.006, 0.08 * s * (1 - i / (rattles + 1)), at, dest);
    }
}

/** Press-camera shutter: two clicks and a faint flash-charge whine. Rate-limited. */
export function shutter(pos = null, strength = 1) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastShutter < 0.07) return;
    lastShutter = t;
    const dest = oneShotDest(pos);
    const s = Math.min(1, Math.max(0.2, strength));
    burst('highpass', 2600, 0.7, 0.012, 0.22 * s, t, dest);
    burst('highpass', 3400, 0.7, 0.01, 0.16 * s, t + 0.055, dest);
    sweep(2400, 5600, 0.22, 'sine', 0.012 * s, t + 0.02, dest);
}


/** One synthesized ping. */
function beep(freq, durationSeconds, type = 'sine', gainValue = 0.15) {
    if (!ctx) return;
    try {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(gainValue, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSeconds);
        osc.connect(g);
        g.connect(bus);
        osc.start();
        osc.stop(ctx.currentTime + durationSeconds + 0.02);
    } catch { /* never let audio kill the race */ }
}

/** Countdown: 3 short pings then a raised GO ping. */
export function countdownBeep(isFinal) {
    beep(isFinal ? 990 : 620, isFinal ? 0.5 : 0.14, 'sine', 0.18);
}

/** Radio blip before an official speaks. */
export function blip() {
    beep(1320, 0.05, 'square', 0.06);
    if (ctx) {
        try {
            window.setTimeout(() => beep(990, 0.05, 'square', 0.05), 70);
        } catch { /* noop */ }
    }
}

/** Lap completed: two-note chime. */
export function lapChime() {
    beep(660, 0.1, 'triangle', 0.12);
    if (ctx) {
        try { window.setTimeout(() => beep(880, 0.14, 'triangle', 0.12), 110); } catch { /* noop */ }
    }
}

/** Race finished: short arpeggio, brighter for a podium finish. */
export function fanfare(podium) {
    const notes = podium ? [523, 659, 784, 1047] : [523, 494, 440];
    notes.forEach((f, i) => {
        try {
            window.setTimeout(() => beep(f, 0.22, 'triangle', 0.13), i * 130);
        } catch { /* noop */ }
    });
}
