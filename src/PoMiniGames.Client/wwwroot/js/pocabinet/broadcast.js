// pocabinet/broadcast.js
//
// The demo's TV coverage (demo mode only). It reads the race and never steps it: render, audio
// focus and DOM only.
//
//   • Director: four times a second it scores the battles in the field (each pair of cars running
//     nose to tail, by the time between them and how far up the order they are) and holds a shot
//     at least MIN_HOLD before cutting to a better fight. A new leader, a wreck near the front or
//     the chequered flag pre-empt that after EVENT_HOLD. Every cut changes the camera (chase, TV,
//     far). In a battle the camera follows the car behind, so both are in frame.
//   • Timing tower: the top ten by name with the gap to the leader, timed the way real timing is: at
//     checkpoints round the lap, the time since the leader crossed the same one. The car on
//     screen gets a row of its own when it is further back.
//   • Caption (lower third): the car on screen, its place, driving style, speed and condition,
//     and in a battle the gap to the car it is fighting.
//   • Callouts: lead changes, a pass in the battle on screen, fastest laps, wrecks near the
//     front, the last lap and the flag.
//   • Picture in picture: in a battle, the rear camera of the car being chased; on a TV shot of
//     the leader, its onboard (scene.setPip; scene.js leaves it out on the low tier and on narrow
//     screens).
//
// The page renders the containers (#pocabinetBroadcast) with every text node empty, so Blazor
// owns no text in them; everything inside is written here, a few times a second, never through
// Blazor.

import * as ph from './physics.js';

const COUNTDOWN = 3;            // race.js: the race clock runs this long before GO
const CHECKPOINTS = 40;         // timing lines per lap
const EVAL_MS = 250;
const MIN_HOLD = 6000;
const MAX_HOLD = 15000;
const EVENT_HOLD = 2500;        // the shortest look at a shot before an event may take over
const BATTLE_GAP = 1.0;         // seconds between two cars that makes a fight worth cutting to
export const BATTLE_LOST = 1.6; // and that ends one already on screen (acoustics.js: the score's drums fade in under it)
const PASS_HOLD = 1.2;          // sim seconds a pass must stick before it is called
const LEAD_HOLD = 1.5;
const TOWER_ROWS = 10;
const CALLOUT_MS = 3600;
const DOM_MS = 200;
const SHOTS = ['chase', 'tv', 'far'];
const PRIORITY = { flag: 3, incident: 2, leader: 1 };
const SHOT_LABEL = { chase: 'Chase cam', tv: 'Trackside', far: 'Wide' };

/**
 * The director's measure of a fight: the seconds between `ahead` and `behind` on the road, at
 * the speed of the car behind. Also the race score's (acoustics.js): drums come in under it.
 */
export function battleGap(ahead, behind) {
    return (ahead.body.distance - behind.body.distance) / Math.max(30, Math.abs(behind.body.speed));
}

export class Broadcast {
    constructor(race) {
        this.race = race;
        this.L = race.track.lapLength;
        this.step = this.L / CHECKPOINTS;
        this.lead = new Map();       // checkpoint index → race time the first car crossed it
        this.st = new Map();         // car → { k, gap, laps, wrecked }
        this.order = [...race.cars].sort((a, b) => a.position - b.position);
        this.leaderId = null;
        this.leadPending = null;
        this.fastest = -1;
        this.fastestId = null;
        this.flagged = false;
        this.finalLap = false;
        this.shot = null;            // { car, rival, kind, mode, at }; in a battle car is behind, rival ahead
        this.modeIx = 0;
        this.evalAt = 0;
        this.domAt = 0;
        this.pending = null;         // an event's shot, waiting for EVENT_HOLD
        this.pass = null;
        this.callouts = [];
        this.callout = null;
        this.calloutEndAt = 0;
        this.dom = null;
    }

    // ── Sim side: called after every solo tick ───────────────────────────

