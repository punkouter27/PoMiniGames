// ambisonics.js — a first-order ambisonic (B-format) ambience bed that turns with the camera.
//
// WHY AMBISONICS FOR AMBIENCE
// Stereo loops are baked to one listening direction: turn the camera and the wind is still
// "left" and the surf still "right", which is exactly wrong for a world you fly around. The
// alternatives are a PannerNode per source (an HRTF convolution each — fine for a few
// one-shots, expensive for six beds that never stop) or the same stereo loop (wrong). A
// B-format bed encodes every source ONCE into four channels that describe the whole sound
// field, and ROTATING the field is a handful of gain changes whatever the source count.
//
// THE MATHS (first order, world frame)
//   encode  a source of signal s at world unit direction d:
//             W = s/√2     X = s·dx     Y = s·dy     Z = s·dz        (W is omni)
//           `spread` 0..1 fades the directional terms toward 0 → a diffuse source (wind, surf)
//           that has a side without being a point.
//   rotate  the camera has basis vectors right r, up u, forward f. Rather than build a rotation
//           matrix stage and then decode, each virtual loudspeaker k at camera-frame direction
//           (sr, su, sf) is turned into the WORLD direction  w_k = sr·r + su·u + sf·f  every
//           time the camera moves, and decoded straight from the world-frame channels:
//             feed_k = ( √2·W + 1.73·(w_k · [X Y Z]) ) / N     (basic decode, max-rE weighted)
//           so the whole rotation costs 3·N gain updates (N = 7: a hexagon + zenith) and the
//           source count is free.
//   decode  to stereo through virtual speakers: each feed goes through a StereoPanner at
//           sin(azimuth), and the rear speakers are lowpassed ~5.5 kHz (the head shadows the
//           highs behind you), which is what makes front/back readable on headphones without
//           an HRTF. It is not binaural — no ITD, no pinna — and says so: this is a
//           "virtual speaker" decoder.
//
// WHY NOT PannerNode HRTF SPEAKERS: a PannerNode is placed relative to the context's
// AudioListener, which games already park on the camera — the virtual speakers would be
// rotated twice. StereoPanners are listener-independent.
//
// Gain changes ride setTargetAtTime(…, 25 ms) so a fast camera spin never zippers.
//
// API
//   const bed = createAmbisonicBed(ctx, destination);
//   const s = bed.addSource(node, { dir:{x,y,z}, gain:1, spread:0.4 });   // node → encoded
//   s.setDirection(dir) / s.setGain(g) / s.remove()
//   bed.oneShot(dir, seconds) → GainNode to connect a short voice into (auto-removed)
//   bed.setOrientation(fx, fy, fz)    // camera forward; up is world +Y
//   bed.setYawPitch(yaw, pitch)       // radians; yaw 0 faces -Z, positive turns toward +X
//   bed.dispose()

const SQRT1_2 = Math.SQRT1_2;
const SQRT2 = Math.SQRT2;
const D1 = 1.73;           // 3 · max-rE weight (1/√3) for first order in 3D
const TAU = 0.025;         // s, gain smoothing

// Virtual loudspeakers in camera frame: azimuth in degrees from forward toward right, plus a
// zenith. [azimuthDeg, elevated?]
const SPEAKERS = [
    { az: 30 }, { az: -30 }, { az: 90 }, { az: -90 }, { az: 150 }, { az: -150 }, { up: true },
];

