// pocabinet/physics.js
//
// Arcade car physics + AI for PoCabinet: speed along heading, a lateral-grip cap
// (understeer past it), grass run-off with extra drag, and a barrier that strips
// the outward velocity component.
//
// Contacts are between car-shaped hulls, not circles: a capsule 39 long
// and 17 wide, the body cars.js draws. A hit is an impulse along the contact normal
// (equal masses, a little restitution) applied where the hulls touch, so it shoves a
// car sideways (`slip`) and turns it (`spin`) as well as changing its speed; the tyres
// then bleed both off in step(). A tap on a rear corner turns a car, a T-bone slides it.
//
// Damage is part of the sim (hurt()): every barrier hit and every contact harder than a
// nudge costs the car structure, engine and alignment, by how hard it closed and where on
// the body it landed. A bent car pulls to one side, has less lock, power, top speed and
// grip; a car whose structure or engine is gone is wrecked: the engine dies and it has just
// enough limp left to get off the racing line (wreckControls()), then it stops for good.
// Being state in the body, it is in the lap proof and the server's sim for free.
//
// MIRROR CONTRACT: step / hurt / advanceDistance / hullContact / resolveContacts / gridSlot /
// soloField / aiControls / wreckControls are line-for-line ports of PoCabinetPhysics.cs,
// PoCabinetAiDriver.cs and PoCabinetPersonality.SoloField, with the same constants in
// the same order of operations. Solo races run this copy. All trig is track.js's own
// sin / cos / atan2 (never Math.*), so the two copies agree to the last bit and a lap
// proof replays as the same race on the server.
// Multiplayer runs the C# copy on the server while this copy predicts the local
// car and replays unacknowledged inputs on top of every snapshot — if the two
// drift apart, each correction becomes a visible snap.
//
// Hills and banking are physics too: gravity along the road's grade speeds a car downhill
// and slows it uphill (with drag past top speed so a descent tops out), a banked turn holds
// it in, and braking takes grip from cornering (a friction circle).
//
// Frame: forward is (cos h, sin h); the right-hand side is (-sin h, cos h); steer
// +1 turns right (heading increases). The scene maps sim (x, y) → world (x/10, y/10)
// on the ground plane, which makes "right" on screen and "right" here agree. The
// old practice ticker had this backwards (left key turned right).

import { wrapAngle, sin, cos, atan2 } from './track.js';

export const TICK_SECONDS = 1 / 30;
export const MAX_SPEED = 140;
export const KMH_PER_UNIT = 2.0;
const ACCEL = 55;
const BRAKE_DECEL = 130;
const COAST_DECEL = 14;
const REVERSE_ACCEL = 25;
const REVERSE_MAX = 18;
const STEER_RATE = 2.3;
const STEER_FULL_SPEED = 18;
export const GRIP_ACCEL = 105;
const SCRUB_DECEL = 30;
const GRASS_DECEL = 50;
const GRASS_GRIP = 0.6;
export const RUN_OFF = 26;
export const CAR_RADIUS = 14;
const WALL_RESTITUTION = 0.25;
const WALL_FRICTION = 0.85;
const CONTACT_SPEED_FLOOR = REVERSE_MAX * 1.5;
/** Hull: a spine of ±HULL_HALF along the heading, HULL_RADIUS thick (39 x 17 overall). */
const HULL_HALF = 11;
const HULL_RADIUS = 8.5;
const CONTACT_RESTITUTION = 0.2;
/** Yaw inertia over mass: the square of a 39 x 17 body's radius of gyration. */
const YAW_INERTIA = 150;
const SLIP_DECEL = 120;
const SPIN_DECEL = 5;
const MAX_SLIP = 60;
const MAX_SPIN = 2.5;
const SLIP_SLIDING = 8;
/** Cars further apart than this along the road never touch: where the Playground run
 *  crosses over itself they are on different levels. */
const SAME_ROAD = 120;
/** Damage (hurt()): closing speed a body shrugs off, and the square of the excess over it that
 *  takes all of a car's structure (a square hit on the barrier at about 110 u/s). */
const DAMAGE_FLOOR = 12;
const DAMAGE_SCALE = 9500;
/** Engine share of a hit on the nose (radiator, engine bay) and of one anywhere else. */
const ENGINE_NOSE = 1.25;
const ENGINE_OTHER = 0.3;
/** Misalignment from a hit on a front corner and from one further back. */
const PULL_NOSE = 2.2;
const PULL_OTHER = 0.6;
/** What full damage costs: engine power and top speed (engine), grip (structure), lock and a
 *  steady pull on the wheel (alignment). */
const POWER_LOSS = 0.5;
const TOP_LOSS = 0.2;
const GRIP_LOSS = 0.2;
const LOCK_LOSS = 0.3;
const PULL_STEER = 0.14;
/** A wrecked car limps at no more than this, and only until it is this far off the tarmac. */
const LIMP_SPEED = 14;
const LIMP_THROTTLE = 0.5;
const WRECK_CLEAR = 16;
/** Hills (track.grade): gravity along the road, arcade-strong so a descent is felt (u/s² per
 *  unit of grade), and the drag that takes back speed past a car's top speed, so a long
 *  descent tops out instead of running away (per second of overspeed). */
const SLOPE_GRAVITY = 60;
const OVERSPEED_DRAG = 1.2;
/** A banked turn holds a car in (+ this share of grip per unit of bank turning into it), an
 *  off-camber one lets it go (down to −half that). */
const BANK_GRIP = 0.6;
/** The friction circle: the brakes take this share of the cornering grip at full pressure,
 *  so braking hard into a corner washes the nose wide. */
const TRAIL_LOSS = 0.25;
/** AI: how far over its own pace a car lets a descent carry it before it brakes for it. */
const RUN_ON = 30;
/**
 * What a car is on (body.surface, set at the end of every step from where it ended up, read by
 * the next one): the road, an apex kerb (flat or raised), or the run-off past the edge.
 * Gravel beaches a car fast; tarmac run-off costs nothing but the lap; a raised kerb scrubs
 * speed and throws the car sideways (out, away from the apex). Gravel and tarmac run-off
 * are deeper than grass: the barrier stands RUN_OFF_WIDE out there.
 */
const SURF_ROAD = 0;
export const SURF_KERB = 1, SURF_SAUSAGE = 2, SURF_GRASS = 3, SURF_GRAVEL = 4, SURF_RUNOFF = 5;
const RUN_OFF_WIDE = 40;
/** How far an apex kerb reaches onto the tarmac, and out past the edge line (sim units). */
export const KERB_INNER = 5;
export const KERB_OUTER = 12;
const KERB_GRIP = 0.97;
const KERB_WET_GRIP = 0.8;
const SAUSAGE_GRIP = 0.85;
const SAUSAGE_SCRUB = 45;
const SAUSAGE_KICK = 1.1;
const GRAVEL_GRIP = 0.45;
const GRAVEL_DECEL = 95;
/** AI: how far ahead it starts picking its side of a road divider, and how wide it keeps of it. */
const ISLAND_LOOK = 320;
const ISLAND_CLEAR = 14;
/** AI following: the gap it keeps to the car ahead (centres; hulls touch at 39) and the braking it plans on. */
const FOLLOW_GAP = 44;
const FOLLOW_DECEL = 80;
/** How far up the road the AI looks for traffic. */
const AI_RANGE = 170;
/** AI braking points: the deceleration a driver plans on, from a cautious one's to (+ the late
 *  share) a late braker's. Well under BRAKE_DECEL, which is what a stamp on the pedal gives. */
