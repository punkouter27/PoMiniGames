// pocapitol/house/world.js — the House map's rules: one officer clears a scanned house of armed raiders.
//
// Capitol's other map (../world.js) is a crowd of 512 against five police lines on an invented
// floor plan. This one is a first-person shooter in a real house: the player is a police officer
// with the same machine gun, five concussion grenades and two smoke grenades the solo raider
// carries there, and eleven armed raiders hold the five rooms. Clear every room, then hold the
// house against the second wave that comes back in by the way the officer did.
//
// The state has the shape ../world.js gives its own, so the things that read one read the other:
// crowd.js draws `companions` (the raiders, with the demo's `armed` flag so they hold guns and
// lie where they fall), audio.js and bursts.js take the same `events`, particles.js the same
// `effects`. What is new is the third dimension: a round has a height and a pitch, because the
// player aims with the mouse and a table or a doorway decides what it hits (nav.js).
//
// Nothing here touches the page or the picture, and the random numbers come from the attempt's
// own seed, so an attempt replays the same in Node.

import { segmentCircle, knockback, blastFalloff, slide } from '../physics.js';
import { createHarm, applyInjury } from '../harm.js';
import { EYE, CEILING } from './nav.js';

/**
 * Per difficulty: how well the raiders shoot (`hit`, at close range), how hard, how fast they
 * react, how long they rest between bursts, how far a shot carries (`hear`, metres of walking:
 * nearer raiders come for it, the rest brace where they are), how the officer recovers, and how
 * many come in the second `wave`.
 */
export const DIFFICULTIES = {
    story: { hit: 0.2, damage: 5, react: 1.1, rest: [1.4, 2.4], hear: 3.5, regen: 6, regenAfter: 3.5, regenTo: 100, wave: 4 },
    standard: { hit: 0.32, damage: 8, react: 0.6, rest: [0.9, 1.7], hear: 5, regen: 3, regenAfter: 6, regenTo: 60, wave: 6 },
};

const WALK = 3.1, SPRINT = 4.7;             // m/s
const MG_INTERVAL = 0.085, MG_REACH = 30;   // the same 12 rounds a second as the solo raider's gun
const RAIDER_HEALTH = 30;
/** What a round does by where it lands: a head shot is three, the body six, a limb ten. */
const ZONE_DAMAGE = { head: 11, torso: 5.2, limbs: 3.2 };
const BODY_RADIUS = 0.3;
const PERSONAL = 0.85;                       // m: nearer than this and one of two people gives way
const SIGHT = 16;                            // m: nobody sees further down a house than this
const GRENADE_RADIUS = 3.4, GRENADE_FUSE = 1.25, GRENADE_RANGE = 9, GRENADE_BLAST = 520;
const SMOKE_RADIUS = 2.3, SMOKE_LIFE = 14;
const LAUNCH_FALL = 0.3, BLAST_SHADOW = 0.25;
/** The second wave: a breath after the last room, then one raider through the entry every so often. */
const WAVE_AFTER = 4.5, WAVE_EVERY = 1.5, WAVE_HOLD = 9;
/** Ids the raiders wear. crowd.js gives every twelfth person a flag on a 3 m pole: not indoors. */
const RAIDER_IDS = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23];

function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const headingTo = (dx, dz) => Math.atan2(-dx, -dz);
const turnToward = (from, to, max) => from + Math.max(-max, Math.min(max, Math.atan2(Math.sin(to - from), Math.cos(to - from))));

/**
 * A new attempt on the House map.
 * @param nav         createNav() of house-nav.json
 * @param difficulty  'story' or 'standard'
 * @param seed        fixes where the raiders look and how they move; the page passes the clock
 */
