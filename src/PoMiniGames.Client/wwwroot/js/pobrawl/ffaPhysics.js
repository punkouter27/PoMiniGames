export const BODY_RADIUS = 0.38;
export const RING_RADIUS = 4.85;
const CONTACT_SKIN = 0.001;
const RESTITUTION = 0.12;

export function fighterMass(fighter) {
  const ratio = fighter.rig.config.mass ?? 1;
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error(`Invalid fighter mass: ${fighter.id}`);
  return ratio * 80;
}

export function impactImpulse(attacker, target, kick, damage) {
  const a = attacker.rig.root.position, b = target.rig.root.position;
  const distance = Math.hypot(b.x - a.x, b.z - a.z);
  const yaw = attacker.rig.root.rotation.y;
  const nx = distance > 1e-6 ? (b.x - a.x) / distance : Math.sin(yaw);
  const nz = distance > 1e-6 ? (b.z - a.z) / distance : Math.cos(yaw);
  const impulse = (kick ? 110 : 75) * Math.min(1.8, damage / 24);
  target.velocity.x += nx * impulse / fighterMass(target);
  target.velocity.z += nz * impulse / fighterMass(target);
  attacker.velocity.x -= nx * impulse * 0.3 / fighterMass(attacker);
  attacker.velocity.z -= nz * impulse * 0.3 / fighterMass(attacker);
  return { normal: { x: nx, y: 0, z: nz }, energy: impulse ** 2 / (2 * fighterMass(target)) };
}

export function sweptCircleTime(dx, dz, vx, vz, radius, duration) {
  const a = vx * vx + vz * vz;
  const c = dx * dx + dz * dz - radius * radius;
  const b = dx * vx + dz * vz;
  if (b >= 0 || a < 1e-12) return null;
  if (c <= 0) return 0;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const time = (-b - Math.sqrt(discriminant)) / a;
  return time >= 0 && time <= duration ? time : null;
}

function wallTime(position, velocity, duration) {
  const a = velocity.x ** 2 + velocity.z ** 2;
  if (a < 1e-12) return null;
  const b = position.x * velocity.x + position.z * velocity.z;
  const c = position.x ** 2 + position.z ** 2 - RING_RADIUS ** 2;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const time = (-b + Math.sqrt(discriminant)) / a;
  return time >= 0 && time <= duration ? time : null;
}

function constraints(fighters) {
  return fighters.filter((f) => f.alive).map((fighter) => ({
    fighter, position: fighter.rig.root.position, velocity: fighter.velocity,
    radius: BODY_RADIUS, inverseMass: 1 / fighterMass(fighter),
  }));
}

function resolvePair(a, b, onContact) {
  if (a.fighter === b.fighter || a.inverseMass + b.inverseMass === 0) return false;
  const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
  const length = Math.hypot(dx, dz);
  const radius = a.radius + b.radius;
  if (length > radius + CONTACT_SKIN * 2) return false;
  const nx = length > 1e-8 ? dx / length : 1;
  const nz = length > 1e-8 ? dz / length : 0;
  const sum = a.inverseMass + b.inverseMass;
  const overlap = radius + CONTACT_SKIN - length;
  if (overlap > 0) {
    a.position.x -= nx * overlap * a.inverseMass / sum;
    a.position.z -= nz * overlap * a.inverseMass / sum;
    b.position.x += nx * overlap * b.inverseMass / sum;
    b.position.z += nz * overlap * b.inverseMass / sum;
  }
  const vx = b.velocity.x - a.velocity.x, vz = b.velocity.z - a.velocity.z;
  const closing = vx * nx + vz * nz;
  if (closing >= -1e-6) return overlap > CONTACT_SKIN;
  const impulse = -(1 + RESTITUTION) * closing / sum;
  const tangent = vx * -nz + vz * nx;
  const friction = Math.max(-impulse * 0.25, Math.min(impulse * 0.25, -tangent / sum));
  a.velocity.x -= (nx * impulse - nz * friction) * a.inverseMass;
  a.velocity.z -= (nz * impulse + nx * friction) * a.inverseMass;
  b.velocity.x += (nx * impulse - nz * friction) * b.inverseMass;
  b.velocity.z += (nz * impulse + nx * friction) * b.inverseMass;
  if (onContact && closing < -0.4) onContact({
    position: { x: (a.position.x + b.position.x) / 2, y: 0.8, z: (a.position.z + b.position.z) / 2 },
    normal: { x: nx, y: 0, z: nz }, energy: closing ** 2 / (2 * sum),
    material: 'cloth',
  });
  return true;
}

