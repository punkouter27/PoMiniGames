// pofighter/arcade.js — the two modes a person plays (demo.js runVersus draws the fights):
//
//   startArcade(root, dotnetRef, opts, session)  1P: you against every other fighter in turn,
//       lowest Elo first, then your own Shadow (a mirror match in the Shadow palette). Each stage
//       is best of three; a draw replays the stage, a loss ends the run. Between stages the
//       ladder is drawn into [data-pf-bracket]. At the end: dotnetRef 'ArcadeFinished'(cleared,
//       stages, won, lastOpponent).
//   startVersus(root, dotnetRef, opts, session)  2P on one device: P1 (WASD F/G) vs P2 (arrows
//       K/L), or two pads; one best-of-three, then 'VersusFinished'(winnerName, isDraw).
//
// Neither posts to the fighter Elo board: it rates the characters from CPU-vs-CPU bouts, and a
// human's skill would skew it. Studio fighters (studio.js, this browser only) can be picked too.

import { resume } from '../platform/audioBus.js';
import { loadAllFighters, PALETTES } from './art.js';
import { runVersus } from './demo.js';
import { createInput } from './input.js';

const LADDER_SECONDS = 3;
const wait = (session, s) => new Promise(r => {
    const id = setTimeout(r, s * 1000);
    session.cleanup.push(() => { clearTimeout(id); r(); });
});
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The arcade ladder for a pick: the others by Elo (lowest first, then by name), then the Shadow. */
export function ladderFor(all, pickId, ratings = {}) {
    const me = all.find(f => f.id === pickId) ?? all[0];
    const elo = f => ratings[f.id] ?? 1000;   // the server board's seed (PairwiseEloOptions.SeedElo)
    const others = all.filter(f => f.id !== me.id).sort((a, b) => elo(a) - elo(b) || a.name.localeCompare(b.name));
    const shadow = { ...me, name: `${PALETTES[1].name} ${me.name}`, palette: 1, boss: true };
    return { me, stages: [...others, shadow] };
}

function renderLadder(el, me, stages, current, cleared) {
    const tile = (f, cls) => `<li class="pfl-stage ${cls}">${f.portrait
        ? `<img src="${esc(f.portrait)}" alt=""${f.palette ? ` style="filter:${esc(PALETTES[f.palette].filter)}"` : ''}>` : ''}
        <span>${esc(f.name)}</span></li>`;
    el.innerHTML = `<div class="pfb-head">STAGE ${current + 1} / ${stages.length}</div>
        <div class="pfl-vs"><span class="pfl-you">${esc(me.name)}</span><span class="pfl-x">VS</span>
            <span class="pfl-foe">${esc(stages[current].name)}</span></div>
        <ol class="pfl-ladder">${stages.map((f, i) =>
            tile(f, i < cleared ? 'pfl-stage--done' : i === current ? 'pfl-stage--next' : '')).join('')}</ol>`;
    el.hidden = false;
}

export async function startArcade(root, dotnetRef, opts, session) {
    resume().catch(() => { });   // the start card's OK was the gesture that unlocks audio
    const all = await loadAllFighters();
    if (session.stopped || !all) return false;
    const { me, stages } = ladderFor(all, opts?.fighterId, opts?.ratings ?? {});
    const difficulty = opts?.difficulty ?? 'normal';
    const input = createInput(root, 'solo', session);
    const board = root.querySelector('[data-pf-bracket]');

    (async () => {
        let cleared = 0;
        while (cleared < stages.length && !session.stopped) {
            renderLadder(board, me, stages, cleared, cleared);
            await wait(session, LADDER_SECONDS);
            if (session.stopped) return;
            board.hidden = true;
            const foe = stages[cleared];
            const final = cleared === stages.length - 1;
            const result = await runVersus(root, session, [{ ...me, input }, foe],
                { label: final ? 'FINAL STAGE' : `STAGE ${cleared + 1}`, final, difficulty });
            if (!result || session.stopped) return;
            if (result.winnerIndex === 0) cleared++;
            else if (result.winnerIndex === 1) break;
            // A draw replays the stage.
        }
        if (session.stopped) return;
        const won = cleared === stages.length;
        dotnetRef?.invokeMethodAsync('ArcadeFinished', cleared, stages.length, won,
            stages[Math.min(cleared, stages.length - 1)].name).catch(() => { });
    })();
    return true;
}

export async function startVersus(root, dotnetRef, opts, session) {
    resume().catch(() => { });
    const all = await loadAllFighters();
    if (session.stopped || !all) return false;
    const pick = id => all.find(f => f.id === id) ?? all[0];
    const p1 = pick(opts?.p1), p2 = pick(opts?.p2);
    const fighters = [
        { ...p1, input: createInput(root, 'p1', session) },
        { ...p2, input: createInput(root, 'p2', session) },
    ];
    (async () => {
        const result = await runVersus(root, session, fighters, { label: '2 PLAYERS' });
        if (!result || session.stopped) return;
        const name = result.winnerIndex >= 0 ? `P${result.winnerIndex + 1} · ${fighters[result.winnerIndex].name}` : '';
        dotnetRef?.invokeMethodAsync('VersusFinished', name, result.isDraw).catch(() => { });
    })();
    return true;
}