export function createHouseAttempt(nav, difficulty = 'standard', seed = 1) {
    if (!Object.hasOwn(DIFFICULTIES, difficulty)) throw new RangeError('Unknown difficulty.');
    const random = mulberry(seed);
    let next = 0;
    const companions = [];
    const rooms = nav.rooms.map(room => {
        for (const spot of room.spots) {
            const id = RAIDER_IDS[next++ % RAIDER_IDS.length];
            // Each faces the way into their room: toward where the officer will come from.
            const toward = nav.rooms[Math.max(0, room.index - 1)].centre;
            const face = room.index === 0 ? headingTo(nav.start.x - spot.x, nav.start.z - spot.z) : headingTo(toward.x - spot.x, toward.z - spot.z);
            companions.push({
                id, room: room.index, x: spot.x, z: spot.z, homeX: spot.x, homeZ: spot.z, mass: 62 + id * 13 % 30,
                vx: 0, vz: 0, kx: 0, kz: 0, y: 0, vy: 0, spin: 0,
                health: RAIDER_HEALTH, heading: face, face, moving: false, attacking: 0, stagger: 0, stun: 0,
                // What crowd.js reads to dress and pose someone: an armed "pusher" holds the gun up.
                temperament: 'pusher', morale: 1, retreating: false, filming: false, chanting: false, crowding: 0, sprayed: 0,
                mode: 'guard', aware: 0, seenAt: -99, lastX: spot.x, lastZ: spot.z, cooldown: 0.4 + random() * 0.6, burst: 0,
                stepAt: 0, goX: spot.x, goZ: spot.z, lookPhase: random() * 6.28, searchUntil: 0,
            });
        }
        return { index: room.index, id: room.id, name: room.name, total: room.spots.length, left: room.spots.length, clearedAt: -1 };
    });
    // The second wave is the last thing to clear: a "room" of people who are not in the house yet.
    const wave = DIFFICULTIES[difficulty].wave;
    rooms.push({ index: rooms.length, id: 'wave', name: 'Second wave', total: wave, left: wave, clearedAt: -1, wave: true });
    return {
        map: 'house', status: 'active', outcome: '', difficulty, demo: false, role: 'police', seed,
        health: 100, elapsed: 0, milestone: 0, objective: 0,
        player: { x: nav.start.x, z: nav.start.z, mass: 92, vx: 0, vz: 0, kx: 0, kz: 0, moving: false },
        weapon: 'mg', mgReady: 0, mgHeat: 0, playerGrenades: 5, playerSmoke: 2, grenadeReady: 0,
        damageFlash: 0, flashed: 0, suppression: 0, hurtAt: -99, hitFrom: 0,
        rooms, companions, enemies: [], civilians: [], lines: [], armed: true,
        // Everyone the officer has to deal with, in the house now or still to come.
        total: companions.length + wave, nextId: next, waveAt: -1, waveIn: 0,
        effects: [], events: [], shots: [], grenades: [],
        stats: { fired: 0, hits: 0, headshots: 0, taken: 0, down: 0 },
        // Steps to the officer over the floor, refreshed a few times a second for whoever is hunting.
        flow: null, flowAt: -1, endAt: -1, random,
    };
}

export function setPaused(state, paused) {
    if (paused && state.status === 'active') state.status = 'paused';
    else if (!paused && state.status === 'paused') state.status = 'active';
}

/** Does a straight line between two points pass through enough smoke to hide what is beyond it? */
export function smokeObscures(effects, ax, az, bx, bz) {
    for (const e of effects) {
        if (e.type === 'smoke' && segmentCircle(ax, az, bx, bz, e.x, e.z, (e.r ?? SMOKE_RADIUS) * 0.75) >= 0) return true;
    }
    return false;
}

/** Can someone at (ax, az) see someone standing at (bx, bz)? Eye to chest, and not through smoke. */
function sees(state, nav, ax, az, bx, bz) {
    return Math.hypot(bx - ax, bz - az) < SIGHT && nav.clearLine(ax, az, bx, bz, 1.4) && !smokeObscures(state.effects, ax, az, bx, bz);
}

function down(state, body, dx, dz, zone, power = 1) {
    body.health = 0;
    body.stagger = 0; body.stun = 0; body.moving = false; body.attacking = 0;
    body.ix = dx; body.iz = dz; body.hitZone = zone; body.hitAt = state.elapsed; body.hitPower = power;
    state.stats.down++;
    const room = state.rooms[body.room];
    room.left = Math.max(0, room.left - 1);
    state.events.push({ type: 'down', x: body.x, z: body.z, y: 0.05, energy: 40, material: 'body' });
    // Whoever is standing next to them flinches: for the eye only.
    for (const other of state.companions) {
        if (other === body || other.health <= 0) continue;
        const ox = other.x - body.x, oz = other.z - body.z, d = Math.hypot(ox, oz);
        if (d > 0.01 && d < 1.8) { other.startle = state.elapsed; other.startleDx = ox / d; other.startleDz = oz / d; }
    }
    if (room.left === 0 && room.clearedAt < 0) {
        room.clearedAt = state.elapsed;
        state.milestone = state.rooms.filter(r => r.left === 0).length;
        state.events.push({ type: 'milestone', x: body.x, z: body.z, room: room.index, energy: 30 });
    }
    const open = state.rooms.find(r => r.left > 0);
    state.objective = open ? open.index : -1;
    // The last one: a beat for the body to fall before the card comes up.
    if (!open && state.endAt < 0) state.endAt = state.elapsed + 1.6;
}