const AI_BRAKE_PLAN = 60;
const AI_BRAKE_PLAN_LATE = 40;
/** The step its braking-curve scan takes up the road (the track's curvature sample step). */
const AI_CURVE_STEP = 8;
/** AI racing line: how much of the track's racing line a driver follows, and how far (a share of
 *  the half width) its own lateralOffset sets it off that line, so a hundred cars are not all
 *  on one line (the whole line packed the field onto the apexes and into each other). */
const LINE_WEIGHT = 0.6;
const LINE_BIAS = 0.5;
/** AI in a bent car: the share of its pace it gives up at full structural damage (on top of
 *  planning its corners on the grip it has left). */
const DAMAGE_PACE = 0.05;
/** Blue flags: how far behind it watches for a car coming to lap it, how close to its own lane
 *  that car must be, how much quicker along the road, how far over it eases each tick (a share
 *  of the half width) and how much it lifts to let the leader by. */
const BLUE_LOOK = 80;
const BLUE_LANE = 30;
const BLUE_CLOSING = 3;
const BLUE_STEP = 0.1;
const BLUE_LIFT = 0.95;
/** Aim error (radians) past which a car rolling forward is pointing the wrong way down the road. */
const WRONG_WAY = 2;
const GRID_COLUMN = 22;
const GRID_ROW = 50;
/** Solo and demo races: 63 rivals and the player (PoCabinetCatalog.SoloCarCount - 1). */
const SOLO_RIVALS = 63;
/** The player's grid slot in a solo race: mid-pack, quicker cars ahead and slower behind.
 *  Rival i of soloField() takes slot i, or i + 1 from here back. */
export const PLAYER_SLOT = 32;

/** A driver's lapses are drawn once per stretch of road this long, and last this far into it (see lapse()). */
const LAPSE_STRETCH = 380;
const LAPSE_LENGTH = 170;

/**
 * The four officials, in the server's roster order (PoCabinetPersonality.Roster). A persona
 * is how a car is driven: the line it holds (lateralOffset), how early it turns in
 * (lookahead), how late and how hard it brakes (brakingAggression), how it insists on its
 * line in traffic (collisionTolerance), whether it tucks in behind a car (draftingAffinity),
 * how often it overcooks a corner and runs off the road (wildness; seed keys the draws), how
 * it treats the car in front and beside it (aggression: a bruiser follows close enough to
 * bump and turns in on a car alongside) and how hard it saws at the wheel (twitch).
 */
export const OFFICIALS = Object.freeze([
    { id: 'sean-s', name: 'Sean S.', color: '#3470d8', maxSpeed: MAX_SPEED * 0.93, corneringSkill: 0.62,
      persona: { lookahead: 25, lateralOffset: -0.95, brakingAggression: 0.95, collisionTolerance: 0.2, draftingAffinity: 0.1, wildness: 0.14, aggression: 0.55, twitch: 0.85, seed: 201 } },
    { id: 'steve-b', name: 'Steve B.', color: '#5e4b8b', maxSpeed: MAX_SPEED * 0.95, corneringSkill: 0.55,
      persona: { lookahead: 45, lateralOffset: 0.85, brakingAggression: 0.20, collisionTolerance: 0.6, draftingAffinity: 0.2, wildness: 0.05, aggression: 0.1, twitch: 0.3, seed: 202 } },
    { id: 'bill-b', name: 'Bill B.', color: '#a02c2c', maxSpeed: MAX_SPEED * 0.91, corneringSkill: 0.70,
      persona: { lookahead: 100, lateralOffset: 0.0, brakingAggression: 0.50, collisionTolerance: 0.9, draftingAffinity: 0.0, wildness: 0.03, aggression: 0.35, twitch: 0.1, seed: 203 } },
    { id: 'mike-p', name: 'Mike P.', color: '#1c8054', maxSpeed: MAX_SPEED * 0.96, corneringSkill: 0.60,
      persona: { lookahead: 130, lateralOffset: -0.50, brakingAggression: 0.40, collisionTolerance: 0.3, draftingAffinity: 0.95, wildness: 0.08, aggression: 0.85, twitch: 0.45, seed: 204 } },
]);

const FIELD_FIRST = ['Dana', 'Kyle', 'Priya', 'Omar', 'Lena', 'Marcus', 'Ines', 'Tobias', 'Yuki', 'Carla',
    'Dmitri', 'Aisha', 'Hank', 'Noor', 'Felix', 'Greta', 'Ravi', 'Sofia', 'Walt'];
const FIELD_LAST = ['K.', 'R.', 'D.', 'W.', 'M.'];

/**
 * The 63 rivals of a solo race in grid order: the four officials, then 59 field racers
 * from the quickest to the slowest. Qualifying order on purpose: a grid sorted any other
 * way has to overtake itself, and a hundred cars doing that on a 27-second lap is a
 * traffic jam, not a race. A field racer's pace comes from its index; so does its
 * personality, every trait from a byte of its own (three hashes of the index), so no two
 * cars drive alike and no trait follows from another. Every one of them has some wildness:
 * the whole field runs off the road now and then, the liabilities a lot.
 * Mirrors PoCabinetPersonality.SoloField (which carries no names or colours: the server
 * only re-runs the physics).
 */
export function soloField() {
    const field = OFFICIALS.slice();
    const n = SOLO_RIVALS - OFFICIALS.length;
    for (let i = 0; i < n; i++) {
        const h = Math.imul(i + 1, 0x9E3779B1) >>> 0;
        const g = Math.imul(i + 1, 0x85EBCA6B) >>> 0;
        const a = (h & 0xff) / 255, b = ((h >>> 8) & 0xff) / 255, c = ((h >>> 16) & 0xff) / 255, d = (h >>> 24) / 255;
        const e = (g & 0xff) / 255, f = ((g >>> 8) & 0xff) / 255, k = ((g >>> 16) & 0xff) / 255, m = (g >>> 24) / 255;
        const q = Math.imul(i + 1, 0xC2B2AE35) >>> 0;
        const r = (q & 0xff) / 255, t = ((q >>> 8) & 0xff) / 255;
        const pace = 1 - i / (n - 1);
        field.push({
            // The surname rotates with the first name too: by i / 19 alone, the 19 quickest (the
            // front of the grid, the timing tower) were all "K.". Still 59 distinct names.
            id: 'field', name: `${FIELD_FIRST[i % FIELD_FIRST.length]} ${FIELD_LAST[(i % FIELD_FIRST.length + Math.floor(i / FIELD_FIRST.length)) % FIELD_LAST.length]}`,
            color: `hsl(${Math.round(d * 360)}, ${55 + Math.round(a * 35)}%, ${32 + Math.round(b * 30)}%)`,
            maxSpeed: MAX_SPEED * (0.7 + 0.2 * pace + 0.03 * a),
            corneringSkill: 0.25 + 0.35 * pace + 0.08 * b,
            persona: {
                lookahead: 30 + 90 * c, lateralOffset: -0.9 + 1.8 * d, brakingAggression: 0.05 + 0.9 * e,
                collisionTolerance: 0.1 + 0.8 * k, draftingAffinity: 0.7 * m,
                // Everyone runs wide now and then; a few are a liability.
                wildness: 0.05 + 0.2 * f * f, aggression: r, twitch: t, seed: i + 1,
            },
        });
    }
    return field;
}