function resolveWall(body, onContact) {
  const length = Math.hypot(body.position.x, body.position.z);
  if (length < RING_RADIUS - CONTACT_SKIN) return;
  const nx = body.position.x / length, nz = body.position.z / length;
  body.position.x = nx * (RING_RADIUS - CONTACT_SKIN);
  body.position.z = nz * (RING_RADIUS - CONTACT_SKIN);
  const outward = body.velocity.x * nx + body.velocity.z * nz;
  if (outward <= 0) return;
  body.velocity.x -= nx * outward * (1 + RESTITUTION);
  body.velocity.z -= nz * outward * (1 + RESTITUTION);
  if (onContact && outward > 0.4) onContact({
    position: { x: body.position.x, y: 0.7, z: body.position.z },
    normal: { x: -nx, y: 0, z: -nz }, energy: outward ** 2 / (2 * body.inverseMass), material: 'rope',
  });
}

export function moveFighters(fighters, dt, onContact) {
  if (!Number.isFinite(dt) || dt < 0 || dt > 0.05) throw new Error('FFA physics requires a finite step of at most 50 ms.');
  const bodies = constraints(fighters);
  const dynamic = bodies.filter((b) => b.inverseMass > 0);
  for (const body of dynamic) {
    if (![body.position.x, body.position.z, body.velocity.x, body.velocity.z].every(Number.isFinite)) {
      throw new Error(`Non-finite FFA motion: ${body.fighter.id}`);
    }
  }
  const pairs = [];
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      if (bodies[i].inverseMass + bodies[j].inverseMass > 0 && bodies[i].fighter !== bodies[j].fighter) pairs.push([bodies[i], bodies[j]]);
    }
  }
  for (let sweep = 0; sweep < 12; sweep++) {
    let changed = false;
    for (const [a, b] of pairs) changed = resolvePair(a, b, sweep === 0 ? onContact : null) || changed;
    for (const body of dynamic) resolveWall(body, sweep === 0 ? onContact : null);
    if (!changed) break;
  }
  let remaining = dt;
  let events = 0;
  while (remaining > 1e-8 && events < 128) {
    let next = remaining;
    let collision = null;
    for (const [a, b] of pairs) {
      const time = sweptCircleTime(b.position.x - a.position.x, b.position.z - a.position.z,
        b.velocity.x - a.velocity.x, b.velocity.z - a.velocity.z, a.radius + b.radius, remaining);
      if (time !== null && time <= next) { next = time; collision = [a, b]; }
    }
    for (const body of dynamic) {
      const time = wallTime(body.position, body.velocity, remaining);
      if (time !== null && time <= next) { next = time; collision = [body]; }
    }
    for (const body of dynamic) {
      body.position.x += body.velocity.x * next;
      body.position.z += body.velocity.z * next;
    }
    remaining -= next;
    if (!collision) break;
    if (collision.length === 2) resolvePair(...collision, onContact);
    else resolveWall(collision[0], onContact);
    events++;
  }
  // An overloaded contact island stays put rather than tunneling through another body.
  if (remaining > 1e-8 && events === 128) {
    for (const body of dynamic) { body.velocity.x = 0; body.velocity.z = 0; }
  }
  for (const body of dynamic) {
    let lift = 0;
    for (const other of fighters) {
      if (other.alive) continue;
      const root = other.rig.root;
      for (const offset of [-0.45, 0, 0.45]) {
        const x = root.position.x - Math.cos(root.rotation.y) * offset;
        const z = root.position.z + Math.sin(root.rotation.y) * offset;
        const distance = Math.hypot(body.position.x - x, body.position.z - z);
        // Step over low, immovable prone bodies rather than trapping survivors behind a pile.
        lift = Math.max(lift, 0.42 * Math.max(0, Math.min(1, (1 - distance) / 0.43)));
      }
    }
    body.position.y = lift;
  }
  return { pairs: pairs.length, events, saturated: events === 128 && remaining > 1e-8 };
}
