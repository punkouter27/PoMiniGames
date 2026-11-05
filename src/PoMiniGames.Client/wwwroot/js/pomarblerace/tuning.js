// tuning.js — every tuning constant of the marble race in one place. Grouped by the system
// that reads it; each module imports only what it uses.

export const RESULT_MS = 3600;     // how long the result banner shows before next track
// ── Race clock ──
export const RACE_TIMEOUT = 180;   // s — failsafe: whatever is still running then is force-finished
                                   // (course.js _unstick is what keeps it from being reached)
export const TICK_INTERVAL = 0.1;  // s — throttle for OnRaceTick to C#
export const LEADERS = 3;          // rivals drawn in glass and trailed (marbles.js)
export const AIR_HOLD = 0.12;      // s without floor contact before the rolling bed calls it airborne
// ── Ghost ──
// Your fastest finish on an authored course, replayed as a faint marble in a local race. The path
// is kept per map (ghostTrack.js) at 20 Hz of race clock, so slow motion and hit-stop play back
// exactly as they ran. Procedural maps build a new course every race, so a ghost there would roll
// through scenery that is no longer there: they neither record nor show one. Online never does
// either (the guest has no physics; the ghost would be one more marble only one player can see).
export const GHOST_HZ = 20;
export const GHOST_SCALES = [10, 10, 10];
export const GHOST_KEY = 'pomarblerace.ghost.v1.';

// ── Staying on the map ──
// A marble is only retired when it is BOTH outside the course envelope AND has touched nothing
// for LOST_AIR seconds. Touching any static body means it is on the map, whatever the centerline
// maths says — an envelope-only test would delete marbles rolling on side lanes. One that is
// touching track while the envelope disagrees has reached another part of the course, so its
// position is re-acquired rather than the marble deleted.
export const LOST_AIR = 1.0;
export const REACQUIRE_AFTER = 1.0;
// Brake strips (track.brakeAt): how fast an over-speed marble is bled down to the strip's cap.
export const BRAKE_RATE = 3;
// Unstick: a marble that has not gained STALL_GAIN units of progress in STALL_AFTER seconds gets
// a nudge along the course, then again every STALL_REPEAT seconds, each one STALL_STEP harder
// (up to STALL_MAX). The escalation is for the authored courses' dips with an uphill exit —
// Spiral Works' Split A → Mid junction parked 23-35 marbles a race — where climbing out takes
// ~27 u/s and a fixed small push only rocked the pile.
export const STALL_AFTER = 5;
export const STALL_REPEAT = 2;
// 12 units per STALL_AFTER, not 2: a marble creeping along a corner at ~0.4 u/s reset a 2-unit
// timer every few seconds and was never nudged at all (Grand Spiral's Loop → Helix B junction
// parked ~50 that way until the race timed out).
export const STALL_GAIN = 12;
export const STALL_NUDGE = 14;
export const STALL_STEP = 8;
export const STALL_MAX = 40;
export const STALL_LOOKAHEAD = 12;
// Dead centre: a marble pressed against a free turnstile right at its pivot exerts no torque, so a
// push straight down the course never frees it (Canyon Run, now part of Neon Canyon, parked three marbles at one turnstile
// for 120 s). From the STALL_SIDESTEP-th nudge on, each push also carries STALL_SIDE_SHARE of its
// strength sideways, alternating sides, sliding the marble along the bar to an end.
export const STALL_SIDESTEP = 3;
export const STALL_SIDE_SHARE = 0.8;


// ── The player's verb ──
// Continuous lateral steering. Holding left/right adds sideways acceleration to the picked
// marble for as long as it's held — this is the entire interactive surface of the game, so the
// player is always able to pick a lane at a split, take the Catch line over the Penalty ramp, or
// steer off a paddle. The force is divided by mass, so a Heavy pick (marbles.js WEIGHTS) turns
// wider and a Light one sharper.
export const STEER_ACCEL = 72;      // lateral units/s² — raised with gravity so steering keeps its bite

// ── Rival personalities (rivals.js) ──
// A CPU marble steers with the player's own push, capped to this share of it: a personality picks
// a line, it never buys speed.
export const RIVAL_STEER_SHARE = 0.35;
export const RIVAL_DEADBAND = 0.08;   // channel fraction: close enough to the wanted line, leave it be
export const RIVAL_GAIN = 2.5;        // how hard the push ramps with the distance off the line
export const RIVAL_LOOKAHEAD = 24;    // world units ahead a line-hugger reads the bend from