/**
 * The one word a driver's personality comes down to, for the standings and the HUD: its
 * most extreme trait. Display only; nothing in the sim reads it.
 */
export function archetype(p) {
    if (!p) return '';
    if (p.aggression >= 0.8) return 'Bruiser';
    if (p.wildness >= 0.17) return 'Wild card';
    if (p.brakingAggression >= 0.85) return 'Late braker';
    if (p.draftingAffinity >= 0.55) return 'Slipstreamer';
    if (p.twitch >= 0.85) return 'Twitchy';
    if (p.collisionTolerance >= 0.8) return 'Line holder';
    if (p.brakingAggression <= 0.15) return 'Cautious';
    if (p.twitch <= 0.15) return 'Smooth';
    if (p.lookahead >= 100) return 'Tactician';
    return 'Journeyman';
}

/**
 * A driver's lapse: 0 while it is driving properly, else how far over the limit it thinks
 * the grip goes (1.5 to 2.4 times), signed by the side of the road it is about to leave
 * (+ = right). While it lasts the car misses its line, runs wide onto the run-off on that
 * side and carries too much speed into whatever corner is next; then it gathers it up.
 * One draw per LAPSE_STRETCH of race distance, live for the first LAPSE_LENGTH of it and
 * never off the grid: a pure hash of the driver's seed and the stretch. No state, no RNG,
 * integer and exact double arithmetic only, so the lap verifier draws the same lapses.
 * Mirrors PoCabinetAiDriver.Lapse.
 */
function lapse(persona, distance) {
    if (!(persona.wildness > 0) || distance < LAPSE_STRETCH) return 0;
    const at = distance + persona.seed * 53;
    const stretch = Math.floor(at / LAPSE_STRETCH);
    if (at - stretch * LAPSE_STRETCH > LAPSE_LENGTH) return 0;
    let h = Math.imul(stretch ^ Math.imul(persona.seed, 0x9E3779B1), 0x85EBCA6B);
    h ^= h >>> 13;
    h = Math.imul(h, 0xC2B2AE35);
    h = (h ^ (h >>> 16)) >>> 0;
    if ((h & 0xffff) / 65535 >= persona.wildness) return 0;
    const over = 1.5 + ((h >>> 16) & 0xff) / 255 * 0.9;
    return h >>> 31 ? over : -over;
}

/** Neutral line used by the demo autopilot and for finished cars' cool-down lap. */
export const AUTOPILOT = Object.freeze({ lookahead: 100, lateralOffset: 0, brakingAggression: 0.5, collisionTolerance: 0.9, draftingAffinity: 0, aggression: 0, twitch: 0.375 });

/** The barrier's distance from the centerline on the track's nominal width (feel and audio only; the physics uses wallAt). */
export function wallLateral(track) {
    return track.halfWidth + RUN_OFF - CAR_RADIUS * 0.5;
}

/** How deep the run-off is at sample `i` on `side` (+1 right). Mirrors PoCabinetPhysics.RunOffAt. */
export function runOffAt(track, i, side) {
    return track.runoffAt(i, side) === 0 ? RUN_OFF : RUN_OFF_WIDE;
}

/** Where a car's centre meets the barrier at sample `i` on `side`. Mirrors PoCabinetPhysics.WallAt. */
export function wallAt(track, i, side) {
    return track.hwAt(i) + runOffAt(track, i, side) - CAR_RADIUS * 0.5;
}

/** What a car `lateral` off the centerline at sample `i` is on (SURF_*). Mirrors PoCabinetPhysics.SurfaceAt. */
export function surfaceAt(track, i, lateral) {
    const hw = track.hwAt(i);
    const l = Math.abs(lateral);
    const s = lateral > 0 ? 1 : -1;
    const k = track.kerbs[i];
    if (k !== 0 && (k > 0 ? 1 : -1) === s && l > hw - KERB_INNER && l < hw + KERB_OUTER) {
        return k === 2 || k === -2 ? SURF_SAUSAGE : SURF_KERB;
    }
    if (l <= hw) return SURF_ROAD;
    const kind = track.runoffAt(i, s);
    return kind === 1 ? SURF_GRAVEL : kind === 2 ? SURF_RUNOFF : SURF_GRASS;
}

/**
 * Track limits: all four wheels past the edge of the track (the kerb counts as track), i.e.
 * the car's flank is beyond it. Mirrors PoCabinetPhysics.Beyond.
 */
function beyondLimits(track, i, lateral) {
    const s = lateral > 0 ? 1 : -1;
    const k = track.kerbs[i];
    const edge = track.hwAt(i) + (k !== 0 && (k > 0 ? 1 : -1) === s ? KERB_OUTER : 0);
    return Math.abs(lateral) - HULL_RADIUS > edge;
}

/** A fresh physical body. Race bookkeeping (laps, times) is layered on by the caller. */
export function createBody() {
    return {
        x: 0, y: 0, heading: 0, speed: 0,
        segHint: -1, along: 0, distance: 0, lateral: 0,
        onGrass: false, sliding: false, wallImpact: 0,
        slip: 0, spin: 0,   // sideways speed (+ = right) and yaw rate a contact left behind
        // What the hits have cost (hurt()): structure and engine 0..1, alignment −1..1 (+ pulls right).
        damage: 0, engine: 0, pull: 0, wrecked: false,
        // What it is on (SURF_*), and whether it is past the track limits.
        surface: SURF_ROAD, wide: false,
    };
}

export function copyBody(src, dst) {
    const d = dst || {};
    d.x = src.x; d.y = src.y; d.heading = src.heading; d.speed = src.speed;
    d.segHint = src.segHint; d.along = src.along; d.distance = src.distance; d.lateral = src.lateral;
    d.onGrass = src.onGrass; d.sliding = src.sliding; d.wallImpact = src.wallImpact;
    d.slip = src.slip; d.spin = src.spin;
    d.damage = src.damage; d.engine = src.engine; d.pull = src.pull; d.wrecked = src.wrecked;
    d.surface = src.surface ?? SURF_ROAD; d.wide = !!src.wide;
    return d;
}

/** Race conditions for step(): rain, and how much rubber is down (track.js rubberAt). */
const DRY = Object.freeze({ wet: false, rubber: 0 });

// Where race.js wants every hit reported, for the dents (render only: nothing reads it back).
let hitSink = null;
/** Report every hit from here on into `list` as { body, fwd, side, nx, ny, closing } (null stops). */
export function reportHits(list) { hitSink = list; }

/**
 * A hit on `car` closing at `closing` u/s, landing (fwd, side) from its centre in its own frame
 * (+ = ahead, + = right), with (nx, ny) the way it pushed, in the same frame. What it costs
 * goes as the square of the closing speed over DAMAGE_FLOOR: structure wherever it lands, the
 * engine mostly from the nose, and the alignment from a corner (the car pulls toward it).
 * Mirrors PoCabinetPhysics.Hurt.
 */
