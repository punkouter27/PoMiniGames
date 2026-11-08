// cup.js — the CPU tournament's presentation layer (mode 'tournament' only). Mixin (mixin.js).
//
//   • The arena remembers the night: one lighting look per stage (golden hour for the
//     first two rounds, dusk for the semis, a night final under tight spots and heavy haze),
//     the hall filling in, and an excitement floor that climbs round by round. (Mat wear,
//     blood and broken crates persisting across the bouts is game.js / props.js: in this
//     mode they are simply not reset.)
//   • The Elo storyline: the page hands in each bout's expectation (PoBrawl.matchup's
//     p1Expected); with the live HP lead it becomes an upset level that drives the crowd —
//     excitement, phones, a murmur while the underdog leads, gasps on their big hits, boos
//     while a heavy favourite cruises, a roar for an upset, and a stadium slap-back echo on
//     the heavy hits of a high-upset moment.
//   • The jumbotron bracket between bouts (PoBrawl.jumbotronBracket).
//
// Presentation only: Math.random, never the seeded match RNG, and no sim state is touched.
// Flicker rule (see spectacle.js): looks ease over seconds; nothing changes whole-frame
// brightness in one frame.
import * as THREE from 'three';
import { ROUND_LOOKS, setCrowdFill } from './arena.js';
import { MAX_HP, HEAVY_HIT_DMG } from './constants.js';
import * as Quality from './quality.js';

const CROWD_FILL = [0.58, 0.82, 1];       // share of seats taken, per round
const EXCITE_FLOOR = [0, 0.1, 0.22];      // the hall's resting excitement, per round
const CROWD_LIFT = [0, 0.05, 0.12];       // added to the crowd bed's floor, per round
const LOOK_RATE = 1.4;                    // 1/s ease toward the round's look
const EVEN_GAP = 0.03;                    // expectation within 0.5 ± this: no favourite
const FULL_GAP = 0.2;                     // 0.30 / 0.70 and beyond: the storyline at full strength
const LEAD_FULL = 0.3;                    // an HP lead of 30 points reads as a rout
const UPSET_ECHO = 0.4;                   // upset level above which heavy hits slap back
const BURN_SEC = 1.3;                     // the jumbotron's winner line burning forward

const LOOK_NUMS = ['keyMul', 'hemiMul', 'fillMul', 'rimMul', 'spotMul', 'spotAngle', 'spotPenumbra',
  'cornerMul', 'backMul', 'rectMul', 'fog', 'haze'];
const LOOK_COLORS = ['key', 'hemiSky', 'hemiGround', 'fill', 'hall'];

const _c = new THREE.Color();
const _v = new THREE.Vector3();

class CupMethods {
  _initCup() {
    this._cup = null;
    this._cupBoardData = null;
    if (this.options.mode !== 'tournament') return;
    this._cup = {
      round: 0, p1Expected: 0.5, underdog: -1, strength: 0, upset: 0,
      exciteFloor: 0, crowdLift: 0, energy: 1, decay: 0.4, phones: 0,
      moodPushed: 0, booT: 4, gaspT: 0, decided: false, captionT: 0, look: null,
    };
    this.cupBout(this.options, true);
    // The belt is only built for the Full show, the only one that crowns a champion on screen.
    if (this._fullShow()) this._initCeremony();
  }

  /**
   * The page's per-bout options (PoBrawl.init / PoBrawl.matchup): `round` 0 quarterfinal,
   * 1 semifinal, 2 final; `p1Expected` the left corner's Elo expectation, 0..1.
   */
  cupBout(opts = {}, snap = false) {
    const c = this._cup;
    if (!c) return;
    const r = Number(opts?.round);
    c.round = r === 1 || r === 2 ? r : 0;
    const e = Number(opts?.p1Expected);
    c.p1Expected = Number.isFinite(e) ? THREE.MathUtils.clamp(e, 0.01, 0.99) : 0.5;
    const gap = 0.5 - c.p1Expected;
    c.underdog = gap > 0 ? 0 : 1;
    c.strength = Math.abs(gap) < EVEN_GAP ? 0 : Math.min(1, Math.abs(gap) / FULL_GAP);
    c.upset = 0;
    c.decided = false;
    c.captionT = 0;
    c.booT = 4;
    setCrowdFill(this.arena, CROWD_FILL[c.round]);
    if (snap || !c.look) c.look = lookFrom(ROUND_LOOKS[c.round]);
  }

