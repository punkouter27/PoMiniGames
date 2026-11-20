// fireLights.js — fire and lava light what is next to them.
//
// The island had one lamp besides the sun: the point light on the tribe's hearth. A forest
// burning at night was bright cones standing on dark ground, and a lava flow glowed without
// lighting the slope it ran down. This is a small, FIXED pool of point lights parked on the
// groups of burning and molten tiles nearest the camera (fireClusters.js).
//
//   FIXED    the lights are made once, at zero brightness, and never added or removed: a
//            change in the number of lights rebuilds every lit material in the scene.
//   CHEAP    no shadows, a hard range, and few of them (every lit pixel pays for each).
//            High tier four, medium two, low none.
//   STEADY   a light keeps its fire between updates (assignSlots), and when it does have to
//            move it fades out where it is, jumps, and fades back in: it never slides
//            across the ground between two fires.
import { Color, PointLight } from 'three-eco/webgpu';
import { VIEW_ONLY_LAYER } from './materials.js';
import { assignSlots } from './fireClusters.js';

const COUNT = { high: 4, medium: 2, low: 0 };
const FIRE = new Color(0xff8a3a);
const LAVA = new Color(0xff4a1e);
const RANGE = 36;            // metres a fire lights
const MOVE_SNAP = 5;         // a target further than this is a different fire: fade, then jump

export function createFireLights(scene, { tier = 'high' } = {}) {
  const n = COUNT[tier] ?? 0;
  const slots = [];
  for (let i = 0; i < n; i++) {
    const light = new PointLight(FIRE, 0, RANGE, 1.6);
    light.name = `fire-light-${i}`;
    light.layers.set(VIEW_ONLY_LAYER);
    scene.add(light);
    slots.push({ light, x: 0, y: 0, z: 0, group: null, level: 0, phase: i * 1.7 });
  }

  return {
    count: n,
    /** The groups to light (fireClusters.js), most important first; hearths are skipped. */
    set(groups) {
      if (!n) return;
      assignSlots(slots, groups.filter(g => !g.camp).slice(0, n));
    },
    /** @param night 0..1 from lighting.js: a fire is a lamp at night and a glow by day. */
    update(dt, timeSec, night) {
      for (const s of slots) {
        const g = s.group;
        let want = 0;
        if (g) {
          const far = Math.hypot(g.x - s.x, g.z - s.z) > MOVE_SNAP;
          // Somewhere else to be: go dark first, then appear there.
          if (far && s.level > 0.03) want = 0;
          else {
            if (far || s.level <= 0.03) { s.x = g.x; s.y = g.y; s.z = g.z; }
            else { s.x += (g.x - s.x) * Math.min(1, dt * 2); s.y += (g.y - s.y) * Math.min(1, dt * 2); s.z += (g.z - s.z) * Math.min(1, dt * 2); }
            want = Math.min(1, 0.3 + g.size / (g.lava ? 6 : 9));
            s.light.color.copy(g.lava ? LAVA : FIRE);
          }
        }
        s.level += (want - s.level) * Math.min(1, dt * 3.5);
        if (s.level < 0.004) { s.level = 0; s.light.intensity = 0; continue; }
        // Two beating sines: a flame's flicker, out of step from light to light.
        const flicker = 0.82 + 0.18 * Math.sin(timeSec * 9.7 + s.phase) * Math.sin(timeSec * 6.3 + s.phase * 2.1);
        s.light.position.set(s.x, s.y + 2.2, s.z);
        s.light.intensity = (16 + night * 110) * s.level * flicker;
      }
    },
    /** For a harness: where each light is and how bright. */
    get state() { return slots.map(s => ({ x: s.x, y: s.y, z: s.z, level: s.level, intensity: s.light.intensity, lava: !!s.group?.lava })); },
    dispose() { for (const s of slots) { scene.remove(s.light); s.light.dispose?.(); } slots.length = 0; },
  };
}