function hurt(car, closing, fwd, side, nx, ny) {
    if (hitSink && closing > 4) hitSink.push({ body: car, fwd, side, nx, ny, closing });
    const e = closing - DAMAGE_FLOOR;
    if (!(e > 0) || car.wrecked) return;
    const s = e * e / DAMAGE_SCALE;
    const nose = fwd > HULL_HALF;
    const across = Math.min(1, Math.max(-1, side / HULL_RADIUS));
    car.damage = Math.min(1, car.damage + s);
    car.engine = Math.min(1, car.engine + s * (nose ? ENGINE_NOSE : ENGINE_OTHER));
    car.pull = Math.min(1, Math.max(-1, car.pull + across * s * (nose ? PULL_NOSE : PULL_OTHER)));
    if (car.damage >= 1 || car.engine >= 1) car.wrecked = true;
}

// step()'s scratch for the barrier bounces: where the car ends up and how it is moving.
const ST = { x: 0, y: 0, heading: 0, v2: 0, slip: 0 };

/**
 * The car has gone `excess` into a barrier that lies on side `s` of it (+1: toward +lateral at
 * the projection `proj`): put it back on the barrier's face, and if it was closing, damage it
 * where it hit and take the closing speed off (a little comes back, the rest scrubs along).
 * Shared by the edge barriers and the road dividers. Mirrors PoCabinetPhysics.Bounce.
 */
function bounce(car, proj, s, excess, st) {
    const nx = -proj.ty * s, ny = proj.tx * s;
    st.x -= nx * excess;
    st.y -= ny * excess;
    const ch = cos(st.heading), sh = sin(st.heading);
    let vx = ch * st.v2 - sh * st.slip, vy = sh * st.v2 + ch * st.slip;
    const vn = vx * nx + vy * ny;
    if (vn > 0) {
        // The part of the body facing the barrier takes it, pushed straight back from it.
        const fn = nx * ch + ny * sh, sn = ny * ch - nx * sh;
        hurt(car, vn, fn * (HULL_HALF + HULL_RADIUS), sn * HULL_RADIUS, -fn, -sn);
        const tx = vx - nx * vn, ty = vy - ny * vn;
        vx = tx * WALL_FRICTION - nx * vn * WALL_RESTITUTION;
        vy = ty * WALL_FRICTION - ny * vn * WALL_RESTITUTION;
        const speed = Math.sqrt(vx * vx + vy * vy);
        if (speed > 1) st.heading = st.v2 >= 0 ? atan2(vy, vx) : atan2(-vy, -vx);
        st.v2 = st.v2 >= 0 ? speed : -speed;
        st.slip = 0;   // the car leaves the barrier pointing the way it is going
        car.wallImpact = Math.max(car.wallImpact, vn);
    }
}

/**
 * Advance one car by dt with controls { throttle, brake, steer }. `grip` is the weather and
 * `cond` the race conditions ({ wet, rubber }; DRY when omitted). Mirrors PoCabinetPhysics.Step.
 */
export function step(track, car, c, dt, grip, cond = DRY) {
    let throttle = c.throttle, steer = c.steer;
    const brake = c.brake;
    const v = car.speed;
    // The road under it (last tick's segment and surface): what it is on, and the grip the
    // patches, the rubber and the kerbs there give.
    const seg = car.segHint;
    const surf = car.surface;
    let surfaceGrip = surf === SURF_GRASS ? GRASS_GRIP : surf === SURF_GRAVEL ? GRAVEL_GRIP
        : surf === SURF_KERB ? (cond.wet ? KERB_WET_GRIP : KERB_GRIP) : surf === SURF_SAUSAGE ? SAUSAGE_GRIP : 1;
    if (seg >= 0) surfaceGrip *= track.gripAt(seg, car.lateral, cond.wet, cond.rubber);
    // What the hits have cost: a wrecked engine gives only a limp, and only until the car is
    // clear of the tarmac; a bent car pulls and has lost lock, power, top speed and grip.
    if (car.wrecked) {
        throttle = Math.abs(car.lateral) > (seg >= 0 ? track.hwAt(seg) : track.halfWidth) + WRECK_CLEAR || v >= LIMP_SPEED ? 0 : Math.min(throttle, LIMP_THROTTLE);
    }
    steer = Math.min(1, Math.max(-1, steer * (1 - LOCK_LOSS * Math.abs(car.pull)) + PULL_STEER * car.pull));
    const power = 1 - POWER_LOSS * car.engine;
    const top = MAX_SPEED * (1 - TOP_LOSS * car.engine);
    grip = grip * (1 - GRIP_LOSS * car.damage);
    // How steep the way it is pointing, how banked.
    const roadDot = seg >= 0 ? cos(car.heading) * track.tx[seg] + sin(car.heading) * track.ty[seg] : 0;
    const slope = seg >= 0 ? track.grade(seg) * roadDot : 0;
    const bank = seg >= 0 ? track.bankOf(seg) : 0;

    let v2;
    if (v < -0.01) {
        if (brake > 0 && throttle === 0) {
            v2 = Math.max(-REVERSE_MAX, v - REVERSE_ACCEL * brake * dt);
        } else {
            v2 = v + (throttle * ACCEL + COAST_DECEL) * dt;
            if (throttle === 0) v2 = Math.min(v2, 0);
        }
    } else if (v <= 0.5 && throttle === 0 && brake > 0) {
        v2 = Math.max(-REVERSE_MAX, v - REVERSE_ACCEL * brake * dt);
    } else {
        const ratio = v / top;
        let a = throttle * ACCEL * power * grip * Math.max(0, 1 - ratio * ratio)
            - brake * BRAKE_DECEL
            - COAST_DECEL * (1 - throttle);
        // Grass drags, gravel beaches the car, a raised kerb scrubs it.
        if (surf === SURF_GRASS && v > 25) a -= GRASS_DECEL;
        else if (surf === SURF_GRAVEL && v > 8) a -= GRAVEL_DECEL;
        else if (surf === SURF_SAUSAGE && v > 15) a -= SAUSAGE_SCRUB;
        // Downhill pulls the car on and uphill holds it back; past its top speed the air
        // takes the excess back.
        a -= SLOPE_GRAVITY * slope;
        if (v > top) a -= OVERSPEED_DRAG * (v - top);
        v2 = Math.max(0, v + a * dt);
    }

    const speedAbs = Math.abs(v2);
    const lockScale = Math.min(1, speedAbs / STEER_FULL_SPEED);
    const omegaWanted = steer * STEER_RATE * lockScale * (v2 < 0 ? -1 : 1);
    // Grip to turn with: more in a turn banked into it, less off-camber, and less again for
    // what the brakes are using (the friction circle).
    const camber = omegaWanted > 0 ? -bank : bank;
    const omegaGrip = GRIP_ACCEL * grip * surfaceGrip * (1 + BANK_GRIP * Math.min(1, Math.max(-0.5, camber)))
        * (1 - TRAIL_LOSS * brake * brake) / Math.max(speedAbs, 1);
    const omega = Math.min(omegaGrip, Math.max(-omegaGrip, omegaWanted));
    car.sliding = Math.abs(omegaWanted) > omegaGrip * 1.02 && speedAbs > 30;
    if (car.sliding) {
        v2 = v2 > 0 ? Math.max(0, v2 - SCRUB_DECEL * dt) : Math.min(0, v2 + SCRUB_DECEL * dt);
    }

    // What a contact left behind: the tyres scrub the sideways slide and the spin off.
    const slipGrip = SLIP_DECEL * grip * surfaceGrip * dt;
    let slip = car.slip > 0 ? Math.max(0, car.slip - slipGrip) : Math.min(0, car.slip + slipGrip);
    const spin = car.spin > 0 ? Math.max(0, car.spin - SPIN_DECEL * dt) : Math.min(0, car.spin + SPIN_DECEL * dt);
    // A raised kerb throws the car out, away from the apex, by how fast it takes it.
    if (surf === SURF_SAUSAGE && speedAbs > 15) slip += (car.lateral > 0 ? 1 : -1) * roadDot * SAUSAGE_KICK * speedAbs * dt;
    if (Math.abs(slip) > SLIP_SLIDING) car.sliding = true;

    const heading = car.heading + (omega + spin) * dt;
    const ch = cos(heading), sh = sin(heading);
    const st = ST;
    st.x = car.x + (ch * v2 - sh * slip) * dt;
    st.y = car.y + (sh * v2 + ch * slip) * dt;
    st.heading = heading;
    st.v2 = v2;
    st.slip = slip;

    // The barriers: at the edge of the run-off (deeper where it is gravel or tarmac), and a
    // road divider, faced from whichever side the car is on.
    let proj = track.project(st.x, st.y, car.segHint);
    car.wallImpact = 0;
    const side = proj.lateral > 0 ? 1 : -1;
    const wallLat = wallAt(track, proj.index, side);
    if (Math.abs(proj.lateral) > wallLat) {
        bounce(car, proj, side, Math.abs(proj.lateral) - wallLat, st);
        proj = track.project(st.x, st.y, proj.index);
    }
    if (track.islandOf[proj.index] >= 0) {
        const lo = track.islandLo[proj.index] - CAR_RADIUS * 0.5, hi = track.islandHi[proj.index] + CAR_RADIUS * 0.5;
        if (proj.lateral > lo && proj.lateral < hi) {
            const toLo = proj.lateral - lo, toHi = hi - proj.lateral;
            if (toLo < toHi) bounce(car, proj, 1, toLo, st);
            else bounce(car, proj, -1, toHi, st);
            proj = track.project(st.x, st.y, proj.index);
        }
    }

    car.x = st.x;
    car.y = st.y;
    car.heading = wrapAngle(st.heading);
    car.speed = st.v2;
    car.slip = st.slip;
    car.spin = spin;
    car.segHint = proj.index;
    car.lateral = proj.lateral;
    car.onGrass = Math.abs(proj.lateral) > track.hwAt(proj.index);
    car.surface = surfaceAt(track, proj.index, proj.lateral);
    car.wide = beyondLimits(track, proj.index, proj.lateral);
    advanceDistance(track, car, proj.along);
}

