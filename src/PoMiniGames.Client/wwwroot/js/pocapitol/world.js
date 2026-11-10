// Deliberately fictional footprint: recognizable spaces, not a real access plan.
export const areas = [
    { x: 0, z: 41, w: 76, d: 54, name: 'Capitol grounds' },
    { x: 0, z: 6, w: 14, d: 18, name: 'Entrance gallery' },
    { x: 0, z: -14, w: 34, d: 24, name: 'Rotunda' },
    { x: 0, z: -30, w: 10, d: 12, name: 'Fictional connecting gallery' },
    { x: 0, z: -48, w: 38, d: 26, name: 'House chamber' },
];

export const obstacles = [
    { x: -9, z: 31, w: 6, d: 2, h: 1.3 },
    { x: 9, z: 31, w: 6, d: 2, h: 1.3 },
    { x: -8, z: -12, w: 3, d: 3, h: 1.3 },
    { x: 8, z: -12, w: 3, d: 3, h: 1.3 },
    { x: -10, z: -46, w: 8, d: 2, h: 1.1 },
    { x: 10, z: -46, w: 8, d: 2, h: 1.1 },
];

export const columns = [
    ...[-25, 25].flatMap(x => [-11, -5, 1, 7, 13].map(offset => ({ x: x + offset, z: 16, height: 8.5 }))),
    ...[-9, 9].map(x => ({ x, z: 17, height: 9 })),
    ...Array.from({ length: 12 }, (_, i) => ({
        x: Math.sin(i / 12 * Math.PI * 2) * 14,
        z: -14 + Math.cos(i / 12 * Math.PI * 2) * 9, height: 7,
    })).filter(c => Math.abs(c.x) > 5),
];

export const milestones = [
    { x: 0, z: 23, radius: 5, label: 'Cross the forecourt' },
    { x: 0, z: 4, radius: 4, label: 'Enter the fictional gallery' },
    { x: 0, z: -16, radius: 5, label: 'Reach the Rotunda' },
    { x: 0, z: -49, radius: 5, label: 'Reach the House chamber' },
];

const difficulties = { story: { damage: 5, interval: 3.2 }, standard: { damage: 12, interval: 2 } };
const inside = (x, z, r, margin = 0) =>
    Math.abs(x - r.x) <= r.w / 2 - margin && Math.abs(z - r.z) <= r.d / 2 - margin;

export function walkable(x, z) {
    // Both endpoints of each link overlap, leaving a continuous center aisle.
    return areas.some(a => inside(x, z, a, 0.4)) &&
        !obstacles.some(o => inside(x, z, o, -0.4)) &&
        !columns.some(c => Math.hypot(x - c.x, z - c.z) < 1.15);
}

export function clearLine(x, z, tx, tz) {
    const distance = Math.hypot(tx - x, tz - z);
    const steps = Math.ceil(distance / 0.25);
    for (let i = 1; i < steps; i++) {
        if (!walkable(x + (tx - x) * i / steps, z + (tz - z) * i / steps)) return false;
    }
    return true;
}

export function createAttempt(difficulty = 'standard') {
    if (!Object.hasOwn(difficulties, difficulty)) throw new RangeError('Unknown difficulty.');
    return {
        status: 'active', difficulty, health: 100, elapsed: 0, milestone: 0,
        player: { x: 0, z: 58 }, cooldown: 0, shots: 0, hits: 0, damageFlash: 0,
        enemies: [[-6, 25], [6, 25], [-11, -18], [11, -18], [-12, -51], [12, -51]]
            .map(([x, z], id) => ({ id, x, z, health: 3, cooldown: 1.5 + id * 0.3 })),
        companions: [-4, -2, 2, 4].map((x, id) => ({ x, z: 60 + id, id })),
        projectiles: [],
    };
}

export function setPaused(state, paused) {
    if (paused && state.status === 'active') state.status = 'paused';
    else if (!paused && state.status === 'paused') state.status = 'active';
}

