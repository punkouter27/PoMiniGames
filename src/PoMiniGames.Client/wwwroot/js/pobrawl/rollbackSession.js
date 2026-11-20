// rollbackSession.js — GGPO-style rollback for the online 1v1, with the server as input relay
// and referee. Pure logic (no THREE, no DOM): netplay.js presents `session.state` every render
// frame, and tests/pobrawl-rollback.test.mjs drives it directly.
//
// The timeline. The server (PoBrawlMatchService) steps the same sim (rollbackSim.js ⇄
// PoBrawlRollbackSim.cs) on a real-time 60 Hz clock and is the authority on WHEN each input
// happened: an input stamped for frame f is applied at max(f, serverFrame + 1) and echoed to the
// whole match — sender included — as a confirmed (side, frame, held, press, sequence) event.
//
//   • Local input is applied at once, INPUT_DELAY frames ahead, and sent with that frame.
//   • Remote input is predicted: keep holding what it held, press nothing (an input-less frame).
//   • A confirmed event for a frame already simulated — the remote's, or our own the server
//     re-stamped because it arrived late — rolls the sim back to that frame and re-simulates to
//     the present from the state ring (HISTORY frames, ~2 s).
//   • A snapshot (full state + frame + checksum, ~10 Hz) whose checksum differs from ours at that
//     frame replaces it and re-simulates (a hard correction). A snapshot frame is also an ANCHOR:
//     the server's state there already contains every input stamped at or before it, so an event
//     at or before the anchor needs no rollback, and our own unconfirmed input stamped there
//     cannot have been applied — the server will re-stamp it later, so we move it to anchor + 1.
//
// The clock. Players run slightly AHEAD of the estimated server frame (RTT/2 + LEAD_MARGIN), so an
// input stamped now + INPUT_DELAY reaches the server before its frame comes up. Spectators run
// BEHIND (RTT/2 + SPECTATOR_LAG) and so nearly never predict at all. The estimate comes from ping
// samples (serverClockFrame, rtt); a new estimate is slewed in at most MAX_SLEW frames per second,
// so drift is fixed by an occasional doubled or skipped frame instead of a visible jump.

import {
  FRAME_MS, INPUT_DELAY, step, cloneState, unpack, checksum, encodeInput, mergeInput,
} from './rollbackSim.js';

export const HISTORY = 128;          // state ring, frames (~2.1 s at 60 Hz)
const LEAD_MARGIN = 1;        // frames a player runs ahead of the server beyond RTT/2
const SPECTATOR_LAG = 4;      // frames a spectator trails beyond RTT/2
const MAX_SLEW = 2;           // frames per second the clock may be nudged
const SNAP_CLOCK_FRAMES = 30; // a clock error larger than this is fixed by a jump
const MAX_STEPS = 12;         // frames simulated per update (keeps slow/WebGL2 tabs responsive)
const MAX_RESIM_DEPTH = 30;   // cap rollback re-simulation; deeper drift rebases to the anchor
const UNCONFIRMED_TTL = 120;  // frames an un-echoed local input may chase the anchor before it is dropped
const MAX_HALF_RTT = 20;      // frames: a lead longer than this would only buy deeper rollbacks
const MAX_SANE_RTT = 2000;    // ms: a ping slower than this (a main thread busy booting) says nothing about the network