function advanceDistance(track, car, along) {
    let delta = along - car.along;
    const half = track.length * 0.5;
    if (delta > half) delta -= track.length;
    else if (delta < -half) delta += track.length;
    car.distance += delta;
    car.along = along;
}

const HIT = { nx: 0, ny: 0, depth: 0, x: 0, y: 0 };

/**
 * Where two hulls touch: null when they are more than `slack` apart, else a shared scratch
 * { nx, ny (unit normal, a → b), depth, x, y (the contact point) }. Takes anything with
 * x, y, heading. Mirrors PoCabinetPhysics.HullContact; fx.js uses it for the sparks.
 */
export function hullContact(a, b, slack) {
    const reach = (HULL_HALF + HULL_RADIUS) * 2 + slack;
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx > reach || dx < -reach || dy > reach || dy < -reach) return null;
    const ahx = cos(a.heading), ahy = sin(a.heading);
    const bhx = cos(b.heading), bhy = sin(b.heading);
    // Closest points of the two spines: a + s·ha and b + t·hb, s and t in ±HULL_HALF.
    const dot = ahx * bhx + ahy * bhy;
    const da = -(ahx * dx + ahy * dy), db = -(bhx * dx + bhy * dy);
    const denom = 1 - dot * dot;
    // Within ~10° of parallel the sides meet along their overlap, not at one end: take its
    // middle, or every side-by-side rub would turn both cars.
    let s = denom > 0.03 ? (dot * db - da) / denom : -da * 0.5;
    s = Math.min(HULL_HALF, Math.max(-HULL_HALF, s));
    let t = dot * s + db;
    if (t < -HULL_HALF) {
        t = -HULL_HALF;
        s = Math.min(HULL_HALF, Math.max(-HULL_HALF, t * dot - da));
    } else if (t > HULL_HALF) {
        t = HULL_HALF;
        s = Math.min(HULL_HALF, Math.max(-HULL_HALF, t * dot - da));
    }
    const px = a.x + ahx * s, py = a.y + ahy * s;
    const qx = b.x + bhx * t, qy = b.y + bhy * t;
    const ex = qx - px, ey = qy - py;
    const d = Math.sqrt(ex * ex + ey * ey);
    if (d <= 1e-6 || d >= HULL_RADIUS * 2 + slack) return null;
    HIT.nx = ex / d; HIT.ny = ey / d;
    HIT.depth = HULL_RADIUS * 2 - d;
    HIT.x = (px + qx) * 0.5; HIT.y = (py + qy) * 0.5;
    return HIT;
}

/**
 * Pairwise hull contacts in index order: separate the two cars, then one impulse along
 * the normal at the contact point, shared between each car's speed, sideways slip and
 * spin. Mirrors PoCabinetPhysics.ResolveContacts.
 */
export function resolveContacts(track, cars) {
    const half = track.length * 0.5;
    for (let i = 0; i < cars.length; i++) {
        const a = cars[i];
        if (track.parked(a.distance)) continue;
        for (let j = i + 1; j < cars.length; j++) {
            const b = cars[j];
            let gap = b.along - a.along;
            if (gap > half) gap -= track.length;
            else if (gap < -half) gap += track.length;
            if (gap > SAME_ROAD || gap < -SAME_ROAD || track.parked(b.distance)) continue;
            const hit = hullContact(a, b, 0);
            if (!hit) continue;
            const nx = hit.nx, ny = hit.ny;
            const rax = hit.x - a.x, ray = hit.y - a.y;
            const rbx = hit.x - b.x, rby = hit.y - b.y;
            const push = hit.depth * 0.5;
            a.x -= nx * push; a.y -= ny * push;
            b.x += nx * push; b.y += ny * push;

            const ahx = cos(a.heading), ahy = sin(a.heading);
            const bhx = cos(b.heading), bhy = sin(b.heading);
            // Each hull's velocity at the contact point: forward speed, slip to its right, spin.
            const vax = ahx * a.speed - ahy * a.slip - a.spin * ray, vay = ahy * a.speed + ahx * a.slip + a.spin * rax;
            const vbx = bhx * b.speed - bhy * b.slip - b.spin * rby, vby = bhy * b.speed + bhx * b.slip + b.spin * rbx;
            const closing = (vax - vbx) * nx + (vay - vby) * ny;
            if (closing <= 0) continue;
            const armA = rax * ny - ray * nx, armB = rbx * ny - rby * nx;
            const impulse = (1 + CONTACT_RESTITUTION) * closing / (2 + (armA * armA + armB * armB) / YAW_INERTIA);
            a.speed -= impulse * (nx * ahx + ny * ahy);
            a.slip -= impulse * (ny * ahx - nx * ahy);
            a.spin -= impulse * armA / YAW_INERTIA;
            b.speed += impulse * (nx * bhx + ny * bhy);
            b.slip += impulse * (ny * bhx - nx * bhy);
            b.spin += impulse * armB / YAW_INERTIA;
            // Bounded so a shove can't launch a car past what its own engine could do.
            a.speed = Math.min(MAX_SPEED * 1.08, Math.max(-CONTACT_SPEED_FLOOR, a.speed));
            b.speed = Math.min(MAX_SPEED * 1.08, Math.max(-CONTACT_SPEED_FLOOR, b.speed));
            a.slip = Math.min(MAX_SLIP, Math.max(-MAX_SLIP, a.slip));
            b.slip = Math.min(MAX_SLIP, Math.max(-MAX_SLIP, b.slip));
            a.spin = Math.min(MAX_SPIN, Math.max(-MAX_SPIN, a.spin));
            b.spin = Math.min(MAX_SPIN, Math.max(-MAX_SPIN, b.spin));
            // Both bodies take the hit where they touched, each pushed away from the other.
            const fa = nx * ahx + ny * ahy, sa = ny * ahx - nx * ahy;
            const fb = nx * bhx + ny * bhy, sb = ny * bhx - nx * bhy;
            hurt(a, closing, rax * ahx + ray * ahy, ray * ahx - rax * ahy, -fa, -sa);
            hurt(b, closing, rbx * bhx + rby * bhy, rby * bhx - rbx * bhy, fb, sb);
        }
    }
}