  // ── Lighting (from game.js _updateLighting, after its own baselines) ─────
  _applyCupLook(L, dt) {
    const c = this._cup;
    if (!c?.look) return;
    const T = ROUND_LOOKS[c.round];
    const o = c.look;
    const k = 1 - Math.exp(-dt * LOOK_RATE);
    for (const n of LOOK_NUMS) o[n] += (T[n] - o[n]) * k;
    for (const n of LOOK_COLORS) o[n].lerp(_c.setHex(T[n]), k);
    o.keyPos.lerp(_v.fromArray(T.keyPos), k);

    L.key.color.copy(o.key);
    L.key.intensity *= o.keyMul;
    L.key.position.copy(o.keyPos);
    L.hemi.color.copy(o.hemiSky);
    L.hemi.groundColor.copy(o.hemiGround);
    L.hemi.intensity *= o.hemiMul;
    L.fill.color.copy(o.fill);
    L.fill.intensity *= o.fillMul;
    L.rim.intensity *= o.rimMul;
    L.spot.intensity *= o.spotMul;
    L.spot.angle = o.spotAngle;
    L.spot.penumbra = o.spotPenumbra;
    L.cornerA.intensity *= o.cornerMul;
    L.cornerB.intensity *= o.cornerMul;
    if (L.rectA) L.rectA.intensity *= o.rectMul;
    if (L.rectB) L.rectB.intensity *= o.rectMul;
    for (const bl of this._backlights || []) bl.intensity *= o.backMul;
    if (this.scene.background?.isColor) this.scene.background.copy(o.hall);
    // The low tier keeps the base haze: a denser fog and a hotter shaft only muddy its
    // flat-lit, bloomless frame. It still gets the time of day from the colours.
    const low = Quality.tier() === 'low';
    if (this.scene.fog) {
      this.scene.fog.color.copy(o.hall);
      if (!low) this.scene.fog.density = o.fog;
    }
    const cone = this.arena?.atmo?.cone;
    if (cone && !low) cone.material.opacity = o.haze + this.lightsDim * 0.14;
  }

  // ── Per frame (from game.js _updateCrowd, wall clock) ────────────────────
  _tickCup(dt) {
    const c = this._cup;
    if (!c) return;
    this._tickCeremony(dt);
    this._tickCupBoard(dt);

    let raw = 0;
    if (this.phase === 'fighting' && c.strength > 0 && this.fighters && this.combat) {
      const lead = (this._hp(this.fighters[c.underdog]) - this._hp(this.fighters[1 - c.underdog])) / MAX_HP;
      raw = c.strength * THREE.MathUtils.clamp(lead / LEAD_FULL, -1, 1);
    } else if (this.phase === 'ko' || this.phase === 'result') {
      raw = c.upset; // the verdict holds the mood
    }
    c.upset += (raw - c.upset) * (1 - Math.exp(-dt * 1.2));
    const u = c.upset;
    const floor = EXCITE_FLOOR[c.round];
    // Underdog ahead: the hall leans forward. Favourite cruising: it sags, and settles faster.
    c.exciteFloor = u >= 0 ? floor + 0.4 * u : floor * (1 + u);
    c.crowdLift = CROWD_LIFT[c.round] + (u > 0 ? 0.12 * u : 0);
    c.energy = u >= 0 ? 1 : 1 + 0.45 * u;
    c.decay = u >= 0 ? 0.4 : 0.4 * (1 - 1.2 * u);
    c.phones = u > 0.3 ? 0.4 + 0.6 * u : 0;
    if (Math.abs(u - c.moodPushed) > 0.05) {
      c.moodPushed = u;
      this.audio?.setCrowdMood(u);
    }
    // A favourite cruising gets a wave of boos every few seconds.
    if (this.phase === 'fighting' && u < -0.35) {
      c.booT -= dt;
      if (c.booT <= 0) {
        c.booT = 3.5 + Math.random() * 3;
        this.audio?.crowdBoo(Math.min(1, -u * 1.2));
      }
    } else {
      c.booT = Math.max(c.booT, 1.5);
    }
    c.gaspT = Math.max(0, c.gaspT - dt);

    // The verdict. A KO reports its winner on the tick it lands; a decision on the bell.
    if (!c.decided && (this.phase === 'ko' || this.phase === 'result') && this.winner) {
      c.decided = true;
      if (c.strength > 0 && this.winner - 1 === c.underdog) this._upsetDecided(this.phase === 'ko');
    }
    // 'UPSET!' waits until the screens have shown the K.O.
    if (c.captionT > 0) {
      c.captionT -= dt;
      if (c.captionT <= 0) this._jumboCaption('UPSET!', 3.2);
    }
  }

