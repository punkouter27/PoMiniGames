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

export const seats = [-1, 1].flatMap(side => Array.from({ length: 5 }, (_, row) =>
    Array.from({ length: 5 }, (_, seat) => ({ x: side * (5.5 + seat * 2.35), z: -39 - row * 3.3, w: 1.15, d: 1.2 }))
        .filter(s => !(Math.abs(s.z + 46) < 2.2 && Math.abs(s.x - side * 10) < 4.5)))).flat();

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
export const CROWD_SIZE = 100;
const inside = (x, z, r, margin = 0) =>
    Math.abs(x - r.x) <= r.w / 2 - margin && Math.abs(z - r.z) <= r.d / 2 - margin;

export function walkable(x, z) {
    // Both endpoints of each link overlap, leaving a continuous center aisle.
    return areas.some(a => inside(x, z, a, 0.4)) &&
        !obstacles.some(o => inside(x, z, o, -0.4)) &&
        (z > -37 || !seats.some(s => inside(x, z, s, -0.4))) &&
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

// A shared flow field routes the whole crowd around scenery without per-NPC path searches.
const gridWidth = 75, gridDepth = 128, gridX = -37, gridZ = -60;
let navigation = null;
function navigationFields() {
    if (navigation) return navigation;
    const open = new Uint8Array(gridWidth * gridDepth);
    for (let z = 0; z < gridDepth; z++) for (let x = 0; x < gridWidth; x++) {
        open[z * gridWidth + x] = walkable(x + gridX, z + gridZ) ? 1 : 0;
    }
    navigation = milestones.map(goal => {
        const distance = new Int16Array(open.length).fill(-1);
        const queue = new Int32Array(open.length);
        let head = 0, tail = 0;
        const origin = (goal.z - gridZ) * gridWidth + goal.x - gridX;
        queue[tail++] = origin; distance[origin] = 0;
        while (head < tail) {
            const cell = queue[head++], x = cell % gridWidth;
            for (const next of [x > 0 ? cell - 1 : -1, x < gridWidth - 1 ? cell + 1 : -1, cell - gridWidth, cell + gridWidth]) {
                if (next < 0 || next >= open.length || !open[next] || distance[next] >= 0) continue;
                distance[next] = distance[cell] + 1;
                queue[tail++] = next;
            }
        }
        return distance;
    });
    return navigation;
}

function routeCell(actor) {
    const x = Math.round(actor.x) - gridX, z = Math.round(actor.z) - gridZ;
    return x >= 0 && x < gridWidth && z >= 0 && z < gridDepth ? z * gridWidth + x : -1;
}

function routeTarget(actor) {
    const milestone = milestones[actor.milestone];
    if (!milestone) return actor;
    const goal = { x: milestone.x + (actor.id % 7 - 3) * 0.45, z: milestone.z };
    if (clearLine(actor.x, actor.z, goal.x, goal.z)) return goal;
    const distances = navigationFields()[actor.milestone], cell = routeCell(actor);
    if (cell < 0) throw new Error('NPC left the scenario navigation bounds.');
    let best = cell, distance = distances[cell] < 0 ? Infinity : distances[cell];
    const x = cell % gridWidth;
    for (const next of [x > 0 ? cell - 1 : -1, x < gridWidth - 1 ? cell + 1 : -1, cell - gridWidth, cell + gridWidth]) {
        if (next < 0 || next >= distances.length || distances[next] < 0 || distances[next] >= distance) continue;
        const target = { x: next % gridWidth + gridX, z: Math.floor(next / gridWidth) + gridZ };
        if (!clearLine(actor.x, actor.z, target.x, target.z)) continue;
        best = next; distance = distances[next];
    }
    return { x: best % gridWidth + gridX, z: Math.floor(best / gridWidth) + gridZ };
}

export function selectLeader(state) {
    const distances = navigationFields();
    let leader = null, best = Infinity;
    for (const actor of state.companions) {
        if (actor.health <= 0) continue;
        const cell = routeCell(actor);
        const fieldDistance = actor.milestone < milestones.length && cell >= 0 ? distances[actor.milestone][cell] : 0;
        const goal = milestones[actor.milestone];
        const remaining = goal ? (fieldDistance < 0 ? 10000 : fieldDistance) +
            Math.hypot(actor.x - goal.x, actor.z - goal.z) -
            Math.hypot(Math.round(actor.x) - goal.x, Math.round(actor.z) - goal.z) : 0;
        const score = (milestones.length - actor.milestone) * 10000 + remaining;
        if (score < best || (score === best && actor.id < leader.id)) { leader = actor; best = score; }
    }
    return leader;
}

export function createAttempt(difficulty = 'standard', demo = false) {
    if (!Object.hasOwn(difficulties, difficulty)) throw new RangeError('Unknown difficulty.');
    return {
        status: 'active', difficulty, demo, health: 100, elapsed: 0, milestone: 0,
        player: { x: 0, z: 58 }, cooldown: 0, shots: 0, hits: 0, damageFlash: 0,
        enemies: [25, 20, -7, -21, -40, -51].flatMap((z, row) =>
            [-1, 1].map(side => ({ id: row * 2 + (side > 0 ? 1 : 0), x: side * (row < 2 ? 4 : row < 4 ? 11 : 3.5),
                z, health: 3, cooldown: 0.5 + row * 0.2, faction: 'capitol-police', heading: Math.PI }))),
        companions: Array.from({ length: demo ? CROWD_SIZE : CROWD_SIZE - 1 }, (_, id) => ({
            id, x: (id % 11 - 5) * 2.3, z: 43 + Math.floor(id / 11) * 2.2,
            health: 30, milestone: 0, heading: 0, moving: false, attacking: 0,
            cooldown: 0.5 + id % 7 * 0.13, delay: id % 9 * 0.12, speed: 3.2 + id % 7 * 0.16,
            routeWait: 0, targetX: 0, targetZ: 23,
        })),
        projectiles: [],
    };
}

export function setPaused(state, paused) {
    if (paused && state.status === 'active') state.status = 'paused';
    else if (!paused && state.status === 'paused') state.status = 'active';
}

export function fire(state, direction) {
    if (!Number.isFinite(direction.x) || !Number.isFinite(direction.z)) throw new TypeError('Invalid direction.');
    if (state.demo || state.status !== 'active' || state.cooldown > 0) return null;
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
    const nx = state.player.x + (state.demo ? 0 : x) / magnitude * speed * dt;
    const nz = state.player.z + (state.demo ? 0 : z) / magnitude * speed * dt;
    if (walkable(nx, state.player.z)) state.player.x = nx;
    if (walkable(state.player.x, nz)) state.player.z = nz;

    const difficulty = difficulties[state.difficulty];
    for (const enemy of state.enemies) {
        if (enemy.health <= 0) continue;
        enemy.cooldown -= dt;
        if (enemy.cooldown > 0) continue;
        let target = null, distance = 23;
        const candidates = state.demo ? state.companions : [state.player, ...state.companions];
        for (const actor of candidates) {
            if (actor.health <= 0) continue;
            const d = Math.hypot(actor.x - enemy.x, actor.z - enemy.z);
            if (d >= distance || d < 0.01 || !clearLine(enemy.x, enemy.z, actor.x, actor.z)) continue;
            target = actor; distance = d;
        }
        if (target) {
            const dx = target.x - enemy.x, dz = target.z - enemy.z;
            enemy.heading = Math.atan2(-dx, -dz);
            state.projectiles.push({ x: enemy.x, z: enemy.z, dx: dx / distance, dz: dz / distance, life: 3, faction: 'police' });
            enemy.cooldown = difficulty.interval;
        } else enemy.cooldown = 0.2;
    }
    for (const p of state.projectiles) {
        p.x += p.dx * 16 * dt;
        p.z += p.dz * 16 * dt;
        p.life -= dt;
        if (!walkable(p.x, p.z)) p.life = 0;
        if (p.life > 0 && !state.demo && p.faction !== 'raider' && Math.hypot(p.x - state.player.x, p.z - state.player.z) < 0.65) {
            state.health = Math.max(0, state.health - difficulty.damage);
            state.damageFlash = 0.22;
            p.life = 0;
        }
        if (p.life <= 0) continue;
        const targets = p.faction === 'raider' ? state.enemies : state.companions;
        for (const actor of targets) {
            if (actor.health <= 0 || Math.hypot(p.x - actor.x, p.z - actor.z) >= 0.65) continue;
            actor.health = Math.max(0, actor.health - (p.faction === 'raider' ? 1 : difficulty.damage));
            p.life = 0;
            break;
        }
    }
    state.projectiles = state.projectiles.filter(p => p.life > 0);
    for (const companion of state.companions) {
        companion.attacking = Math.max(0, companion.attacking - dt);
        companion.cooldown -= dt;
        companion.moving = false;
        if (companion.health <= 0 || state.elapsed < companion.delay) continue;
        const goal = milestones[companion.milestone];
        if (!goal) continue;
        companion.routeWait -= dt;
        if (companion.routeWait <= 0 || Math.hypot(companion.targetX - companion.x, companion.targetZ - companion.z) < 0.2) {
            const next = routeTarget(companion);
            companion.targetX = next.x; companion.targetZ = next.z;
            companion.routeWait = 0.2;
        }
        const dx = companion.targetX - companion.x, dz = companion.targetZ - companion.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.05) {
            const step = Math.min(d, companion.speed * dt);
            const cx = companion.x + dx / d * step, cz = companion.z + dz / d * step;
            if (walkable(cx, companion.z)) companion.x = cx;
            if (walkable(companion.x, cz)) companion.z = cz;
            companion.heading = Math.atan2(-dx, -dz);
            companion.moving = true;
        }
        if (Math.hypot(companion.x - goal.x, companion.z - goal.z) <= goal.radius) {
            companion.milestone++;
            companion.routeWait = 0;
        }
        if (companion.cooldown <= 0) {
            let target = null, nearest = 14;
            for (const enemy of state.enemies) {
                if (enemy.health <= 0) continue;
                const distance = Math.hypot(enemy.x - companion.x, enemy.z - companion.z);
                if (distance < nearest && distance > 0.01 && clearLine(companion.x, companion.z, enemy.x, enemy.z)) {
                    nearest = distance; target = enemy;
                }
            }
            if (target) {
                state.projectiles.push({ x: companion.x, z: companion.z, dx: (target.x - companion.x) / nearest,
                    dz: (target.z - companion.z) / nearest, life: 1.5, faction: 'raider' });
                companion.attacking = 0.18;
                companion.cooldown = 1.8 + companion.id % 5 * 0.2;
            } else companion.cooldown = 0.2;
        }
    }
    if (state.demo) {
        const leader = selectLeader(state);
        if (!leader) { state.status = 'failed'; return; }
        state.milestone = leader.milestone;
        if (state.milestone === milestones.length) state.status = 'completed';
        return;
    }
    // Damage is resolved before arrival so a fatal hit cannot also produce a win.
    if (state.health === 0) { state.status = 'failed'; return; }
    const goal = milestones[state.milestone];
    if (goal && Math.hypot(state.player.x - goal.x, state.player.z - goal.z) <= goal.radius) {
        state.milestone++;
        if (state.milestone === milestones.length) state.status = 'completed';
    }
}