/**
 * A shot or a blast at the officer's end of the house. Raiders within `reach` metres of walking
 * leave their post and come for it; the rest have heard it too, and turn to cover the way in:
 * the house is cleared room by room, not by waiting at the door for all eleven.
 */
function alarm(state, nav, reach) {
    for (const r of state.companions) {
        if (r.health <= 0 || r.mode !== 'guard') continue;
        const walk = state.flow ? nav.walkDistance(state.flow, r.x, r.z) : Math.hypot(r.x - state.player.x, r.z - state.player.z);
        if (walk <= reach) {
            r.mode = 'hunt'; r.lastX = state.player.x; r.lastZ = state.player.z; r.searchUntil = state.elapsed + 9;
            r.cooldown = Math.max(r.cooldown, 0.5 + state.random() * 0.5);
            continue;
        }
        r.aware = Math.max(r.aware, 0.5);
        const way = state.flow ? nav.downhill(state.flow, r.x, r.z) : null;
        if (way) r.face = headingTo(way.x, way.z);
    }
}

/**
 * The officer's machine gun: one round along the unit direction `aim` ({x, y, z}) from the eye,
 * at twelve a second, the spread opening as the burst goes on. The first raider in the line of
 * fire takes it, where it lands deciding how badly; otherwise it marks the wall, the furniture,
 * the floor or the ceiling. Returns where it ended, or null if the gun was not ready.
 */
export function fire(state, nav, aim) {
    if (state.status !== 'active' || state.health <= 0) return null;
    if (![aim?.x, aim?.y, aim?.z].every(Number.isFinite)) throw new TypeError('Invalid aim.');
    const now = state.elapsed;
    if (now < state.mgReady) return null;
    state.mgReady = now + MG_INTERVAL;
    const heat = Math.min(1, (state.mgHeat += 0.06));
    const random = state.random;
    // Spread: a cone that widens with the burst, wider still on the move.
    const cone = (0.008 + heat * 0.035) * (state.player.moving ? 1.6 : 1);
    const yaw = Math.atan2(aim.x, aim.z) + (random() - 0.5) * 2 * cone;
    const flat = Math.hypot(aim.x, aim.z);
    const pitch = Math.atan2(aim.y, flat) + (random() - 0.5) * 2 * cone;
    const dx = Math.sin(yaw) * Math.cos(pitch), dy = Math.sin(pitch), dz = Math.cos(yaw) * Math.cos(pitch);
    const ox = state.player.x, oy = EYE - 0.08, oz = state.player.z;
    const wall = nav.ray(ox, oy, oz, dx, dy, dz, MG_REACH);
    // The nearest raider the round passes through before the wall: each is an upright cylinder.
    let hit = null, best = wall.t, bestY = 0;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal > 1e-4) {
        const reach = wall.t * horizontal;
        const ex = ox + dx / horizontal * reach, ez = oz + dz / horizontal * reach;
        for (const r of state.companions) {
            if (r.health <= 0) continue;
            const k = segmentCircle(ox, oz, ex, ez, r.x, r.z, BODY_RADIUS);
            if (k < 0) continue;
            // Where along the round's own path it enters the body, and how high it is there and at the middle.
            const t = k * reach / horizontal;
            const top = 1.82 + (r.y ?? 0);
            const yIn = oy + dy * t, yMid = oy + dy * (t + BODY_RADIUS / horizontal);
            const y = yIn > 0.05 && yIn < top ? yIn : yMid > 0.05 && yMid < top ? yMid : -1;
            if (y < 0 || t >= best) continue;
            best = t; hit = r; bestY = y;
        }
    }
    const end = { x: ox + dx * best, y: oy + dy * best, z: oz + dz * best };
    state.stats.fired++;
    state.shots.push({ x: ox + dx * 0.7, y: oy - 0.12 + dy * 0.7, z: oz + dz * 0.7, dx, dy, dz, t: 0, length: Math.max(0.5, best - 0.7), faction: 'police' });
    state.events.push({ type: 'gunshot', x: ox + dx * 0.6, z: oz + dz * 0.6, y: oy, energy: 70, human: true });
    alarm(state, nav, DIFFICULTIES[state.difficulty].hear);
    if (hit) {
        const zone = bestY > 1.5 ? 'head' : bestY > 0.85 ? 'torso' : 'limbs';
        const flatX = dx / (horizontal || 1), flatZ = dz / (horizontal || 1);
        hit.health = Math.max(0, hit.health - ZONE_DAMAGE[zone]);
        hit.stagger = Math.max(hit.stagger, zone === 'head' ? 0.6 : 0.4);
        hit.hitZone = zone; hit.hitAt = now; hit.hitPower = zone === 'limbs' ? 0.6 : 1;
        hit.ix = flatX; hit.iz = flatZ;
        knockback(hit, flatX * 0.7, flatZ * 0.7);
        hit.harm ??= createHarm();
        applyInjury(hit.harm, { zone, energy: 520 });
        state.stats.hits++;
        if (zone === 'head') state.stats.headshots++;
        state.events.push({ type: 'impact', x: end.x, z: end.z, y: bestY, material: 'body', energy: 90, zone, round: true, dx: flatX, dz: flatZ });
        // Being shot at tells them exactly where from.
        if (hit.health > 0) { hit.mode = 'fight'; hit.aware = 1; hit.lastX = ox; hit.lastZ = oz; hit.seenAt = now; }
        else down(state, hit, flatX, flatZ, zone);
    } else if (wall.hit) {
        state.events.push({ type: 'impact', x: wall.x, z: wall.z, y: wall.y, energy: 70, material: wall.hit === 'wall' ? 'marble' : 'wood',
            surface: wall.hit, spall: true, round: true, dx: wall.nx, dz: wall.nz });
    }
    return end;
}

