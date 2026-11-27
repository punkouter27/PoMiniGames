// pocapitol/house/autopilot.js — the officer who plays the House map's demo.
//
// The demo is the same game with nobody at the controls: this decides, every frame, where the
// officer looks, where they walk and whether they fire, from what a player could see. It walks
// to the nearest raider across the floor (nav.js), turns to anyone in view the way a hand on a
// mouse does (a limited turn rate, a moment's reaction, an aim that is never quite still),
// holds its fire until the muzzle is on them, lobs a grenade at a group, and backs off behind
// the last corner when it is badly hurt. Between the rooms and the second wave it goes and
// watches the way in. No page, no picture: it runs in Node beside world.js.

import { EYE } from './nav.js';

const TURN = 5.2;               // rad/s the aim can swing
const REACT = 0.22;             // s between seeing someone and starting to turn on them
const ON_TARGET = 0.07;         // rad: nearer the aim point than this, the trigger is held
const SEE = 11;                 // m

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * @param nav  createNav()
 * @returns {{ step(state, dt): { yaw:number, pitch:number, x:number, z:number, sprint:boolean, fire:boolean, lob:string|null } , reset() }}
 */
export function createAutopilot(nav) {
    let yaw = nav.start.yaw, pitch = 0, target = null, sawAt = 0, field = null, fieldAt = -1, fieldFor = null, lobAt = -99, clock = 0;

    function reset() { yaw = nav.start.yaw; pitch = 0; target = null; sawAt = 0; fieldAt = -1; fieldFor = null; lobAt = -99; clock = 0; }

    /** Walk toward (x, z) over the floor; null once there (within `near` metres of walking). */
    function toward(state, x, z, near) {
        if (state.elapsed - fieldAt > 0.35 || fieldFor?.x !== x || fieldFor?.z !== z) {
            field = nav.field(x, z, field ?? undefined); fieldAt = state.elapsed; fieldFor = { x, z };
        }
        if (nav.walkDistance(field, state.player.x, state.player.z) <= near) return null;
        return nav.downhill(field, state.player.x, state.player.z);
    }

    function step(state, dt) {
        clock += dt;
        const p = state.player;
        const alive = state.companions.filter(r => r.health > 0);
        const inView = alive
            .map(r => ({ r, d: Math.hypot(r.x - p.x, r.z - p.z) }))
            .filter(v => v.d < SEE && nav.clearLine(p.x, p.z, v.r.x, v.r.z, 1.4))
            .sort((a, b) => a.d - b.d);
        // Keep on whoever is being shot at until they drop or are lost; otherwise take the nearest.
        const still = target && inView.find(v => v.r === target);
        const seen = still ?? inView[0] ?? null;
        if (seen && seen.r !== target) sawAt = clock;
        target = seen?.r ?? null;

        let wantYaw = yaw, wantPitch = 0, x = 0, z = 0, fire = false, lob = null, sprint = false;
        if (seen && clock - sawAt >= REACT) {
            const dx = seen.r.x - p.x, dz = seen.r.z - p.z;
            // A hand's aim: at the chest, wandering a little, worse on the first shots.
            const wander = Math.sin(clock * 5.3) * 0.022 + Math.sin(clock * 11.7) * 0.012;
            wantYaw = Math.atan2(-dx, -dz) + wander;
            wantPitch = Math.atan2(1.22 + (seen.r.y ?? 0) - (EYE - 0.08), seen.d) + wander * 0.4;
            fire = Math.abs(wrap(wantYaw - yaw)) < ON_TARGET && Math.abs(wantPitch - pitch) < ON_TARGET;
            // Three or more in view, at a throwing distance: a grenade first.
            if (inView.length >= 3 && seen.d > 3.2 && seen.d < 8 && state.playerGrenades > 0 && state.elapsed - lobAt > 5) { lob = 'concussion'; lobAt = state.elapsed; }
            // Badly hurt and under fire: give ground the way they came, still facing them.
            if (state.health < 30 && state.elapsed - state.hurtAt < 1.2) {
                const back = toward(state, nav.start.x, nav.start.z, 0.6);
                if (back) { x = back.x; z = back.z; }
            } else if (seen.d > 6.5) {
                // Too far to be sure of: close in a little.
                const d = seen.d || 1;
                x = dx / d * 0.6; z = dz / d * 0.6;
            }
        } else if (!seen) {
            // Nobody in view: go and find the nearest, or (rooms clear, wave not in yet) watch the entry.
            const next = alive.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
            const way = next ? toward(state, next.x, next.z, 0.8) : toward(state, nav.entry.x, nav.entry.z, 5.5);
            if (way) {
                x = way.x; z = way.z;
                wantYaw = Math.atan2(-way.x, -way.z);
                sprint = !next;
            } else if (!next) {
                wantYaw = Math.atan2(-(nav.entry.x - p.x), -(nav.entry.z - p.z)) + Math.sin(clock * 0.7) * 0.5;
            }
        }
        yaw += Math.max(-TURN * dt, Math.min(TURN * dt, wrap(wantYaw - yaw)));
        pitch += Math.max(-TURN * dt, Math.min(TURN * dt, wantPitch - pitch));
        return { yaw, pitch, x, z, sprint, fire, lob };
    }

    return { step, reset };
}
