/**
 * After-action recorder for one attempt.
 *
 * The simulation already knows everything worth charting — police-line integrity, the
 * pressure against it, who is still standing, milestone times and the harm totals — but it
 * keeps only the current tick. This module samples that into a small series as the attempt
 * runs and turns it into one plain object the page can chart, export as CSV, or announce.
 *
 * Pure: it takes a state and returns data. No DOM, no storage, no clock of its own.
 */
const SAMPLE_SECONDS = 1;

export function createRecorder({ maxSamples = 900, labels = [] } = {}) {
    const series = [];
    const milestones = [];
    let lastMilestone = 0;
    let nextSample = 0;
    let peakPressure = 0;
    let lowestIntegrity = 100;
    let casualties = 0;
    let immediate = 0;

    return {
        reset() {
            series.length = 0;
            milestones.length = 0;
            lastMilestone = 0;
            nextSample = 0;
            peakPressure = 0;
            lowestIntegrity = 100;
            casualties = 0;
            immediate = 0;
        },

        /** Call every frame; it only records at its own cadence, so the cost is bounded. */
        step(state) {
            if (!state) return;
            if (state.milestone > lastMilestone) {
                lastMilestone = state.milestone;
                milestones.push({ at: Math.round(state.elapsed * 10) / 10, index: state.milestone, label: labels[state.milestone - 1] ?? '' });
            }
            casualties = Math.max(casualties, state.harmed ?? 0);
            immediate = Math.max(immediate, state.immediate ?? 0);
            if (state.elapsed < nextSample) return;
            nextSample = state.elapsed + SAMPLE_SECONDS;
            const line = state.lines?.find(l => l.state === 'holding') ?? state.lines?.[0];
            const integrity = line ? Math.round(line.integrity) : 0;
            const pressure = line ? Math.round(line.pressure * 10) / 10 : 0;
            peakPressure = Math.max(peakPressure, pressure);
            lowestIntegrity = Math.min(lowestIntegrity, integrity);
            series.push({
                at: Math.round(state.elapsed * 10) / 10,
                integrity,
                pressure,
                raiders: state.companions.filter(c => c.health > 0).length,
                police: state.enemies.filter(e => e.health > 0).length,
                casualties: state.harmed ?? 0,
            });
            if (series.length > maxSamples) series.shift();
        },

        /** Everything the report needs, as one flat object. */
        build(state, meta = {}) {
            const firstBreak = (state.lines ?? []).reduce(
                (earliest, line) => line.brokenAt >= 0 && (earliest < 0 || line.brokenAt < earliest) ? line.brokenAt : earliest, -1);
            return {
                mode: meta.mode ?? (state.demo ? 'demo' : 'solo'),
                role: meta.role ?? state.role,
                difficulty: state.difficulty,
                outcome: state.outcome ?? state.status,
                status: state.status,
                elapsed: Math.round(state.elapsed * 10) / 10,
                clock: meta.clock ?? '',
                standing: state.companions.filter(c => c.health > 0).length,
                police: state.enemies.filter(e => e.health > 0).length,
                casualties,
                immediate,
                peakPressure: Math.round(peakPressure * 10) / 10,
                lowestIntegrity,
                firstBreak: firstBreak >= 0 ? Math.round(firstBreak * 10) / 10 : null,
                pushes: state.pushes ?? 0,
                staggers: state.staggers ?? 0,
                milestones: milestones.slice(),
                series: series.slice(),
            };
        },
    };
}

/** The series as CSV, one row per sample. Bounded by maxSamples, so a file is always small. */
export function toCsv(report) {
    const rows = ['minute,line_integrity,line_pressure,raiders_standing,police_standing,casualties'];
    for (const s of report.series ?? []) {
        rows.push([s.at, s.integrity, s.pressure, s.raiders, s.police, s.casualties].join(','));
    }
    return rows.join('\n');
}