export class RollbackSession {
  /**
   * @param {object} o
   * @param {number} o.localSide  1 or 2 for a player, 0 to spectate
   * @param {(frame:number, held:number, press:number, seq:number) => void} [o.send]  hub SubmitInput
   * @param {(c:{depth:number, dx:number[]}) => void} [o.onCorrection]  presentation only: after a
   *   rollback or hard correction re-simulated to the present, how far it moved each corner's X
   *   (sim units, mm) and how many frames it re-ran. Never feeds back into the sim.
   */
  constructor({ localSide = 0, send = null, onCorrection = null } = {}) {
    this.localSide = localSide | 0;
    this.send = send;
    this.onCorrection = onCorrection;
    this.state = null;                   // the present (predicted) state
    this.history = new Array(HISTORY);   // states by frame % HISTORY
    this.anchor = null;                  // the newest server snapshot state
    this.events = [new Map(), new Map()]; // per corner: frame → [{ seq, input }] in arrival order
    this.pending = new Map();            // our unconfirmed inputs: seq → { frame, origFrame, input }
    this.seq = 0;
    this.lastLocalFrame = 0;
    // Clock: target frame = now / FRAME_MS + clock. `clock` slews toward `clockGoal`, which is the
    // estimated server offset plus this role's lead (players) or lag (spectators).
    this.clock = null;
    this.clockGoal = null;
    this.serverOffset = null;
    this.rtt = 100;
    this.clockSource = 'none';
    this.samples = [];
    this.lastUpdate = null;
    this.stats = { rollbacks: 0, resimulated: 0, maxDepth: 0, corrections: 0, restamps: 0, jumps: 0 };
  }

  get isSpectator() { return this.localSide === 0; }
  get frame() { return this.state ? this.state.frame : -1; }
  /**
   * The newest frame the server's own state has confirmed (the latest snapshot): anything the
   * sim did after it still rests on a prediction — the remote corner's held input, or our own
   * input the server may yet re-stamp. -1 before the first snapshot.
   */
  get confirmedFrame() { return this.anchor ? this.anchor.frame : -1; }

  // ── Clock ───────────────────────────────────────────────────────────

  /** A ping answer: the server's clock frame when it answered, and the round trip that took. */
  onClock(serverClockFrame, rttMs, now) {
    const estimate = serverClockFrame + rttMs / 2 / FRAME_MS;
    const sample = { offset: estimate - now / FRAME_MS, rtt: rttMs };
    // An absurd round trip (the first ping often waits behind the engine boot) says nothing about
    // the network and would put the clock seconds off: the snapshot estimate stands until a sane one.
    if (!(rttMs >= 0 && rttMs <= MAX_SANE_RTT)) return;
    this.samples.push(sample);
    if (this.samples.length > 8) this.samples.shift();
    // The least-delayed sample has the least queueing in it: trust its offset. RTT is the median.
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    const rtts = this.samples.map((s) => s.rtt).sort((a, b) => a - b);
    this.rtt = rtts[rtts.length >> 1];
    this._setServerOffset(best.offset, this.clockSource !== 'ping');
    this.clockSource = 'ping';
  }

  _setServerOffset(offset, snap) {
    this.serverOffset = offset;
    const half = Math.min(MAX_HALF_RTT, this.rtt / 2 / FRAME_MS);
    this.clockGoal = offset + (this.isSpectator ? -(half + SPECTATOR_LAG) : half + LEAD_MARGIN);
    if (snap || this.clock === null || Math.abs(this.clock - this.clockGoal) > SNAP_CLOCK_FRAMES) this.clock = this.clockGoal;
  }

  /** The frame the server is on at `now`, by the latest estimate. */
  serverFrameAt(now) { return this.serverOffset === null ? null : now / FRAME_MS + this.serverOffset; }

  /** The frame this client should be showing at `now`. */
  targetFrame(now) { return this.clock === null ? null : now / FRAME_MS + this.clock; }

  // ── Network in ──────────────────────────────────────────────────────

  /** A server snapshot: the packed state at `frame`, and its checksum. */
  onSnapshot(sim, frame, sum, now) {
    const s = unpack(sim);
    if (s.frame !== frame) return;
    if (this.clockSource === 'none') {
      // No ping yet: assume the snapshot is a few frames old. The first ping replaces this.
      this._setServerOffset(frame + 3 - now / FRAME_MS, true);
      this.clockSource = 'snapshot';
    }
    if (!this.state) {
      this.anchor = s;
      this._rebase(s);
      return;
    }
    if (this.anchor && frame <= this.anchor.frame) return; // late or duplicate
    this.anchor = s;
    const moved = this._chaseAnchor(frame);
    this._prune();
    if (frame >= this.state.frame) {
      // We are behind the server (a spectator's start, a hidden tab): take its state and go on from it.
      this._rebase(s);
      return;
    }
    if (moved !== Infinity) {
      // Our history at `frame` held inputs the server had not applied by then, so comparing is
      // moot: the snapshot is the truth, go on from it.
      this._resimulateFrom(s);
      return;
    }
    const mine = this.history[frame % HISTORY];
    if (!mine || mine.frame !== frame || checksum(mine) !== (sum >>> 0)) {
      this.stats.corrections++;
      this._resimulateFrom(s);
    }
  }

