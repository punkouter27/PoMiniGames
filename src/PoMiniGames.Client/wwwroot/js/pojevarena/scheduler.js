// pojevarena/scheduler.js — the staggered decision scheduler.
//
// Every 250 ms of *sim* time (15 ticks) it sends one batch: the living units whose slot is due
// (slot = unit index mod 4). Scheduling on sim time rather than wall time means a paused or hidden
// tab (the loop stops stepping) makes no calls at all.
//
// How often a unit is asked: the free rule-based brain on the server answers every unit once a
// second.
//
// A unit with a request in flight is skipped, never double-asked. Failures change nothing: the
// unit keeps acting on its last intent, indefinitely, and its stale timer keeps climbing for the
// inspector. Account-level stops (match expired) end scheduling for the match; units hold their
// intents to the end.

import { measure, applyDecision } from './sim.js';

export const SLOT_TICKS = 15;
export const SLOTS = 4;
const MAX_BATCHES_IN_FLIGHT = 3;
const STOPPING_NOTICES = new Set(['match-expired']);

/**
 * decide(batch) → Promise<{ decisions, notice } | { error }>, where batch is
 * { units: ArenaUnitState[] }. onDecision(frame, unitIdx, decision, request) records it.
 */
export function createScheduler(world, { decide, onDecision, onNotice, brain = 'local' }) {
    const inFlight = new Set();
    const lastDecided = new Float64Array(world.units.length).fill(0);   // sim time of last answer
    let batchesInFlight = 0;
    let stopped = null;
    let calls = 0;

    async function send(indices) {
        const requests = new Map();
        const units = [];
        for (const i of indices) {
            const m = measure(world, i);
            requests.set(m.state.unit, { idx: i, candidates: m.candidates, state: m.state, frame: world.tick });
            units.push(m.state);
            inFlight.add(i);
        }
        batchesInFlight++;
        calls += units.length;

        let response;
        try {
            response = await decide({ units });
        } catch {
            response = { error: 'network' };
        } finally {
            batchesInFlight--;
            for (const i of indices) inFlight.delete(i);
        }

        if (!response) response = { error: 'network' };
        if (response.error) {
            if (STOPPING_NOTICES.has(response.error)) stop(response.error);
            for (const r of requests.values()) onDecision(world.tick, r.idx, { ok: false, failure: response.error }, r);
            return;
        }

        for (const d of response.decisions || []) {
            const r = requests.get(d.unit);
            if (!r) continue;
            const u = world.units[r.idx];
            if (d.ok && u.alive && !world.over) {
                applyDecision(world, r.idx, d, r.candidates);
                lastDecided[r.idx] = world.time;
            }
            onDecision(world.tick, r.idx, d, r);
        }
        if (response.notice && STOPPING_NOTICES.has(response.notice)) stop(response.notice);
        else if (response.notice) onNotice?.(response.notice);
    }

    function stop(reason) {
        if (stopped) return;
        stopped = reason;
        onNotice?.(reason);
    }

    return {
        /** Called once per sim tick, after step(). */
        tick() {
            if (stopped || world.over || world.tick % SLOT_TICKS !== 0) return;
            if (batchesInFlight >= MAX_BATCHES_IN_FLIGHT) return;
            const slot = (world.tick / SLOT_TICKS) % SLOTS;
            const due = world.units
                .filter(u => u.alive && u.idx % SLOTS === slot && !inFlight.has(u.idx))
                .map(u => u.idx);
            if (due.length) send(due);
        },
        /** Seconds since the unit last got a usable answer (from match start if never). */
        staleSeconds(idx) { return world.time - lastDecided[idx]; },
        get brain() { return brain; },
        get stoppedReason() { return stopped; },
        get calls() { return calls; },
        stop,
    };
}
