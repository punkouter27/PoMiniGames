// composer.js — the one course, dealt fresh every race.
//
// There is a single map (maps.js, slot 7), and it is never the same twice: the race seed picks a
// THEME (sky, light, kerbs, backdrop) and a run of SET-PIECES in a random order with random gaps,
// and track-procedural.js builds whatever this returns. A seed always deals the same course, so an
// online guest and the host (who share the seed the server dealt) race the identical one.
//
// What does NOT move, on purpose:
//   · the length (2800) and the drop: MarbleRaceRunVerifier.cs checks finish times against the
//     finish distance of slot 7, so a shorter course would let real times look impossible;
//   · the finale (last boost, the Gauntlet, the checkered tray): every race ends the same way;
//   · the plinko field is always dealt — it is the main source of race-to-race variance, and
//     without it the finishing order is mostly the start grid.
//
// Everything is pure arithmetic on the seed (no Math.random), so the headless harness
// (scripts/pomarblerace) can replay any course.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a + (b - a) * t for two 0xRRGGBB colours. */
export function mixHex(a, b, t) {
  const ch = (h, s) => (h >> s) & 255;
  const m = (s) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t) & 255;
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

// ── Themes ──────────────────────────────────────────────────────────────────────────────────
// `favor` lists set-pieces this theme deals more often (weight FAVOR_WEIGHT instead of 1).
// `splat` describes the Gaussian-splat backdrop (backdrop.js): what the far scenery is made of.
const FAVOR_WEIGHT = 2.6;
export const THEMES = [
  {
    id: 'neon', name: 'Neon Night',
    bg: 0x0b1024, fogNear: 90, fogFar: 360,
    ambient: [0xb4b0d8, 2.7], hemi: [0xc4a8ff, 0x2a1824, 1.8], key: [0xffe8cc, 3.0], exposure: 1.1,
    reflect: true, kerbTint: 0xffffff,
    acts: ['#f59e0b', '#e879f9', '#fbbf24', '#38bdf8'],
    actNames: ['Neon Gate', 'Canyon Lights', 'Midnight Run', 'Afterglow'],
    favor: ['kickers', 'bobs', 'magnets', 'tunnel'],
    splat: { kind: 'city', rock: [0x1a1638, 0x2a2458], top: 0x3b3170, accent: [0xe879f9, 0x22d3ee, 0xfde047], accentShare: 0.07 },
  },
  {
    id: 'glacier', name: 'Glacier Run',
    bg: 0x10202f, fogNear: 100, fogFar: 380,
    ambient: [0xcfe3f5, 2.9], hemi: [0xdff2ff, 0x24323f, 2.0], key: [0xf4fbff, 3.2], exposure: 1.12,
    reflect: true, kerbTint: 0xd8ecff,
    acts: ['#7dd3fc', '#a5b4fc', '#5eead4', '#e0f2fe'],
    actNames: ['Ice Shelf', 'Crevasse', 'Meltwater', 'Frozen Falls'],
    favor: ['ice', 'flume', 'seesaws', 'funnel'],
    splat: { kind: 'peaks', rock: [0x2b3a4a, 0x46586b], top: 0xeef6ff, accent: [0x9bd7ff], accentShare: 0.01 },
  },
  {
    id: 'foundry', name: 'Foundry',
    bg: 0x1a0d09, fogNear: 80, fogFar: 340,
    ambient: [0xd6b8a2, 2.6], hemi: [0xffb070, 0x2a120a, 1.7], key: [0xffd2a6, 3.0], exposure: 1.08,
    reflect: false, kerbTint: 0xffd9b8,
    acts: ['#fb923c', '#f87171', '#facc15', '#fdba74'],
    actNames: ['Smelter', 'Slag Chute', 'Forge Floor', 'Quench'],
    favor: ['magnets', 'conveyors', 'turnstiles', 'kickers'],
    splat: { kind: 'basalt', rock: [0x1c1412, 0x30211c], top: 0x47302a, accent: [0xff6a1a, 0xffb020], accentShare: 0.06 },
  },
  {
    id: 'jungle', name: 'Jungle Dusk',
    bg: 0x0d1a12, fogNear: 85, fogFar: 350,
    ambient: [0xc2d8b8, 2.8], hemi: [0xc8f0b0, 0x1c2414, 1.9], key: [0xffe2b0, 3.0], exposure: 1.1,
    reflect: false, kerbTint: 0xe8ffd8,
    acts: ['#4ade80', '#facc15', '#2dd4bf', '#fb923c'],
    actNames: ['Canopy', 'Vine Bridge', 'River Run', 'Temple Steps'],
    favor: ['flume', 'seesaws', 'trampolines', 'bobs'],
    splat: { kind: 'canopy', rock: [0x2a2a1e, 0x3b3a28], top: 0x2f6b34, accent: [0xfde68a, 0xf472b6], accentShare: 0.012 },
  },
  {
    id: 'desert', name: 'Desert Canyon',
    bg: 0x2c1f18, fogNear: 110, fogFar: 400,
    ambient: [0xe6cfb6, 3.0], hemi: [0xffe0b0, 0x3a2414, 2.0], key: [0xfff0d8, 3.4], exposure: 1.12,
    reflect: false, kerbTint: 0xffe9cc,
    acts: ['#fbbf24', '#f97316', '#fca5a5', '#fde68a'],
    actNames: ['Dry Wash', 'Mesa Pass', 'Dune Sea', 'Red Rock'],
    favor: ['sand', 'ridges', 'trampolines', 'funnel'],
    splat: { kind: 'mesa', rock: [0x7a3b20, 0xa3542c], top: 0xd08a52, accent: [0xf6d7a7], accentShare: 0.006 },
  },
];