  _upsetDecided(ko) {
    const c = this._cup;
    c.upset = Math.max(c.upset, 0.85);
    c.captionT = ko ? 1.3 : 0.4;
    this.excited = 1;
    this.audio?.crowdRoar(ko ? 1 : 0.75, ko ? 3 : 2);
    this._pressBurst?.(ko ? 8 : 5);
  }

  /** One landed hit (game.js _registerLandedHit): gasps for the underdog, the slap-back. */
  _upsetOnHit(attacker, defender, dmg) {
    const c = this._cup;
    if (!c || c.strength <= 0 || dmg < HEAVY_HIT_DMG || !this.fighters) return;
    if (this.fighters.indexOf(attacker) === c.underdog && c.gaspT <= 0) {
      c.gaspT = 1.2;
      this.audio?.crowdGasp();
      this.excited = Math.min(1, this.excited + 0.2);
    }
    if (c.upset > UPSET_ECHO) this.audio?.slapback(0.5 + 0.5 * c.upset);
  }

  // ── The jumbotron bracket ────────────────────────────────────────────────
  /**
   * Between bouts the arena screens show the bracket instead of the fight card, until the
   * next count starts. data: { bouts: [{ p1, p2, w }] ×15 in play order (w 0 undecided,
   * 1 left, 2 right), fresh: index of the bout just decided (its winner's line burns
   * forward) or -1, next: index of the next bout or -1, champ: name or null, champWins, title }.
   */
  cupBoard(data) {
    if (!data || !Array.isArray(data.bouts) || data.bouts.length !== 15) { this._cupBoardData = null; return; }
    this._cupBoardData = { ...data, burn: this._calm() || !(data.fresh >= 0) ? 1 : 0 };
    this._jumboT = 99;
  }

  _tickCupBoard(dt) {
    const d = this._cupBoardData;
    if (!d || d.burn >= 1) return;
    d.burn = Math.min(1, d.burn + dt / BURN_SEC);
    this._jumboT = 99; // every frame while the line burns, then back to ~8 Hz
  }

  /** Draws the board onto the jumbotron canvas. False when there is none (or the bout is on). */
  _drawCupBoard(g, W, H) {
    const d = this._cupBoardData;
    if (!d) return false;
    if (this.phase === 'countdown' || this.phase === 'fighting') { this._cupBoardData = null; return false; }
    g.fillStyle = '#0a0f22';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,209,102,0.16)';
    g.fillRect(0, 0, W, 16);
    g.textBaseline = 'middle';
    g.font = 'bold 10px Impact, sans-serif';
    g.textAlign = 'left';
    g.fillStyle = '#ffd166';
    g.fillText('PO BRAWL CUP', 6, 8.5);
    g.textAlign = 'right';
    g.fillStyle = '#cfe0ff';
    g.fillText(String(d.title || '').toUpperCase().slice(0, 24), W - 6, 8.5);