    tick(elapsed) {
        const r = this.race;
        this.order = [...r.cars].sort((a, b) => a.position - b.position);
        if (elapsed < 0) return;
        for (const car of r.cars) {
            let s = this.st.get(car);
            if (!s) {
                s = { k: Math.floor(car.body.distance / this.step), gap: 0, laps: car.lapsDone, wrecked: false };
                this.st.set(car, s);
            }
            if (!car.finished) {
                const k = Math.floor(car.body.distance / this.step);
                while (s.k < k) {
                    s.k++;
                    const t = this.lead.get(s.k);
                    if (t === undefined) { this.lead.set(s.k, elapsed); s.gap = 0; } else s.gap = elapsed - t;
                }
            }
            if (car.body.wrecked && !s.wrecked) { s.wrecked = true; this.onWreck(car); }
            if (car.lapsDone > s.laps) { s.laps = car.lapsDone; this.onLap(car); }
        }

        const leader = this.order[0];
        if (!leader) return;
        if (this.leaderId === null || elapsed < 4) {
            this.leaderId = leader.id;
        } else if (leader.id !== this.leaderId) {
            if (this.leadPending?.id !== leader.id) this.leadPending = { id: leader.id, since: elapsed };
            else if (elapsed - this.leadPending.since >= LEAD_HOLD) this.newLeader(leader);
        } else {
            this.leadPending = null;
        }

        if (!this.finalLap && leader.lapsDone === r.totalLaps - 1 && r.totalLaps > 1) {
            this.finalLap = true;
            this.say('final', 'Final lap', `${nameOf(leader)} leads into the last lap`);
        }
        const winner = !this.flagged && r.cars.find(c => c.finishOrder === 1);
        if (winner) {
            this.flagged = true;
            this.say('flag', 'Chequered flag', `${nameOf(winner)} wins`);
            this.request(winner, 'flag', 'tv');
        }

        // A pass in the battle on screen, once it has stuck.
        const sh = this.shot;
        if (sh?.kind === 'battle' && sh.rival && sh.car.position < sh.rival.position && !sh.car.finished) {
            if (!this.pass) this.pass = { since: elapsed };
            else if (elapsed - this.pass.since >= PASS_HOLD) {
                const by = sh.car, of = sh.rival;
                if (by.position === 1) this.newLeader(by);
                else this.say('overtake', 'Overtake', `${nameOf(by)} takes P${by.position} from ${nameOf(of)}`);
                // Still the same fight: follow whoever is behind now.
                sh.car = of;
                sh.rival = by;
                this.pass = null;
            }
        } else {
            this.pass = null;
        }
    }

    newLeader(car) {
        this.leaderId = car.id;
        this.leadPending = null;
        this.say('lead', 'New leader', `${nameOf(car)} takes the lead`);
        if (!(this.shot?.kind === 'battle' && (this.shot.car === car || this.shot.rival === car))) this.request(car, 'leader', 'tv');
    }

    onLap(car) {
        // Lap one starts from the grid, behind the line: not a flying lap. A lap past track limits never counts.
        if (car.lapsDone < 2 || !(car.lastLap > 0) || car.lastLapValid === false) return;
        if (this.fastest > 0 && car.lastLap >= this.fastest) return;
        this.fastest = car.lastLap;
        this.fastestId = car.id;
        this.say('fastest', 'Fastest lap', `${nameOf(car)} · ${formatLap(car.lastLap)}`);
    }

    onWreck(car) {
        const onScreen = this.shot && (this.shot.car === car || this.shot.rival === car);
        if (car.position > 25 && !onScreen) return;
        this.say('wreck', 'Out', `${nameOf(car)} is wrecked in P${car.position}`);
        if (car.position <= 15 || onScreen) this.request(car, 'incident', 'tv');
    }

    request(car, kind, mode) {
        if (this.pending && PRIORITY[this.pending.kind] > PRIORITY[kind]) return;
        this.pending = { car, kind, mode };
    }

    /** Queue a callout. A newer fastest lap replaces one still waiting. */
    say(kind, title, text) {
        if (kind === 'fastest') this.callouts = this.callouts.filter(c => c.kind !== 'fastest');
        this.callouts.push({ kind, title, text });
        if (this.callouts.length > 3) this.callouts.shift();
    }

    // ── Render side: called every frame before the camera is placed ──────

    /** The shot to show this frame: { car, mode }. */
    view(now) {
        const elapsed = this.race.clock - COUNTDOWN;
        if (!this.shot || now - this.evalAt >= EVAL_MS) {
            this.evalAt = now;
            this.direct(now, elapsed);
        }
        return this.shot;
    }

    /** After the camera: the picture in picture and the graphics. */
    draw(now) {
        this.updatePip();
        if (now - this.domAt >= DOM_MS) {
            this.domAt = now;
            try { this.updateDom(now); } catch { /* graphics are decoration */ }
        }
    }

    /** The camera button: cut now, to the next best thing. */
    cutNow() {
        if (!this.shot) return;
        this.shot.at = -Infinity;
        this.shot.forced = true;
        this.evalAt = 0;
    }