/** One grenade toward the aim: it lands where the aim meets the floor or a wall, at most nine metres off. */
export function throwPlayerGrenade(state, nav, aim, kind = 'concussion') {
    if (state.status !== 'active' || state.health <= 0) return null;
    const smoke = kind === 'smoke';
    if (smoke ? !(state.playerSmoke > 0) : !(state.playerGrenades > 0)) return null;
    if (state.elapsed < state.grenadeReady) return null;
    const flat = Math.hypot(aim?.x ?? 0, aim?.z ?? 0);
    if (!(flat > 1e-6)) return null;
    // A lob, not a line: thrown a little above where the eye points, then it comes down.
    const up = Math.min(0.5, Math.max(-0.6, (aim.y ?? 0) + 0.12)), norm = Math.hypot(flat, up);
    const stop = nav.ray(state.player.x, EYE, state.player.z, aim.x / norm, up / norm, aim.z / norm, GRENADE_RANGE);
    const reach = Math.max(0.8, stop.t * flat / norm - (stop.hit === 'wall' ? 0.35 : 0));
    const to = nav.nearestWalkable(state.player.x + aim.x / flat * reach, state.player.z + aim.z / flat * reach, 6)
        ?? { x: state.player.x, z: state.player.z };
    if (smoke) state.playerSmoke--; else state.playerGrenades--;
    state.grenadeReady = state.elapsed + 1.0;
    const effect = { type: 'grenade', x: state.player.x, z: state.player.z, y: EYE - 0.2, life: GRENADE_FUSE, span: GRENADE_FUSE };
    state.grenades.push({ fromX: state.player.x, fromZ: state.player.z, x: state.player.x, z: state.player.z, toX: to.x, toZ: to.z, t: 0, fuse: GRENADE_FUSE, kind, effect });
    state.effects.push(effect);
    state.events.push({ type: 'throw', x: state.player.x, z: state.player.z, y: EYE - 0.2, energy: 12, human: true });
    return to;
}

