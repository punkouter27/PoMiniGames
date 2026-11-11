// PoCapitol's rules: a crowd-pressure simulation, not a shooter.
//
// Deliberately fictional footprint: recognizable spaces, not a real access plan. The rooms
// sit in a straight line that the real building does not have, and police positions are
// invented. What follows the record is the SHAPE of the day: a mostly passive crowd, a
// minority pushing on police lines, non-lethal police tools, lines that fall back in stages,
// a House chamber that was evacuated and never entered, and a 6 pm curfew.
//
// The spectator demo is the exception, by the owner's request: an armed variant in which both
// sides carry guns and whoever is hit drops out for good. That part follows no record at all.
import { createSteering } from './steering.js';
import { createHarm, applyInjury, advanceHarm, harmSummary } from './harm.js';
import { createGrid, sweep, segmentCircle, firstBlocked, strike, exchange, slide, bounce, massOf, MIN_GAP } from './physics.js';

export const areas = [
    // The lawn runs well back from the building: the crowd starts out on the grass.
    { x: 0, z: 61, w: 76, d: 94, name: 'West front grounds' },
    { x: 0, z: 5.5, w: 18, d: 19, name: 'Crypt' },
    { x: 0, z: -14, w: 34, d: 24, name: 'Rotunda' },
    { x: 0, z: -27.5, w: 8, d: 5, name: 'Connecting doorway' },
    { x: 0, z: -37, w: 24, d: 16, name: 'Statuary Hall' },
    { x: 0, z: -48.5, w: 8, d: 9, name: 'House corridor' },
];

/**
 * Height of the walking surface the renderer draws at (x, z), so feet and contact shadows sit
 * on it: interior floors, the paved forecourt, the two planted beds, otherwise the lawn.
 * Visual only; the simulation stays flat.
 */
export function groundHeight(x, z) {
    if (z < 15) return 0.1;
    if (Math.abs(x) <= 12 && z >= 12 && z <= 72) return 0.02;
    if (Math.abs(Math.abs(x) - 30) <= 4.5 && z >= 38 && z <= 64) return 0.05;
    return -0.05;
}

export const obstacles = [
    // Inauguration bleachers flank the approach and leave one central gap.
    { x: -25.5, z: 33, w: 24, d: 6, h: 4.5, kind: 'bleacher' },
    { x: 25.5, z: 33, w: 24, d: 6, h: 4.5, kind: 'bleacher' },
    { x: -8, z: -12, w: 3, d: 3, h: 1.3, kind: 'bench' },
    { x: 8, z: -12, w: 3, d: 3, h: 1.3, kind: 'bench' },
];

export const columns = [
    ...[-25, 25].flatMap(x => [-11, -5, 1, 7, 13].map(offset => ({ x: x + offset, z: 16, height: 8.5 }))),
    ...[-9, 9].map(x => ({ x, z: 17, height: 9 })),
    ...Array.from({ length: 12 }, (_, i) => ({
        x: Math.sin(i / 12 * Math.PI * 2) * 14,
        z: -14 + Math.cos(i / 12 * Math.PI * 2) * 9, height: 7,
    })).filter(c => Math.abs(c.x) > 5),
    // The Crypt's forest of squat columns.
    ...[-4.5, 4.5].flatMap(x => [10, 5, 0].map(z => ({ x, z, height: 7.6 }))),
];

export const statues = [-10, 10].flatMap(x => [-32, -37, -42].map(z => ({ x, z })));

export const milestones = [
    { x: 0, z: 27, radius: 5, label: 'Pass the barricades' },
    { x: 0, z: 9, radius: 4, label: 'Enter the Crypt' },
    { x: 0, z: -12, radius: 5, label: 'Reach the Rotunda' },
    { x: 0, z: -34, radius: 4, label: 'Enter Statuary Hall' },
    { x: 0, z: -43, radius: 3, label: 'Cross Statuary Hall' },
    { x: 0, z: -50, radius: 2.5, label: 'Reach the House chamber doors' },
];

// Police lines, front to back. Each seals a chokepoint for as long as it holds.
export const lineDefs = [
    { z: 33, x0: -13.5, x1: 13.5, officers: 14, barrier: 6, name: 'Bike-rack barricade' },
    { z: 14, x0: -9, x1: 9, officers: 10, barrier: 4, name: 'Crypt doors' },
    { z: -3, x0: -9, x1: 9, officers: 8, barrier: 2, name: 'Rotunda doors' },
    { z: -27.5, x0: -4, x1: 4, officers: 6, barrier: 3, name: 'Statuary Hall doorway' },
    { z: -47, x0: -4, x1: 4, officers: 6, barrier: 4, name: 'House corridor' },
];

export const CROWD_SIZE = 256;
export const MAX_POLICE = 64;
/** Staff and members sheltering in the chamber. Non-combatants: nothing can target or reach them. */
export const CIVILIANS = 64;
/** One real second is one minute of the day: 12:50 pm to the 6:00 pm curfew is 310 seconds. */
export const CLOCK_START = 12 * 60 + 50;
export const CURFEW_ELAPSED = 18 * 60 - CLOCK_START;
export const aidStation = { x: -30, z: 62 };
const reinforcementTimes = [55, 95, 135, 175, 215];
const EVACUATION_STARTS = 85;
const LINE_STANDOFF = 0.6;

const difficulties = {
    story: { hold: 1.2, baton: 4, spray: 3, gas: 0.8, interval: 3.2, playerBaton: 6, playerSpray: 4, playerGas: 3, wear: 0.34, tire: 55, shot: 4 },
    standard: { hold: 2.2, baton: 12, spray: 8, gas: 1.8, interval: 1.1, playerBaton: 14, playerSpray: 9, playerGas: 6, wear: 0.2, tire: 95, shot: 16, raiderShot: 1.6 },
};
const roles = ['raider', 'police', 'observer'];

const inside = (x, z, r, margin = 0) =>
    Math.abs(x - r.x) <= r.w / 2 - margin && Math.abs(z - r.z) <= r.d / 2 - margin;

export function walkable(x, z) {
    // Both endpoints of each link overlap, leaving a continuous center aisle.
    return areas.some(a => inside(x, z, a, 0.4)) &&
        !obstacles.some(o => inside(x, z, o, -0.4)) &&
        !columns.some(c => Math.hypot(x - c.x, z - c.z) < 1.15) &&
        !statues.some(s => Math.hypot(x - s.x, z - s.z) < 1);
}

export function clearLine(x, z, tx, tz) {
    const distance = Math.hypot(tx - x, tz - z);
    const steps = Math.ceil(distance / 0.25);
    for (let i = 1; i < steps; i++) {
        if (!walkable(x + (tx - x) * i / steps, z + (tz - z) * i / steps)) return false;
    }
    return true;
}

