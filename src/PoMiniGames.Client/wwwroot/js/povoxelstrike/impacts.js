// impacts.js — every real contact in the physics world is also a sound, and the heavy ones
// are a hit.
//
// VoxelStrike had two hand-written voices for rubble (audio.js debrisHit / rubbleTick), each
// fed by a gate the DEBRIS code chose ("rel > 4 and the piece is older than 0.15 s"). It had
// no platform impact synth at all, so a tonne of masonry landing on soil and a chip hitting a
// wall rang with the same stone mode bank, and nothing a contact did could shake the screen.
//
// rapierWorld.js raises ONE event per body per step whose contact force crossed its
// threshold (so resting piles never fire), already converted to an impact speed. This module
// is the sink for that event:
//
//   1. MATERIAL TAG per voxel type. The colliding pair decides what you hear, not the body
//      alone: anything landing on the terrain is a dirt thump; stone / brick / slate /
//      plaster / terracotta ring as stone, timber as wood, soil as dirt. A body striking the
//      player is skipped (the player has its own damage cue).
//   2. impactSynth.play(tag, impulse, { position, size }) — the platform's modal synth, so the
//      pitch follows the SIZE of the object (a chip pings, a wall section booms) and the hit
//      is a real positioned HRTF voice with the existing acoustic probe's occlusion.
//   3. RATE LIMIT. Rubble produces bursts: at most MAX_PER_S voices a second, a short gap per
//      body so one tumbling block does not machine-gun, and a loudness floor so the synth is
//      only asked for hits that would be audible at all. impactSynth adds its own voice cap.
//   4. window.PoImpact.impact('heavy' | 'medium') for the big ones, close to the player only,
//      with its own cooldown — PoImpact already honours reduced motion and flash settings.
//
// Everything here is decoration: it never throws into the physics step.

import * as ImpactSynth from '../platform/impactSynth.js';
import '../platform/impactBus.js';

const MAX_PER_S = 22;
const BODY_GAP_S = 0.12;
// Impulse (kg*m/s) at which impactSynth treats a hit as full strength. A 37 kg voxel at 6 m/s
// is ~220; a 2.4 t tower section at 12 m/s is ~29 000.
const FULL_IMPULSE = 4000;
const MIN_IMPULSE = 18;            // below this nothing audible would come out
const HEAVY_IMPULSE = 22000;
const MEDIUM_IMPULSE = 7000;
const FEEL_RADIUS = 34;            // metres: only hits this close shake the player's screen
const FEEL_GAP_S = 0.45;

function tagOf(material) {
  const kind = typeof material === 'string' ? material : material?.kind;
  if (kind === 'wood') return 'wood';
  if (kind === 'dirt') return 'dirt';
  return 'stone';
}

/** Bounding radius of a body from its box shapes, in metres (impactSynth `size`). */
function sizeOf(body) {
  let r = 0.05;
  for (const s of body.shapes) {
    if (s.kind === 'ball') { r = Math.max(r, s.r); continue; }
    const reach = Math.hypot(s.ox || 0, s.oy || 0, s.oz || 0) + Math.hypot(s.hx, s.hy, s.hz) * 0.6;
    if (reach > r) r = reach;
  }
  return r;
}

/**
 * Install the contact-force sink on `world`.
 * @param {object} world PhysWorld
 * @param {() => object|null} getEngine the Engine (listener position + audio occlusion)
 * @param {{materialOf?: (body) => any}} [opts]
 * @returns {{stats: object, dispose: () => void}}
 */
export function wireImpacts(world, getEngine) {
  const stats = { events: 0, played: 0, heavy: 0, limited: 0, tags: {} };
  let windowStart = 0;
  let windowCount = 0;
  let lastFeel = 0;

  world.onImpact = (body, other, speed, impulse) => {
    try {
      stats.events++;
      if (impulse < MIN_IMPULSE) return;
      if (other && other.material === 'player') return;
      const now = performance.now() / 1000;
      if (now - (body._lastSound ?? -1) < BODY_GAP_S) { stats.limited++; return; }
      if (now - windowStart >= 1) { windowStart = now; windowCount = 0; }
      if (windowCount >= MAX_PER_S) { stats.limited++; return; }

      const own = body.userData?.material ?? body.material;
      const tag = other?.terrain ? 'dirt' : tagOf(own);
      const synth = ImpactSynth;
      const engine = getEngine?.();
      const p = body.position;
      let occlusion = 0;
      let dist = 0;
      const lp = engine?.audio?._lp;
      if (lp) {
        dist = Math.hypot(p.x - lp.x, p.y - lp.y, p.z - lp.z);
        try { occlusion = engine.audio._occlusionAt?.(p, dist) ?? 0; } catch { occlusion = 0; }
      }
      if (synth && dist < 90) {
        const played = synth.play(tag, impulse, {
          full: FULL_IMPULSE,
          size: sizeOf(body),
          mass: body.mass,
          position: { x: p.x, y: p.y, z: p.z, refDistance: 3, maxDistance: 90 },
          occlusion,
        });
        if (played) {
          body._lastSound = now;
          windowCount++;
          stats.played++;
          stats.tags[tag] = (stats.tags[tag] || 0) + 1;
        }
      }

      // The big ones are felt, not only heard.
      if (impulse >= MEDIUM_IMPULSE && dist < FEEL_RADIUS && now - lastFeel > FEEL_GAP_S) {
        lastFeel = now;
        const heavy = impulse >= HEAVY_IMPULSE;
        const closeness = 1 - dist / FEEL_RADIUS;
        window.PoImpact?.impact?.(heavy ? 'heavy' : 'medium', Math.min(1.2, 0.35 + closeness * 0.7));
        if (heavy) stats.heavy++;
      }
    } catch { /* sound and feel are decoration */ }
  };

  return { stats, dispose() { world.onImpact = null; } };
}