function detonate(state, nav, g) {
    const x = g.toX, z = g.toZ;
    g.effect.life = 0;
    if (g.kind === 'smoke') {
        state.events.push({ type: 'smoke', x, z, y: 0.05, energy: 200, radius: SMOKE_RADIUS });
        state.effects.push({ type: 'smoke', x, z, r: SMOKE_RADIUS, life: SMOKE_LIFE, span: SMOKE_LIFE });
        return;
    }
    // Distance sets the pressure; a wall between takes most of it, so a blast stays in its room.
    const reach = (tx, tz) => {
        const fall = blastFalloff(Math.hypot(tx - x, tz - z), GRENADE_RADIUS);
        return fall > 0 ? fall * (nav.clearLine(x, z, tx, tz, 1.0) ? 1 : BLAST_SHADOW) : 0;
    };
    state.events.push({ type: 'grenade', x, z, y: 0.05, energy: GRENADE_BLAST, radius: GRENADE_RADIUS });
    state.effects.push({ type: 'grenadeBlast', x, z, life: 0.4, span: 0.4 });
    for (const r of state.companions) {
        if (r.health <= 0) continue;
        const fall = reach(r.x, r.z);
        if (fall <= 0) continue;
        const dx = r.x - x, dz = r.z - z, d = Math.hypot(dx, dz) || 1;
        knockback(r, dx / d * 6 * fall, dz / d * 6 * fall);
        if (fall >= LAUNCH_FALL) {
            // Close enough to be lifted off their feet: thrown, limp from that instant.
            r.vy = 2.2 + 4.2 * fall;
            r.spin = ((r.id * 37) % 7 - 3) * (0.4 + fall);
            r.killed = true;
            r.harm ??= createHarm();
            applyInjury(r.harm, { zone: 'torso', energy: 900 + 1400 * fall });
            down(state, r, dx / d, dz / d, 'torso');
            continue;
        }
        r.stun = Math.max(r.stun, 2.6 * fall + 0.6);
        r.stagger = Math.max(r.stagger, 1.2 * fall);
        r.health = Math.max(1, r.health - 9 * fall);
        if (r.mode === 'guard') { r.mode = 'hunt'; r.lastX = x; r.lastZ = z; r.searchUntil = state.elapsed + 9; }
    }
    alarm(state, nav, DIFFICULTIES[state.difficulty].hear + 1.5);
    const fall = reach(state.player.x, state.player.z);
    if (fall > 0 && state.health > 0) {
        const dx = state.player.x - x, dz = state.player.z - z, d = Math.hypot(dx, dz) || 1;
        knockback(state.player, dx / d * 6 * fall, dz / d * 6 * fall);
        hurt(state, 26 * fall, x, z);
        state.flashed = Math.max(state.flashed, 0.6 * fall);
    }
}

function hurt(state, amount, fromX, fromZ) {
    state.health = Math.max(0, state.health - amount);
    state.stats.taken += amount;
    state.damageFlash = Math.max(state.damageFlash, Math.min(0.7, 0.25 + amount / 40));
    state.hurtAt = state.elapsed;
    // Bearing of whoever did it, relative to straight ahead being set by the page's yaw.
    state.hitFrom = headingTo(fromX - state.player.x, fromZ - state.player.z);
}

/**
 * The second wave. Once the five rooms are clear there is a breath, then the rest come in one at
 * a time by the entry passage and go straight for the officer. Nobody appears in plain view:
 * while the officer is watching the way in from close by, the next one waits outside (not for
 * ever: after WAVE_HOLD seconds they come anyway).
 */
function stepWave(state, nav) {
    const room = state.rooms[state.rooms.length - 1];
    if (!room.wave || state.objective !== room.index || state.waveIn >= room.total) return;
    if (state.waveAt < 0) { state.waveAt = state.elapsed + WAVE_AFTER; return; }
    if (state.elapsed < state.waveAt) return;
    const p = state.player, door = nav.start;
    const watched = Math.hypot(p.x - door.x, p.z - door.z) < 4.5 && nav.clearLine(p.x, p.z, door.x, door.z, 1.4);
    if (watched && state.elapsed < state.waveAt + WAVE_HOLD) return;
    const id = RAIDER_IDS[state.nextId++ % RAIDER_IDS.length];
    const heading = headingTo(p.x - door.x, p.z - door.z);
    state.companions.push({
        id, room: room.index, x: door.x, z: door.z, homeX: door.x, homeZ: door.z, mass: 62 + id * 13 % 30,
        vx: 0, vz: 0, kx: 0, kz: 0, y: 0, vy: 0, spin: 0,
        health: RAIDER_HEALTH, heading, face: heading, moving: false, attacking: 0, stagger: 0, stun: 0,
        temperament: 'pusher', morale: 1, retreating: false, filming: false, chanting: false, crowding: 0, sprayed: 0,
        // They know where the shooting was: hunting from the first step, and they do not give it up.
        mode: 'hunt', relentless: true, aware: 0.6, seenAt: -99, lastX: p.x, lastZ: p.z, cooldown: 0.6 + state.random() * 0.5, burst: 0,
        stepAt: 0, goX: door.x, goZ: door.z, lookPhase: state.random() * 6.28, searchUntil: Infinity,
    });
    state.waveIn++;
    state.waveAt = state.elapsed + WAVE_EVERY;
}

