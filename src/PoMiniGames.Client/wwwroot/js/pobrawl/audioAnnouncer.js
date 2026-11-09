// audioAnnouncer.js — the ring-announcer half of the AudioBus (audio.js): the round-start
// intro themes and the stingers. No voice: the calls are captions (commentary.js). A
// prototype mixin like the BrawlGame subsystems (mixin.js): `this` is the AudioBus, so these
// methods use its graph, gains and clock directly.

import { LOOKAHEAD_MS, SCHEDULE_AHEAD, SFX_FILTER_OPEN, clamp, autoDisconnect, noteToFreq, MOTIFS } from './audioCore.js';

// Round-start chiptune intros: ≤5 s two-voice riffs (melody = detuned squares,
// bass = triangle), [note, beats]. Keys MUST match the charId in fighters.js.
const INTRO_THEMES = {
  // Donald Trump (2017-2021) — riff from "Eye of the Tiger" (Survivor, 1982)
  trump: {
    bpm: 138,
    melody: [
      ['E4', 0.5], ['E4', 0.5], ['G#4', 0.5], ['E4', 0.5],
      ['B3', 0.5], ['C5', 0.5], ['D5', 0.5], ['E5', 0.5],
      ['E4', 0.5], ['E4', 0.5], ['G#4', 0.5], ['E4', 0.5],
      ['B3', 0.5], ['C5', 0.5], ['D5', 1], ['E5', 1],
    ],
    bass: [['E2', 2], ['A2', 2], ['E2', 2], ['B2', 2]],
  },
  // Joe Biden (2021-2025) — riff from "Don't Stop Believin'" (Journey, 1981)
  biden: {
    bpm: 119,
    melody: [
      ['E4', 1], ['E4', 1], ['G4', 1], ['E4', 1],
      ['G4', 0.5], ['A4', 0.5], ['B4', 0.5], ['A4', 0.5],
      ['G4', 0.5], ['F#4', 0.5], ['E4', 1], ['D4', 1],
    ],
    bass: [['E2', 2], ['A2', 2], ['D3', 2], ['A2', 2]],
  },
  // Barack Obama (2009-2017) — riff from "Signed, Sealed, Delivered" (Stevie Wonder, 1970)
  obama: {
    bpm: 110,
    melody: [
      ['F4', 0.5], ['F4', 0.5], ['Eb4', 0.5], ['F4', 0.5],
      ['F4', 0.5], ['F4', 0.5], ['Eb4', 0.5], ['F4', 0.5],
      ['F4', 0.5], ['Eb4', 0.5], ['F4', 1], ['G4', 1],
    ],
    bass: [['F2', 2], ['Bb2', 2], ['F2', 2], ['C3', 2]],
  },
  // George W. Bush (2001-2009) — riff from "Sweet Home Alabama" (Lynyrd Skynyrd, 1974)
  bush: {
    bpm: 96,
    melody: [
      ['D5', 0.5], ['D5', 0.5], ['C5', 0.5], ['G4', 0.5],
      ['D5', 0.5], ['D5', 0.5], ['C5', 0.5], ['G4', 0.5],
      ['D5', 0.5], ['C5', 0.5], ['G4', 1], ['D5', 1],
    ],
    bass: [['D2', 2], ['G2', 2], ['D2', 2], ['A2', 2]],
  },
  // Bill Clinton (1993-2001) — riff from "Don't Stop" (Fleetwood Mac, 1977)
  clinton: {
    bpm: 120,
    melody: [
      ['G4', 1], ['D5', 1], ['E5', 1], ['D5', 0.5],
      ['C5', 0.5], ['D5', 1], ['E5', 0.5], ['D5', 0.5],
      ['E5', 0.5], ['D5', 0.5], ['C5', 1], ['B4', 1],
    ],
    bass: [['G2', 2], ['D3', 2], ['E2', 2], ['C3', 2]],
  },
  // George H.W. Bush (1989-1993) — riff from "I've Been Everywhere" (Johnny Cash, 1962)
  bushsr: {
    bpm: 130,
    melody: [
      ['A4', 0.5], ['A4', 0.5], ['A4', 0.5], ['A4', 0.5],
      ['G4', 0.5], ['A4', 0.5], ['A4', 0.5], ['A4', 0.5],
      ['B4', 0.5], ['C5', 0.5], ['D5', 1], ['E5', 1],
    ],
    bass: [['A2', 2], ['E2', 2], ['D2', 2], ['A2', 2]],
  },
  // Ronald Reagan (1981-1989) — riff from "God Bless the U.S.A." (Lee Greenwood, 1984)
  reagan: {
    bpm: 110,
    melody: [
      ['C5', 0.5], ['G4', 0.5], ['A4', 0.5], ['F4', 0.5],
      ['C5', 0.5], ['G4', 0.5], ['F4', 0.5], ['G4', 0.5],
      ['C5', 0.5], ['G4', 0.5], ['A4', 0.5], ['F4', 0.5],
      ['C5', 1], ['G4', 1],
    ],
    bass: [['C2', 2], ['G2', 2], ['A1', 2], ['F2', 2]],
  },
  // Jimmy Carter (1977-1981) — riff from "Georgia on My Mind" (Ray Charles, 1960)
  carter: {
    bpm: 80,
    melody: [
      ['F4', 1], ['E4', 0.5], ['F4', 0.5], ['A4', 1],
      ['G4', 0.5], ['F4', 0.5], ['E4', 1], ['D4', 1],
    ],
    bass: [['F2', 2], ['C2', 2], ['D2', 2], ['Bb1', 2]],
  },
  // Gerald Ford (1974-1977) — riff from "Rock the Boat" (The Hues Corporation, 1974)
  ford: {
    bpm: 124,
    melody: [
      ['A4', 0.5], ['G4', 0.5], ['F4', 0.5], ['E4', 0.5],
      ['D4', 0.5], ['E4', 0.5], ['F4', 0.5], ['G4', 0.5],
      ['A4', 0.5], ['B4', 0.5], ['C5', 0.5], ['D5', 0.5],
      ['C5', 1],
    ],
    bass: [['A1', 2], ['G1', 2], ['F1', 2], ['E1', 2]],
  },
  // Richard Nixon (1969-1974) — riff from "(Sittin' On) The Dock of the Bay" (Otis Redding, 1968)
  nixon: {
    bpm: 104,
    melody: [
      ['G4', 0.5], ['B4', 0.5], ['D5', 0.5], ['B4', 0.5],
      ['G4', 1], ['E4', 1],
      ['G4', 0.5], ['B4', 0.5], ['D5', 0.5], ['B4', 0.5],
      ['A4', 0.5], ['G4', 1],
    ],
    bass: [['G2', 2], ['E2', 2], ['A1', 2], ['G2', 2]],
  },
  // Lyndon B. Johnson (1963-1969) — riff from "Ballad of the Green Berets" (Barry Sadler, 1966)
  lbj: {
    bpm: 88,
    melody: [
      ['C4', 0.5], ['C4', 0.5], ['E4', 0.5], ['G4', 0.5],
      ['G4', 0.5], ['E4', 0.5], ['C4', 0.5], ['D4', 0.5],
      ['F4', 0.5], ['F4', 0.5], ['F4', 0.5], ['E4', 0.5],
      ['D4', 1], ['C4', 1],
    ],
    bass: [['C2', 2], ['G2', 2], ['F2', 2], ['C2', 2]],
  },
  // John F. Kennedy (1961-1963) — riff from "High Hopes" (Frank Sinatra, 1959)
  jfk: {
    bpm: 120,
    melody: [
      ['A4', 0.5], ['A4', 0.5], ['A4', 0.5], ['A4', 0.5],
      ['G4', 0.5], ['A4', 0.5], ['C5', 0.5], ['B4', 0.5],
      ['A4', 0.5], ['G4', 0.5], ['F4', 0.5], ['G4', 0.5],
      ['A4', 1], ['E4', 1],
    ],
    bass: [['A1', 2], ['E2', 2], ['F#1', 2], ['D2', 2]],
  },
  // Dwight D. Eisenhower (1953-1961) — riff from "In the Mood" (Glen Miller, 1939)
  eisenhower: {
    bpm: 150,
    melody: [
      ['F4', 0.5], ['D5', 0.5], ['C5', 0.5], ['A4', 0.5],
      ['Bb4', 0.5], ['A4', 0.5], ['G4', 0.5], ['F4', 0.5],
      ['G4', 0.5], ['A4', 0.5], ['Bb4', 0.5], ['C5', 0.5],
      ['D5', 1], ['C5', 1],
    ],
    bass: [['Bb1', 2], ['F2', 2], ['G2', 2], ['C3', 2]],
  },
  // Harry S. Truman (1945-1953) — riff from "Sentimental Journey" (Les Brown / Doris Day, 1945)
  truman: {
    bpm: 100,
    melody: [
      ['C4', 0.5], ['E4', 0.5], ['G4', 0.5], ['C5', 0.5],
      ['B4', 0.5], ['A4', 0.5], ['G4', 0.5], ['E4', 0.5],
      ['F4', 0.5], ['G4', 0.5], ['A4', 0.5], ['B4', 0.5],
      ['C5', 1], ['G4', 1],
    ],
    bass: [['C2', 2], ['G1', 2], ['F1', 2], ['C2', 2]],
  },
  // Franklin D. Roosevelt (1933-1945) — riff from "Happy Days Are Here Again" (1929)
  fdr: {
    bpm: 100,
    melody: [
      ['G4', 0.5], ['G4', 0.5], ['G4', 0.5], ['C5', 0.5],
      ['B4', 0.5], ['A4', 0.5], ['G4', 0.5], ['F4', 0.5],
      ['E4', 0.5], ['E4', 0.5], ['A4', 0.5], ['G4', 0.5],
      ['F4', 1], ['E4', 1],
    ],
    bass: [['G2', 2], ['D2', 2], ['C2', 2], ['G1', 2]],
  },
  // Herbert Hoover (1929-1933) — an original, measured brass-and-reed fanfare.
  hoover: {
    bpm: 92,
    melody: [
      ['G4', 1], ['B4', 0.5], ['D5', 0.5], ['C5', 1],
      ['B4', 0.5], ['A4', 0.5], ['G4', 1], ['D4', 1],
    ],
    bass: [['G2', 2], ['D2', 2], ['G2', 2], ['C3', 2]],
  },
};