    direct(now, elapsed) {
        const order = this.order;
        if (!order.length) return;
        if (elapsed < 0 || !this.shot) {
            if (!this.shot) this.cut({ car: order[0], rival: null, kind: 'grid', mode: 'far' }, now);
            return;
        }
        const cur = this.shot;
        const held = now - cur.at;
        if (this.pending && held >= EVENT_HOLD) {
            const p = this.pending;
            this.pending = null;
            this.cut({ car: p.car, rival: null, kind: p.kind, mode: p.mode }, now);
            return;
        }
        // The grid shot gives way as soon as the lights are out.
        if (held < MIN_HOLD && !(cur.kind === 'grid' && elapsed > 1.5)) return;

        const battles = this.battles();
        let valid, curScore = 0;
        if (cur.kind === 'battle') {
            const b = battles.find(x => x.att === cur.car && x.def === cur.rival);
            valid = !!b;
            curScore = b?.score ?? 0;
        } else if (cur.kind === 'leader') {
            valid = cur.car === order[0] && !cur.car.finished;
        } else if (cur.kind === 'flag') {
            valid = held < 9000;
        } else {
            valid = false;   // grid, incident: one look is enough
        }
        const fresh = battles.filter(b => b.gap < BATTLE_GAP && !(cur.kind === 'battle' && (b.att === cur.car || b.def === cur.car)));
        const better = fresh[0] && fresh[0].score > curScore * 1.6;
        if (valid && held < MAX_HOLD && !better && !cur.forced) return;

        const pick = fresh[0];
        if (pick) {
            this.cut({ car: pick.att, rival: pick.def, kind: 'battle', mode: this.nextMode() }, now);
        } else if (valid && cur.kind === 'battle' && !cur.forced) {
            // Nothing else on track worth a look: stay with this fight, from another angle.
            cur.mode = this.nextMode();
            cur.at = now;
        } else {
            const lead = order.find(c => !c.body.wrecked) || order[0];
            this.cut({ car: lead, rival: null, kind: 'leader', mode: cur.mode === 'tv' ? 'far' : 'tv' }, now);
        }
    }

    /** Pairs of running cars nose to tail, best first. */
    battles() {
        const out = [];
        const o = this.order;
        for (let i = 0; i + 1 < o.length && i < 60; i++) {
            const a = o[i], b = o[i + 1];
            if (a.finished || b.finished || a.body.wrecked || b.body.wrecked) continue;
            const d = a.body.distance - b.body.distance;
            if (d < 0 || d > this.L * 0.5) continue;
            const gap = battleGap(a, b);
            if (gap > BATTLE_LOST) continue;
            out.push({ att: b, def: a, gap, place: i + 1, score: (BATTLE_LOST - gap) * (1 + 4 / (i + 1)) });
        }
        return out.sort((x, y) => y.score - x.score);
    }

    nextMode() {
        this.modeIx = (this.modeIx + 1) % SHOTS.length;
        return SHOTS[this.modeIx];
    }

    cut(shot, now) {
        shot.at = now;
        this.shot = shot;
        this.pass = null;
        this.domAt = 0;
    }

    updatePip() {
        const scene = this.race.scene;
        const sh = this.shot;
        let p = null;
        if (sh?.kind === 'battle' && sh.rival) p = { car: sh.rival, back: true };
        else if (sh?.kind === 'leader' && sh.mode === 'tv') p = { car: sh.car, back: false };
        if (!p) { scene.setPip?.(null); this.pipCar = null; return; }
        const r = p.car.render;
        scene.setPip?.({ x: r.x, y: r.y, heading: r.heading, h: r.h, pitch: r.pitch, back: p.back });
        this.pipCar = p;
    }

    // ── Graphics ─────────────────────────────────────────────────────────

    nodes() {
        if (this.dom?.root.isConnected) return this.dom;
        const root = document.getElementById('pocabinetBroadcast');
        if (!root) { this.dom = null; return null; }
        const q = (s) => root.querySelector(`[data-bc="${s}"]`);
        this.dom = {
            root,
            lap: q('lap'),
            rows: [...root.querySelectorAll('[data-bc-row]')].map(li => ({
                li, pos: li.querySelector('[data-bc="rpos"]'), chip: li.querySelector('[data-bc="rchip"]'),
                code: li.querySelector('[data-bc="rcode"]'), gap: li.querySelector('[data-bc="rgap"]'),
            })),
            callout: q('callout'), ck: q('ck'), ct: q('ct'),
            lower: q('lower'), shot: q('shot'), pos: q('pos'), chip: q('chip'), name: q('name'), style: q('style'), meta: q('meta'),
            pip: q('pip'), pipLabel: q('piplabel'),
        };
        return this.dom;
    }

