// PoMule renderer and frame loop.
//
// The rules live in C# (PoMiniGames.Shared/Games/PoMule). This module is the match's only
// clock: every tenth of a second of game time it calls OnTick on the page and gets back one
// flat snapshot array (layout: PoMuleMatch.Snapshot). During development it also runs the
// avatars (movement, collisions, the M.U.L.E. tether, the walk through the store) and
// reports what they reached; the engine decides what that means. Nothing here changes cash,
// land or goods.
import * as W from './world.js';
import * as P from './physics.js';
import * as Sfx from './audio.js';
import { drawFrame, frameLayout, SCREEN_W, MAP_Y } from './render.js';
import { buildTouchControls, isTouchDevice } from './touch.js';

const TICK = 0.1;
const HEADER = 23, PER = 16;
const LAND = 0, AUCTION = 1, DEVELOP = 2, PRODUCE = 3, MARKET = 5, STANDINGS = 6, FINISHED = 7;
const GOAL_OUTFITTER = 1, GOAL_INSTALL = 2, GOAL_ASSAY = 3, GOAL_SURVEY = 4, GOAL_PUB = 5, GOAL_CHASE = 6;
const RADZEN_CSS_ID = 'pomule-radzen-css';
const MOVE_KEYS = { KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] };

let g = null;

/**
 * Radzen's theme is global CSS, and until the rest of the app moves to Radzen it must only
 * be present while PoMule is. Resolves once the stylesheet and Radzen's script are in.
 */
function ensureRadzen() {
  const base = document.baseURI;
  const css = document.getElementById(RADZEN_CSS_ID) ? Promise.resolve() : new Promise((done) => {
    const link = document.createElement('link');
    link.id = RADZEN_CSS_ID;
    link.rel = 'stylesheet';
    link.href = new URL('_content/Radzen.Blazor/css/material-dark-base.css?v=12.1.12', base).href;
    link.onload = link.onerror = () => done();
    document.head.appendChild(link);
  });
  const js = window.Radzen ? Promise.resolve() : new Promise((done) => {
    const script = document.createElement('script');
    script.src = new URL('_content/Radzen.Blazor/Radzen.Blazor.js?v=12.1.12', base).href;
    script.onload = script.onerror = () => done();
    document.head.appendChild(script);
  });
  return Promise.all([css, js]).then(() => true);
}

function removeRadzen() {
  document.getElementById(RADZEN_CSS_ID)?.remove();
}

function call(method, ...args) {
  return g?.ref.invokeMethodAsync(method, ...args).catch(() => {});
}

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = g.host.clientWidth, h = g.host.clientHeight;
  g.canvas.width = Math.max(1, Math.round(w * dpr));
  g.canvas.height = Math.max(1, Math.round(h * dpr));
  g.view = { w, h, dpr };
}

/** Puts everyone outside a town at the start of a development phase. */
function placeAvatars() {
  for (const a of g.avatars) {
    a.x = W.wrapX(W.TOWN_COLS[a.seat % 4] * W.TILE + W.TILE / 2 + (a.seat < 4 ? -20 : 20));
    a.y = (W.TOWN_ROW + 1) * W.TILE + 24;
    a.stamina = P.DASH_SECONDS;
    a.winded = false;
    a.dashing = false;
    a.mule = null;
    a.cooldown = 0;
    a.bumped = 0;
    a.walked = 0;
    a.frame = 0;
  }
  g.runaways = [];
  g.interior = null;
  g.canEnter = false; // step off the town plot first
  g.stall = -1;
}

function humanInput() {
  let dx = 0, dy = 0;
  for (const code of g.keys) {
    const m = MOVE_KEYS[code];
    if (m) { dx += m[0]; dy += m[1]; }
  }
  return { dx: Math.sign(dx), dy: Math.sign(dy), dash: g.keys.has('ShiftLeft') || g.keys.has('ShiftRight') };
}

