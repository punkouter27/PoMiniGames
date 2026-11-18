// camera2d.js — fitting a fixed-size world into a resizable view.
//
// fitWorld: the letterbox / pixel-perfect math every 2D game re-derived (PoFighter's
// "scale = min(w/W, h/H), bottom-aligned", PoMule's integer PX scale). Pure, so it is tested.
// Feed the result to stage.setTransform(cam.scale, cam.x, cam.y).

/**
 * @param {number} viewW  view width (CSS px)
 * @param {number} viewH  view height (CSS px)
 * @param {number} worldW world width (world units)
 * @param {number} worldH world height
 * @param {{mode?:'contain'|'cover', alignX?:'left'|'center'|'right', alignY?:'top'|'center'|'bottom',
 *          integer?:boolean, minScale?:number}} [opts]
 * @returns {{scale:number, x:number, y:number, w:number, h:number}}  x/y = world origin in view px
 */
export function fitWorld(viewW, viewH, worldW, worldH, opts = {}) {
    const sx = viewW / worldW;
    const sy = viewH / worldH;
    let scale = opts.mode === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
    if (opts.integer) scale = Math.max(opts.minScale ?? 1, Math.floor(scale));
    else if (opts.minScale) scale = Math.max(opts.minScale, scale);
    const w = worldW * scale;
    const h = worldH * scale;
    const ax = opts.alignX ?? 'center';
    const ay = opts.alignY ?? 'center';
    const x = ax === 'left' ? 0 : ax === 'right' ? viewW - w : (viewW - w) / 2;
    const y = ay === 'top' ? 0 : ay === 'bottom' ? viewH - h : (viewH - h) / 2;
    return { scale, x: opts.integer ? Math.round(x) : x, y: opts.integer ? Math.round(y) : y, w, h };
}

/** View px → world units for a fitWorld() result. */
export function viewToWorld(cam, px, py) {
    return { x: (px - cam.x) / cam.scale, y: (py - cam.y) / cam.scale };
}