    updateDom(now) {
        const d = this.nodes();
        if (!d) return;
        const r = this.race;
        const elapsed = r.clock - COUNTDOWN;
        const order = this.order;
        const leader = order[0];
        const sh = this.shot;
        const focus = sh?.car;

        // Tower.
        setText(d.lap, elapsed < 0 ? 'Starting grid'
            : this.flagged ? 'Chequered flag'
                : `Lap ${Math.min(r.totalLaps, (leader?.lapsDone ?? 0) + 1)}/${r.totalLaps}`);
        const shown = order.slice(0, TOWER_ROWS);
        const extra = focus && focus.position > TOWER_ROWS ? focus : null;
        const rows = d.rows;
        const prevPos = this.prevRowPos || (this.prevRowPos = new Map());
        const nextPos = new Map();
        const moved = [];
        // Each car is timed at its own last checkpoint, so a car that just crossed one can read
        // closer than the car ahead that has not yet (P3 +1.700 under P2 +1.833). The tower
        // never shows that: a gap is at least the gap of the row above.
        let floor = 0;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            let car = null, gapText = '';
            if (i < shown.length) car = shown[i];
            else if (i === TOWER_ROWS + 1 && extra) car = extra;
            const sep = i === TOWER_ROWS && !!extra;
            setData(row.li, 'state', car ? 'car' : sep ? 'sep' : 'off');
            if (!car) {
                setText(row.pos, ''); setText(row.code, ''); setText(row.gap, '');
                setData(row.li, 'move', 'none');
                continue;
            }
            if (i < TOWER_ROWS) {
                nextPos.set(car.id, i);
                const oldIdx = prevPos.get(car.id);
                if (oldIdx !== undefined && oldIdx !== i) {
                    const rowH = row.li.offsetHeight || 22;
                    row.li.style.transition = 'none';
                    row.li.style.transform = `translateY(${(oldIdx - i) * rowH}px)`;
                    setData(row.li, 'move', oldIdx > i ? 'up' : 'down');
                    moved.push(row.li);
                } else {
                    setData(row.li, 'move', 'none');
                }
            } else {
                setData(row.li, 'move', 'none');
            }
            const gap = this.gapSeconds(car, leader, elapsed);
            if (gap !== null) floor = Math.max(floor, gap);
            gapText = gap !== null ? '+' + formatGap(floor) : this.gapText(car, leader, elapsed);
            setText(row.pos, String(car.position));
            setText(row.code, nameOf(car));
            setText(row.gap, gapText);
            if (row.chip.dataset.c !== car.color) { row.chip.dataset.c = car.color; row.chip.style.background = car.color; }
            setData(row.li, 'focus', car === focus || car === sh?.rival ? 'on' : 'off');
            setData(row.li, 'out', car.body.wrecked && !car.finished ? 'on' : 'off');
        }
        this.prevRowPos = nextPos;
        if (moved.length) {
            // Single layout flush so all displaced rows animate cleanly in parallel (FLIP).
            void moved[0].offsetHeight;
            for (const li of moved) {
                li.style.transition = '';
                li.style.transform = '';
            }
        }

        // Caption.
        if (focus) {
            const label = sh.kind === 'battle' && sh.rival ? `Battle for P${Math.min(focus.position, sh.rival.position)}`
                : sh.kind === 'leader' ? 'Race leader'
                    : sh.kind === 'incident' ? 'Incident'
                        : sh.kind === 'flag' ? 'Winner'
                            : 'Pole position';
            setText(d.shot, `${label} · ${SHOT_LABEL[sh.mode] || 'Live'}`);
            setText(d.pos, `P${focus.position}`);
            if (d.chip.dataset.c !== focus.color) { d.chip.dataset.c = focus.color; d.chip.style.background = focus.color; }
            setText(d.name, nameOf(focus));
            setText(d.style, ph.archetype(focus.persona) || '');
            const b = focus.body;
            const parts = [];
            if (b.wrecked) parts.push('Wrecked');
            else {
                parts.push(`${Math.round(Math.abs(focus.render.speed) * ph.KMH_PER_UNIT)} km/h`);
                const worst = Math.max(b.damage || 0, b.engine || 0);
                if (worst > 0.15) parts.push(worst > 0.65 ? 'Heavy damage' : 'Damaged');
            }
            if (sh.kind === 'battle' && sh.rival && !b.wrecked) {
                const gap = (sh.rival.body.distance - b.distance) / Math.max(30, Math.abs(b.speed));
                parts.push(gap >= 0 ? `${gap.toFixed(1)} s behind ${nameOf(sh.rival)}` : `alongside ${nameOf(sh.rival)}`);
            } else if (focus.bestLap > 0) {
                parts.push(`Best ${formatLap(focus.bestLap)}${focus.id === this.fastestId ? ' (fastest)' : ''}`);
            }
            setText(d.meta, parts.join(' · '));
            setData(d.lower, 'show', 'on');
        } else {
            setData(d.lower, 'show', 'off');
        }