// ── Set-pieces ──────────────────────────────────────────────────────────────────────────────
// len(r): the share of the course a piece takes (r is the composer's random source).
// apply(Z, a, b, r, out): write the piece into the zone table Z over [a, b]; `out` collects the
// course-shape extras (pinches, flares, plunges, reverb zones).
// `once`: pieces whose zone is a single slot in the generator can only be dealt once — all of
// them are, in fact, so a course never repeats a piece.
const OFF = () => ({ from: 1, to: 0, step: 1 });
const PIECES = [
  {
    id: 'split', name: 'Split Lanes', line: 'The pack splits — pick a lane!',
    len: () => 0.12,
    apply(Z, a) {
      Z.BRAKE.push([a, a + 0.028, 50]);
      Z.SPLITS.push({ from: a + 0.034, to: a + 0.115, widthFrac: 0.2 });
      Z.BOOST.push([a + 0.055, a + 0.08]);
    },
  },
  {
    id: 'plinko', name: 'Plinko Scramble', line: 'Into the plinko scramble!',
    len: (r) => 0.085 + Math.floor(r() * 3) * 0.009,
    apply(Z, a, b, r, out) {
      // A short funnel at the mouth squeezes the pack into the pins.
      out.pinches.push({ c: a + 0.004, w: 0.012, d: 0.3 });
      Z.PLINKO = { from: a + 0.014, to: b - 0.004, rows: Math.round((b - a) / 0.012) };
    },
  },
  {
    id: 'kickers', name: 'Kicker Band', line: 'Kickers charging — brace!',
    len: () => 0.03,
    apply(Z, a, b) { Z.KICKERS = [a + 0.004, b - 0.004]; },
  },
  {
    id: 'bobs', name: 'Pendulums', line: 'Pendulums swinging ahead!',
    len: () => 0.075,
    apply(Z, a, b) { Z.BOBS = { from: a + 0.006, to: b - 0.006, step: 0.031 }; },
  },
  {
    id: 'ridges', name: 'Washboard', line: 'Washboard ridges — hang on!',
    len: () => 0.05,
    apply(Z, a, b) { Z.RIDGES = { from: a + 0.004, to: b - 0.004, step: 0.0105 }; },
  },
  {
    id: 'funnel', name: 'Vortex Funnel', line: 'Vortex funnel and free-fall plunge!',
    len: () => 0.1,
    apply(Z, a, b, r, out) {
      out.flares.push({ c: a + 0.028, w: 0.026, d: 0.42 });
      out.pinches.push({ c: a + 0.066, w: 0.022, d: 0.52 });
      out.plunges.push({ c: a + 0.084, w: 0.013, drop: 80 + Math.round(r() * 20) });
    },
  },
  {
    id: 'tunnel', name: 'Drop Tunnel & Slide', line: 'Dropping into the tunnel!',
    len: () => 0.125,
    apply(Z, a, b, r, out) {
      Z.TUNNELS.push({ from: a, to: a + 0.068 });
      Z.SLIDE = [a + 0.072, b];
      out.reverb.push({ from: a, to: a + 0.068, wet: 0.45, tone: 2200 });
    },
  },
  {
    id: 'turnstiles', name: 'Turnstiles', line: 'Turnstiles spinning!',
    len: () => 0.05,
    apply(Z, a, b) { Z.TURNSTILES = { from: a + 0.006, to: b - 0.006, step: 0.019 }; },
  },
  {
    id: 'trampolines', name: 'Trampolines', line: 'Trampolines — get some air!',
    len: () => 0.045,
    apply(Z, a, b) { Z.TRAMPOLINES = { from: a + 0.006, to: b - 0.006, rows: 3 }; },
  },
  {
    id: 'seesaws', name: 'See-saws', line: 'See-saws tipping ahead!',
    len: () => 0.055,
    apply(Z, a, b) { Z.SEESAWS = { from: a + 0.008, to: b - 0.008, step: 0.0195 }; },
  },
  {
    id: 'conveyors', name: 'Cross Conveyors', line: 'Conveyor belts — fight the drag!',
    len: () => 0.05,
    apply(Z, a, b, r) {
      let dir = r() < 0.5 ? 1 : -1;
      for (let k = 0; k < 3; k++, dir = -dir) {
        const s0 = a + k * 0.0175;
        Z.CONVEYORS.push([s0, s0 + 0.013, dir]);
      }
    },
  },
  {
    id: 'magnets', name: 'Magnet Alley', line: 'Magnets live — steer through!',
    len: () => 0.06,
    apply(Z, a, b) { Z.MAGNETS = { from: a + 0.008, to: b - 0.008, step: 0.0145 }; },
  },
  {
    id: 'ice', name: 'Ice Sheet', line: 'Black ice! No grip!',
    len: (r) => 0.05 + r() * 0.02,
    apply(Z, a, b) { Z.ICE.push([a, b]); },
  },
  {
    id: 'sand', name: 'Sand Trap', line: 'Sand trap — keep your speed!',
    len: (r) => 0.04 + r() * 0.015,
    apply(Z, a, b) { Z.SAND.push([a, b]); },
  },
  {
    id: 'flume', name: 'Water Flume', line: 'Splashdown in the flume!',
    len: (r) => 0.08 + r() * 0.015,
    apply(Z, a, b) { Z.FLUME.push([a, b]); },
  },
];

