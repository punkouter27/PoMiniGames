// The inspector card's tether: the card belongs to the person it describes, so it opens from
// where they stand on screen, sits beside them, and a thin leader line runs from the card's
// edge to them every frame.
//
// Blazor owns the card and the line's <svg>; this only writes CSS custom properties on the
// game's root (--pc-ax/--pc-ay: the anchor in root pixels; --pc-card-x/--pc-card-y: where the
// card goes) and the line's end points. When nobody is selected, or the person is behind the
// camera, the properties are removed and the card falls back to its corner placement.
import * as THREE from 'three';
import { groundHeight } from './world.js';

const CARD_W = 340, CARD_H = 250, GAP = 28, EDGE = 12;

export function createLeader(root) {
    const point = new THREE.Vector3();
    let anchored = false, cardX = null, cardY = null;

    function clear() {
        if (!anchored) return;
        anchored = false; cardX = cardY = null;
        for (const p of ['--pc-ax', '--pc-ay', '--pc-card-x', '--pc-card-y']) root.style.removeProperty(p);
        root.removeAttribute('data-anchored');
    }

    /** Called once per frame after the render. `unit` is the inspector's selection (x, z) or null. */
    function update(camera, unit) {
        const card = root.querySelector('.pc-inspector-card');
        if (!camera || !unit || !card || !Number.isFinite(unit.x) || !Number.isFinite(unit.z)) { clear(); return; }
        const w = root.clientWidth, h = root.clientHeight;
        point.set(unit.x, groundHeight(unit.x, unit.z) + 1.75, unit.z).project(camera);
        if (point.z > 1 || point.z < -1) { clear(); return; }
        const ax = (point.x * 0.5 + 0.5) * w, ay = (-point.y * 0.5 + 0.5) * h;
        if (ax < -40 || ax > w + 40 || ay < -40 || ay > h + 40) { clear(); return; }
        const cw = Math.min(CARD_W, card.offsetWidth || CARD_W), ch = card.offsetHeight || CARD_H;
        // Beside the person, on whichever side has room, then clamped into the frame.
        const right = ax + GAP + cw < w - EDGE;
        let x = right ? ax + GAP : ax - GAP - cw;
        let y = ay - ch * 0.5;
        x = Math.max(EDGE, Math.min(w - cw - EDGE, x));
        y = Math.max(EDGE + 56, Math.min(h - ch - EDGE, y));
        // The card eases after the person instead of jittering with every step they take.
        cardX = cardX === null ? x : cardX + (x - cardX) * 0.18;
        cardY = cardY === null ? y : cardY + (y - cardY) * 0.18;
        root.style.setProperty('--pc-ax', `${ax.toFixed(1)}px`);
        root.style.setProperty('--pc-ay', `${ay.toFixed(1)}px`);
        root.style.setProperty('--pc-card-x', `${cardX.toFixed(1)}px`);
        root.style.setProperty('--pc-card-y', `${cardY.toFixed(1)}px`);
        if (!anchored) { anchored = true; root.setAttribute('data-anchored', ''); }
        const line = root.querySelector('.pc-leader line');
        if (line) {
            // From the nearer vertical edge of the card, at the person's height where possible.
            const ex = ax > cardX + cw / 2 ? cardX + cw : cardX;
            const ey = Math.max(cardY + 14, Math.min(cardY + ch - 14, ay));
            line.setAttribute('x1', ex.toFixed(1)); line.setAttribute('y1', ey.toFixed(1));
            line.setAttribute('x2', ax.toFixed(1)); line.setAttribute('y2', ay.toFixed(1));
        }
        const dot = root.querySelector('.pc-leader circle');
        if (dot) { dot.setAttribute('cx', ax.toFixed(1)); dot.setAttribute('cy', ay.toFixed(1)); }
    }

    return { update, clear };
}