function aiInput(a) {
  const kind = g.seat(a.seat, 11), target = g.seat(a.seat, 12);
  let tx, ty, dash = false;
  if (kind === GOAL_INSTALL || kind === GOAL_SURVEY) ({ x: tx, y: ty } = W.tileCenter(target));
  else if (kind === GOAL_OUTFITTER) ({ x: tx, y: ty } = W.nearestBuilding(a.x, W.OUTFITTER));
  else if (kind === GOAL_ASSAY) ({ x: tx, y: ty } = W.nearestBuilding(a.x, W.ASSAY));
  else if (kind === GOAL_PUB) ({ x: tx, y: ty } = W.nearestBuilding(a.x, W.PUB));
  else if (kind === GOAL_CHASE && target >= 0 && !g.avatars[target].hidden) {
    ({ x: tx, y: ty } = g.avatars[target]);
    dash = Math.hypot(W.wrapDelta(a.x, tx), ty - a.y) < 160;
  } else if (kind === GOAL_CHASE) {
    // Nobody to hit: stand in a town doorway and be in the way.
    ({ x: tx, y: ty } = W.nearestBuilding(a.x, W.OUTFITTER));
    ty += W.TILE / 2;
  } else return { dx: 0, dy: 0, dash: false };

  const s = P.steerToward(a, tx, ty, W.WORLD_W, 8);
  if (s.arrived && kind !== GOAL_CHASE && a.cooldown <= 0) {
    a.cooldown = 0.5; // one report per arrival; the next snapshot brings the next goal
    call('OnArrive', a.seat);
  }
  return { dx: s.dx, dy: s.dy, dash };
}

/** Counts off the walk cycle and its footstep blips. */
function stride(a, before, loud) {
  const moved = Math.hypot(a.x - before.x, a.y - before.y);
  if (moved <= 0 || moved > W.TILE) return; // standing still, or wrapped round the seam
  a.walked += moved;
  const frame = Math.floor(a.walked / 14) % 2;
  if (frame !== a.frame && loud) Sfx.step();
  a.frame = frame;
}

/** The player inside the store: walk into a stall to use it, out either side to leave. */
function simulateInterior(me, dt, speed) {
  const before = { x: me.x, y: me.y };
  // A width with no seam in reach: the store does not wrap.
  P.stepAvatar(me, humanInput(), dt, 1e9, W.WORLD_H, speed / 100);
  stride(me, before, true);
  if (me.hasMule) {
    me.mule ??= { x: me.x - me.facing * P.TETHER, y: me.y };
    P.stepTether(me.mule, me, dt, 1e9);
  } else me.mule = null;

  if (me.x < 12 || me.x > W.WORLD_W - 12) {
    // Back out onto the planet, just below the town.
    me.x = W.TOWN_COLS[g.interior.town] * W.TILE + W.TILE / 2;
    me.y = (W.TOWN_ROW + 1) * W.TILE + 24;
    me.mule = null;
    g.interior = null;
    g.canEnter = false;
    return;
  }
  const stall = W.stallAt(me.x, me.y);
  if (stall !== g.stall) {
    g.stall = stall;
    if (stall >= 0) call('OnTown', stall);
  }
}