/** Columns of the starting grid: as many as the tarmac takes, at least two. */
function gridColumns(track) {
    return Math.max(2, Math.floor(track.halfWidth * 1.6 / GRID_COLUMN) + 1);
}

/**
 * Distance behind the line of grid row `row`. Rows are GRID_ROW apart, but none stands on a
 * bend tighter than one and a half road widths: there the slots of neighbouring rows fan
 * into each other (Press Briefing turns 130° in thirty units at its line), so the row moves
 * back to where the road has straightened. Mirrors PoCabinetPhysics.GridBack.
 */
function gridBack(track, row) {
    const limit = 1 / (track.halfWidth * 1.5);
    let back = 18;
    for (let r = 0; back < track.length; ) {
        const at = track.length - back;
        if (track.maxCurvature(at - 25, at + 25) > limit) { back += 8; continue; }
        if (r === row) break;
        r++;
        back += GRID_ROW;
    }
    return back;
}

/** Grid slot: rows across the tarmac, pole just behind the line. Mirrors PoCabinetPhysics.GridSlot. */
export function gridSlot(track, car, slot) {
    const cols = gridColumns(track);
    const back = gridBack(track, Math.floor(slot / cols));
    const lateral = (slot % cols - (cols - 1) / 2) * GRID_COLUMN;
    const p = track.pointAt(track.length - back);
    car.x = p.x + -p.ty * lateral;
    car.y = p.y + p.tx * lateral;
    car.heading = atan2(p.ty, p.tx);
    car.speed = 0;
    car.slip = 0;
    car.spin = 0;
    // Hinted with where the slot is: a long grid runs back over other parts of a course
    // that crosses itself, and a blind nearest-point search can land on the wrong level.
    const proj = track.project(car.x, car.y, track.indexAt(track.length - back));
    car.segHint = proj.index;
    car.along = proj.along;
    car.lateral = proj.lateral;
    car.onGrass = false;
    car.surface = SURF_ROAD;
    car.wide = false;
    // Race distance starts negative: the slot's own distance behind the line, corrected by
    // where the car projects (a bend moves an outer slot a little along the road). Not
    // "along minus a lap": a front-row slot on a tight last bend can project past the line.
    let off = proj.along - (track.length - back);
    if (off > track.length * 0.5) off -= track.length;
    else if (off < -track.length * 0.5) off += track.length;
    car.distance = off - back;
}

/**
 * Speed the tightest corner in braking range allows; `reach` is how many seconds of road
 * that range is (the later a driver brakes, the less). Shared by the AI and the auto-brake assist.
 */
function cornerSpeed(track, car, grip, margin, reach, inside = 0) {
    const v = car.speed;
    // Capped at a turn as tight as the road is wide: the centerline has kinks sharper than
    // that (Mar-a-Lago's last bend, a few samples long) which a car simply cuts across,
    // and braking for them parked a 100-car field on the start line.
    let kappa = Math.min(1 / track.halfWidth, track.maxCurvature(car.along + 5, car.along + 30 + Math.abs(v) * reach));
    // A car `inside` units to the inside of the bend runs a tighter radius than the centerline's.
    if (inside > 0) kappa = kappa / Math.max(0.4, 1 - kappa * inside);
    return Math.sqrt(GRIP_ACCEL * grip * margin / Math.max(kappa, 1e-5));
}

/**
 * How far to the inside of the bend a car beside (or about to be beside) a road divider is:
 * its lane is the short side's, the inside, a tighter radius than the centerline's. 0 for any
 * other car. Mirrors PoCabinetAiDriver.InsideOfIsland.
 */
function insideOfIsland(track, car, target) {
    const half = track.length * 0.5;
    for (const s of track.islands) {
        let d = s.fromAlong - car.along;
        if (d > half) d -= track.length;
        else if (d < -half) d += track.length;
        if (d > ISLAND_LOOK || d < -(s.toAlong - s.fromAlong)) continue;
        const lat = Math.max(Math.abs(car.lateral), Math.abs(target));
        const mid = (s.latFrom + s.latTo) * 0.5;
        return (target - mid) * s.shortSide > 0 ? lat : 0;
    }
    return 0;
}

/**
 * The AI's speed limit for the corners in braking range: for each curvature sample within `reach`
 * seconds of road, the speed it can still brake down to that sample's corner speed from, at
 * `decel` (the braking curve sqrt(vApex² + 2·decel·distance)), and the lowest of them. A corner
 * up the road costs nothing until its braking point comes. `inside` is as cornerSpeed's.
 * Mirrors PoCabinetAiDriver.CornerLimit.
 */
function cornerLimit(track, car, grip, margin, reach, inside, decel) {
    const v = car.speed;
    // Capped at a turn as tight as the road is wide: the centerline has kinks sharper than
    // that (Mar-a-Lago's last bend, a few samples long) which a car simply cuts across,
    // and braking for them parked a 100-car field on the start line.
    const cap = 1 / track.halfWidth;
    const to = car.along + 30 + Math.abs(v) * reach;
    let limit = Number.MAX_VALUE;
    for (let d = car.along + 5; d <= to; d += AI_CURVE_STEP) {
        let kappa = Math.min(cap, track.curv[track.indexAt(d)]);
        // A car `inside` units to the inside of the bend runs a tighter radius than the centerline's.
        if (inside > 0) kappa = kappa / Math.max(0.4, 1 - kappa * inside);
        const apex = GRIP_ACCEL * grip * margin / Math.max(kappa, 1e-5);
        const allowed = Math.sqrt(apex + 2 * decel * (d - car.along));
        if (allowed < limit) limit = allowed;
    }
    return limit;
}

/** How fast body `b` is going along the unit direction (`dx`, `dy`): its forward speed and its
 *  sideways slide both count, so a car that has spun round is not "pulling away". */
function speedAlong(b, dx, dy) {
    const bx = cos(b.heading), by = sin(b.heading);
    return (bx * b.speed - by * b.slip) * dx + (by * b.speed + bx * b.slip) * dy;
}