// A super calls superStinger twice (the show bus with the owner, personalityEffects without):
// a second call inside this window is the same super.
const SUPER_DEDUPE_SEC = 0.3;

class AudioAnnouncerMethods {
  // Super stinger: tape-stop, sub drop under the freeze, then the owner's leitmotif as a
  // brass stinger (charId given — the show bus calls first, with the owner), or the old
  // detuned minor chord without one. personalityEffects.js calls again with no owner a
  // moment later; inside SUPER_DEDUPE_SEC that is the same super, so it never doubles.
  superStinger(charId = null) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (now - this._superAt < SUPER_DEDUPE_SEC) return;
    this._superAt = now;

    // 1. Tape stop: falling bandpassed noise.
    const stopDur = 0.42;
    const tape = this._noiseSource(stopDur);
    const tbp = ctx.createBiquadFilter();
    tbp.type = 'bandpass';
    tbp.Q.value = 1.4;
    tbp.frequency.setValueAtTime(4200, now);
    tbp.frequency.exponentialRampToValueAtTime(180, now + stopDur);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.linearRampToValueAtTime(0.16, now + 0.03);
    tg.gain.exponentialRampToValueAtTime(0.001, now + stopDur);
    tape.connect(tbp).connect(tg).connect(this.sfxGain);
    tape.start(now, tape._offset); tape.stop(now + stopDur);
    autoDisconnect(tape, [tape, tbp, tg]);