/** One slice of the development phase: move, collide, drag M.U.L.E.s, tell the engine. */
function simulate(dt) {
  const me = g.human ? g.avatars[0] : null;
  for (const a of g.avatars) {
    const speed = g.seat(a.seat, 5);
    a.out = g.seat(a.seat, 8) === 1 || speed === 0;
    a.hasMule = g.seat(a.seat, 6) === 1;
    a.cooldown -= dt;
    a.bumped -= dt;
    if (a.out && a === me) g.interior = null;
    // Off the map: in the pub, out of time, or (the player) inside the store.
    a.hidden = a.out || (a === me && !!g.interior);
    if (a.out) { a.mule = null; continue; }
    if (a === me && g.interior) { simulateInterior(a, dt, speed); continue; }

    const before = { x: a.x, y: a.y };
    const input = a === me ? humanInput() : aiInput(a);
    const terrain = g.terrain[W.tileAt(a.x, a.y).index];
    P.stepAvatar(a, input, dt, W.WORLD_W, W.WORLD_H, (speed / 100) * P.terrainFactor(terrain, a.trait));
    stride(a, before, a === me);
  }

  // Collisions are between colonists out on the map; `out` is what the physics skips.
  for (const a of g.avatars) a.out = a.hidden;
  const bumps = P.resolveCollisions(g.avatars, W.WORLD_W);

  const reportBump = (a) => {
    if (!a.hasMule || a.bumped > 0) return;
    a.bumped = 1;
    call('OnBump', a.seat);
  };
  for (const b of bumps) {
    if (!b.dashA && !b.dashB) continue;
    reportBump(g.avatars[b.a]);
    reportBump(g.avatars[b.b]);
  }

  for (const a of g.avatars) {
    if (a.hidden) continue;
    if (!a.hasMule) { a.mule = null; continue; }
    a.mule ??= { x: W.wrapX(a.x - a.facing * P.TETHER), y: a.y };
    if (P.stepTether(a.mule, a, dt, W.WORLD_W)) reportBump(a);
  }
  for (const r of g.runaways) { r.x = W.wrapX(r.x + r.vx * dt); r.life -= dt; }
  g.runaways = g.runaways.filter((r) => r.life > 0);

  if (me && !me.hidden) {
    const here = W.tileAt(me.x, me.y);
    const town = here.row === W.TOWN_ROW ? W.TOWN_COLS.indexOf(here.col) : -1;
    if (town < 0) g.canEnter = true;
    else if (g.canEnter) {
      // Through the door: the store's interior takes over the screen.
      g.interior = { town };
      g.stall = -1;
      me.x = W.WORLD_W / 2;
      me.y = W.WORLD_H / 2;
      me.mule = null;
    }
    // Touching the wampus while it shows is how it is caught.
    if (g.snap[20] === here.index && me.cooldown <= 0) {
      me.cooldown = 0.5;
      call('OnWampus');
    }
  }
}

/** A point on the fat-pixel screen (render.js) in viewport px, for a cue's particle burst. */
function screenPoint(bx, by) {
  const r = g.canvas.getBoundingClientRect();
  const layout = frameLayout(g.view);
  const scale = layout.width / SCREEN_W;
  return {
    x: r.left + layout.x + bx * scale,
    y: r.top + layout.y + by * scale,
  };
}

const worldPoint = (x, y) => screenPoint(x / 4, MAP_Y + y / 4); // 4 world units to a fat pixel
const plotPoint = (i) => { const t = W.tileCenter(i); return worldPoint(t.x, t.y); };

/** Where a message's sound happened: the highlighted plot in the land grant, else the player. */
function soundAt() {
  if (!g?.view) return null;
  if (g.phase === LAND && g.snap[10] >= 0) return plotPoint(g.snap[10]);
  const me = g.avatars[0];
  return g.human && me && !me.hidden && !g.interior ? worldPoint(me.x, me.y) : null;
}

function onSnapshot(snap) {
  const before = g.phase;
  g.snap = snap;
  g.phase = snap[1];
  // The land auction ticks with each new high bid, like the original's floor.
  if (g.phase === AUCTION && before === AUCTION && snap[5] > 0 && snap[5] !== g.bid) Sfx.auctionTick();
  g.bid = snap[5];
  if (g.phase === before) return;
  g.phaseTime = 0;
  g.units = 0;
  g.interior = null;
  if (g.phase === DEVELOP) placeAvatars();
  if (g.phase !== PRODUCE) g.production = null;
  // The engine zeroes the player's market direction when a market opens; start level and
  // resend if a key is already down.
  g.marketDir = 0;
  sendMarketDir();
  g.trades = [];
}

