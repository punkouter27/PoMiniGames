// PoCapitol Tactical Unit Inspector & Telemetry Module
// Provides deep unit telemetry (role, gear, stamina, morale, activity)
// and camera-latching for any demonstrator or police officer.

import { lineDefs, milestones } from './world.js';
import { harmSummary } from './harm.js';

export function createInspector({ onTelemetryChange } = {}) {
    let currentUnit = null;
    let currentFaction = null;
    let latched = false;

    function formatTelemetry(unit, state) {
        if (!unit) return null;
        const isPolice = unit.faction === 'capitol-police' || unit.faction === 'police';
        const roleLabel = isPolice
            ? (unit.id % 5 === 0 ? 'Squad Sergeant · Riot Defense' : 'Line Officer · Shield Unit')
            : unit.temperament === 'pusher'
            ? 'Frontline Raider · Breakthrough Surge'
            : unit.temperament === 'medic'
            ? 'Street Medic · Field First Aid'
            : unit.temperament === 'bystander'
            ? 'Documentary Bystander · Mobile Streaming'
            : 'Demonstration Follower · Crowd Support';

        const gear = isPolice
            ? `${Math.round(unit.mass || 92)} kg · Polycarbonate Riot Shield, Baton, Protective Vest`
            : `${Math.round(unit.mass || 74)} kg · Insulated Winter Coat, Boots, Backpack`;

        const line = isPolice && unit.line >= 0 && unit.line < lineDefs.length ? lineDefs[unit.line].name : null;
        const currentMilestone = !isPolice && unit.milestone >= 0 && unit.milestone < milestones.length ? milestones[unit.milestone].label : null;
        const harm = harmSummary(unit.harm, unit.mass);

        let statusText = 'Active';
        if (unit.health <= 0) {
            statusText = isPolice ? 'Downed / Incapacitated' : unit.resting ? 'Resting at Aid Station' : 'Downed · Awaiting Medic';
        } else if (isPolice) {
            statusText = unit.stagger > 0 ? 'Staggered by Impact' : unit.attacking > 0 ? 'Engaging with Baton / Spray' : 'Holding Defensive Line';
        } else {
            statusText = unit.retreating ? 'Falling Back to Catch Breath' : unit.sprayed > 0 ? 'Disoriented by Pepper Spray' : unit.crowding > 3 ? 'Surging at Barrier' : unit.filming ? 'Filming Scene' : 'Advancing';
        }

        return {
            id: unit.id,
            faction: isPolice ? 'police' : 'raider',
            name: isPolice ? `OFFICER #${unit.id + 1}` : `RAIDER #${unit.id + 1}`,
            role: roleLabel,
            gear,
            health: Math.max(0, Math.round((unit.health / (isPolice ? 10 : 30)) * 100)),
            rawHealth: unit.health,
            stamina: Math.max(0, Math.min(100, Math.round((unit.morale ?? 0.8) * 100))),
            mass: Math.round(unit.mass || 75),
            status: statusText,
            lineAssignment: line,
            milestone: currentMilestone,
            crowding: unit.crowding || 0,
            x: unit.x,
            z: unit.z,
            latched,
            // Flat fields, so the trimmed WASM build needs no nested-deserialisation support.
            harmHits: harm.hits,
            harmSeverity: harm.severity,
            harmLossMl: harm.lossMl,
            harmHemorrhage: harm.hemorrhage,
            harmTriage: harm.triage,
        };
    }

    function select(unit, state, autoLatch = true) {
        currentUnit = unit;
        if (!unit) {
            latched = false;
            onTelemetryChange?.(null);
            return;
        }
        currentFaction = unit.faction === 'capitol-police' || unit.faction === 'police' ? 'police' : 'raider';
        if (autoLatch) latched = true;
        const tele = formatTelemetry(unit, state);
        onTelemetryChange?.(tele);
    }

    function toggleLatch(state) {
        latched = !latched;
        if (currentUnit) onTelemetryChange?.(formatTelemetry(currentUnit, state));
        return latched;
    }

    function clear() {
        currentUnit = null;
        latched = false;
        onTelemetryChange?.(null);
    }

    function getSelected() {
        return currentUnit;
    }

    function isLatched() {
        return latched && currentUnit;
    }

    function update(state) {
        if (!currentUnit) return;
        // Keep telemetry fresh each tick
        const pool = currentFaction === 'police' ? state.enemies : state.companions;
        const fresh = pool.find(u => u.id === currentUnit.id);
        if (fresh) {
            currentUnit = fresh;
            onTelemetryChange?.(formatTelemetry(fresh, state));
        }
    }

    return { select, toggleLatch, clear, getSelected, isLatched, update };
}