export function fire(state, direction) {
    if (!Number.isFinite(direction.x) || !Number.isFinite(direction.z)) throw new TypeError('Invalid direction.');
    if (state.status !== 'active' || state.cooldown > 0) return null;
    const length = Math.hypot(direction.x, direction.z);
    if (length < 0.001) return null;
    const dx = direction.x / length, dz = direction.z / length;
    let target = null, nearest = 40;
    for (let distance = 0.25; distance <= nearest; distance += 0.25) {
        if (!walkable(state.player.x + dx * distance, state.player.z + dz * distance)) {
            nearest = distance;
            break;
        }
    }
    for (const enemy of state.enemies) {
        if (enemy.health <= 0) continue;
        const x = enemy.x - state.player.x, z = enemy.z - state.player.z;
        const along = x * dx + z * dz;
        if (along <= 0 || along >= nearest || Math.abs(x * dz - z * dx) > 0.9) continue;
        if (!clearLine(state.player.x, state.player.z, enemy.x, enemy.z)) continue;
        target = enemy;
        nearest = along;
    }
    if (target) { target.health--; state.hits++; }
    state.shots++;
    state.cooldown = 0.24;
    return { hit: target?.id ?? null, x: state.player.x + dx * nearest, z: state.player.z + dz * nearest };
}

export function advance(state, input, seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Invalid time step.');
    const x = input.x ?? 0, z = input.z ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new TypeError('Invalid movement input.');
    if (state.status !== 'active') return;
    const dt = Math.min(seconds, 0.05);
    state.elapsed += dt;
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.damageFlash = Math.max(0, state.damageFlash - dt);
    const magnitude = Math.max(1, Math.hypot(x, z));
    const speed = input.sprint ? 8 : 5;
    const nx = state.player.x + x / magnitude * speed * dt;
    const nz = state.player.z + z / magnitude * speed * dt;
    if (walkable(nx, state.player.z)) state.player.x = nx;
    if (walkable(state.player.x, nz)) state.player.z = nz;

    const difficulty = difficulties[state.difficulty];
    for (const enemy of state.enemies) {
        if (enemy.health <= 0) continue;
        enemy.cooldown -= dt;
        const dx = state.player.x - enemy.x, dz = state.player.z - enemy.z;
        const distance = Math.hypot(dx, dz);
        if (enemy.cooldown <= 0 && distance < 23 && distance > 0.01 &&
            clearLine(enemy.x, enemy.z, state.player.x, state.player.z)) {
            state.projectiles.push({ x: enemy.x, z: enemy.z, dx: dx / distance, dz: dz / distance, life: 3 });
            enemy.cooldown = difficulty.interval;
        }
    }
    for (const p of state.projectiles) {
        p.x += p.dx * 16 * dt;
        p.z += p.dz * 16 * dt;
        p.life -= dt;
        if (!walkable(p.x, p.z)) p.life = 0;
        if (p.life > 0 && Math.hypot(p.x - state.player.x, p.z - state.player.z) < 0.65) {
            state.health = Math.max(0, state.health - difficulty.damage);
            state.damageFlash = 0.22;
            p.life = 0;
        }
    }
    state.projectiles = state.projectiles.filter(p => p.life > 0);
    for (const companion of state.companions) {
        const tx = state.player.x + (companion.id % 2 ? 1 : -1) * 1.8;
        const tz = state.player.z + 2.5 + companion.id * 0.6;
        const dx = tx - companion.x, dz = tz - companion.z;
        const d = Math.hypot(dx, dz);
        if (d > 1) {
            const step = Math.min(d, 5.5 * dt);
            const cx = companion.x + dx / d * step, cz = companion.z + dz / d * step;
            if (walkable(cx, cz)) { companion.x = cx; companion.z = cz; }
        }
    }
    // Damage is resolved before arrival so a fatal hit cannot also produce a win.
    if (state.health === 0) { state.status = 'failed'; return; }
    const goal = milestones[state.milestone];
    if (goal && Math.hypot(state.player.x - goal.x, state.player.z - goal.z) <= goal.radius) {
        state.milestone++;
        if (state.milestone === milestones.length) state.status = 'completed';
    }
}