function frame(now) {
  if (!g?.running) return;
  g.raf = requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - g.last) / 1000);
  g.last = now;
  // A phone held upright shows the rotate prompt; the match waits.
  g.paused = g.touch && window.matchMedia('(orientation: portrait)').matches;
  if (!g.paused) {
    const gameDt = dt * g.speed;
    g.time += dt;
    g.phaseTime += gameDt;
    if (g.phase === DEVELOP) for (let left = gameDt; left > 0; left -= 0.05) simulate(Math.min(0.05, left));
    for (const t of g.trades) t.life -= dt;
    g.trades = g.trades.filter((t) => t.life > 0);
    // A message is worth so many seconds of the match, not of the wall clock: sped up, it
    // would otherwise still be on the bar two phases later. (Never quicker than 4×, to stay readable.)
    if (g.messageLife > 0 && (g.messageLife -= dt * Math.min(g.speed, 4)) <= 0) g.message = '';

    // Production counts each plot's units up one at a time, with a blip for each.
    if (g.phase === PRODUCE && g.production) {
      const shown = Math.min(7, Math.floor(g.phaseTime / 0.35));
      if (shown > g.units && g.production.some((n) => n >= shown)) Sfx.unit(shown);
      g.units = Math.max(g.units, shown);
    }

    g.acc += gameDt;
    while (g.acc >= TICK) { g.acc -= TICK; g.pending++; }
    if (g.pending > 0 && !g.busy && g.phase !== FINISHED) {
      const n = Math.min(g.pending, 20);
      g.pending -= n;
      g.busy = true;
      g.ref.invokeMethodAsync('OnTick', n)
        .then((snap) => { if (g) { g.busy = false; onSnapshot(snap); } })
        .catch((e) => { console.error('[PoMule] tick failed', e); window.PoMule.stop(); });
    }
  }

  g.ctx.setTransform(g.view.dpr, 0, 0, g.view.dpr, 0, 0);
  drawFrame(g.ctx, g, g.view);
}

function onKeyDown(e) {
  if (!g || e.target?.closest?.('input, textarea, select')) return;
  // A focused button or link owns Space: on the Bid button it must be one bid, not the
  // button's click plus this handler's. Movement keys still work from there.
  const move = MOVE_KEYS[e.code];
  if (e.code === 'Space' && e.target?.closest?.('button, a')) return;
  if (move || e.code === 'Space') e.preventDefault();
  if (g.paused || !g.human) return;

  if (!e.repeat) {
    g.keys.add(e.code);
    if (e.code === 'Space') {
      // Land grant: claim the plot the highlighter is on, as drawn on this screen.
      if (g.phase === LAND) { if (g.snap[10] >= 0) call('OnLandPick', g.snap[10]); }
      else if (g.phase === DEVELOP && !g.interior && !g.avatars[0].hidden) {
        // On the map the button installs the towed M.U.L.E. (or surveys) where you stand.
        call('OnPlotAction', W.tileAt(g.avatars[0].x, g.avatars[0].y).index);
      } else if (g.phase === STANDINGS) call('OnSkip');
    }
  }
  sendMarketDir();
}

function onKeyUp(e) {
  if (!g) return;
  g.keys.delete(e.code);
  sendMarketDir();
}

/** The window lost focus: no keyup will arrive for whatever was held, so let go of it all. */
function onBlur() {
  if (!g) return;
  g.keys.clear();
  sendMarketDir();
}

function sendMarketDir() {
  // The land auction is walked like the market: up the floor to bid more.
  if ((g.phase !== MARKET && g.phase !== AUCTION) || !g.human) return;
  const dir = -humanInput().dy; // up the screen is up in price
  if (dir !== g.marketDir) {
    g.marketDir = dir;
    call('OnMarketInput', dir);
    // The original sings the price: higher on the floor, higher the note.
    if (dir !== 0) Sfx.price((g.seat(0, 10) - g.snap[8]) / Math.max(1, g.snap[8]));
  }
}