/** A short plain-text report for the clipboard or a screen reader. */
export function toText(report) {
    const lines = [
        `PoCapitol ${report.mode} · ${report.difficulty} · ${report.role}`,
        `Ended: ${report.outcome || report.status} (${report.status}) at ${report.clock || `${report.elapsed}s`}`,
        `${report.standing} raiders and ${report.police} police still standing`,
        `Milestones: ${(report.milestones ?? []).map(m => `${m.label || `#${m.index}`} @ ${m.at}s`).join(', ') || 'none'}`,
        `Lowest line integrity ${report.lowestIntegrity}%, peak pressure ${report.peakPressure}`,
        `First line broken: ${report.firstBreak === null ? 'never' : `${report.firstBreak}s`}`,
        `Casualties ${report.casualties} (${report.immediate} immediate)`,
    ];
    return lines.join('\n');
}

/**
 * The report as one self-contained SVG: line integrity against the pressure pushing on it,
 * with a tick where each milestone was crossed. Literal colours, not CSS variables, so the
 * page can serialise it straight to a PNG.
 */
export function toSvg(report, { width = 640, height = 220 } = {}) {
    const series = report.series ?? [];
    if (series.length < 2) return '';
    const pad = { l: 36, r: 12, t: 18, b: 26 };
    const w = width - pad.l - pad.r, h = height - pad.t - pad.b;
    const tMax = Math.max(1, series[series.length - 1].at);
    const x = at => pad.l + (at / tMax) * w;
    const yIntegrity = v => pad.t + (1 - Math.max(0, Math.min(100, v)) / 100) * h;
    const maxPressure = Math.max(1, ...series.map(s => s.pressure));
    const yPressure = v => pad.t + (1 - Math.max(0, Math.min(maxPressure, v)) / maxPressure) * h;
    const points = (value, toY) => series.map(s => `${x(s.at).toFixed(1)},${toY(value(s)).toFixed(1)}`).join(' ');

    const parts = [
        `<svg xmlns="http://www.w3.org/2000/svg" id="pocapitol-report-chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`,
        `<title>Line integrity and crowd pressure over the attempt</title>`,
        `<rect width="${width}" height="${height}" fill="#0d1520"/>`,
    ];
    for (const value of [0, 50, 100]) {
        const y = yIntegrity(value).toFixed(1);
        parts.push(`<line x1="${pad.l}" y1="${y}" x2="${pad.l + w}" y2="${y}" stroke="#2a3d55" stroke-width="1"/>`);
        parts.push(`<text x="${pad.l - 6}" y="${Number(y) + 3}" fill="#7f95ad" font-size="9" text-anchor="end" font-family="monospace">${value}</text>`);
    }
    for (const milestone of report.milestones ?? []) {
        const mx = x(milestone.at).toFixed(1);
        parts.push(`<line x1="${mx}" y1="${pad.t}" x2="${mx}" y2="${pad.t + h}" stroke="#c9a227" stroke-width="1" stroke-dasharray="3 3"/>`);
        if (milestone.index > 0) {
            parts.push(`<text x="${Number(mx) + 3}" y="${pad.t + 9}" fill="#c9a227" font-size="8" font-family="monospace">${milestone.index}</text>`);
        }
    }
    parts.push(`<polyline points="${points(s => s.pressure, yPressure)}" fill="none" stroke="#ff9f43" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.9"/>`);
    parts.push(`<polyline points="${points(s => s.integrity, yIntegrity)}" fill="none" stroke="#54a0ff" stroke-width="2"/>`);
    parts.push(`<text x="${pad.l}" y="${height - 8}" fill="#7f95ad" font-size="9" font-family="monospace">0 min</text>`);
    parts.push(`<text x="${pad.l + w}" y="${height - 8}" fill="#7f95ad" font-size="9" text-anchor="end" font-family="monospace">${Math.round(tMax / 60)} min</text>`);
    parts.push(`<text x="${pad.l + w}" y="${pad.t + 9}" fill="#54a0ff" font-size="9" text-anchor="end" font-family="monospace">— integrity</text>`);
    parts.push(`<text x="${pad.l + w}" y="${pad.t + 20}" fill="#ff9f43" font-size="9" text-anchor="end" font-family="monospace">- - pressure (max ${Math.round(maxPressure)})</text>`);
    parts.push('</svg>');
    return parts.join('');
}
