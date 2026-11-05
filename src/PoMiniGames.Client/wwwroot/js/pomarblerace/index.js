// index.js — public interop surface for PoMarbleRace. The Blazor page calls these.
import { Game } from './game.js';
import { mapById, mapMenu, DEFAULT_MAP_ID } from './maps.js';
import { SKINS, WEIGHTS, paletteHex } from './marbles.js';
import { GUEST_COLOR } from './tuning.js';
import { readBest, readTrackStats, readMarbleChoice, load as loadSave, update as updateSave, readPref, setPref } from './store.js';
import { startPad, stopPad, watchInput, unwatchInput } from './gamepad.js';

let game = null;
// Monotonic token for the in-flight start(). The course model is fetched over the network, so
// two starts can overlap (navigate away and back, or the kiosk cycling a demo) and the slower
// one would otherwise install its Game over the newer one's. Only the latest token may install.
let startToken = 0;

window.PoMarbleRace = {
  /**
   * Everything the page's intro card offers, as one JSON string (the page deserializes it with a
   * source-generated context — trim-safe): maps, skins with their unlock score, weights, the best
   * run, per-track stats, the last marble picked, and the HUD palette.
   */
  menu() {
    const choice = readMarbleChoice();
    return JSON.stringify({
      maps: mapMenu(), defaultMap: DEFAULT_MAP_ID,
      skins: SKINS, weights: WEIGHTS.map(({ id, name, hint }) => ({ id, name, hint })),
      best: readBest(), stats: readTrackStats(), skin: choice.skin, weight: choice.weight,
      // HUD colours, so the page never keeps its own copy of the palette.
      palette: { ...paletteHex(), guest: '#' + GUEST_COLOR.toString(16).padStart(6, '0') },
      // The Settings drawer's switches, as saved (store.js prefs, plus the ghost and mute).
      prefs: { ...loadSave().prefs, ghostOn: loadSave().ghostOn, muted: !!readPref('muted') },
    });
  },

  // Async because a map may have to fetch an authored model before anything can be built. The
  // Blazor page calls this without awaiting; every other entry point below is a no-op until
  // `game` exists, which is the same guard they already had.
  // `online` is null for a local game, else { role: 'host'|'guest', seed, guestIndex } — see
  // the Online section of game.js.
  // `marble` is the player's { skin, weight } pick, or null for defaults (demo, online guest).
  async start(containerId, dotnetRef, demo, mapId, online, marble) {
    const token = ++startToken;
    if (game) { game.dispose(); game = null; }
    const el = document.getElementById(containerId);
    if (!el) { console.error('[PoMarbleRace] container not found:', containerId); return; }
    const map = mapById(mapId === undefined || mapId === null ? DEFAULT_MAP_ID : mapId);
    // Download progress for the page's loading bar, in whole percent and only on change.
    let lastPct = -1;
    const onProgress = (f) => {
      const pct = Math.round(f * 100);
      if (pct === lastPct || !dotnetRef || token !== startToken) return;
      lastPct = pct;
      dotnetRef.invokeMethodAsync('OnLoadProgress', pct).catch(() => { });
    };
    let asset;
    try {
      asset = await map.load(onProgress);
    } catch (err) {
      console.error(`[PoMarbleRace] failed to load map ${map.id} (${map.name}):`, err);
      // Thrown on to the page (its start() call rejects), which offers a retry card instead of a
      // dead canvas. A superseded start stays quiet.
      if (token !== startToken) return;
      throw new Error(`Couldn't load ${map.name}. Check your connection and try again.`);
    }
    // A newer start() (or a stop()) landed while the map was in flight — stand down.
    if (token !== startToken) return;
    // No pick from the page (an auto-skipped intro can beat the menu load): race the saved one.
    game = new Game(containerId, dotnetRef, demo, map.id, asset, online || null, marble || (demo ? null : readMarbleChoice()));
    if (readPref('muted')) game.setMuted(true);
    game.start();
    if (!demo) startPad(() => game);
  },
  // The host calls resume() after the intro OK is clicked. Until then the rAF
  // loop is gated and OnPhase('pick') is suppressed, so the 3s pick countdown
  // never runs while the intro is still on screen.
  resume() { if (game) game.resume(); },
  pick(index) { if (game) game.pick(index); },
  // dir: -1 steers left, +1 right (local track frame); active toggles the hold on/off. The
  // on-screen pads drive this on pointer down/up, mirroring the keyboard's keydown/keyup.
  setSteer(dir, active) { if (game) game.setSteer(dir, active); },
  // The pick countdown is owned by the Blazor component, so the pip that goes with it has
  // to be driven from there — JS never sees the tick.
  beep(final) { if (game) game.beep(final); },
  regenerate() { if (game) game.regenerate(); },
  setMuted(muted) { setPref('muted', !!muted); if (game) game.setMuted(muted); },
  // Performance overlay (perf.js): FPS, frame/physics/render ms, draws, live field, tier drops. F3 too.
  setPerfHud(on) { setPref('perfHud', !!on); if (game) game.setPerfHud(on); },
  // Settings → Effects: 'full' | 'lite'. Lite drops everything fx-race.js adds (bursts, speed
  // streak + lens dirt, SSR), the finish swoop and the glass dispersion. Live, and remembered.
  setEffects(level) {
    const l = level === 'lite' ? 'lite' : 'full';
    setPref('effects', l);
    if (game) { game.scene.setEffects?.(l); game.marbleSet?.setEffects?.(l); }
  },
  // Settings drawer: show the ghost of your best run (same switch as the G key).
  setGhost(on) {
    if (game) { if (!!game._ghostOn !== !!on) game.toggleGhost(); } else updateSave((s) => { s.ghostOn = !!on; });
  },
  // Settings drawer: the spoken race announcer (audio.js say), off by default and remembered.
  setAnnouncer(on) { setPref('announcer', !!on); if (game) game.audio.setAnnouncer(!!on); },
  // Settings drawer: remember a switch the engine reads at start (tutorialSeen, ...).
  setPref(key, value) { setPref(key, value); },
  // Report the input device in use ('keys' | 'touch' | 'pad') to the page's OnInputKind.
  watchInput(dotnetRef) {
    watchInput((kind) => { dotnetRef.invokeMethodAsync('OnInputKind', kind).catch(() => { }); });
  },
  unwatchInput() { unwatchInput(); },
  // First-race tutorial: where the player's marble is on screen, as fractions of the canvas
  // (x right, y down) as "x,y", or '' when it is not in front of the camera. A plain string so
  // the trimmed WASM page needs no JSON contract for it.
  playerScreenPos() {
    const g = game;
    const m = g && g.marbleSet && g.marbleSet.marbles[g.isGuest ? g.guestIndex : 0];
    if (!m) return '';
    const v = m.mesh.position.clone().project(g.scene.camera);
    if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return '';
    return `${((v.x + 1) / 2).toFixed(4)},${((1 - v.y) / 2).toFixed(4)}`;
  },
  // ── Online ──
  // Host: the guest's held steering direction, relayed by the hub.
  setGuestSteer(dir) { if (game) game.setGuestSteer(dir); },
  // Guest: one streamed snapshot from the host (see game.js applyFrame for the argument list).
  applyFrame(...args) { if (game) game.applyFrame(...args); },
  // Guest: the host resolved the race; `won` is the guest's own top-10 verdict.
  guestResult(won) { if (game) game.guestResult(won); },
  // Host: both players agreed to a rematch; start the next race.
  rematch() { if (game) game.rematch(); },
  // Guest: the host started the next race on this seed.
  nextTrack(seed) { if (game) game.nextTrack(seed); },
  // Bumping the token here too, so a start() still waiting on the model fetch cannot install a
  // Game after the host has torn the page down.
  stop() { startToken++; stopPad(); if (game) { game.dispose(); game = null; } },
};

// Headless verification handle: SwiftShader runs at 1-2 fps, so browser checks drive the live
// instance directly rather than wait for the game to get anywhere on its own.
window.__game = () => game;