window.PoMule = {
  ensureRadzen,
  removeRadzen,

  /**
   * @param opts { terrain, peaks, species, traits, colors, names: arrays; human: bool;
   *               speed: number; snapshot: the match's first snapshot }
   */
  start(containerId, dotnetRef, opts) {
    this.stop();
    const host = document.getElementById(containerId);
    if (!host) return false;
    const canvas = document.createElement('canvas');
    canvas.className = 'pm-canvas';
    host.appendChild(canvas);
    const plots = W.COLS * W.ROWS;
    g = {
      host, canvas, ctx: canvas.getContext('2d'), ref: dotnetRef,
      terrain: opts.terrain, peaks: opts.peaks, species: opts.species, colors: opts.colors, names: opts.names,
      owner: new Array(plots).fill(-1), installed: new Array(plots).fill(-1), crystite: new Array(plots).fill(0),
      human: !!opts.human, speed: opts.speed || 1, seats: opts.species.length,
      snap: opts.snapshot, phase: -1, time: 0, phaseTime: 0, acc: 0, pending: 0, busy: false, running: true, paused: false,
      keys: new Set(),
      avatars: opts.species.map((species, seat) => ({ seat, species, trait: opts.traits[seat], mass: P.massOf(opts.traits[seat]), x: 0, y: 0, facing: 1, out: false, hidden: false, frame: 0, walked: 0 })),
      runaways: [], trades: [], production: null, units: 0, eventPlot: -1, message: '', messageLife: 0,
      interior: null, canEnter: false, stall: -1, marketDir: 0, touch: false, removeTouch: null,
      seat(seat, field) { return this.snap[HEADER + seat * PER + field]; },
    };
    placeAvatars();
    onSnapshot(opts.snapshot);
    resize();
    g.onResize = () => g && resize();
    g.resizeObserver = new ResizeObserver(g.onResize);
    g.resizeObserver.observe(host);
    window.addEventListener('resize', g.onResize);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    if (g.human && isTouchDevice()) {
      g.touch = true;
      g.removeTouch = buildTouchControls(host);
    }
    if (g.human) Sfx.tune();
    // The host shakes with the cues' impact feel (a meteor, a claim).
    g.unstage = window.PoImpact?.registerStage?.(host);
    g.last = performance.now();
    g.raf = requestAnimationFrame(frame);
    return true;
  },

  /** Terrain (a meteor can change it), owners, installed M.U.L.E.s and the Crystite the viewer may see. */
  setPlots(terrain, owner, installed, crystite) {
    if (!g) return;
    // Only a meteor makes a crater: one appearing is the strike landing.
    for (let i = 0; i < terrain.length; i++) {
      if (terrain[i] === W.CRATER && g.terrain[i] !== W.CRATER) { Sfx.meteor(g.view ? plotPoint(i) : null); break; }
    }
    g.terrain = terrain;
    g.tilesStale = true; // render.js repaints its cached picture of the plots
    g.owner = owner;
    g.installed = installed;
    g.crystite = crystite;
  },

  /** How many times faster than real time the match runs (the demo's speed buttons). */
  setSpeed(speed) {
    if (g) g.speed = Math.min(16, Math.max(1, speed));
  },

  /** Puts a line on the orange message bar for a few seconds. `sound`: a name from audio.js. */
  say(text, seconds = 4, sound = '') {
    if (!g) return;
    g.message = String(text);
    g.messageLife = seconds;
    Sfx[sound]?.(soundAt());
  },

  /** This month's output per plot, for the unit-by-unit count on the map. */
  production(perPlot) {
    if (g) { g.production = perPlot; g.units = 0; }
  },

  /** The plot this month's event struck (a meteor, the pests), or -1. */
  eventAt(plot) {
    if (g) g.eventPlot = plot;
  },

  /** A M.U.L.E. bolts from this seat's avatar and runs off. */
  runaway(seat) {
    const a = g?.avatars[seat];
    if (!a) return;
    if (!a.hidden) g.runaways.push({ x: a.mule?.x ?? a.x, y: a.mule?.y ?? a.y, vx: -a.facing * 260, life: 2 });
    a.mule = null;
    if (seat === 0 && g.human) Sfx.bray();
  },

  /** Flash a trade on the floor. A seat of -1 is the Store. */
  trade(seller, buyer, price) {
    if (!g) return;
    g.trades.push({ seller, buyer, price, life: 0.33 });
    Sfx.trade();
  },

  stop() {
    if (!g) return;
    g.running = false;
    cancelAnimationFrame(g.raf);
    g.resizeObserver.disconnect();
    window.removeEventListener('resize', g.onResize);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    g.removeTouch?.();
    g.unstage?.();
    g.canvas.remove();
    g = null;
  },
};

// Debug handle for the Playwright tests.
window.__pomule = () => g;