  /** A confirmed input event (PoBrawlMatchInputEvent): side 0/1, the frame the server applied it at. */
  onInput(side, frame, held, press, sequence) {
    side |= 0; frame |= 0;
    if (side !== 0 && side !== 1) return;
    const input = encodeInput(held | 0, press | 0);
    // Our own echo: confirm it, or move it to the frame the server actually used.
    if (side === this.localSide - 1 && sequence > 0 && this.pending.has(sequence)) {
      const p = this.pending.get(sequence);
      this.pending.delete(sequence);
      if (p.frame === frame) return;
      this.stats.restamps++;
      this._removeEvent(side, p.frame, sequence);
      if (this.anchor && frame <= this.anchor.frame) {
        // The snapshot overtook this echo: the anchor already contains the input, so it only has to
        // leave the frame we had moved it to.
        if (this.state) this._rollbackTo(p.frame);
        return;
      }
      this._addEvent(side, frame, sequence, input);
      if (this.state) this._rollbackTo(Math.min(p.frame, frame));
      return;
    }
    if (this.anchor && frame <= this.anchor.frame) return; // the anchor state already contains it
    this._addEvent(side, frame, sequence, input);
    if (this.state && frame <= this.state.frame) this._rollbackTo(frame);
  }

  // ── Local input ─────────────────────────────────────────────────────

  /**
   * The local corner pressed or let go of something. `held` 0–3 (corner-relative: idle, forward,
   * back, block), `press` 0 or 4–6. Applied INPUT_DELAY frames ahead and sent with that frame.
   * Pass `now` to catch the sim up to the clock first, so the stamp does not depend on when the
   * last render ran.
   */
  localInput(held, press, now) {
    if (this.isSpectator || !this.state) return null;
    if (now !== undefined) this.update(now);
    const side = this.localSide - 1;
    let frame = Math.max(this.state.frame + INPUT_DELAY, this.lastLocalFrame);
    if (this.anchor) frame = Math.max(frame, this.anchor.frame + 1);
    this.lastLocalFrame = frame;
    const seq = ++this.seq;
    const input = encodeInput(held, press);
    this._addEvent(side, frame, seq, input);
    this.pending.set(seq, { frame, origFrame: frame, input });
    if (frame <= this.state.frame) this._rollbackTo(frame);
    if (this.send) this.send(frame, held, press, seq);
    return { frame, seq };
  }

  // ── Advance ─────────────────────────────────────────────────────────

  /** Once per render frame: slew the clock, then simulate up to the target frame. */
  update(now) {
    const dt = this.lastUpdate === null ? 0 : Math.min(1000, Math.max(0, now - this.lastUpdate));
    this.lastUpdate = now;
    if (this.clock !== null) {
      const room = MAX_SLEW * dt / 1000;
      this.clock += Math.max(-room, Math.min(room, this.clockGoal - this.clock));
    }
    if (!this.state) return 0;
    const target = this.targetFrame(now);
    if (target === null) return 0;
    let want = Math.floor(target) - this.state.frame;
    if (want <= 0) return 0; // ahead of the clock: hold this frame (a "duplicated" frame)
    if (want > MAX_RESIM_DEPTH && this.anchor && this.anchor.frame > this.state.frame) {
      // Far behind (a backgrounded or WebGL2-stalled tab): restart from the newest confirmed state.
      this.stats.jumps++;
      this._rebase(this.anchor);
      want = Math.floor(target) - this.state.frame;
    }
    const n = Math.min(Math.max(0, want), MAX_STEPS);
    for (let i = 0; i < n; i++) this._stepOne();
    return n;
  }

