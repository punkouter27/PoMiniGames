// Quantified harm for PoCapitol: how badly a hit hurts, how fast someone bleeds, and how a
// casualty would be sorted. This is the measurement layer behind the inspector telemetry.
//
// It is a coarse simulation model, deliberately not clinical: it exists so the demo can report
// severity, estimated blood loss and a triage category as numbers, and so balance changes can be
// justified. It is not medical guidance and must not be used to predict real outcomes.
//
// Nothing here draws anything. The figures on screen still show no injury.

/** Injury severity on a 1..6 scale, in the spirit of AIS (1 minor .. 6 maximal). */
export function severityOf({ zone = 'torso', energy = 0, armor = 0 } = {}) {
    let severity = 2;
    if (zone === 'head') severity += 2;
    else if (zone === 'torso') severity += 1;
    // A limb hit that carries real energy still breaks bone or opens a vessel.
    else if (energy >= 250) severity += 1;
    if (energy >= 400) severity += 2;
    else if (energy >= 200) severity += 1;
    // A vest turns a serious torso wound into a bad bruise.
    if (armor > 0 && zone !== 'head') severity -= 2;
    return Math.max(1, Math.min(6, Math.round(severity)));
}

/** Uncontrolled bleeding in mL per minute for an injury of this severity. */
export function bleedRate(severity) {
    return [0, 15, 40, 120, 300, 700, 1400][Math.max(0, Math.min(6, Math.round(severity)))] ?? 0;
}

/** Estimated circulating volume in mL, at roughly 70 mL per kg. */
export function bloodVolume(mass) {
    const kg = Number.isFinite(mass) && mass > 0 ? mass : 72;
    return Math.round(kg * 70);
}

/**
 * Haemorrhage class from the share of blood volume lost:
 * 0 = none, I = up to 15%, II = 15-30%, III = 30-40%, IV = over 40%.
 */
export function hemorrhageClass(lossMl, volumeMl) {
    const share = volumeMl > 0 ? lossMl / volumeMl : 0;
    if (share >= 0.4) return 4;
    if (share >= 0.3) return 3;
    if (share >= 0.15) return 2;
    if (share > 0.02) return 1;
    return 0;
}

/** A triage category a responder could act on. */
export function triageFor(severity, hemorrhage) {
    if (severity >= 5 || hemorrhage >= 4) return 'Immediate';
    if (severity >= 3 || hemorrhage >= 3) return 'Delayed';
    if (severity >= 2) return 'Minimal';
    return 'Minimal';
}

/** A fresh harm record for one person. */
export function createHarm() {
    return { severity: 0, hits: 0, lossMl: 0, worstZone: null, worstSeverity: 0, downAt: -1 };
}

/**
 * Folds one hit into a person's record. `hit.energy` is impact energy in joules, as the physics
 * layer already reports it. Returns the severity of this hit.
 */
export function applyInjury(harm, { zone = 'torso', energy = 0, armor = 0 } = {}) {
    const severity = severityOf({ zone, energy, armor });
    harm.hits += 1;
    if (harm.worstZone === null || severity >= (harm.worstSeverity ?? 0)) {
        harm.worstZone = zone;
        harm.worstSeverity = severity;
    }
    harm.severity = Math.max(harm.severity, severity);
    return severity;
}

/**
 * Bleeds the record forward by `seconds`, at the rate its worst injury earns. Bleeding tapers as
 * the person goes down, because a casualty who is no longer moving loses volume more slowly.
 */
export function advanceHarm(harm, seconds, { down = false } = {}) {
    if (!Number.isFinite(seconds) || seconds <= 0 || harm.hits === 0) return harm.lossMl;
    const rate = bleedRate(harm.severity) * (down ? 0.45 : 1);
    harm.lossMl += rate * seconds / 60;
    return harm.lossMl;
}

/** Everything the telemetry panel needs, from a record and a body mass. */
export function harmSummary(harm, mass) {
    if (!harm || harm.hits === 0) {
        return { hits: 0, severity: 0, worstZone: null, lossMl: 0, volumeMl: bloodVolume(mass), hemorrhage: 0, triage: 'Minimal' };
    }
    const volumeMl = bloodVolume(mass);
    const hemorrhage = hemorrhageClass(harm.lossMl, volumeMl);
    return {
        hits: harm.hits,
        severity: harm.severity,
        worstZone: harm.worstZone,
        lossMl: Math.round(harm.lossMl),
        volumeMl,
        hemorrhage,
        triage: triageFor(harm.severity, hemorrhage),
    };
}