// ── Boost pads and kickers ──
// These are surfaces a MAP may or may not have. The procedural chute paints boost pads, rumble
// bands and telegraphed kicker bands onto itself; the authored GLB course has no equivalent and
// exposes neither, so _applyBoost and _applyKickers below feature-detect and simply do nothing
// on a map without them. See the optional part of the track interface in maps.js.
export const BOOST_ACCEL = 40;      // units/s² along the track tangent while on a pad
export const BOOST_MAX_SPEED = 150; // don't let a marble that camps a pad accelerate without bound

// Kickers: a telegraphed push-only band that fires on a cycle, shoving marbles sideways.
export const KICK_DV = 16;          // lateral velocity punch at mass 1 when it fires (÷ mass — heavies resist)
export const KICK_UP = 4;           // small upward pop so the kick reads as a jolt, not a slide
export const KICK_CHARGE = 0.34;    // fraction of each cycle spent visibly charging up — the TELL

// ── Scoring ──
// Placement-weighted across the 101-marble field: finishing anywhere in the top SCORE_TOP
// scores, more for a higher place, with a dominant-win bonus and a streak multiplier on top.
// Beating 100 marbles with only a steering input makes even a top-10 a real result, so the
// scoring bar is the top 10 rather than a podium of 3.
export const SCORE_TOP = 10;                // finish in the top 10 of 101 to score / keep a streak
export const DOMINANT_GAP = 1.5;            // s clear of 2nd for the dominant-win bonus
export const DOMINANT_BONUS = 4;
export const MAX_STREAK_STEPS = 4;          // multiplier caps at 1 + 4*0.5 = 3×

// ── Director ──
// The camera locks to the player's own marble (this is a game you steer, so you must always
// see what you're steering); the leader only takes the shot when the player is out of the
// race or during the slow-motion finish. See _pickShot.
export const SLOWMO_DIST = 45;       // units from the finish where the leader triggers slow-motion
export const SLOWMO_SCALE = 0.35;
// Shot hysteresis, demo mode only. "Follow the leader" over a 101-marble pack means the subject
// changes every time two marbles swap noses — several times a second in traffic — and every
// change asked the camera for a cut. That, not the follow lerp, is what made the demo camera
// jump. A shot now has to run for SHOT_MIN_HOLD before it can be replaced, and the new leader
// has to be SHOT_LEAD_MARGIN units clear of the current subject to be worth cutting to, so the
// camera stays with a marble through a scrap and only moves on once someone has actually gone.
export const SHOT_MIN_HOLD = 3.0;    // seconds a shot must run before another marble can take it
export const SHOT_LEAD_MARGIN = 14;  // units the leader must be up on the current subject to take the shot

// Out-of-bounds is no longer a world-Y test — the course banks to near-vertical, so "well below
// the centerline" would eliminate marbles for riding a wall-of-death. track.isOutOfBounds()
// judges it in the local frame instead; see the note there.

// How far the camera anchor is pulled from the subject marble back toward the road centreline.
// 0 = lock dead on the marble (jittery — it inherits per-frame physics noise); 1 = the old
// road-only framing, which loses the marble entirely on a 160-unit-wide channel.
export const ROAD_BIAS = 0.35;


// ── Online (host-authoritative relay) ──
// The host browser is the only simulation: it streams marble positions to the guest at NET_HZ
// and applies the guest's steering to the guest's marble. The guest builds the same course from
// the same seed and renders what it is sent. See PoMarbleRaceShared.cs for why not lockstep.
export const NET_HZ = 15;
export const NET_INTERVAL = 1 / NET_HZ;
// The guest's marble. Not red (that is the host's, and PACK_PALETTE keeps clear of red for the
// same reason) and not in the palette either: an off-white the pack never uses.
export const GUEST_COLOR = 0xf8fafc;
// Guest-side easing toward the last streamed position, per second: high enough that 15 Hz reads
// as continuous, low enough that a late frame slides rather than snaps.
export const NET_SMOOTH = 14;

// ── Presentation ──
// The leader's share of the course past which the grade warms to 'final' (director.js).
export const FINAL_STRETCH = 0.86;
// The audio beds' "near the finish" ramp: the leader's distance from the line over which it
// rises, and the easing exponent (< 1 rises harder and sooner).
export const BED_NEAR_RANGE = 300;
export const BED_NEAR_EASE = 0.6;
