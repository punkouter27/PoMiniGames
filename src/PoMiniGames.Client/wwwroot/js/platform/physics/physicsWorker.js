// physicsWorker.js — a Web Worker that owns a platform/physics world and streams poses back.
//
// WHY: a world with hundreds of bodies (islands, debris, a marble pack) costs milliseconds per step
// that the render thread would rather spend on frames. The worker steps the world and posts one
// transferable Float32Array of poses (7 floats per body: x y z qx qy qz qw, in creation order) per
// step batch; the page ping-pongs two buffers so nothing is allocated per frame. Contact-force
// events are turned into plain {tag, impulse, opts} messages (the worker has no window or audio);
// workerWorld.js plays them on the page through PoImpactSynth. Import maps do not apply inside
// workers, so Rapier comes from the same absolute CDN URL the import map uses.
import { adoptRapier, createPhysicsWorld } from './rapier.js';

const RAPIER_URL = 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.21.0/dist/rapier.mjs';
let world = null;
const order = [];        // body records in creation order (pose buffer layout)
const byId = new Map();  // id -> record
let hits = [];

self.onmessage = async (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      const mod = await import(/* @vite-ignore */ m.rapierUrl || RAPIER_URL);
      const R = mod.default || mod;
      await R.init();
      adoptRapier(R);
      world = createPhysicsWorld(R, {
        ...m.options,
        impact: m.options?.impact === false ? false : {
          ...(m.options?.impact || {}),
          sink: (tag, impulse, opts) => hits.push({ tag, impulse, opts }),
        },
      });
      self.postMessage({ type: 'ready' });
      break;
    }
    case 'add': {
      const rec = world.addBody(m.desc);
      byId.set(m.id, rec);
      order.push(rec);
      break;
    }
    case 'remove': {
      const rec = byId.get(m.id);
      if (!rec) break;
      world.removeBody(rec);
      byId.delete(m.id);
      order.splice(order.indexOf(rec), 1);
      break;
    }
    case 'set': {
      const rec = byId.get(m.id);
      if (!rec) break;
      if (m.position) rec.rb.setTranslation(m.position, true);
      if (m.linvel) rec.rb.setLinvel(m.linvel, true);
      if (m.angvel) rec.rb.setAngvel(m.angvel, true);
      if (m.impulse) rec.rb.applyImpulse(m.impulse, true);
      if (m.torqueImpulse) rec.rb.applyTorqueImpulse(m.torqueImpulse, true);
      if (m.force) rec.rb.addForce(m.force, true);
      break;
    }
    case 'batchImpulse': {
      if (!Array.isArray(m.items)) break;
      for (const item of m.items) {
        const rec = byId.get(item.id);
        if (rec && item.impulse) rec.rb.applyImpulse(item.impulse, true);
      }
      break;
    }
    case 'step': {
      if (!world) break;
      const n = world.step(m.dt);
      let buf = m.buf && m.buf.byteLength >= order.length * 28 ? m.buf : new Float32Array(order.length * 7);
      world.writePoses(order, buf);
      const out = hits; hits = [];
      self.postMessage({ type: 'poses', buf, count: order.length, steps: n, hits: out }, [buf.buffer]);
      break;
    }
    case 'free': world?.free(); world = null; break;
    default: break;
  }
};