  // ── Internals ───────────────────────────────────────────────────────

  _inputAt(side, frame) {
    const list = this.events[side].get(frame);
    if (!list) return 0;
    let input = 0;
    for (const e of list) input = mergeInput(input, e.input);
    return input;
  }

  _addEvent(side, frame, seq, input) {
    let list = this.events[side].get(frame);
    if (!list) { list = []; this.events[side].set(frame, list); }
    list.push({ seq, input });
  }

  _removeEvent(side, frame, seq) {
    const list = this.events[side].get(frame);
    if (!list) return;
    const i = list.findIndex((e) => e.seq === seq);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this.events[side].delete(frame);
  }

  _stepOne() {
    const next = cloneState(this.state);
    const f = next.frame + 1;
    step(next, this._inputAt(0, f), this._inputAt(1, f));
    this.history[next.frame % HISTORY] = next;
    this.state = next;
  }

  _rebase(s) {
    this.state = cloneState(s);
    this.history[this.state.frame % HISTORY] = this.state;
  }

  /** Re-simulate everything after confirmed state `base` up to the present frame. */
  _resimulateFrom(base) {
    const before = this.state;
    const present = before.frame;
    const depth = present - base.frame;
    if (depth > MAX_RESIM_DEPTH) {
      // Avoid a rollback death spiral on a throttled/backgrounded tab: rebase directly to the
      // confirmed state instead of synchronously re-simulating hundreds of stale frames.
      this.stats.jumps++;
      this._rebase(base);
      if (this.onCorrection) {
        this.onCorrection({ depth: 0, dx: [this.state.p1.x - before.p1.x, this.state.p2.x - before.p2.x] });
      }
      return;
    }
    this.state = cloneState(base);
    this.history[base.frame % HISTORY] = this.state;
    while (this.state.frame < present) this._stepOne();
    this.stats.resimulated += depth;
    if (depth > this.stats.maxDepth) this.stats.maxDepth = depth;
    if (this.onCorrection && this.state.frame === present) {
      this.onCorrection({ depth, dx: [this.state.p1.x - before.p1.x, this.state.p2.x - before.p2.x] });
    }
  }

  /** Something changed on frame `f` (≤ the present): restore the state before it and re-simulate. */
  _rollbackTo(f) {
    if (!this.state || f > this.state.frame) return;
    let baseFrame = f - 1;
    if (this.anchor && baseFrame < this.anchor.frame) baseFrame = this.anchor.frame;
    const base = baseFrame === this.anchor?.frame ? this.anchor : this.history[baseFrame % HISTORY];
    if (!base || base.frame !== baseFrame) return; // older than the ring: the next snapshot repairs it
    this.stats.rollbacks++;
    this._resimulateFrom(base);
  }

  /**
   * A snapshot confirmed frame `anchorFrame`. Our inputs still waiting for their echo and stamped at
   * or before it were not in the server's state, so it will re-stamp them later: move them to
   * anchor + 1 now (or drop one that has chased the anchor too long — its echo was lost with a
   * dropped connection). Returns the earliest frame changed, or Infinity.
   */
  _chaseAnchor(anchorFrame) {
    let earliest = Infinity;
    if (this.isSpectator) return earliest;
    const side = this.localSide - 1;
    for (const [seq, p] of this.pending) {
      if (p.frame > anchorFrame) continue;
      this._removeEvent(side, p.frame, seq);
      if (anchorFrame + 1 - p.origFrame > UNCONFIRMED_TTL) {
        this.pending.delete(seq);
        continue;
      }
      p.frame = anchorFrame + 1;
      this._addEvent(side, p.frame, seq, p.input);
      earliest = Math.min(earliest, p.frame);
    }
    if (this.lastLocalFrame <= anchorFrame) this.lastLocalFrame = anchorFrame + 1;
    return earliest;
  }

  _prune() {
    if (!this.anchor || !this.state) return;
    // A rollback never reaches behind the anchor, so nothing at or before it is needed again.
    for (const map of this.events) {
      for (const f of map.keys()) if (f <= this.anchor.frame) map.delete(f);
    }
  }
}
