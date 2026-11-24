// Home menu pager (Features/Home/Index.razor): the game grid is cut into pages that each fit the window, so the
// main menu never scrolls (Profile B, b_flow: 1366x768 and 375x667).
//
// measure() shows every card for one synchronous pass (no paint happens in between), groups them into the grid's
// rows by their top edge, and packs whole rows into pages: a page holds as many rows as fit in the height left once
// everything that is not the grid (header, marquee, pager, footer, bottom nav) is taken off the window. Blazor owns
// the `hidden` attributes; they are put back exactly as they were before this returns.
//
// attach() re-measures on resize, when a web font lands and when the grid changes size (both change card heights), turns PageUp/PageDown
// (anywhere on the page) and ArrowLeft/ArrowRight (on the pager) into page turns, and a horizontal swipe on the grid
// into the next/previous page.

const SWIPE_PX = 60;

export function measure(grid) {
    if (!grid) return [0];
    const cards = [...grid.querySelectorAll(':scope > .home-card')];
    if (cards.length === 0) return [0];
    const saved = cards.map(c => c.hidden);
    cards.forEach(c => { c.hidden = false; });
    try {
        const root = document.documentElement;
        const chrome = root.scrollHeight - grid.offsetHeight;
        const avail = window.innerHeight - chrome;
        const gap = parseFloat(getComputedStyle(grid).rowGap) || 0;
        // Rows: consecutive cards sharing a top edge (one card per row in the one-column layouts).
        const rows = [];
        for (let i = 0; i < cards.length; i++) {
            const top = Math.round(cards[i].offsetTop);
            const h = cards[i].offsetHeight;
            const last = rows[rows.length - 1];
            if (last && Math.abs(last.top - top) <= 2) {
                last.height = Math.max(last.height, h);
            } else {
                rows.push({ start: i, top, height: h });
            }
        }
        const starts = [0];
        let used = 0;
        for (const row of rows) {
            const need = (used === 0 ? 0 : gap) + row.height;
            if (used > 0 && used + need > avail) {
                starts.push(row.start);
                used = row.height;
            } else {
                used += need;
            }
        }
        return starts;
    } finally {
        cards.forEach((c, i) => { c.hidden = saved[i]; });
    }
}

export function attach(grid, pager, dotnet) {
    let timer = 0;
    const remeasure = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            dotnet.invokeMethodAsync('OnPagesMeasured', measure(grid)).catch(() => { /* page left */ });
        }, 120);
    };
    const turn = (delta) => dotnet.invokeMethodAsync('TurnPage', delta).catch(() => { /* page left */ });

    const onKey = (e) => {
        if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        if (document.querySelector('dialog[open]')) return;
        const onPager = pager && pager.contains(t);
        if (e.key === 'PageDown' || (onPager && e.key === 'ArrowRight')) { e.preventDefault(); turn(1); }
        else if (e.key === 'PageUp' || (onPager && e.key === 'ArrowLeft')) { e.preventDefault(); turn(-1); }
    };

    let sx = 0, sy = 0, sid = -1;
    const onDown = (e) => { if (e.isPrimary) { sx = e.clientX; sy = e.clientY; sid = e.pointerId; } };
    const onUp = (e) => {
        if (e.pointerId !== sid) return;
        sid = -1;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) turn(dx < 0 ? 1 : -1);
    };

    // A web font landing late (the Material Symbols card icons, Space Grotesk titles) changes card heights after
    // the first measure: the grid's own size changing is the signal to pack the rows again.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(remeasure) : null;
    if (ro) ro.observe(grid);
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', remeasure);

    window.addEventListener('resize', remeasure);
    document.addEventListener('keydown', onKey);
    grid.addEventListener('pointerdown', onDown);
    grid.addEventListener('pointerup', onUp);
    grid.addEventListener('pointercancel', () => { sid = -1; });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure, () => {});
    remeasure();

    return {
        remeasure,
        dispose() {
            clearTimeout(timer);
            if (ro) ro.disconnect();
            if (document.fonts && document.fonts.removeEventListener) document.fonts.removeEventListener('loadingdone', remeasure);
            window.removeEventListener('resize', remeasure);
            document.removeEventListener('keydown', onKey);
            grid.removeEventListener('pointerdown', onDown);
            grid.removeEventListener('pointerup', onUp);
        },
    };
}