        // Callouts: one at a time, each held CALLOUT_MS.
        if (this.callout && now - this.callout.at > CALLOUT_MS) {
            this.callout = null;
            this.calloutEndAt = now;
            setData(d.callout, 'show', 'off');
        }
        // A short gap between two callouts, so the second one slides in rather than swapping text.
        if (!this.callout && this.callouts.length && now - this.calloutEndAt > 400) {
            const c = this.callouts.shift();
            this.callout = { ...c, at: now };
            setText(d.ck, c.title);
            setText(d.ct, c.text);
            setData(d.callout, 'kind', c.kind);
            setData(d.callout, 'show', 'on');
        }

        // Picture in picture: the frame and its label over the scene's viewport.
        const rect = r.scene.pipRect;
        if (rect && this.pipCar && d.pip) {
            const canvas = r.scene.canvas;
            const parent = d.pip.offsetParent || d.pip.parentElement;
            const cb = canvas.getBoundingClientRect(), pb = parent.getBoundingClientRect();
            const st = d.pip.style;
            st.left = `${Math.round(cb.left - pb.left + rect.x)}px`;
            st.top = `${Math.round(cb.top - pb.top + rect.y)}px`;
            st.width = `${rect.w}px`;
            st.height = `${rect.h}px`;
            setText(d.pipLabel, `${this.pipCar.back ? 'Rear cam' : 'Onboard'} · ${nameOf(this.pipCar.car)}`);
            setData(d.pip, 'show', 'on');
        } else if (d.pip) {
            setData(d.pip, 'show', 'off');
        }
    }

    /** The timed gap to the leader in seconds, or null when the row shows a word instead (OUT, Leader, +N laps). */
    gapSeconds(car, leader, elapsed) {
        if ((car.body.wrecked && !car.finished) || elapsed < 0 || car === leader) return null;
        if (car.finished && leader?.finished) return car.finishTime - leader.finishTime;
        const behind = (leader?.body.distance ?? 0) - car.body.distance;
        if (Math.floor(behind / this.L) >= 1 && !car.finished) return null;
        return this.st.get(car)?.gap ?? 0;
    }

    gapText(car, leader, elapsed) {
        if (car.body.wrecked && !car.finished) return 'OUT';
        if (elapsed < 0) return '';
        if (car === leader) return car.finished ? 'Winner' : 'Leader';
        if (car.finished && leader?.finished) return '+' + formatGap(car.finishTime - leader.finishTime);
        const behind = (leader?.body.distance ?? 0) - car.body.distance;
        const laps = Math.floor(behind / this.L);
        if (laps >= 1 && !car.finished) return `+${laps} lap${laps > 1 ? 's' : ''}`;
        return '+' + formatGap(this.st.get(car)?.gap ?? 0);
    }

    dispose() {
        this.race.scene.setPip?.(null);
        const d = this.dom;
        if (d?.root.isConnected) {
            setData(d.callout, 'show', 'off');
            setData(d.pip, 'show', 'off');
        }
        this.dom = null;
    }
}

function nameOf(car) {
    // The demo's own car runs on autopilot under the viewer's name; a guest name is not one.
    if (car.isLocal) return 'Autopilot';
    return car.name || 'Driver';
}

function formatLap(s) {
    if (!(s > 0)) return '—';
    const m = Math.floor(s / 60);
    const rest = s - m * 60;
    return `${m}:${rest.toFixed(3).padStart(6, '0')}`;
}

function formatGap(s) {
    const v = Math.max(0, s);
    return v >= 60 ? formatLap(v) : v.toFixed(3);
}

function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
}

function setData(el, key, value) {
    if (el && el.dataset[key] !== value) el.dataset[key] = value;
}