// Where the dealt pieces live, as shares of the course. The start grid runs to ~0.031; the
// finale (FINALE_FROM onward) is fixed.
const DEAL_FROM = 0.045;
const DEAL_TO = 0.852;
const MIN_GAP = 0.008;
const FINALE_FROM = 0.855;

/**
 * Deal the course for a seed.
 * @returns {{ variant, theme, acts, reverbZones, name, sub, pieces: string[] }}
 *   `variant` is generateTrack's last argument; the rest is presentation for game.js.
 */
export function composeCourse(seed) {
  const r = mulberry32((seed ^ 0x5eedc0de) >>> 0);
  const theme = THEMES[Math.floor(r() * THEMES.length)];

  // Choose: plinko always, then a weighted draw without replacement (Efraimidis–Spirakis keys:
  // u^(1/w), largest first) until the budget is full.
  const lens = new Map(PIECES.map((p) => [p.id, p.len(r)]));
  const keyed = PIECES.filter((p) => p.id !== 'plinko').map((p) => {
    const w = theme.favor.includes(p.id) ? FAVOR_WEIGHT : 1;
    return { p, k: Math.pow(r(), 1 / w) };
  }).sort((x, y) => y.k - x.k).map((e) => e.p);
  const chosen = [PIECES.find((p) => p.id === 'plinko')];
  const budget = DEAL_TO - DEAL_FROM;
  let used = lens.get('plinko');
  for (const p of keyed) {
    const need = used + lens.get(p.id) + MIN_GAP * (chosen.length + 2);
    if (need <= budget) { chosen.push(p); used += lens.get(p.id); }
  }
  // Shuffle the running order (Fisher–Yates on the composer's stream).
  for (let i = chosen.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
  }

  // Spread the slack over the gaps (one before each piece and one before the finale).
  const gaps = chosen.length + 1;
  const slack = budget - used - MIN_GAP * gaps;
  const shares = Array.from({ length: gaps }, () => 0.4 + r());
  const shareSum = shares.reduce((a, b) => a + b, 0);
  const gapLen = shares.map((w) => MIN_GAP + slack * (w / shareSum));

  const Z = {
    BRAKE: [], SPLITS: [], BOOST: [], RUMBLE: [], TUNNELS: [], ICE: [], SAND: [], FLUME: [], CONVEYORS: [],
    PLINKO: OFF(), KICKERS: null, BOBS: OFF(), RIDGES: OFF(), TURNSTILES: OFF(), SEESAWS: OFF(),
    TRAMPOLINES: OFF(), MAGNETS: OFF(), SLIDE: null,
    // The finale: the last boost launch into the double Gauntlet and the wide checkered tray.
    GAUNTLET: { from: 0.89, to: 0.94, step: 0.016 },
    FINISH: [0.945, 1.0],
  };
  const out = {
    pinches: [{ c: 0.86, w: 0.025, d: 0.36 }],   // the pre-Gauntlet squeeze
    flares: [{ c: 0.975, w: 0.035, d: 0.35 }],   // the finish tray
    plunges: [],
    reverb: [],
  };

  // Lay the pieces down; a wide enough gap may carry a boost pad or a rumble band.
  const placed = [];
  let s = DEAL_FROM;
  for (let i = 0; i < chosen.length; i++) {
    const g = gapLen[i];
    if (g >= 0.03) {
      const roll = r();
      const mid = s + g / 2;
      if (roll < 0.55) Z.BOOST.push([mid - 0.011, mid + 0.011]);
      else if (roll < 0.8) Z.RUMBLE.push([mid - 0.011, mid + 0.011]);
    }
    s += g;
    const p = chosen[i];
    const a = s, b = s + lens.get(p.id);
    p.apply(Z, a, b, r, out);
    placed.push({ p, a, b });
    s = b;
  }
  Z.BOOST.push([0.862, 0.882]);   // the finale's launch

  // Acts: the dealt pieces in four runs of near-equal count, then the fixed finale.
  const acts = [];
  const per = Math.ceil(placed.length / 4);
  for (let k = 0; k < 4; k++) {
    const run = placed.slice(k * per, (k + 1) * per);
    if (!run.length) continue;
    const color = theme.acts[k % theme.acts.length];
    acts.push({
      from: acts.length === 0 ? 0 : run[0].a - 0.004,
      color,
      tag: `ACT ${acts.length + 1} · ${theme.actNames[k].toUpperCase()}`,
      sub: run.map((e) => e.p.name).join(' · '),
      line: run[0].p.line,
    });
  }
  acts.push({
    from: FINALE_FROM, color: '#ef4444',
    tag: `ACT ${acts.length + 1} · GRAND FINALE`, sub: 'Double Gauntlet to the Checkered Tray',
    line: 'Final Gauntlet! Hold your line to the finish!',
  });
  for (let k = 0; k < acts.length; k++) {
    acts[k].to = k + 1 < acts.length ? acts[k + 1].from : 1;
    const hex = parseInt(acts[k].color.slice(1), 16);
    // Act lighting (scene.js setActLights): the sky leans toward the act's colour, the fill
    // takes a third of it; the key stays the theme's sun.
    acts[k].light = { bg: mixHex(theme.bg, hex, 0.1), key: theme.key[0], hemi: mixHex(theme.hemi[0], hex, 0.35) };
  }

  const variant = {
    // LENGTH and DROP fixed (see the header); width and wander vary.
    track: { LENGTH: 2800, DROP: 1120, START_Y: 240, CHANNEL_WIDTH: 54 + Math.round(r() * 8), SEGMENTS: 780 },
    zones: Z,
    pinches: out.pinches,
    flares: out.flares,
    plunges: out.plunges,
    curve: 0.95 + r() * 0.2,
    kerbTint: theme.kerbTint,
    // Checkpoint arches and sector splits: where acts 2..5 begin.
    checkpoints: acts.slice(1).map((a) => a.from),
  };
  return {
    variant,
    theme,
    acts,
    reverbZones: out.reverb,
    name: `${theme.name} · Course ${String(seed % 10000).padStart(4, '0')}`,
    sub: placed.map((e) => e.p.name).join(' · '),
    pieces: placed.map((e) => e.p.id),
    // Where each dealt piece runs, as shares of the course: the pre-race flyover names them.
    spans: placed.map((e) => ({ name: e.p.name, a: e.a, b: e.b })),
  };
}
