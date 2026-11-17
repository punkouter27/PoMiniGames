// ghostTrack.js — a recorded path (your best lap or run), small enough for localStorage.
//
// The racing games keep their ghost per device, per track, in localStorage, trusted by nobody.
// A PoRacer lap is simulated on the server and a PoMarbleRace run by cannon-es, so neither can
// replay a key log; the ghost is the path itself: N channels
// (x, y, heading for a car; x, y, z for a marble) sampled at a fixed rate.
//
// Wire format v1, little-endian, then base64:
//   u8 version (1) | u8 channels | u8 hz | u8 reserved | u32 frames
//   f32 scale × channels                 quantization step is 1/scale
//   i32 first frame × channels           round(value × scale)
//   i16 delta × channels × (frames - 1)
// Deltas are taken against the RECONSTRUCTED previous value, not the true one, and clamped to
// int16. So rounding never accumulates, and a jump too big for one delta (a respawn) is caught
// up over the next few frames instead of leaving the rest of the path offset.
//
// No imports: tests/poracer-snapshot.test.mjs loads this file on its own.
const VERSION = 1;
const HEADER = 8;
const MAX_FRAMES = 20 * 60 * 6;   // six minutes at 20 Hz: longer than any lap or run

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * @param {ArrayLike<number>} data frames × channels, frame-major
 * @param {number} channels
 * @param {number} hz sample rate the frames were taken at
 * @param {number[]} scales one per channel: 10 keeps a tenth of a unit, 1000 a milliradian
 * @returns {string} base64
 */
export function encodeTrack(data, channels, hz, scales) {
  const frames = Math.min(MAX_FRAMES, Math.floor(data.length / channels));
  const bytes = new Uint8Array(HEADER + channels * 8 + Math.max(0, frames - 1) * channels * 2);
  const v = new DataView(bytes.buffer);
  v.setUint8(0, VERSION); v.setUint8(1, channels); v.setUint8(2, hz); v.setUint32(4, frames, true);
  let o = HEADER;
  for (let c = 0; c < channels; c++, o += 4) v.setFloat32(o, scales[c], true);
  const rec = new Array(channels);
  for (let c = 0; c < channels; c++, o += 4) {
    rec[c] = frames ? Math.round(data[c] * Math.fround(scales[c])) : 0;
    v.setInt32(o, rec[c], true);
  }
  for (let f = 1; f < frames; f++) {
    for (let c = 0; c < channels; c++, o += 2) {
      const q = Math.round(data[f * channels + c] * Math.fround(scales[c]));
      const d = Math.max(-32768, Math.min(32767, q - rec[c]));
      rec[c] += d;
      v.setInt16(o, d, true);
    }
  }
  return toBase64(bytes);
}

/** @returns {{channels: number, hz: number, frames: number, data: Float32Array} | null} null if malformed. */
export function decodeTrack(text) {
  if (typeof text !== 'string' || !text) return null;
  let bytes;
  try { bytes = fromBase64(text); } catch { return null; }
  if (bytes.length < HEADER) return null;
  const v = new DataView(bytes.buffer);
  const channels = v.getUint8(1), hz = v.getUint8(2), frames = v.getUint32(4, true);
  if (v.getUint8(0) !== VERSION || !channels || !hz || frames > MAX_FRAMES) return null;
  if (bytes.length !== HEADER + channels * 8 + Math.max(0, frames - 1) * channels * 2) return null;
  let o = HEADER;
  const scales = [], rec = [];
  for (let c = 0; c < channels; c++, o += 4) scales.push(v.getFloat32(o, true));
  if (scales.some((s) => !(s > 0))) return null;
  for (let c = 0; c < channels; c++, o += 4) rec.push(v.getInt32(o, true));
  const data = new Float32Array(frames * channels);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      if (f > 0) { rec[c] += v.getInt16(o, true); o += 2; }
      data[f * channels + c] = rec[c] / scales[c];
    }
  }
  return { channels, hz, frames, data };
}

/**
 * Irregular samples (snapshot or frame times) onto the fixed grid encodeTrack stores: frame k is
 * time k / hz, linearly interpolated, from 0 up to the last sample.
 * @param {number[]} times seconds, ascending
 * @param {number[]} values times.length × channels
 */
export function resample(times, values, channels, hz) {
  const n = times.length;
  if (!n) return new Float32Array(0);
  const frames = Math.min(MAX_FRAMES, Math.floor(times[n - 1] * hz) + 1);
  const out = new Float32Array(frames * channels);
  let j = 0;
  for (let f = 0; f < frames; f++) {
    const t = f / hz;
    while (j < n - 2 && times[j + 1] < t) j++;
    const t0 = times[j], t1 = times[Math.min(n - 1, j + 1)];
    const k = t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 0;
    const a = j * channels, b = Math.min(n - 1, j + 1) * channels;
    for (let c = 0; c < channels; c++) out[f * channels + c] = values[a + c] + (values[b + c] - values[a + c]) * k;
  }
  return out;
}

/** Where the ghost is at time t (seconds), interpolated, into `out`. Null before 0 or after the end. */
export function sampleAt(track, t, out) {
  if (!track || !(t >= 0)) return null;
  const pos = t * track.hz;
  if (pos > track.frames - 1) return null;
  const i = Math.floor(pos), k = pos - i, ch = track.channels;
  const a = i * ch, b = Math.min(track.frames - 1, i + 1) * ch;
  for (let c = 0; c < ch; c++) out[c] = track.data[a + c] + (track.data[b + c] - track.data[a + c]) * k;
  return out;
}

/** Angle `a` moved by whole turns to sit within half a turn of `prev`, so a heading never jumps by 2π. */
export function unwrap(prev, a) {
  const TAU = Math.PI * 2;
  return a + Math.round((prev - a) / TAU) * TAU;
}

/** The stored best for a key: { time, track } (decoded), or null. */
export function loadGhost(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    const track = raw && decodeTrack(raw.d);
    return track && raw.t > 0 ? { time: raw.t, track } : null;
  } catch { return null; }
}

/**
 * Keep `time` as the best for `key` if it beats what is stored. Returns the new { time, track }
 * (decoded from what was stored, so playback matches a reload exactly), or null if not better.
 */
export function saveGhost(key, time, encoded) {
  const was = loadGhost(key);
  if (!(time > 0) || (was && was.time <= time)) return null;
  const track = decodeTrack(encoded);
  if (!track) return null;
  try { localStorage.setItem(key, JSON.stringify({ t: Math.round(time * 1000) / 1000, d: encoded })); } catch { /* private mode / quota */ }
  return { time, track };
}