/** One raider's round at the officer: it hits by chance (range, movement, their own state) or cracks past. */
function raiderShot(state, nav, r, difficulty) {
    const random = state.random;
    const px = state.player.x, pz = state.player.z;
    const dx = px - r.x, dz = pz - r.z, d = Math.hypot(dx, dz) || 1;
    r.attacking = 0.2; r.tool = 'gun';
    const chance = difficulty.hit * Math.max(0.35, Math.min(1, 1.25 - d / 13))
        * (state.player.moving ? 0.72 : 1) * (r.stagger > 0 ? 0.3 : 1) * (r.health < RAIDER_HEALTH * 0.4 ? 0.7 : 1);
    const hits = random() < chance;
    // A miss goes wide of the head by a hand or an arm's length; a hit is on the chest.
    const wide = hits ? 0 : (0.25 + random() * 0.6) * (random() < 0.5 ? -1 : 1);
    const tx = px + (-dz / d) * wide, tz = pz + (dx / d) * wide, ty = hits ? 1.25 : 1.2 + random() * 0.6;
    const ox = r.x + dx / d * 0.5, oy = 1.38, oz = r.z + dz / d * 0.5;
    const lx = tx - ox, ly = ty - oy, lz = tz - oz, length = Math.hypot(lx, ly, lz) || 1;
    const ux = lx / length, uy = ly / length, uz = lz / length;
    const stop = hits ? { t: length, hit: '' } : nav.ray(ox, oy, oz, ux, uy, uz, 24);
    state.shots.push({ x: ox, y: oy, z: oz, dx: ux, dy: uy, dz: uz, t: 0, length: stop.t, faction: 'raider' });
    state.events.push({ type: 'gunshot', x: ox, z: oz, y: oy, energy: 70 });
    if (hits) {
        hurt(state, difficulty.damage, r.x, r.z);
        state.events.push({ type: 'impact', x: px, z: pz, y: 1.2, material: 'body', energy: 110, zone: 'torso', human: true });
    } else {
        state.suppression = Math.min(1, state.suppression + 0.22);
        state.events.push({ type: 'whiz', x: tx, z: tz, y: ty, dx: ux, dz: uz, human: true });
        if (stop.hit) state.events.push({ type: 'impact', x: stop.x, z: stop.z, y: stop.y, energy: 70, material: stop.hit === 'wall' ? 'marble' : 'wood',
            surface: stop.hit, spall: true, round: true, dx: stop.nx, dz: stop.nz });
    }
}

/** A spot within a step or two of a raider that still has the officer in view: where they shift to between bursts. */
function sidestep(state, nav, r) {
    const random = state.random;
    for (let tries = 0; tries < 6; tries++) {
        const angle = random() * Math.PI * 2, reach = 0.6 + random() * 1.1;
        const x = r.x + Math.cos(angle) * reach, z = r.z + Math.sin(angle) * reach;
        if (!nav.walkable(x, z) || !nav.clearLine(r.x, r.z, x, z, 0.4)) continue;
        if (Math.hypot(x - state.player.x, z - state.player.z) < 1.6) continue;
        if (nav.clearLine(x, z, state.player.x, state.player.z, 1.4)) { r.goX = x; r.goZ = z; return; }
    }
    r.goX = r.x; r.goZ = r.z;
}