/** speedAlong the road where `b` is. Mirrors PoCabinetAiDriver.RoadSpeed. */
function roadSpeed(track, b) {
    const seg = b.segHint >= 0 ? b.segHint : track.indexAt(b.along);
    return speedAlong(b, track.tx[seg], track.ty[seg]);
}

// aiControls scratch: the slower cars ahead within range, and how far ahead each is.
const NEAR = [];
const NEAR_GAP = [];

/** Clear road ahead in lane `lateral` (capped at AI_RANGE) among the first `n` NEAR cars. */
function clearRun(n, lateral) {
    let run = AI_RANGE;
    for (let i = 0; i < n; i++) {
        if (NEAR_GAP[i] < run && Math.abs(NEAR[i].lateral - lateral) < 20) run = NEAR_GAP[i];
    }
    return run;
}

/**
 * A wrecked car's driver: get it off the racing line to the barrier on the side it is nearer,
 * on what limp the engine has left (step() caps it), then stop it there.
 * Mirrors PoCabinetAiDriver.Wrecked.
 */
export function wreckControls(track, car) {
    const v = car.speed;
    const seg = car.segHint >= 0 ? car.segHint : track.indexAt(car.along);
    const side = car.lateral < 0 ? -1 : 1;
    const target = side * (track.hwAt(seg) + runOffAt(track, seg, side) * 0.7);
    const p = track.pointAt(car.along + 30 + Math.abs(v) * 0.3);
    const tx = p.x + -p.ty * target;
    const ty = p.y + p.tx * target;
    let steer = Math.min(1, Math.max(-1, wrapAngle(atan2(ty - car.y, tx - car.x) - car.heading) * 2.4));
    if (v < 0) steer = -steer;
    const clear = Math.abs(car.lateral) > track.hwAt(seg) + WRECK_CLEAR;
    return { throttle: clear ? 0 : 1, brake: clear && v > 0.5 ? 0.6 : 0, steer };
}

/**
 * A road divider within ISLAND_LOOK ahead (or alongside): keep the lane target on one side of
 * it, clear of its ends. A car keeps to the side it is on (a field swapping sides in front of
 * the nose is a pile-up); a driver who goes for the joker (`joker`) crosses to the short side
 * if it is still well short of the nose and nobody is alongside on that side (`left`, `right`).
 * Mirrors PoCabinetAiDriver.IslandLane.
 */
function islandLane(track, car, target, joker, left, right) {
    const half = track.length * 0.5;
    for (const s of track.islands) {
        let d = s.fromAlong - car.along;
        if (d > half) d -= track.length;
        else if (d < -half) d += track.length;
        const len = s.toAlong - s.fromAlong;
        if (d > ISLAND_LOOK || d < -len) continue;
        const mid = (s.latFrom + s.latTo) * 0.5;
        let side = car.lateral < mid ? -1 : 1;
        if (joker && d > ISLAND_LOOK * 0.4 && side !== s.shortSide && !(s.shortSide > 0 ? right : left)) side = s.shortSide;
        const lo = side < 0 ? -s.hw * 0.85 : s.latTo + ISLAND_CLEAR;
        const hi = side < 0 ? s.latFrom - ISLAND_CLEAR : s.hw * 0.85;
        // The middle of the lane, not its edges: on a bend the line a car steers along cuts in
        // toward the inside, and an edge an inch off the divider is a car grinding along it.
        const m = (hi - lo) * 0.2;
        return Math.min(hi - m, Math.max(lo + m, target));
    }
    return target;
}

/** True when cars `a` and `b` are both beside the same road divider, on opposite sides of it. Mirrors PoCabinetAiDriver.SplitBy. */
function splitBy(track, a, b) {
    if (a.segHint < 0 || b.segHint < 0) return false;
    const k = track.islandOf[a.segHint];
    if (k < 0 || track.islandOf[b.segHint] !== k) return false;
    const s = track.islands[k];
    const mid = (s.latFrom + s.latTo) * 0.5;
    return (a.lateral < mid) !== (b.lateral < mid);
}

/**
 * AI controls for one car. Mirrors PoCabinetAiDriver.Decide. `guide` (the steering assist's
 * call, browser only) leaves the racing line out and steers for the centre as it always has.
 */
