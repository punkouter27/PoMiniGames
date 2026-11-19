// pofighter/tournament.js — the 16-slot CPU tournament (bracket.js holds the rules).
//
// Every roster slot enters: the built-in fighters seeded by their Elo, then this browser's
// Studio fighters (seeded at 1500), the rest EMPTY (byes). Between bouts the bracket is shown
// in [data-pf-bracket] (built here, styled by the page's CSS); each real bout is a best-of-three
// on the canvas (demo.js runVersus). After a bout between two built-in fighters the page is told
// through dotnetRef.invokeMethodAsync('BoutFinished', winnerId, loserId, isDraw), and it posts
// the result to the fighter Elo board (a Studio fighter lives in one browser, so its bouts are
// not rated); at the end, 'TournamentFinished'(name).

import { createBracket, nextBout, recordResult, ROUND_NAMES, SIZE } from './bracket.js';
import { ROSTER, isBuiltIn, loadAllFighters } from './art.js';
import { runVersus } from './demo.js';
import { resume } from '../platform/audioBus.js';

const BRACKET_SECONDS = 3.5;      // the bracket stays up this long before a bout
const CHAMPION_SECONDS = 5;
const wait = (session, s) => new Promise(r => {
    const id = setTimeout(r, s * 1000);
    session.cleanup.push(() => { clearTimeout(id); r(); });
});

/** The 16 slots: built-in fighters first, then Studio fighters ([{ id, name, portrait }]), then EMPTY. */
export function slots(customs = []) {
    const entrants = [...ROSTER.map(f => ({ id: f.id, name: f.name })),
        ...customs.map(c => ({ id: c.id, name: c.name, portrait: c.portrait }))];
    return Array.from({ length: SIZE }, (_, i) => entrants[i]
        ? entrants[i]
        : { id: `empty-${i + 1}`, name: 'EMPTY', empty: true });
}

function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function renderBracket(el, bracket, current, championId) {
    const side = (f, m) => {
        if (!f) return '<li class="pfb-side pfb-side--tbd">—</li>';
        const cls = ['pfb-side', f.empty ? 'pfb-side--empty' : '',
            m.winner && m.winner.id === f.id && !f.empty ? 'pfb-side--won' : '',
            m.winner && m.winner.id !== f.id ? 'pfb-side--out' : '',
            championId && f.id === championId && m.round === 3 ? 'pfb-side--champ' : ''].join(' ');
        const src = f.empty ? '' : isBuiltIn(f.id) ? `data/pofighter/${f.id}-portrait.webp` : f.portrait ?? '';
        const portrait = src ? `<img src="${esc(src)}" alt="">` : '';
        return `<li class="${cls}">${portrait}<span>${esc(f.name)}</span>${f.seed && !f.empty ? `<small>${f.seed}</small>` : ''}</li>`;
    };
    el.innerHTML = `<div class="pfb-head">${championId ? 'CHAMPION' : current ? `NEXT · ${esc(ROUND_NAMES[current.round].toUpperCase())}` : ''}</div>
        <div class="pfb-rounds">${bracket.rounds.map((round, r) => `
            <section class="pfb-round" aria-label="${esc(ROUND_NAMES[r])}">
                <h3>${esc(ROUND_NAMES[r])}</h3>
                ${round.map(m => `<ol class="pfb-match${m === current ? ' pfb-match--next' : ''}${m.bye ? ' pfb-match--bye' : ''}">
                    ${side(m.a, m)}${side(m.b, m)}${m.bye ? '<li class="pfb-bye">BYE</li>' : ''}</ol>`).join('')}
            </section>`).join('')}
        </div>`;
    el.hidden = false;
}

export async function startTournament(root, dotnetRef, ratings, session) {
    resume().catch(() => { });   // the start card's OK was the gesture that unlocks audio
    const roster = await loadAllFighters();
    if (session.stopped || !roster) return false;
    const byId = new Map(roster.map(f => [f.id, f]));
    const bracket = createBracket(slots(roster.filter(f => f.custom)), ratings ?? {});
    session.state = bracket;
    const board = root.querySelector('[data-pf-bracket]');

    (async () => {
        for (let bout = nextBout(bracket); bout && !session.stopped; bout = nextBout(bracket)) {
            renderBracket(board, bracket, bout, null);
            await wait(session, BRACKET_SECONDS);
            if (session.stopped) return;
            board.hidden = true;
            const final = bout.round === ROUND_NAMES.length - 1;
            const result = await runVersus(root, session, [byId.get(bout.a.id), byId.get(bout.b.id)],
                { label: ROUND_NAMES[bout.round].toUpperCase(), final });
            if (!result || session.stopped) return;
            recordResult(bracket, bout, result.isDraw ? null : result.winnerId);
            if (isBuiltIn(result.winnerId) && isBuiltIn(result.loserId)) {
                dotnetRef?.invokeMethodAsync('BoutFinished', result.winnerId, result.loserId, result.isDraw).catch(() => { });
            }
        }
        if (session.stopped) return;
        renderBracket(board, bracket, null, bracket.champion?.id ?? null);
        await wait(session, CHAMPION_SECONDS);
        if (!session.stopped) dotnetRef?.invokeMethodAsync('TournamentFinished', bracket.champion?.name ?? '').catch(() => { });
    })();
    return true;
}