function stepRaider(state, nav, r, difficulty, dt) {
    const now = state.elapsed, random = state.random;
    const px = state.player.x, pz = state.player.z;
    r.cooldown = Math.max(0, r.cooldown - dt);
    r.attacking = Math.max(0, r.attacking - dt);
    r.stagger = Math.max(0, r.stagger - dt);
    r.stun = Math.max(0, r.stun - dt);
    // Knocked about by a round or a blast: friction takes it off, walls stop it.
    if (r.kx || r.kz) { nav.move(r, r.kx * dt, r.kz * dt); slide(r, dt); }
    r.moving = false;
    if (r.stun > 0) return;

    const dx = px - r.x, dz = pz - r.z, d = Math.hypot(dx, dz) || 1;
    const bearing = headingTo(dx, dz);
    const inView = Math.abs(Math.atan2(Math.sin(bearing - r.heading), Math.cos(bearing - r.heading))) < 1.25;
    const visible = state.health > 0 && sees(state, nav, r.x, r.z, px, pz) && (r.mode !== 'guard' || inView || d < 2.2);
    if (visible) {
        // Noticing takes a moment, less of one close up; once it has happened they do not forget.
        r.aware = Math.min(1, r.aware + dt / (difficulty.react * (r.mode === 'guard' ? 1 : 0.4)) * (d < 3 ? 1.6 : 1));
        r.lastX = px; r.lastZ = pz; r.seenAt = now;
        if (r.aware >= 1 && r.mode !== 'fight') { r.mode = 'fight'; r.cooldown = Math.max(r.cooldown, 0.15 + random() * 0.25); r.burst = 0; }
    } else if (r.mode === 'guard') r.aware = Math.max(0, r.aware - dt * 0.5);

    let speed = 0, wantX = 0, wantZ = 0;
    if (r.mode === 'guard') {
        // Watching the way in, the head and shoulders turning a little either side of it.
        r.heading = turnToward(r.heading, r.face + Math.sin(now * 0.45 + r.lookPhase) * 0.7, dt * 1.4);
        return;
    }
    if (r.mode === 'fight') {
        r.heading = turnToward(r.heading, headingTo(r.lastX - r.x, r.lastZ - r.z), dt * 7);
        if (!visible && now - r.seenAt > 1.4) { r.mode = 'hunt'; r.searchUntil = r.relentless ? Infinity : now + 10; }
        if (visible && r.cooldown <= 0 && r.stagger <= 0) {
            if (r.burst <= 0) r.burst = 2 + Math.floor(random() * 3);
            raiderShot(state, nav, r, difficulty);
            r.burst--;
            // A burst, then a breath; they shift their feet while they take it.
            if (r.burst > 0) r.cooldown = 0.14 + random() * 0.08;
            else { r.cooldown = difficulty.rest[0] + random() * (difficulty.rest[1] - difficulty.rest[0]); sidestep(state, nav, r); }
        }
        const gx = r.goX - r.x, gz = r.goZ - r.z, gap = Math.hypot(gx, gz);
        if (gap > 0.12 && r.burst <= 0) { wantX = gx / gap; wantZ = gz / gap; speed = 1.7; }
    } else {
        // Hunting: across the floor toward the shooting and the footsteps, until they see who it is
        // (which is `fight`) or give it up and hold wherever they have got to.
        const step = state.flow ? nav.downhill(state.flow, r.x, r.z) : null;
        if (step && d > 1.8) { wantX = step.x; wantZ = step.z; speed = 2.5; }
        else r.heading += dt * 1.6;
        if (now > r.searchUntil) { r.mode = 'guard'; r.face = r.heading; r.aware = 0.4; }
    }
    if (speed > 0) {
        // Keep out of each other's way: nobody stands in the same doorway.
        for (const other of state.companions) {
            if (other === r || other.health <= 0) continue;
            const ox = r.x - other.x, oz = r.z - other.z, gap = Math.hypot(ox, oz);
            if (gap > 0.01 && gap < 0.75) { wantX += ox / gap * (0.75 - gap) * 2.5; wantZ += oz / gap * (0.75 - gap) * 2.5; }
        }
        const length = Math.hypot(wantX, wantZ) || 1;
        const slow = r.stagger > 0 ? 0.35 : 1;
        const before = { x: r.x, z: r.z };
        nav.move(r, wantX / length * speed * slow * dt, wantZ / length * speed * slow * dt);
        r.moving = Math.hypot(r.x - before.x, r.z - before.z) > speed * dt * 0.3;
        if (r.mode === 'hunt' && r.moving) r.heading = turnToward(r.heading, headingTo(wantX, wantZ), dt * 8);
    }
}

/**
 * One step of the attempt. `input` is where the officer wants to go: { x, z } in the world
 * (already turned by where they face), and `sprint`.
 */