    // 2. Sub drop under the hit-pause.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(180, now);
    sub.frequency.exponentialRampToValueAtTime(31, now + 0.7);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, now);
    sg.gain.linearRampToValueAtTime(0.5, now + 0.02);
    sg.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
    sub.connect(sg).connect(this.sfxGain);
    sub.start(now); sub.stop(now + 1.05);
    autoDisconnect(sub, [sub, sg]);

    // 3a. The owner's motif, fast, in brass doubled a fifth under — 0.18 s in, out of the
    // tape stop — with its last note held as the stinger's tail.
    const chordAt = now + 0.18;
    const motif = charId && MOTIFS[charId];
    if (motif) {
      this.playMotif(charId, { at: chordAt, sixteenth: 0.075, timbre: 'brass', peak: 0.11, hold: 0.9 });
      this.playMotif(charId, { at: chordAt, sixteenth: 0.075, timbre: 'brass', peak: 0.06, transpose: -7, hold: 0.9 });
      this._pulse(1.0);
      this.crowdSwell(1.0);
      return;
    }

    // 3b. Chord: minor triad, three detuned saws per note, opening lowpass; 0.18 s in.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(320, chordAt);
    lp.frequency.exponentialRampToValueAtTime(5200, chordAt + 0.5);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, chordAt);
    cg.gain.linearRampToValueAtTime(0.13, chordAt + 0.08);
    cg.gain.exponentialRampToValueAtTime(0.001, chordAt + 1.5);
    lp.connect(cg).connect(this.sfxGain);
    for (const hz of [110, 130.81, 329.63]) {         // A2, C3, E4
      for (const cents of [-7, 0, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz;
        o.detune.value = cents;
        o.connect(lp);
        o.start(chordAt); o.stop(chordAt + 1.55);
        autoDisconnect(o, [o]);
      }
    }
    // Shared filter/gain torn down off a sentinel that outlives every note.
    const last = ctx.createConstantSource();
    last.start(chordAt); last.stop(chordAt + 1.6);
    autoDisconnect(last, [last, lp, cg]);

    this._pulse(1.0);
    this.crowdSwell(1.0);
  }

  // Music stem: two synthesized loops crossfaded by HP.
  startMusic() {
    if (!this._ensure() || this.musicNodes) return;
    const ctx = this.ctx;
    const tempo = 96; // bpm
    const beat = 60 / tempo;

    // Two gains: bassEnv (per-note, scheduler) and bassLevel (setMusicTension, which
    // cancelScheduledValues and would otherwise wipe queued notes).
    const bassNotes = [55, 55, 73, 65]; // A1, A1, D2, C2 (A minor pentatonic)
    const bassNode = ctx.createOscillator();
    bassNode.type = 'triangle';
    const bassEnv = ctx.createGain();
    bassEnv.gain.value = 0;
    const bassLevel = ctx.createGain();
    bassLevel.gain.value = 0.22;
    const bassLP = ctx.createBiquadFilter();
    bassLP.type = 'lowpass';
    bassLP.frequency.value = 700;
    bassNode.connect(bassLP).connect(bassEnv).connect(bassLevel).connect(this.musicGain);
    bassNode.start();

    // Lookahead scheduler: the timer only decides when to queue; note times come
    // off the audio clock.
    let step = 0;
    let nextNoteTime = ctx.currentTime + 0.05;
    const scheduleNote = (t) => {
      const freq = bassNotes[step % bassNotes.length];
      bassNode.frequency.setValueAtTime(freq, t);
      bassEnv.gain.setValueAtTime(0.0001, t);
      bassEnv.gain.linearRampToValueAtTime(1, t + 0.01);
      bassEnv.gain.exponentialRampToValueAtTime(0.0001, t + beat * 0.85);
      step++;
    };
    const scheduler = () => {
      if (this.musicNodes?.stopped) return;
      // After a stall, skip missed beats (staying on the grid) rather than cram
      // them all into one instant.
      if (nextNoteTime < ctx.currentTime) {
        const missed = Math.ceil((ctx.currentTime - nextNoteTime) / beat);
        nextNoteTime += missed * beat;
        step += missed;
      }
      while (nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
        scheduleNote(nextNoteTime);
        nextNoteTime += beat;
      }
    };
    const bassInterval = setInterval(scheduler, LOOKAHEAD_MS);
    scheduler();

    // Pad: filtered noise with a slow LFO on cutoff.
    const pad = ctx.createBufferSource();
    pad.buffer = this.noiseBuf;
    pad.loop = true;
    const padLP = ctx.createBiquadFilter();
    padLP.type = 'lowpass';
    padLP.frequency.value = 600;
    const padGain = ctx.createGain();
    padGain.gain.value = 0.04;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.18;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 250;
    lfo.connect(lfoGain).connect(padLP.frequency);
    pad.connect(padLP).connect(padGain).connect(this.musicGain);
    pad.start(); lfo.start();

    this.musicNodes = {
      bassNode, bassEnv, bassLevel, bassInterval, pad, lfo, padGain,
      stopped: false,
    };
  }

  // 0..1 toward the "low-HP" stem: quieter bass, louder pad.
  setMusicTension(t) {
    this.lowMusicCrossfade = clamp(t, 0, 1);
    if (!this.musicNodes || !this._ensure()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Writes bassLevel, not the per-note envelope — see startMusic.
    this.musicNodes.bassLevel.gain.cancelScheduledValues(now);
    this.musicNodes.bassLevel.gain.linearRampToValueAtTime(0.22 - 0.16 * this.lowMusicCrossfade, now + 0.4);
    this.musicNodes.padGain.gain.cancelScheduledValues(now);
    this.musicNodes.padGain.gain.linearRampToValueAtTime(0.04 + 0.06 * this.lowMusicCrossfade, now + 0.4);
  }

  stopMusic() {
    if (!this.musicNodes) return;
    this.musicNodes.stopped = true;
    clearInterval(this.musicNodes.bassInterval);
    try { this.musicNodes.bassNode.stop(); } catch { /* */ }
    try { this.musicNodes.pad.stop(); } catch { /* */ }
    try { this.musicNodes.lfo.stop(); } catch { /* */ }
    this.musicNodes = null;
  }

  // Round-start riff for charId (an INTRO_THEMES key) on introGain, ducking the loop.
  // Restarts any in-flight intro.
  playIntroTheme(charId) {
    if (!this._ensure() || this.muted) return;
    const theme = INTRO_THEMES[charId];
    if (!theme || !this.introGain) return;
    // The countdown's leitmotif exchange (countdownMotifs) owns this countdown: a riff
    // on top of it would be two tunes in two keys under the PA.
    if (this.ctx.currentTime < (this._introSuppressUntil || 0)) return;

    this.stopIntroTheme();

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const beatDur = 60 / theme.bpm;

    let melodyBeats = 0, bassBeats = 0;
    for (const [, d] of theme.melody) melodyBeats += d;
    if (theme.bass) for (const [, d] of theme.bass) bassBeats += d;
    const totalDur = Math.max(melodyBeats, bassBeats) * beatDur;

    // Duck and restore in audio time, so tab throttling can't strand it.
    if (this.musicGain) {
      this._introRestoreVol = this.musicGain.gain.value;
      this.musicGain.gain.cancelScheduledValues(now);
      this.musicGain.gain.linearRampToValueAtTime(0.08, now + 0.08);
      const restoreAt = now + totalDur + 0.15;
      this.musicGain.gain.linearRampToValueAtTime(this._introRestoreVol, restoreAt + 0.35);
    }

    const created = [];

    // Lead: two detuned squares.
    let t = 0;
    for (const [note, dur] of theme.melody) {
      const startT = now + t * beatDur;
      const endT = startT + dur * beatDur * 0.92;
      const freq = noteToFreq(note);

      const o1 = ctx.createOscillator();
      o1.type = 'square';
      o1.frequency.value = freq;
      const o2 = ctx.createOscillator();
      o2.type = 'square';
      o2.frequency.value = freq * 1.006; // 0.6% detune → slight chorus
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, startT);
      g.gain.linearRampToValueAtTime(0.14, startT + 0.006);
      g.gain.setValueAtTime(0.14, endT - 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, endT);

      o1.connect(g); o2.connect(g); g.connect(this.introGain);
      o1.start(startT); o2.start(startT);
      o1.stop(endT + 0.02); o2.stop(endT + 0.02);
      created.push(o1, o2, g);
      t += dur;
    }

    if (theme.bass) {
      let bt = 0;
      for (const [note, dur] of theme.bass) {
        const startT = now + bt * beatDur;
        const endT = startT + dur * beatDur * 0.94;
        const freq = noteToFreq(note);

        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, startT);
        g.gain.linearRampToValueAtTime(0.11, startT + 0.008);
        g.gain.setValueAtTime(0.11, endT - 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, endT);

        o.connect(g).connect(this.introGain);
        o.start(startT); o.stop(endT + 0.02);
        created.push(o, g);
        bt += dur;
      }
    }

    this.introNodes = created;
  }

  // Idempotent.
  stopIntroTheme() {
    if (!this.introNodes) return;
    const ctx = this.ctx;
    const now = ctx ? ctx.currentTime : 0;
    if (this.musicGain && ctx) {
      this.musicGain.gain.cancelScheduledValues(now);
      this.musicGain.gain.linearRampToValueAtTime(this._introRestoreVol, now + 0.08);
    }
    for (const n of this.introNodes) {
      try { if (n.stop) n.stop(); } catch { /* already stopped */ }
      try { n.disconnect(); } catch { /* already disconnected */ }
    }
    this.introNodes = null;
  }

  // Combo melody: each hit in a run rings one step up A minor pentatonic (the
  // music loop's key), a mallet voice layered on the impact. The impact itself lands
  // on the frame of contact; only this mallet snaps to the conductor's next 8th/16th
  // (setConductor), never more than ~120 ms late, so a run rings out in time.
  comboNote(n, worldPos = null) {
    if (n < 2 || !this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime + this._gridDelay();
    const PENTA = [0, 3, 5, 7, 10];               // A C D E G
    const deg = Math.min(n - 2, 11);              // tops out two octaves up
    const semis = PENTA[deg % 5] + 12 * Math.floor(deg / 5);
    const f0 = 440 * Math.pow(2, semis / 12);
    const spat = this._connectSpat(this._spatializer(worldPos));
    const voice = (hz, peak, decay) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(peak, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0008, now + decay);
      o.connect(g).connect(spat);
      o.start(now); o.stop(now + decay + 0.03);
      return [o, g];
    };
    const lift = Math.min(1, 0.55 + deg * 0.06);
    const [o1, g1] = voice(f0, 0.07 * lift, 0.42);
    const [o2, g2] = voice(f0 * 2.76, 0.022 * lift, 0.16);
    autoDisconnect(o2, [o2, g2]);
    // The longer fundamental owns tearing down the shared spatializer.
    autoDisconnect(o1, [o1, g1, spat, spat.output].filter(Boolean));
  }

  // Run of 4+ expiring: a rising Am(add9) arpeggio resolving the combo phrase.
  comboFinisher(n) {
    if (n < 4 || !this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const notes = [220, 261.63, 329.63, 493.88, 440];  // A3 C4 E4 B4 A4
    const peak = Math.min(0.075, 0.04 + n * 0.004);
    notes.forEach((hz, i) => {
      const t0 = now + i * 0.055;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.7);
      o.connect(g).connect(this.sfxGain);
      o.start(t0); o.stop(t0 + 0.75);
      autoDisconnect(o, [o, g]);
    });
    this.crowdSwell(0.5);
  }

  // One lub-dub; game.js owns the tempo (shared with the screen-edge pulse).
  heartbeat(strength = 1) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const s = clamp(strength, 0, 1);
    const thump = (t0, peak) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(62, t0);
      o.frequency.exponentialRampToValueAtTime(38, t0 + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.2);
      // Straight to master so it survives the concussion lowpass.
      o.connect(g).connect(this.master);
      o.start(t0); o.stop(t0 + 0.22);
      autoDisconnect(o, [o, g]);
    };
    thump(now, 0.3 * s);
    thump(now + 0.17, 0.2 * s);
  }

  /** 0..1 — how close the nearer fighter is to a KO. Sinks the music under a lowpass. */
  setDanger(level) {
    if (!this.musicLP || !this.ctx) return;
    const d = clamp(level, 0, 1);
    // Exponential sweep, 20 kHz → ~700 Hz.
    const hz = d < 0.01 ? SFX_FILTER_OPEN : 700 * Math.pow(SFX_FILTER_OPEN / 700, 1 - d);
    this.musicLP.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.25);
  }

  // VS splash: riser into a sub boom + clang at 0.45 s, when the splash CSS slams
  // the name cards together.
  vsSting() {
    // Running-only: nodes queued on a suspended context would fire mid-fight on resume.
    if (!this._ensure() || this.muted || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const hitAt = now + 0.45;

    const riseDur = 0.45;
    const rise = this._noiseSource(riseDur);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(900, now);
    hp.frequency.exponentialRampToValueAtTime(5200, hitAt);
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, now);
    rg.gain.exponentialRampToValueAtTime(0.14, hitAt - 0.01);
    rg.gain.linearRampToValueAtTime(0.0001, hitAt + 0.02);
    rise.connect(hp).connect(rg).connect(this.sfxGain);
    rise.start(now, rise._offset); rise.stop(hitAt + 0.03);
    autoDisconnect(rise, [rise, hp, rg]);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(120, hitAt);
    sub.frequency.exponentialRampToValueAtTime(34, hitAt + 0.5);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, hitAt);
    sg.gain.linearRampToValueAtTime(0.5, hitAt + 0.015);
    sg.gain.exponentialRampToValueAtTime(0.0008, hitAt + 0.8);
    sub.connect(sg).connect(this.sfxGain);
    sub.start(hitAt); sub.stop(hitAt + 0.85);
    autoDisconnect(sub, [sub, sg]);

    // Clang: three inharmonic square partials through a bandpass.
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 2.2;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, hitAt);
    cg.gain.linearRampToValueAtTime(0.06, hitAt + 0.005);
    cg.gain.exponentialRampToValueAtTime(0.0008, hitAt + 0.9);
    bp.connect(cg).connect(this.sfxGain);
    for (const hz of [311, 523, 887]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = hz;
      o.connect(bp);
      o.start(hitAt); o.stop(hitAt + 0.95);
      autoDisconnect(o, [o]);
    }
    const last = ctx.createConstantSource();
    last.start(hitAt); last.stop(hitAt + 1.0);
    autoDisconnect(last, [last, bp, cg]);
    this._pulse(0.6);
  }
}

export const AudioAnnouncer = AudioAnnouncerMethods.prototype;
