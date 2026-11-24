// ammoWorker.js — opt-in Ammo.js (Bullet WASM) Web Worker backend sharing workerWorld.js's
// exact pose-buffer protocol (7 floats/body: x y z qx qy qz qw). Enables true Bullet soft-body
// cloth, ropes, and rigid-body fracture on high-tier showcase modes without touching Rapier.
const AMMO_CDN = 'https://cdn.jsdelivr.net/npm/ammo.js@0.0.10/ammo.wasm.js';

let Ammo = null;
let world = null;
let transform = null;
const order = [];
const byId = new Map();

function buildBody(desc) {
  const mass = desc.type === 'fixed' ? 0 : (desc.mass ?? 1);
  const start = new Ammo.btTransform();
  start.setIdentity();
  const p = desc.position || { x: 0, y: 0, z: 0 };
  start.setOrigin(new Ammo.btVector3(p.x ?? 0, p.y ?? 0, p.z ?? 0));

  let shape;
  if (desc.shape === 'sphere') {
    shape = new Ammo.btSphereShape(desc.radius ?? 0.5);
  } else {
    const h = desc.halfExtents || { x: 0.5, y: 0.5, z: 0.5 };
    shape = new Ammo.btBoxShape(new Ammo.btVector3(h.x ?? 0.5, h.y ?? 0.5, h.z ?? 0.5));
  }
  const inertia = new Ammo.btVector3(0, 0, 0);
  if (mass > 0) shape.calculateLocalInertia(mass, inertia);
  const motionState = new Ammo.btDefaultMotionState(start);
  const info = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, inertia);
  const rb = new Ammo.btRigidBody(info);
  world.addRigidBody(rb);
  Ammo.destroy(info);
  Ammo.destroy(start);
  Ammo.destroy(inertia);
  return { rb, shape, motionState };
}

self.onmessage = async (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      try {
        const mod = await import(/* @vite-ignore */ m.ammoUrl || AMMO_CDN);
        const factory = mod.default || mod;
        Ammo = typeof factory === 'function' ? await factory() : factory;
        const cfg = new Ammo.btSoftBodyRigidBodyCollisionConfiguration();
        const disp = new Ammo.btCollisionDispatcher(cfg);
        const broad = new Ammo.btDbvtBroadphase();
        const solver = new Ammo.btSequentialImpulseConstraintSolver();
        const softSolver = new Ammo.btDefaultSoftBodySolver();
        world = new Ammo.btSoftRigidDynamicsWorld(disp, broad, solver, cfg, softSolver);
        const g = m.options?.gravity || { x: 0, y: -9.81, z: 0 };
        world.setGravity(new Ammo.btVector3(g.x ?? 0, g.y ?? -9.81, g.z ?? 0));
        transform = new Ammo.btTransform();
        self.postMessage({ type: 'ready' });
      } catch (err) {
        self.postMessage({ type: 'error', message: String(err) });
      }
      break;
    }
    case 'add': {
      if (!world) break;
      const rec = buildBody(m.desc || {});
      byId.set(m.id, rec);
      order.push(rec);
      break;
    }
    case 'remove': {
      const rec = byId.get(m.id);
      if (!rec || !world) break;
      world.removeRigidBody(rec.rb);
      Ammo.destroy(rec.rb); Ammo.destroy(rec.motionState); Ammo.destroy(rec.shape);
      byId.delete(m.id);
      order.splice(order.indexOf(rec), 1);
      break;
    }
    case 'set': {
      const rec = byId.get(m.id);
      if (!rec) break;
      if (m.impulse) {
        const v = new Ammo.btVector3(m.impulse.x ?? 0, m.impulse.y ?? 0, m.impulse.z ?? 0);
        rec.rb.activate(true);
        rec.rb.applyCentralImpulse(v);
        Ammo.destroy(v);
      }
      break;
    }
    case 'step': {
      if (!world) break;
      world.stepSimulation(Math.min(0.05, m.dt || 1 / 60), 4, 1 / 60);
      const buf = m.buf && m.buf.byteLength >= order.length * 28 ? m.buf : new Float32Array(order.length * 7);
      for (let i = 0; i < order.length; i++) {
        order[i].motionState.getWorldTransform(transform);
        const o = transform.getOrigin(), q = transform.getRotation();
        const k = i * 7;
        buf[k] = o.x(); buf[k + 1] = o.y(); buf[k + 2] = o.z();
        buf[k + 3] = q.x(); buf[k + 4] = q.y(); buf[k + 5] = q.z(); buf[k + 6] = q.w();
      }
      self.postMessage({ type: 'poses', buf, count: order.length, steps: 1, hits: [] }, [buf.buffer]);
      break;
    }
    case 'free': {
      for (const rec of order) {
        world?.removeRigidBody(rec.rb);
        Ammo?.destroy(rec.rb); Ammo?.destroy(rec.motionState); Ammo?.destroy(rec.shape);
      }
      order.length = 0; byId.clear();
      if (transform) { Ammo?.destroy(transform); transform = null; }
      world = null;
      break;
    }
    default: break;
  }
};