export function clockLabel(elapsed) {
    const minutes = CLOCK_START + Math.floor(elapsed);
    const hour = Math.floor(minutes / 60), minute = minutes % 60;
    return `${(hour + 11) % 12 + 1}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

// A shared flow field per destination routes everyone around scenery without per-NPC path
// searches. Fields: one per milestone, then the aid station, then a rally point behind each
// police line, then the last post outside the chamber doors.
const gridWidth = 75, gridDepth = 170, gridX = -37, gridZ = -60;
const AID_FIELD = milestones.length, LINE_FIELD = AID_FIELD + 1, LAST_POST_FIELD = LINE_FIELD + lineDefs.length;
const destinations = [
    ...milestones, aidStation,
    ...lineDefs.map(line => ({ x: 0, z: Math.round(line.z - 2.5) })),
    { x: 0, z: -51 },
];
let navigation = null;
function navigationFields() {
    if (navigation) return navigation;
    const open = new Uint8Array(gridWidth * gridDepth);
    for (let z = 0; z < gridDepth; z++) for (let x = 0; x < gridWidth; x++) {
        open[z * gridWidth + x] = walkable(x + gridX, z + gridZ) ? 1 : 0;
    }
    navigation = destinations.map(goal => {
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

/** The next point to walk to: the goal itself when in sight, else a few cells down the field. */
function routeTarget(actor, field, goal, state = null) {
    const gasEffects = state?.effects?.filter(e => e.type === 'gas') ?? [];
    const crossesGas = (ax, az, bx, bz) => gasEffects.some(g => segmentCircle(ax, az, bx, bz, g.x, g.z, g.r * 0.85) >= 0);
    if (clearLine(actor.x, actor.z, goal.x, goal.z) && !crossesGas(actor.x, actor.z, goal.x, goal.z)) return goal;
    const distances = navigationFields()[field];
    let best = routeCell(actor);
    if (best < 0) throw new Error('NPC left the scenario navigation bounds.');
    let distance = distances[best] < 0 ? Infinity : distances[best];
    // Looking a few cells ahead gives steering a waypoint worth steering toward, where a
    // one-cell hop would have every figure zig-zagging between cell centers.
    for (let hop = 0; hop < 4; hop++) {
        const x = best % gridWidth;
        let chosen = -1, bestCost = distance;
        for (const next of [x > 0 ? best - 1 : -1, x < gridWidth - 1 ? best + 1 : -1, best - gridWidth, best + gridWidth]) {
            if (next < 0 || next >= distances.length || distances[next] < 0) continue;
            const nx = next % gridWidth + gridX, nz = Math.floor(next / gridWidth) + gridZ;
            if (!clearLine(actor.x, actor.z, nx, nz)) continue;
            let penalty = 0;
            for (const g of gasEffects) {
                const gd = Math.hypot(nx - g.x, nz - g.z);
                if (gd < g.r + 1.5) penalty += 6 * (1 - gd / (g.r + 1.5));
            }
            const cost = distances[next] + penalty;
            if (cost < bestCost) {
                chosen = next; bestCost = cost;
            }
        }
        if (chosen < 0) break;
        best = chosen; distance = distances[best];
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

/** The police line the crowd is up against: the first one still holding, or null. */
export function frontLine(state) {
    const index = state.lines.findIndex(line => line.state === 'holding');
    return index < 0 ? null : { ...lineDefs[index], ...state.lines[index] };
}

function temperamentOf(id) {
    if (id % 20 === 6) return 'medic';
    const k = id % 10;
    return k < 3 ? 'pusher' : k < 7 ? 'follower' : 'bystander';
}
const baseMorale = { pusher: 0.85, follower: 0.6, bystander: 0.45, medic: 0.7 };

function officer(id, line, x, z) {
    // Officers carry about 12 kg of gear on top of the body, including ballistic Kevlar and riot helmet.
    return { id, x, z, health: 10, line, cooldown: 1 + id % 5 * 0.3, stagger: 0, attacking: 0, tool: '',
        faction: 'capitol-police', heading: Math.PI, moving: false, row: 0, spray: 2 + id % 4,
        mass: 90 + id * 7 % 5 * 3, vx: 0, vz: 0, kx: 0, kz: 0, armor: 4 };
}

const steeringByAttempt = new WeakMap();

export function createAttempt(difficulty = 'standard', demo = false, role = 'raider') {
    if (!Object.hasOwn(difficulties, difficulty)) throw new RangeError('Unknown difficulty.');
    if (!roles.includes(role)) throw new RangeError('Unknown role.');
    role = demo ? 'none' : role;
    let officerId = 0;
    const state = {
        status: 'active', outcome: '', difficulty, demo, role, health: 100, elapsed: 0, milestone: 0,
        player: { ...(role === 'police' ? { x: 3, z: 30 } : role === 'observer' ? { x: 18, z: 52 } : { x: 0, z: 100 }),
            mass: role === 'police' ? 92 : 80, vx: 0, vz: 0, kx: 0, kz: 0 },
        cooldown: 0, pushes: 0, staggers: 0, damageFlash: 0, playerPush: 0, sprayed: 0, gassed: false, flashed: 0,
        suppression: 0, recoil: 0,
        lines: lineDefs.map((def, id) => ({ id, state: 'holding', integrity: 100, pressure: 0, hold: 0,
            munition: 10 + id * 2, gasLeft: id === 0 ? 2 : 1, flashCooldown: 6, flashLeft: 1, brokenAt: -1, strain: 0 })),
        enemies: lineDefs.flatMap((def, line) => Array.from({ length: def.officers }, (_, i) =>
            officer(officerId++, line, def.x0 + (i + 0.5) * (def.x1 - def.x0) / def.officers, def.z - 0.4))),
        companions: Array.from({ length: role === 'raider' ? CROWD_SIZE - 1 : CROWD_SIZE }, (_, id) => {
            const temperament = temperamentOf(id);
            return {
                id, x: (id % 32 - 15.5) * 2.2, z: 80 + Math.floor(id / 32) * 2.4,
                mass: 58 + id * 13 % 35, vx: 0, vz: 0, kx: 0, kz: 0,
                health: 30, milestone: 0, heading: 0, moving: false, attacking: 0,
                cooldown: 0.5 + id % 7 * 0.13, delay: id % 9 * 0.12, speed: 3.2 + id % 7 * 0.16,
                routeWait: 0, targetX: 0, targetZ: 27,
                temperament, morale: baseMorale[temperament], retreating: false, milling: false,
                anchorX: 0, anchorZ: 0, filming: temperament === 'bystander' || id % 4 === 1,
                // Most of the crowd never goes far inside; only some drift past the doors.
                reach: temperament === 'bystander' ? 1 + (id % 3 === 0 ? 1 : 0) : milestones.length,
                sprayed: 0, stun: 0, surge: 0, downFor: 0, helped: false, resting: false, crowding: 0,
            };
        }),
        effects: [], events: [], reinforcements: 0, droppedShields: [],
        // Demo only: both sides are armed, and anyone brought to zero is out for the attempt.
        armed: demo, shots: [],
        // Seated or standing in the chamber until the evacuation; then out the rear doors.
        civilians: Array.from({ length: CIVILIANS }, (_, id) => {
            const seat = id < 50, side = id % 2 ? 1 : -1, n = Math.floor(id / 2);
            return { id, x: seat ? side * (5.5 + n % 5 * 2.35) : (id - 56.5) * 0.95, z: seat ? -57.9 - Math.floor(n / 5) * 3.3 : -74,
                heading: seat ? 0 : Math.PI, moving: false, evacuated: false };
        }),
        evacuation: -1,
    };
    steeringByAttempt.set(state, createSteering(CROWD_SIZE));
    return state;
}

export function setPaused(state, paused) {
    if (paused && state.status === 'active') state.status = 'paused';
    else if (!paused && state.status === 'paused') state.status = 'active';
}

const swept = {};
/**
 * Moves an actor with continuous collision: swept in small steps so no move, however fast,
 * can end inside a column or on the far side of a wall. Raiders cannot cross a line that holds.
 * Returns the sweep result (position and which axes were stopped), valid until the next call.
 */
function relocate(state, actor, nx, nz, crowd) {
    if (crowd && (actor === state.player ? state.health : actor.health) > 0) nz = heldAt(state, nx, actor.z, nz) ?? nz;
    sweep(actor.x, actor.z, nx, nz, walkable, swept);
    actor.x = swept.x; actor.z = swept.z;
    return swept;
}

/** Impact events carry joules and a material so sound and sparks can scale with the blow. */
const blow = (state, type, x, z, energy, material, extra = {}) => state.events.push({ type, x, z, energy, material, ...extra });
const MAX_IMPACTS = 4;

/** A blow: momentum passes from the attacker to the target, who slides away under ground friction. */
const deliver = strike;

/**
 * The human's one action. A raider leans into the line and staggers the officer in front;
 * an officer pushes back whoever is pressing. Nobody is shot: there are no firearms here.
 */
export function shove(state, direction) {
    if (!Number.isFinite(direction.x) || !Number.isFinite(direction.z)) throw new TypeError('Invalid direction.');
    if (state.status !== 'active' || state.cooldown > 0 || (state.role !== 'raider' && state.role !== 'police')) return null;
    const length = Math.hypot(direction.x, direction.z);
    if (length < 0.001) return null;
    const dx = direction.x / length, dz = direction.z / length;
    const inReach = actor => {
        const x = actor.x - state.player.x, z = actor.z - state.player.z, distance = Math.hypot(x, z);
        return actor.health > 0 && distance < 2.4 && distance > 0.01 && (x * dx + z * dz) / distance > 0.3 ? distance : Infinity;
    };
    let hit = null, energy = 0;
    if (state.role === 'raider') {
        let nearest = Infinity;
        for (const enemy of state.enemies) {
            const distance = inReach(enemy);
            if (distance < nearest) { nearest = distance; hit = enemy; }
        }
        if (hit) {
            hit.stagger = 1.4; hit.health = Math.max(0, hit.health - 1); state.staggers++;
            energy = deliver(state.player, hit, dx, dz, 'shove');
        }
    } else {
        const pressing = state.companions.filter(c => inReach(c) < Infinity).slice(0, 3);
        for (const raider of pressing) {
            raider.health = Math.max(0, raider.health - 6);
            raider.stun = 0.7; raider.morale = Math.max(0, raider.morale - 0.2);
            energy = Math.max(energy, deliver(state.player, raider, dx, dz, 'shove'));
            state.staggers++;
        }
        hit = pressing[0] ?? null;
    }
    state.pushes++;
    state.cooldown = 0.45;
    state.playerPush = 0.6;
    // A shove into thin air still has a body behind it: a lean of the shoulder, about 25 J.
    blow(state, 'shove', state.player.x, state.player.z, energy || 25, 'body', { human: true });
    return { hit: hit?.id ?? null, x: state.player.x + dx * 1.6, z: state.player.z + dz * 1.6 };
}

/** The z a raider is held at if this move would cross a line that still holds, else null. */
function heldAt(state, x, fromZ, toZ) {
    for (const [i, def] of lineDefs.entries()) {
        if (state.lines[i].state !== 'holding') continue;
        const limit = def.z + LINE_STANDOFF;
        if (x >= def.x0 - 0.5 && x <= def.x1 + 0.5 && fromZ >= limit - 0.05 && toZ < limit) return limit;
    }
    return null;
}

/** Distance from a raider to the next line still holding in front of them. */
function lineAhead(state, actor) {
    for (const [i, def] of lineDefs.entries()) {
        if (state.lines[i].state === 'holding' && actor.z >= def.z + LINE_STANDOFF - 0.05) return actor.z - def.z - LINE_STANDOFF;
    }
    return Infinity;
}

const inGas = (state, actor) => state.effects.some(e =>
    e.type === 'gas' && Math.hypot(actor.x - e.x, actor.z - e.z) < e.r);

function end(state, outcome) {
    state.outcome = outcome;
    const won = state.role === 'police' ? outcome === 'curfew' || outcome === 'dispersed' : outcome === 'doors';
    state.status = won ? 'completed' : 'failed';
}

/**
 * Staff and members leave by the rear doors: from about 2:15 pm, sooner if the building is
 * entered, and at a run once the crowd reaches Statuary Hall. They are gone before anyone
 * can reach the chamber doors, which stay shut regardless.
 */
function evacuate(state, dt) {
    if (state.evacuation < 0 && (state.elapsed >= EVACUATION_STARTS || state.lines[1].state === 'broken')) {
        state.evacuation = state.elapsed;
        state.events.push({ type: 'evacuation', x: 0, z: -66 });
    }
    if (state.evacuation < 0) return;
    const rush = state.lines[3].state === 'broken';
    for (const person of state.civilians) {
        person.moving = false;
        if (person.evacuated || (!rush && state.elapsed < state.evacuation + person.id * 0.45)) continue;
        const exitX = person.x < 0 ? -17 : 17, dx = exitX - person.x, dz = -77.5 - person.z, d = Math.hypot(dx, dz);
        if (d < 0.6) { person.evacuated = true; continue; }
        const step = Math.min(d, (rush ? 7 : 3.4) * dt);
        person.x += dx / d * step; person.z += dz / d * step;
        person.heading = Math.atan2(-dx, -dz); person.moving = true;
    }
}

function updateLines(state, difficulty, dt) {
    const humanRaider = state.role === 'raider' && state.health > 0;
    const humanOfficer = state.role === 'police' && state.health > 0;
    for (const [i, def] of lineDefs.entries()) {
        const line = state.lines[i];
        if (line.state !== 'holding') continue;
        line.munition -= dt; line.flashCooldown -= dt;
        const limit = def.z + LINE_STANDOFF;
        const pressing = actor => actor.x >= def.x0 - 0.5 && actor.x <= def.x1 + 0.5 && actor.z >= limit - 0.1 && actor.z <= limit + 2.4;
        let pressure = 0, sumX = 0, count = 0, instigatorX = 0, instigatorWeight = 0;
        for (const c of state.companions) {
            if (c.health <= 0 || c.retreating || c.stun > 0 || !pressing(c)) continue;
            const weight = c.temperament === 'pusher' ? 1 : c.temperament === 'follower' && c.morale > 0.7 ? 0.5 : 0;
            if (weight === 0) continue;
            pressure += weight * (c.surge > 0 ? 1.3 : 1);
            sumX += c.x; count++;
            const iw = (c.hasShield ? 2.5 : 1) * weight * (c.surge > 0 ? 1.5 : 1);
            instigatorX += c.x * iw; instigatorWeight += iw;
        }
        if (humanRaider && pressing(state.player)) pressure += state.playerPush > 0 ? 6 : 1;
        let hold = def.barrier;
        const frontSlots = Math.floor((def.x1 - def.x0) / 1.7);
        let standing = 0;
        for (const e of state.enemies) {
            if (e.health <= 0 || e.line !== i || e.stagger > 0 || Math.abs(e.z - def.z) > 2.2) continue;
            if (standing++ < frontSlots) hold += difficulty.hold;
        }
        if (humanOfficer && Math.abs(state.player.z - def.z) < 2.6 && state.player.x >= def.x0 - 1 && state.player.x <= def.x1 + 1) {
            hold += state.playerPush > 0 ? 6 : 3;
        }
        // A line that has been leaned on for a long time tires, however many stand in it.
        if (pressure > hold * 0.3) line.strain += dt;
        hold *= 1 - Math.min(0.65, line.strain / difficulty.tire);
        line.pressure = pressure; line.hold = hold;
        line.integrity = Math.max(0, Math.min(100, line.integrity + (hold - pressure) * (pressure > hold ? 1.5 : 0.25) * dt));
        const rawCenter = instigatorWeight > 0 ? instigatorX / instigatorWeight : count ? sumX / count : 0;
        const centerX = count ? Math.max(def.x0 + 2, Math.min(def.x1 - 2, rawCenter)) : 0;
        if (pressure > hold * 0.6 && line.gasLeft > 0 && line.munition <= 0) {
            line.gasLeft--; line.munition = 22;
            // Gas hangs longer under a ceiling than in the open air.
            const life = i === 0 ? 8 : 12;
            state.effects.push({ type: 'gas', x: centerX, z: def.z + 3.4, r: 4, life, span: life });
            state.events.push({ type: 'gas', x: centerX, z: def.z + 3.4 });
        }
        if (line.integrity < 40 && line.flashLeft > 0 && line.flashCooldown <= 0) {
            line.flashLeft--; line.flashCooldown = 25;
            const fx = centerX, fz = def.z + 2.6;
            state.effects.push({ type: 'flash', x: fx, z: fz, r: 5, life: 0.5, span: 0.5 });
            state.events.push({ type: 'flash', x: fx, z: fz });
            for (const c of state.companions) {
                if (c.health <= 0 || Math.hypot(c.x - fx, c.z - fz) > 5) continue;
                c.stun = 1.5; c.morale = Math.max(0, c.morale - 0.3);
            }
            if (humanRaider && Math.hypot(state.player.x - fx, state.player.z - fz) < 5) state.flashed = 1.2;
        }
        if (line.integrity <= 0) {
            line.state = 'broken'; line.brokenAt = state.elapsed; line.pressure = 0;
            state.events.push({ type: 'break', x: 0, z: def.z, line: i });
            // Drop captured police shields along the broken line
            state.droppedShields = state.droppedShields ?? [];
            state.droppedShields.push({ x: (def.x0 + def.x1) * 0.5 - 2.5, z: def.z + 0.5 });
            state.droppedShields.push({ x: (def.x0 + def.x1) * 0.5 + 2.5, z: def.z + 0.5 });
            // A line giving way is the moment a hesitant crowd surges.
            for (const c of state.companions) {
                if (c.health <= 0 || Math.abs(c.z - def.z) > 35) continue;
                c.morale = Math.min(1, c.morale + 0.35); c.surge = 4; c.retreating = false;
            }
        }
    }
    const front = state.lines.findIndex(line => line.state === 'holding');
    if (front >= 0 && state.reinforcements < reinforcementTimes.length &&
        state.elapsed >= reinforcementTimes[state.reinforcements] && state.enemies.length + 4 <= MAX_POLICE) {
        state.reinforcements++;
        const def = lineDefs[front];
        for (let i = 0; i < 4; i++) {
            state.enemies.push(officer(state.enemies.length, front, (i - 1.5) * 1.1, Math.max(-51, def.z - 3 - (i % 2))));
        }
        state.events.push({ type: 'reinforce', x: 0, z: def.z - 3, line: front });
    }
}

export function blocksWithShield(target, fromX, fromZ) {
    if (!target?.hasShield || (target.shieldHp ?? 0) <= 0) return false;
    const heading = target.heading ?? 0;
    const forwardX = -Math.sin(heading), forwardZ = -Math.cos(heading);
    const attackDirX = target.x - fromX, attackDirZ = target.z - fromZ;
    const dist = Math.hypot(attackDirX, attackDirZ);
    if (dist < 1e-4) return false;
    const dot = (attackDirX / dist) * forwardX + (attackDirZ / dist) * forwardZ;
    return dot < -0.2;
}

function updateOfficers(state, difficulty, dt) {
    const humanRaider = state.role === 'raider' && state.health > 0;
    // Slots: the front rank spreads along the line and bows back as the line weakens;
    // anyone beyond the front rank stands in reserve behind it.
    const ranks = lineDefs.map(() => 0), standing = lineDefs.map(() => 0);
    for (const e of state.enemies) {
        while (e.line < lineDefs.length && state.lines[e.line].state === 'broken') e.line++;
        if (e.health > 0 && e.line < lineDefs.length) standing[e.line]++;
    }
    for (const e of state.enemies) {
        e.attacking = Math.max(0, e.attacking - dt);
        e.stagger = Math.max(0, e.stagger - dt);
        e.cooldown -= dt;
        e.moving = false;
        const def = lineDefs[e.line], line = state.lines[e.line];
        let slot, field;
        if (e.health <= 0) {
            // Pulled back behind the line they were holding, not left where they fell.
            const back = lineDefs[Math.min(e.line, lineDefs.length - 1)];
            slot = { x: e.x, z: Math.min(e.z, back.z - 4) }; field = -1;
        } else if (!def) {
            const rank = ranks[lineDefs.length - 1]++;
            slot = { x: (rank % 5 - 2) * 1.3, z: -51 - Math.floor(rank / 5) * 0.9 }; field = LAST_POST_FIELD;
        } else {
            const rank = ranks[e.line]++, span = def.x1 - def.x0;
            const perRow = Math.min(Math.floor(span / 1.7), standing[e.line]), row = Math.floor(rank / perRow);
            const x = def.x0 + (rank % perRow + 0.5) * span / perRow;
            const bow = (1 - line.integrity / 100) * 1.4 * Math.cos(Math.PI * (x - (def.x0 + def.x1) / 2) / span);
            slot = { x, z: def.z - 0.4 - bow - row * 1.8 }; field = LINE_FIELD + e.line; e.row = row;
        }
        const distance = Math.hypot(slot.x - e.x, slot.z - e.z), fromX = e.x, fromZ = e.z;
        if (distance > 0.15) {
            const target = field < 0 || distance < 3 ? slot : routeTarget(e, field, slot);
            const dx = target.x - e.x, dz = target.z - e.z, d = Math.hypot(dx, dz) || 1;
            const step = Math.min(d, (e.health <= 0 ? 1.5 : 4.6) * dt);
            relocate(state, e, e.x + dx / d * step, e.z + dz / d * step, false);
            e.moving = distance > 0.6;
            if (e.moving) e.heading = Math.atan2(-dx, -dz);
        }
        e.vx = dt > 0 ? (e.x - fromX) / dt : 0; e.vz = dt > 0 ? (e.z - fromZ) / dt : 0;
        e.spray -= dt;
        // Only the front rank reaches with melee. In standard difficulty, reserve ranks also provide fire support.
        if (e.health <= 0 || !def || (e.row > (state.difficulty === 'standard' && state.armed ? 1 : 0)) || distance > 1.5 || e.stagger > 0) continue;
        if (!e.moving) e.heading = Math.PI;
        if (e.cooldown > 0) continue;
        // Nearest person pressing from the front: baton at arm's length, spray beyond it.
        let target = null, nearest = state.armed ? 24 : e.spray <= 0 ? 4.5 : 1.9;
        for (const actor of humanRaider ? [state.player, ...state.companions] : state.companions) {
            if (actor !== state.player && (actor.health <= 0 || actor.retreating)) continue;
            if (actor.z < e.z) continue;
            const d = Math.hypot(actor.x - e.x, actor.z - e.z);
            if (d < nearest && d > 0.01) { nearest = d; target = actor; }
        }
        if (!target || (nearest > 1.9 && !clearLine(e.x, e.z, target.x, target.z))) { e.cooldown = 0.3; continue; }
        const dx = (target.x - e.x) / nearest, dz = (target.z - e.z) / nearest;
        const baton = nearest <= 1.9;
        e.heading = Math.atan2(-dx, -dz);
        e.cooldown = difficulty.interval + e.id % 3 * 0.25;
        if (!baton && state.armed) {
            e.attacking = 0.2; e.tool = 'gun';
            state.shots.push({ x: e.x, z: e.z, dx, dz, life: 1.2, faction: 'police' });
            state.events.push({ type: 'gunshot', x: e.x, z: e.z });
            continue;
        }
        e.attacking = 0.3; e.tool = baton ? 'baton' : 'spray';
        if (!baton) e.spray = difficulty.interval * 3;
        let energy = 0;
        const blocked = blocksWithShield(target, e.x, e.z);
        if (blocked) {
            target.shieldHp = (target.shieldHp ?? 8) - 1;
            energy = 70;
            state.events.push({ type: 'impact', x: target.x, z: target.z, material: 'metal', energy: 120 });
            if (target.shieldHp <= 0) {
                target.hasShield = false;
                state.events.push({ type: 'break', x: target.x, z: target.z });
            }
        } else if (target === state.player) {
            state.health = Math.max(0, state.health - (baton ? difficulty.playerBaton : difficulty.playerSpray));
            state.damageFlash = 0.22;
            if (baton) energy = deliver(e, state.player, dx, dz, 'baton'); else state.sprayed = 4;
        } else {
            target.health = Math.max(0, target.health - (baton ? difficulty.baton : difficulty.spray));
            target.morale = Math.max(0, target.morale - (baton ? 0.15 : 0.35));
            if (baton) { energy = deliver(e, target, dx, dz, 'baton'); target.stun = 0.5; } else target.sprayed = 4;
            if (target.health === 0) state.events.push({ type: 'down', x: target.x, z: target.z, energy: 30, material: 'body' });
        }
        if (!baton) state.effects.push({ type: 'spray', x: e.x, z: e.z, tx: target.x, tz: target.z, life: 0.35, span: 0.35 });
        blow(state, e.tool, e.x, e.z, energy, baton ? 'baton' : 'air', { tx: target.x, tz: target.z });
    }
}

/** Decides what every raider wants this step; steering then works out how they move. */
function planRaiders(state, difficulty, dt, agents, bodies) {
    if (state.role !== 'none' && state.health > 0) bodies.push(state.player);
    for (const e of state.enemies) if (e.health > 0) bodies.push(e);
    const down = state.armed ? [] : state.companions.filter(c => c.health <= 0 && !c.helped);
    for (const c of state.companions) {
        c.attacking = Math.max(0, c.attacking - dt);
        c.sprayed = Math.max(0, c.sprayed - dt);
        c.stun = Math.max(0, c.stun - dt);
        c.surge = Math.max(0, c.surge - dt);
        c.cooldown -= dt;
        c.moving = false;
        let goal, field, speed = c.speed;
        if (c.health <= 0) {
            // Armed demo: eliminated, and they stay where they dropped.
            if (state.armed) { bodies.push(c); continue; }
            // Out of the scenario, not out of the world: they sit until a street medic (or
            // time) gets them up, then walk back to the aid station and stay there.
            if (!c.helped) {
                c.downFor += dt;
                if (c.downFor > 8) c.helped = true;
                bodies.push(c); continue;
            }
            if (c.resting) { bodies.push(c); continue; }
            if (Math.hypot(c.x - aidStation.x, c.z - aidStation.z) < 5 + c.id % 4) { c.resting = true; bodies.push(c); continue; }
            goal = aidStation; field = AID_FIELD; speed = 1.5;
        } else {
            if (state.elapsed < c.delay) { bodies.push(c); continue; }
            const gassed = inGas(state, c);
            if (gassed) {
                c.health = Math.max(0, c.health - difficulty.gas * dt);
                c.morale = Math.max(0, c.morale - 0.18 * dt);
                if (c.health === 0) { state.events.push({ type: 'down', x: c.x, z: c.z }); bodies.push(c); continue; }
            } else {
                const base = baseMorale[c.temperament];
                c.morale += Math.sign(base - c.morale) * Math.min(Math.abs(base - c.morale), 0.08 * dt);
            }
            // Worn-out people drop back to catch their breath, then drift forward again.
            if (!state.armed && (c.retreating || lineAhead(state, c) > 6)) c.health = Math.min(30, c.health + 1 * dt);
            if (c.morale < 0.25 || (!state.armed && c.health < 6)) c.retreating = true;
            else if (c.morale > 0.55 && (state.armed || c.health > 16)) c.retreating = false;
            if (c.milestone < c.reach && milestones[c.milestone] &&
                Math.hypot(c.x - milestones[c.milestone].x, c.z - milestones[c.milestone].z) <= milestones[c.milestone].radius) {
                c.milestone++; c.routeWait = 0;
                state.events.push({ type: 'advance', x: c.x, z: c.z });
            }
            const patient = c.temperament === 'medic' && !c.retreating ? down.reduce((best, d) => {
                const distance = Math.hypot(d.x - c.x, d.z - c.z);
                return distance < 14 && (!best || distance < best.distance) ? { actor: d, distance } : best;
            }, null) : null;
            const standoff = c.temperament === 'pusher' || (c.temperament === 'follower' && c.morale > 0.7) ? 0
                : c.temperament === 'follower' ? 2.6 + c.id % 3 * 0.7 : c.temperament === 'medic' ? 6 : 9 + c.id % 6;
            let stand = false;
            if (c.stun > 0) stand = true;
            else if (c.retreating) {
                field = c.milestone > 0 ? c.milestone - 1 : AID_FIELD;
                goal = c.milestone > 0 ? milestones[c.milestone - 1] : aidStation;
                if (Math.hypot(c.x - goal.x, c.z - goal.z) < 4) stand = true;
            } else if (patient && clearLine(c.x, c.z, patient.actor.x, patient.actor.z)) {
                if (patient.distance < 1.6) { patient.actor.helped = true; stand = true; }
                else { goal = patient.actor; field = -1; }
            } else if (c.milestone >= c.reach || c.milestone >= milestones.length || lineAhead(state, c) <= standoff) {
                // Nothing to push toward: mill about, the way most of a crowd does.
                if (!c.milling) { c.milling = true; c.anchorX = c.x; c.anchorZ = c.z; }
                goal = { x: c.anchorX + Math.sin(state.elapsed * 0.31 + c.id * 1.9) * 2.2,
                    z: c.anchorZ + Math.cos(state.elapsed * 0.27 + c.id * 0.7) * 1.6 };
                field = -1; speed = 1.1;
                if (!walkable(goal.x, goal.z)) stand = true;
            } else {
                const milestone = milestones[c.milestone];
                goal = { x: milestone.x + (c.id % 7 - 3) * 0.45, z: milestone.z }; field = c.milestone;
            }
            if (!(c.milestone >= c.reach || lineAhead(state, c) <= standoff) || c.retreating) c.milling = false;
            if (stand) goal = null;
            if (gassed) speed *= 0.7;
            if (c.sprayed > 0) speed *= 0.5;
            if (c.surge > 0) speed *= 1.25;
            // People packed shoulder to shoulder shuffle; they do not stride.
            speed /= 1 + 0.18 * Math.max(0, c.crowding - 2);
        }
        if (goal) {
            c.routeWait -= dt;
            if (field < 0) { c.targetX = goal.x; c.targetZ = goal.z; }
            else if (c.routeWait <= 0 || Math.hypot(c.targetX - c.x, c.targetZ - c.z) < 0.4) {
                const next = routeTarget(c, field, goal);
                c.targetX = next.x; c.targetZ = next.z;
                c.routeWait = 0.2;
            }
        } else { c.targetX = c.x; c.targetZ = c.z; speed = 0; }
        agents.push({ id: c.id, x: c.x, z: c.z, targetX: c.targetX, targetZ: c.targetZ, speed, mass: massOf(c), actor: c });
    }
}

export function advance(state, input, seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Invalid time step.');
    const x = input.x ?? 0, z = input.z ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new TypeError('Invalid movement input.');
    if (state.status !== 'active') return;
    const dt = Math.min(seconds, 0.05);
    const difficulty = difficulties[state.difficulty];
    state.events.length = 0;
    state.elapsed += dt;
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.damageFlash = Math.max(0, state.damageFlash - dt);
    state.playerPush = Math.max(0, state.playerPush - dt);
    state.sprayed = Math.max(0, state.sprayed - dt);
    state.flashed = Math.max(0, state.flashed - dt);
    stepHarm(state, dt);

    if (state.role !== 'none' && state.health > 0) {
        const magnitude = Math.max(1, Math.hypot(x, z));
        const speed = (input.sprint ? 8 : 5) * (state.sprayed > 0 ? 0.6 : 1);
        const nx = state.player.x + x / magnitude * speed * dt;
        let nz = state.player.z + z / magnitude * speed * dt;
        if (state.role === 'raider') nz = heldAt(state, nx, state.player.z, nz) ?? nz;
        const fromX = state.player.x, fromZ = state.player.z;
        relocate(state, state.player, nx, nz, false);
        state.player.vx = dt > 0 ? (state.player.x - fromX) / dt : 0;
        state.player.vz = dt > 0 ? (state.player.z - fromZ) / dt : 0;
        state.gassed = state.role === 'raider' && inGas(state, state.player);
        if (state.gassed) {
            state.health = Math.max(0, state.health - difficulty.playerGas * dt);
            state.damageFlash = Math.max(state.damageFlash, 0.1);
        }
    }

    evacuate(state, dt);
    for (const effect of state.effects) effect.life -= dt;
    state.effects = state.effects.filter(effect => effect.life > 0);
    updateLines(state, difficulty, dt);
    updateOfficers(state, difficulty, dt);
    stepRaiders(state, difficulty, dt);

    // Pick up fallen police riot shields
    if (state.droppedShields?.length > 0) {
        for (const c of state.companions) {
            if (c.health <= 0 || c.hasShield) continue;
            for (let i = 0; i < state.droppedShields.length; i++) {
                const s = state.droppedShields[i];
                if (Math.hypot(c.x - s.x, c.z - s.z) < 1.4) {
                    c.hasShield = true; c.shieldHp = 8;
                    state.droppedShields.splice(i, 1);
                    state.events.push({ type: 'pickup', x: c.x, z: c.z, item: 'shield' });
                    break;
                }
            }
        }
        if (state.role === 'raider' && state.health > 0 && !state.player.hasShield) {
            for (let i = 0; i < state.droppedShields.length; i++) {
                const s = state.droppedShields[i];
                if (Math.hypot(state.player.x - s.x, state.player.z - s.z) < 1.4) {
                    state.player.hasShield = true; state.player.shieldHp = 10;
                    state.droppedShields.splice(i, 1);
                    state.events.push({ type: 'pickup', x: state.player.x, z: state.player.z, item: 'shield' });
                    break;
                }
            }
        }
    }

    // Armed demo: rounds in flight, swept as segments so a 1.5 m step cannot skip a body or a
    // wall. A hit takes stamina; nobody is hit by their own side.
    state.suppression = Math.max(0, (state.suppression ?? 0) - dt * 0.75);
    const listenerX = state.role === 'none' ? (state.cameraLeader?.x ?? state.companions[0]?.x ?? 0) : state.player.x;
    const listenerZ = state.role === 'none' ? (state.cameraLeader?.z ?? state.companions[0]?.z ?? 50) : state.player.z;

    for (const shot of state.shots) {
        shot.speed = shot.speed ?? 30;
        const fromX = shot.x, fromZ = shot.z;
        const toX = fromX + shot.dx * shot.speed * dt, toZ = fromZ + shot.dz * shot.speed * dt;
        shot.life -= dt;
        shot.y = (shot.y ?? 1.35) - (shot.vy ?? 0.08) * dt;
        shot.vy = (shot.vy ?? 0.08) + 1.8 * dt;

        let reach = firstBlocked(fromX, fromZ, toX, toZ, walkable), victim = null;
        if (reach < 0) reach = 1;
        for (const actor of shot.faction === 'raider' ? state.enemies : state.companions) {
            if (actor.health <= 0) continue;
            const t = segmentCircle(fromX, fromZ, toX, toZ, actor.x, actor.z, 0.6);
            if (t >= 0 && t <= reach) { reach = t; victim = actor; }
        }

        // Supersonic near-miss fly-by acoustics & suppression stress
        if (!victim && reach >= 1 && !shot.whizzed) {
            const nearT = segmentCircle(fromX, fromZ, toX, toZ, listenerX, listenerZ, 2.5);
            if (nearT >= 0) {
                shot.whizzed = true;
                state.events.push({ type: 'whiz', x: shot.x, z: shot.z, dx: shot.dx, dz: shot.dz });
                state.suppression = Math.min(1.0, (state.suppression ?? 0) + 0.28);
            }
        }

        shot.x = fromX + (toX - fromX) * reach; shot.z = fromZ + (toZ - fromZ) * reach;
        if (victim) {
            const dmg = shot.faction === 'raider' ? (difficulty.raiderShot ?? 3.4) : difficulty.shot;
            const hitZone = (shot.y ?? 1.35) > 1.4 ? 'head' : (shot.y ?? 1.35) > 0.85 ? 'torso' : 'limbs';
            if (victim.faction === 'capitol-police' && (victim.armor ?? 0) > 0) {
                if (hitZone === 'head') {
                    state.events.push({ type: 'ricochet', x: shot.x, z: shot.z, material: 'metal' });
                } else if (hitZone === 'torso') {
                    victim.armor = Math.max(0, victim.armor - 1);
                    state.events.push({ type: 'armor_hit', x: shot.x, z: shot.z, material: 'kevlar' });
                }
            }
            victim.health = Math.max(0, victim.health - dmg);
            if (shot.faction === 'police') victim.morale = Math.max(0, victim.morale - 0.25);
            victim.stagger = Math.max(victim.stagger ?? 0, 0.25);
            // What the renderer needs to react to: where it landed, from which way, and how hard.
            victim.hitZone = hitZone;
            victim.hitAt = state.elapsed ?? 0;
            victim.hitPower = Math.min(1, dmg / (shot.faction === 'raider' ? (difficulty.raiderShot ?? 3.4) : difficulty.shot));
            victim.ix = shot.dx; victim.iz = shot.dz;
            // The measurement layer: severity of this hit and the bleeding it starts.
            victim.harm ??= createHarm();
            applyInjury(victim.harm, { zone: hitZone, energy: 520, armor: (victim.armor ?? 0) > 0 ? 1 : 0 });
            // Slight kinetic momentum transfer
            victim.kx = (victim.kx ?? 0) + shot.dx * (shot.faction === 'raider' ? 0.8 : 0.3);
            victim.kz = (victim.kz ?? 0) + shot.dz * (shot.faction === 'raider' ? 0.8 : 0.3);

            if (victim.health === 0) {
                state.events.push({ type: 'down', x: victim.x, z: victim.z, energy: 30, material: 'body' });
                // A body dropping makes the people pressed against it check their step. This is a
                // render-only flinch: nothing here touches position, momentum or line holding.
                for (const other of [...(state.role !== 'none' && state.health > 0 ? [state.player] : []), ...state.companions, ...state.enemies]) {
                    if (!other || other === victim || other.health <= 0) continue;
                    const dx = other.x - victim.x, dz = other.z - victim.z, d = Math.hypot(dx, dz);
                    if (d <= 0.01 || d >= 1.6) continue;
                    other.startle = state.elapsed ?? 0;
                    other.startleDx = dx / d; other.startleDz = dz / d;
                }
            }
            blow(state, 'impact', shot.x, shot.z, 520, 'body', { round: true, zone: hitZone });
            shot.life = 0;
        } else if (reach < 1 || !walkable(shot.x, shot.z)) {
            blow(state, 'impact', shot.x, shot.z, 520, 'marble', { round: true, spall: true });
            state.events.push({ type: 'ricochet', x: shot.x, z: shot.z, dx: -shot.dz * 0.5, dz: shot.dx * 0.5, material: 'marble' });
            shot.life = 0;
        }
    }
    state.shots = state.shots.filter(shot => shot.life > 0);

    // Pushers lean on whoever is holding the line; this is what wears a line down.
    const humanOfficer = state.role === 'police' && state.health > 0;
    for (const c of state.companions) {
        if (c.health <= 0 || c.cooldown > 0 || c.retreating || c.stun > 0) continue;
        if (c.temperament !== 'pusher' && !(c.temperament === 'follower' && c.morale > 0.7)) continue;
        let target = null, nearest = state.armed ? 16 : 1.9;
        for (const e of state.enemies) {
            if (e.health <= 0) continue;
            const d = Math.hypot(e.x - c.x, e.z - c.z);
            if (d < nearest && d > 0.01) { nearest = d; target = e; }
        }
        if (state.armed) {
            if (!target || !clearLine(c.x, c.z, target.x, target.z)) { c.cooldown = 0.3; continue; }
            state.shots.push({ x: c.x, z: c.z, dx: (target.x - c.x) / nearest, dz: (target.z - c.z) / nearest, life: 0.9, faction: 'raider' });
            state.events.push({ type: 'gunshot', x: c.x, z: c.z });
            c.attacking = 0.2;
            c.cooldown = 2.4 + c.id % 5 * 0.3;
            continue;
        }
        if (humanOfficer && Math.hypot(state.player.x - c.x, state.player.z - c.z) < nearest) target = state.player;
        if (!target) { c.cooldown = 0.2; continue; }
        if (target === state.player) {
            state.health = Math.max(0, state.health - difficulty.playerSpray);
            state.damageFlash = 0.22;
        } else target.health = Math.max(0, target.health - difficulty.wear);
        c.attacking = 0.18;
        c.cooldown = 1.8 + c.id % 5 * 0.2;
        state.events.push({ type: 'shove', x: c.x, z: c.z });
    }

    // Incapacitation is resolved before arrival so a final hit cannot also produce a win.
    if (state.role !== 'none' && state.role !== 'observer' && state.health === 0) { end(state, 'overcome'); return; }
    if (state.role === 'raider') {
        const goal = milestones[state.milestone];
        if (goal && Math.hypot(state.player.x - goal.x, state.player.z - goal.z) <= goal.radius) {
            state.milestone++;
            state.events.push({ type: 'milestone', x: state.player.x, z: state.player.z });
            if (state.milestone === milestones.length) { end(state, 'doors'); return; }
        }
    } else {
        const leader = selectLeader(state);
        if (!leader) { end(state, 'dispersed'); return; }
        if (leader.milestone > state.milestone) state.events.push({ type: 'milestone', x: leader.x, z: leader.z });
        state.milestone = leader.milestone;
        if (state.milestone === milestones.length) { end(state, 'doors'); return; }
    }
    if (state.elapsed >= CURFEW_ELAPSED) end(state, 'curfew');
}

function stepRaiders(state, difficulty, dt) {
    const steering = steeringByAttempt.get(state);
    if (!steering) throw new Error('Attempt was not created by createAttempt.');
    const agents = [], bodies = [];
    planRaiders(state, difficulty, dt, agents, bodies);
    steering.step(agents, bodies, dt);
    for (const agent of agents) {
        const actor = agent.actor, fromX = actor.x, fromZ = actor.z;
        let nz = agent.nextZ;
        const held = actor.health > 0 ? heldAt(state, agent.nextX, fromZ, nz) : null;
        if (held !== null) nz = held;
        relocate(state, actor, agent.nextX, nz, false);
        const dx = actor.x - fromX, dz = actor.z - fromZ, moved = Math.hypot(dx, dz);
        if (held !== null || moved < Math.hypot(agent.nextX - fromX, agent.nextZ - fromZ) * 0.5) steering.stop(actor.id);
        actor.crowding = agent.crowding;
        actor.moving = moved > 0.3 * dt;
        // What the body is doing, in m/s, for the contact pass below and for the sound of a crowd's friction.
        actor.vx = dt > 0 ? dx / dt : 0; actor.vz = dt > 0 ? dz / dt : 0;
        if (moved > 0.6 * dt) actor.heading = Math.atan2(-dx, -dz);
        else if (actor.health > 0 && !actor.retreating) actor.heading = 0;
    }
    stepContacts(state, dt);
}

const crowdMember = (state, actor) => actor === state.player ? state.role === 'raider' : actor.faction === undefined;
const contactGrid = createGrid(), contactList = [];

/**
 * Bleeds every injured body forward, and keeps the field-wide totals the debrief reports.
 * Values are estimates from a coarse model, not clinical measurements.
 */
function stepHarm(state, dt) {
    let casualties = 0, immediate = 0, lossTotal = 0;
    for (const actor of [...state.enemies, ...state.companions]) {
        if (!actor.harm || actor.harm.hits === 0) continue;
        advanceHarm(actor.harm, dt, { down: actor.health <= 0 });
        const summary = harmSummary(actor.harm, actor.mass);
        if (actor.health <= 0) { casualties++; if (summary.triage === 'Immediate') immediate++; }
        lossTotal += summary.lossMl;
    }
    state.harmed = casualties;
    state.immediate = immediate;
    state.bloodLossTotal = Math.round(lossTotal);
}

/**
 * Everyone on the field is a body with a mass. Anyone knocked into motion slides until friction
 * stops them (or a wall does, with a thud proportional to the energy). Anyone overlapping gives
 * way in proportion to the other's mass and trades momentum when they were closing quickly.
 */function stepContacts(state, dt) {
    if (dt <= 0) return;
    const list = contactList;
    list.length = 0;
    if (state.role !== 'none' && state.health > 0) list.push(state.player);
    for (const e of state.enemies) if (e.health > 0) list.push(e);
    for (const c of state.companions) list.push(c);
    let impacts = 0;
    for (const body of list) {
        const speed = Math.hypot(body.kx ?? 0, body.kz ?? 0);
        if (speed === 0) continue;
        relocate(state, body, body.x + body.kx * dt, body.z + body.kz * dt, crowdMember(state, body));
        const energy = bounce(body, swept.hitX, swept.hitZ, speed);
        if (energy > 15 && impacts < MAX_IMPACTS) { impacts++; blow(state, 'impact', body.x, body.z, energy, 'marble'); }
        slide(body, dt);
    }
    contactGrid.clear();
    for (let i = 0; i < list.length; i++) contactGrid.insert(i, list[i].x, list[i].z);
    const weight = body => body.health <= 0 ? massOf(body) * 4 : massOf(body);
    for (let i = 0; i < list.length; i++) {
        const a = list[i];
        contactGrid.query(a.x, a.z, MIN_GAP, j => {
            if (j <= i) return;
            const b = list[j];
            let dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
            if (d >= MIN_GAP) return;
            // Exactly stacked bodies part along a direction fixed by who they are, never by chance.
            if (d < 1e-4) { dx = Math.cos(i * 2.4 + j); dz = Math.sin(i * 2.4 + j); d = 1; }
            const nx = dx / d, nz = dz / d, push = (MIN_GAP - d) * 0.6;
            const ma = weight(a), mb = weight(b), total = ma + mb;
            relocate(state, a, a.x - nx * push * mb / total, a.z - nz * push * mb / total, crowdMember(state, a));
            relocate(state, b, b.x + nx * push * ma / total, b.z + nz * push * ma / total, crowdMember(state, b));
            const closing = ((a.vx ?? 0) - (b.vx ?? 0)) * nx + ((a.vz ?? 0) - (b.vz ?? 0)) * nz;
            if (closing <= 0.8) return;
            const energy = exchange(a, b, nx, nz, closing);
            if (energy > 12 && impacts < MAX_IMPACTS) {
                impacts++;
                blow(state, 'impact', (a.x + b.x) / 2, (a.z + b.z) / 2, energy, 'body');
            }
        });
    }
}