function norm(v) {
    const l = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination
 * @param {{level?:number}} [opts]
 */
export function createAmbisonicBed(ctx, destination, opts = {}) {
    const N = SPEAKERS.length;
    const out = ctx.createGain();
    out.gain.value = opts.level == null ? 1 : opts.level;
    out.connect(destination);

    // World-frame B-format buses (X Y Z are WORLD axes here).
    const W = ctx.createGain(), X = ctx.createGain(), Y = ctx.createGain(), Z = ctx.createGain();

    // Basis of the listener.
    let basis = { r: { x: 1, y: 0, z: 0 }, u: { x: 0, y: 1, z: 0 }, f: { x: 0, y: 0, z: -1 } };

    const spk = SPEAKERS.map((s) => {
        const a = ((s.az || 0) * Math.PI) / 180;
        const cam = s.up ? { sr: 0, su: 1, sf: 0 } : { sr: Math.sin(a), su: 0, sf: Math.cos(a) };
        const gW = ctx.createGain(); gW.gain.value = SQRT2 / N;
        const gX = ctx.createGain(), gY = ctx.createGain(), gZ = ctx.createGain();
        const sum = ctx.createGain();
        W.connect(gW).connect(sum);
        X.connect(gX).connect(sum); Y.connect(gY).connect(sum); Z.connect(gZ).connect(sum);
        let tail = sum;
        const rear = !s.up && Math.abs(s.az) > 110;
        if (rear) {
            const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5500; lp.Q.value = 0.5;
            sum.connect(lp); tail = lp;
        }
        const level = ctx.createGain(); level.gain.value = rear ? 0.85 : s.up ? 0.7 : 1;
        tail.connect(level);
        if (ctx.createStereoPanner) {
            const p = ctx.createStereoPanner();
            p.pan.value = s.up ? 0 : Math.sin(a) * 0.92;
            level.connect(p); p.connect(out);
        } else level.connect(out);
        return { cam, gX, gY, gZ };
    });

    let lastKey = '';
    function applyBasis(immediate) {
        const { r, u, f } = basis;
        const key = [r.x, r.z, u.x, u.y, u.z, f.x, f.y, f.z].map((v) => v.toFixed(3)).join(',');
        if (key === lastKey) return;
        lastKey = key;
        const t = ctx.currentTime;
        for (const s of spk) {
            const wx = s.cam.sr * r.x + s.cam.su * u.x + s.cam.sf * f.x;
            const wy = s.cam.sr * r.y + s.cam.su * u.y + s.cam.sf * f.y;
            const wz = s.cam.sr * r.z + s.cam.su * u.z + s.cam.sf * f.z;
            for (const [g, w] of [[s.gX, wx], [s.gY, wy], [s.gZ, wz]]) {
                if (immediate) { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(D1 * w / N, t); }
                else g.gain.setTargetAtTime((D1 * w) / N, t, TAU);
            }
        }
    }

    function setOrientation(fx, fy, fz) {
        const f = norm({ x: fx, y: fy, z: fz });
        // right = f × worldUp, falling back to the previous right when looking straight up/down.
        let r = { x: -f.z, y: 0, z: f.x };
        if (Math.hypot(r.x, r.z) < 1e-3) r = basis.r; else r = norm(r);
        const u = {
            x: r.y * f.z - r.z * f.y,
            y: r.z * f.x - r.x * f.z,
            z: r.x * f.y - r.y * f.x,
        };
        basis = { r, u, f };
        applyBasis(false);
    }

    function setYawPitch(yaw, pitch = 0) {
        const cp = Math.cos(pitch);
        setOrientation(Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    }

    setOrientation(0, 0, -1);
    applyBasis(true);

    const sources = new Set();

    function addSource(node, o = {}) {
        const d = norm(o.dir || { x: 0, y: 1, z: 0 });
        let gain = o.gain == null ? 1 : o.gain;
        let spread = Math.max(0, Math.min(1, o.spread == null ? 0 : o.spread));
        const gW = ctx.createGain(), gX = ctx.createGain(), gY = ctx.createGain(), gZ = ctx.createGain();
        let dir = d;
        const set = (immediate) => {
            const t = ctx.currentTime, k = 1 - spread;
            const vals = [[gW, SQRT1_2 * gain], [gX, dir.x * gain * k], [gY, dir.y * gain * k], [gZ, dir.z * gain * k]];
            for (const [g, v] of vals) {
                if (immediate) g.gain.value = v; else g.gain.setTargetAtTime(v, t, TAU);
            }
        };
        set(true);
        node.connect(gW); node.connect(gX); node.connect(gY); node.connect(gZ);
        gW.connect(W); gX.connect(X); gY.connect(Y); gZ.connect(Z);
        const handle = {
            setDirection(nd) { dir = norm(nd); set(false); },
            setGain(g) { gain = g; set(false); },
            setSpread(s) { spread = Math.max(0, Math.min(1, s)); set(false); },
            remove() {
                if (!sources.delete(handle)) return;
                for (const g of [gW, gX, gY, gZ]) { try { g.disconnect(); } catch { /* gone */ } }
                try { for (const g of [gW, gX, gY, gZ]) node.disconnect(g); } catch { /* gone */ }
            },
        };
        sources.add(handle);
        return handle;
    }

    return {
        addSource,
        /** A GainNode to feed one short sound into; it is encoded at `dir` and removed after `seconds`. */
        oneShot(dir, seconds = 1, o = {}) {
            const input = ctx.createGain();
            const h = addSource(input, { dir, spread: o.spread || 0, gain: o.gain == null ? 1 : o.gain });
            if (typeof setTimeout === 'function') setTimeout(() => { h.remove(); try { input.disconnect(); } catch { /* gone */ } }, seconds * 1000 + 100);
            return input;
        },
        setOrientation, setYawPitch,
        setLevel(v) { out.gain.setTargetAtTime(Math.max(0, v), ctx.currentTime, 0.1); },
        get output() { return out; },
        get sourceCount() { return sources.size; },
        dispose() {
            for (const s of [...sources]) s.remove();
            try { out.disconnect(); } catch { /* gone */ }
        },
    };
}

if (typeof window !== 'undefined') window.PoAmbisonics = { createAmbisonicBed };