    if (d.champ) {
      // The ceremony card.
      g.textAlign = 'center';
      g.fillStyle = '#ffd166';
      g.font = 'bold 13px Impact, sans-serif';
      g.fillText('★  CHAMPION  ★', W / 2, 38);
      const name = String(d.champ).toUpperCase();
      g.font = `bold ${name.length > 9 ? 24 : 32}px Impact, sans-serif`;
      const grad = g.createLinearGradient(0, 56, 0, 92);
      grad.addColorStop(0, '#fff3c4');
      grad.addColorStop(0.5, '#ffc53d');
      grad.addColorStop(1, '#b57a12');
      g.fillStyle = grad;
      g.fillText(name, W / 2, 74);
      g.font = 'bold 10px Impact, sans-serif';
      g.fillStyle = '#cfe0ff';
      g.fillText(`${Number(d.champWins) || 0} WINS`, W / 2, 104);
    } else {
      this._drawCupBracket(g, d);
    }
    g.fillStyle = 'rgba(0,0,0,0.22)';
    for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
    return true;
  }

  _drawCupBracket(g, d) {
    const COL_X = [3, 65, 127, 189], COL_W = 54, HALF = 8;
    const at = (i) => (i < 8 ? { col: 0, cy: 24 + i * 14 }
      : i < 12 ? { col: 1, cy: 32 + (i - 8) * 28 }
        : i < 14 ? { col: 2, cy: 46 + (i - 12) * 56 }
          : { col: 3, cy: 74 });
    const nextOf = (i) => (i < 8 ? 8 + (i >> 1) : i < 12 ? 12 + ((i - 8) >> 1) : i < 14 ? 14 : -1);
    const slotOf = (i) => (i < 8 ? i & 1 : i < 12 ? (i - 8) & 1 : i < 14 ? i - 12 : 0);

    // Connectors first, under the boxes.
    for (let i = 0; i < 14; i++) {
      const b = d.bouts[i], { col, cy } = at(i);
      const n = at(nextOf(i));
      const x0 = COL_X[col] + COL_W, x2 = COL_X[n.col], xm = (x0 + x2) / 2;
      const yEnd = n.cy + (slotOf(i) ? HALF / 2 : -HALF / 2);
      if (!b.w) {
        g.strokeStyle = 'rgba(160,176,220,0.35)';
        g.lineWidth = 1;
        polyline(g, [[x0, cy], [xm, cy], [xm, yEnd], [x2, yEnd]], 1);
        continue;
      }
      const y0 = cy + (b.w === 1 ? -HALF / 2 : HALF / 2);
      const pts = [[x0, y0], [xm, y0], [xm, yEnd], [x2, yEnd]];
      const p = i === d.fresh ? d.burn : 1;
      g.strokeStyle = '#ffd166';
      g.lineWidth = 2;
      const head = polyline(g, pts, p);
      if (p < 1) {
        // The spark riding the burn front.
        const glow = g.createRadialGradient(head[0], head[1], 0, head[0], head[1], 6);
        glow.addColorStop(0, 'rgba(255,255,240,1)');
        glow.addColorStop(0.35, 'rgba(255,200,90,0.8)');
        glow.addColorStop(1, 'rgba(255,150,40,0)');
        g.fillStyle = glow;
        g.fillRect(head[0] - 6, head[1] - 6, 12, 12);
      }
    }

    g.font = 'bold 9px Impact, sans-serif';
    g.textAlign = 'left';
    for (let i = 0; i < 15; i++) {
      const b = d.bouts[i], { col, cy } = at(i);
      const x = COL_X[col];
      g.fillStyle = i === d.next ? 'rgba(255,209,102,0.16)' : 'rgba(255,255,255,0.06)';
      g.fillRect(x, cy - HALF, COL_W, HALF * 2);
      if (i === d.next) {
        g.strokeStyle = '#ffd166';
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, cy - HALF + 0.5, COL_W - 1, HALF * 2 - 1);
      }
      // The loser's name only greys out once the burn has reached the next round.
      const settled = i !== d.fresh || d.burn >= 1;
      [b.p1, b.p2].forEach((name, k) => {
        const y = cy + (k ? HALF / 2 : -HALF / 2);
        const won = b.w === k + 1, lost = b.w && !won && settled;
        g.fillStyle = !name ? '#4a5272' : won ? '#ffd166' : lost ? '#5d6684' : '#e8eeff';
        const label = fit(g, String(name || 'TBD').toUpperCase(), COL_W - 8);
        g.fillText(label, x + 4, y + 0.5);
        if (lost) {
          g.fillRect(x + 4, y, g.measureText(label).width, 1);
        }
      });
    }
  }

  _disposeCup() {
    this._disposeCeremony();
    this._cupBoardData = null;
    this._cup = null;
  }
}

function lookFrom(T) {
  const o = {};
  for (const n of LOOK_NUMS) o[n] = T[n];
  for (const n of LOOK_COLORS) o[n] = new THREE.Color(T[n]);
  o.keyPos = new THREE.Vector3().fromArray(T.keyPos);
  return o;
}

// Stroke the first `p` (0..1, by length) of a polyline; returns the head point.
function polyline(g, pts, p) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let left = total * p;
  let head = pts[0];
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length && left > 0; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const len = Math.hypot(bx - ax, by - ay);
    const k = len > 0 ? Math.min(1, left / len) : 1;
    head = [ax + (bx - ax) * k, ay + (by - ay) * k];
    g.lineTo(head[0], head[1]);
    left -= len;
  }
  g.stroke();
  return head;
}

function fit(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

export const Cup = CupMethods.prototype;