export function advance(state, nav, input, seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Invalid time step.');
    const ix = input?.x ?? 0, iz = input?.z ?? 0;
    if (!Number.isFinite(ix) || !Number.isFinite(iz)) throw new TypeError('Invalid movement input.');
    if (state.status !== 'active') return;
    const dt = Math.min(seconds, 0.05);
    const difficulty = DIFFICULTIES[state.difficulty];
    state.events.length = 0;
    state.elapsed += dt;
    state.damageFlash = Math.max(0, state.damageFlash - dt);
    state.flashed = Math.max(0, state.flashed - dt * 0.5);
    state.suppression = Math.max(0, state.suppression - dt * 0.45);
    state.mgHeat = Math.max(0, state.mgHeat - dt * 0.9);

    // The officer: eased toward the speed asked for, stopped and slid by the walls.
    const p = state.player;
    if (state.health > 0) {
        const length = Math.hypot(ix, iz), top = input?.sprint ? SPRINT : WALK;
        const tx = length > 0.05 ? ix / Math.max(1, length) * top : 0, tz = length > 0.05 ? iz / Math.max(1, length) * top : 0;
        const ease = 1 - Math.exp(-dt * 12);
        p.vx += (tx - p.vx) * ease; p.vz += (tz - p.vz) * ease;
        const before = { x: p.x, z: p.z };
        nav.move(p, (p.vx + p.kx) * dt, (p.vz + p.kz) * dt);
        slide(p, dt);
        // Nobody stands inside anybody: a raider the officer walks into gives way, and if the wall
        // behind them will not let them, the officer is the one held off.
        for (const r of state.companions) {
            if (r.health <= 0) continue;
            const ox = r.x - p.x, oz = r.z - p.z, gap = Math.hypot(ox, oz);
            if (gap >= PERSONAL || gap < 1e-4) continue;
            const push = PERSONAL - gap, rx = r.x, rz = r.z;
            nav.move(r, ox / gap * push, oz / gap * push);
            const moved = Math.hypot(r.x - rx, r.z - rz);
            if (moved < push * 0.9) nav.move(p, -ox / gap * (push - moved), -oz / gap * (push - moved));
        }
        p.moving = Math.hypot(p.x - before.x, p.z - before.z) > 0.6 * dt;
        if (state.health < difficulty.regenTo && state.elapsed - state.hurtAt > difficulty.regenAfter) {
            state.health = Math.min(difficulty.regenTo, state.health + difficulty.regen * dt);
        }
    }

    if (state.elapsed - state.flowAt > 0.3) {
        state.flowAt = state.elapsed;
        // The way to the officer from anywhere on the floor: who hears a shot, and how hunters walk.
        state.flow = nav.field(p.x, p.z, state.flow ?? undefined);
    }
    stepWave(state, nav);
    for (const r of state.companions) {
        if (r.health > 0) stepRaider(state, nav, r, difficulty, dt);
        else if (r.kx || r.kz) { nav.move(r, r.kx * dt, r.kz * dt); slide(r, dt); }
        // Thrown by a blast: up, over and down again.
        if (r.vy || r.y > 0) {
            r.y += r.vy * dt; r.vy -= 9.8 * dt;
            if (r.y <= 0) { r.y = 0; r.vy = 0; state.events.push({ type: 'down', x: r.x, z: r.z, y: 0.05, energy: 60, material: 'body' }); }
        }
    }

    for (let i = state.grenades.length - 1; i >= 0; i--) {
        const g = state.grenades[i];
        g.t += dt;
        const k = Math.min(1, g.t / g.fuse);
        g.x = g.fromX + (g.toX - g.fromX) * k; g.z = g.fromZ + (g.toZ - g.fromZ) * k;
        g.effect.x = g.x; g.effect.z = g.z;
        // Thrown from the hand, down to the floor, with a lob's rise in between.
        g.effect.y = (EYE - 0.2) * (1 - k) + 0.08 * k + Math.min(CEILING - EYE - 0.2, 0.9) * 4 * k * (1 - k);
        if (g.t < g.fuse) continue;
        state.grenades.splice(i, 1);
        detonate(state, nav, g);
    }
    for (const effect of state.effects) effect.life -= dt;
    state.effects = state.effects.filter(e => e.life > 0);
    for (const shot of state.shots) shot.t += 140 * dt;
    state.shots = state.shots.filter(s => s.t < s.length);

    if (state.health <= 0) { state.status = 'failed'; state.outcome = 'down'; }
    else if (state.endAt >= 0 && state.elapsed >= state.endAt) { state.status = 'completed'; state.outcome = 'cleared'; }
}

/** What the end card and the HUD show, as plain numbers. */
export function summary(state) {
    const s = state.stats;
    return {
        seconds: Math.round(state.elapsed), rooms: Math.min(state.milestone, state.rooms.length - 1), roomsTotal: state.rooms.length - 1,
        down: s.down, raiders: state.total, fired: s.fired, hits: s.hits, headshots: s.headshots,
        accuracy: s.fired ? Math.round(100 * s.hits / s.fired) : 0, taken: Math.round(s.taken), health: Math.round(state.health),
    };
}