export function aiControls(track, car, persona, maxSpeed, corneringSkill, field, grip, guide = false) {
    if (car.wrecked) return wreckControls(track, car);
    const v = car.speed;
    const seg = car.segHint >= 0 ? car.segHint : track.indexAt(car.along);
    const hw = track.hwAt(seg);
    const edge = hw * 0.8;
    // Steering aims at a point ahead, further ahead at speed; the line there is the track's
    // racing line (wide on the way in, the apex, wide on the way out), set off it by the
    // driver's own bias.
    const look = persona.lookahead * 0.5 + 20 + Math.abs(v) * 0.45;
    const racing = guide ? 0 : track.line[track.indexAt(car.along + look)] * LINE_WEIGHT;
    const line = Math.min(edge, Math.max(-edge, racing + persona.lateralOffset * hw * LINE_BIAS));
    let lateralTarget = line;

    // Traffic. What is in the way (the car to follow, a car alongside) is judged in this
    // car's own frame, from where the two actually are: the centerline has kinks tighter
    // than a car, and across one of those "ahead on the road" is noise that parked a whole
    // field behind a car that was beside it. Lanes are a road notion, so the lane choice
    // reads road positions: the nearest car ahead, and the ones not pulling away.
    const half = track.length * 0.5;
    const hx = cos(car.heading), hy = sin(car.heading);
    const own = (hx * v - hy * car.slip) * track.tx[seg] + (hy * v + hx * car.slip) * track.ty[seg];
    let ahead = null, gap = Number.MAX_VALUE;
    let blocker = null, blockGap = Number.MAX_VALUE;
    let blue = null, blueGap = -BLUE_LOOK;
    let left = false, right = false;
    let near = 0;
    for (const other of field) {
        if (other === car) continue;
        // Along the road first: it wraps the lap (a lapped or cooling-down car counts) and
        // drops the other level of a crossing.
        let d = other.along - car.along;
        if (d > half) d -= track.length;
        else if (d < -half) d += track.length;
        if (d <= -AI_RANGE || d >= AI_RANGE || track.parked(other.distance)) continue;
        // A car the other side of a road divider is in another lane altogether: on a bend it
        // can look dead ahead, and two lanes braking for each other stop both.
        if (splitBy(track, car, other)) continue;
        const dx = other.x - car.x, dy = other.y - car.y;
        const fwd = dx * hx + dy * hy, side = dy * hx - dx * hy;
        if (fwd > -44 && fwd < 44) {
            if (side > 12 && side < 30) right = true;
            else if (side < -12 && side > -30) left = true;
        }
        // Blue flag: the nearest car close behind on the road, near its lane, that is really a
        // lap or more ahead and coming up on it.
        if (d < 0 && d > blueGap && !other.wrecked && other.distance - car.distance > half
            && Math.abs(other.lateral - car.lateral) < BLUE_LANE && roadSpeed(track, other) > own + BLUE_CLOSING) { blueGap = d; blue = other; }
        // In its path AND ahead of it on the road: two cars converging at an angle are each
        // in the other's path, and without the second test both wait for the other forever.
        // A wreck is never followed: it is not going anywhere, so it is a lane to avoid (below).
        if (d > 0 && fwd > 4 && fwd < blockGap && Math.abs(side) < 20 && !other.wrecked) { blockGap = fwd; blocker = other; }
        if (d <= 4) continue;
        if (d < gap && !other.wrecked) { gap = d; ahead = other; }
        // Not pulling away: slower, or quick but going nowhere along the road (spun, sideways).
        if (other.speed < v + 4 || roadSpeed(track, other) < other.speed * 0.5) { NEAR[near] = other; NEAR_GAP[near] = d; near++; }
    }
    if (ahead && persona.draftingAffinity > 0.5 && gap > 50) {
        lateralTarget = ahead.lateral;
    } else if (near > 0) {
        // Pick a lane: its own line and seven across the tarmac, scored by the clear road
        // ahead, less how far the lane is from its line (a tolerant driver insists on its
        // line) and from where the car is now (which keeps the choice from flickering).
        const insist = 0.2 + 0.6 * persona.collisionTolerance;
        let best = clearRun(near, line) - Math.abs(line - car.lateral) * 0.25;
        for (let k = -3; k <= 3; k++) {
            const lane = edge * k / 3;
            const score = clearRun(near, lane) - Math.abs(lane - line) * insist - Math.abs(lane - car.lateral) * 0.25;
            if (score > best) { best = score; lateralTarget = lane; }
        }
    }
    // Being lapped: never across the leader's bows, and easing over to the side away from it
    // (it lifts, below). Not a dive for the edge: that put the cars behind into it.
    if (blue) {
        const away = blue.lateral > car.lateral ? -1 : 1;
        if ((lateralTarget - car.lateral) * away < 0) lateralTarget = car.lateral;
        lateralTarget += away * hw * BLUE_STEP;
    }
    lateralTarget = Math.min(edge, Math.max(-edge, lateralTarget));
    // A lapse: off its line and out over the edge of the road.
    const lapsing = lapse(persona, car.distance);
    if (lapsing !== 0) lateralTarget = lapsing > 0 ? hw + RUN_OFF * 0.6 : -(hw + RUN_OFF * 0.6);
    // Never turn in on a car that is alongside: hold the lane (but always come back off the
    // grass). A bruiser does it anyway and leans on whoever is there.
    if (persona.aggression < 0.8 && (lateralTarget > car.lateral ? right : left)) lateralTarget = Math.min(edge, Math.max(-edge, car.lateral));
    // A divider ahead: pick a side of it (the wild and the aggressive go for the joker lane).
    if (track.islands.length) lateralTarget = islandLane(track, car, lateralTarget, persona.aggression >= 0.5 || persona.wildness >= 0.15, left, right);

    const p = track.pointAt(car.along + look);
    const tx = p.x + -p.ty * lateralTarget;
    const ty = p.y + p.tx * lateralTarget;
    const desired = atan2(ty - car.y, tx - car.x);
    const err = wrapAngle(desired - car.heading);
    // A smooth driver feeds the lock in; a twitchy one saws at it and weaves.
    let steer = Math.min(1, Math.max(-1, err * (1.8 + 1.6 * persona.twitch)));
    if (v < 0) steer = -steer;
    // Nose into a barrier or a divider, facing well away from its line and barely moving:
    // back out (the brake at a standstill is reverse, and reversing turns the tail the other way).
    if ((err > 1.2 || err < -1.2) && v < 6 && v > -REVERSE_MAX) return { throttle: 0, brake: 1, steer };
    // Spun and rolling on the wrong way: no throttle into the oncoming field; it turns round on
    // the lock and what speed it has. (Braking it to a stop instead left cars parked across
    // the road.)
    if ((err > WRONG_WAY || err < -WRONG_WAY) && v >= 6) return { throttle: 0, brake: 0, steer };

    // Speed. A bent car has less grip than it set out with and plans its corners (and a little
    // of its pace) on what is left; a lapse has it believing in grip that is not there.
    const health = 1 - GRIP_LOSS * car.damage;
    const pace = maxSpeed * (1 - DAMAGE_PACE * car.damage);
    const margin = (0.55 + corneringSkill * 0.4) * (lapsing !== 0 ? Math.abs(lapsing) : 1);
    const inside = track.islands.length ? insideOfIsland(track, car, lateralTarget) : 0;
    // A late braker looks 0.7 s up the road for its corner, a cautious one 1.3 s, and brakes
    // where the braking curve it plans on (harder, the later the braker) meets the corner.
    const corner = cornerLimit(track, car, grip * health, margin, 1.3 - 0.6 * persona.brakingAggression, inside,
        AI_BRAKE_PLAN + AI_BRAKE_PLAN_LATE * persona.brakingAggression);
    let target = Math.min(pace, corner);
    // What it brakes for: the corner and the traffic. Its own pace it only lifts for, so a
    // descent can carry it on, up to RUN_ON over (a finished car parking, at 0, stops).
    let limit = Math.min(corner, pace > 0 ? pace + RUN_ON : 0);
    if (blocker) {
        // The car ahead in this lane: no faster than can still be braked down to its speed
        // in the room there is, and a little under it once nose to tail. Its speed is how fast
        // it is going this car's way: a car sideways or pointing back is a car stopped. Never
        // negative: brake at a standstill is the reverse gear. An aggressive driver follows
        // closer than the cars are long, and bumps.
        const room = blockGap - (FOLLOW_GAP - 12 * persona.aggression);
        const vb = Math.max(0, speedAlong(blocker, hx, hy));
        const follow = room > 0 ? Math.sqrt(vb * vb + 2 * FOLLOW_DECEL * room) : Math.max(0, vb - 15);
        target = Math.min(target, follow);
        limit = Math.min(limit, follow);
    }
    // Being lapped: a lift to let the leader by.
    if (blue) target = target * BLUE_LIFT;

    const throttle = v < target - 3 ? 1 : v < target ? 0.35 : 0;
    const brake = v > limit + 4
        ? Math.min(1, Math.max(0.15, (v - limit) / 18 * (0.6 + persona.brakingAggression * 0.8)))
        : 0;
    return { throttle, brake, steer };
}

/**
 * Driver aids, applied to the player's raw input before it is stepped or sent.
 * Online they run client-side on the input only, so the server needs no special
 * case and nobody gets a different physics model.
 *   steering: 'off' | 'light' | 'strong' — blend toward the centre-line steer
 *   autoBrake: lift and brake when over the next corner's speed
 */
export function assistControls(track, car, input, assists, grip) {
    let { throttle, brake, steer } = input;
    const weight = assists?.steering === 'strong' ? 0.6 : assists?.steering === 'light' ? 0.35 : 0;
    if (weight > 0 && car.speed > 5) {
        const guide = aiControls(track, car, AUTOPILOT, MAX_SPEED, 0.9, [], grip, true);
        steer = Math.min(1, Math.max(-1, steer * (1 - weight * 0.5) + guide.steer * weight));
    }
    if (assists?.autoBrake && car.speed > 20) {
        const target = cornerSpeed(track, car, grip, 0.92, 1.1);
        if (car.speed > target + 4) {
            throttle = Math.min(throttle, 0.3);
            brake = Math.max(brake, Math.min(1, (car.speed - target) / 25));
        }
    }
    return { throttle, brake, steer };
}
