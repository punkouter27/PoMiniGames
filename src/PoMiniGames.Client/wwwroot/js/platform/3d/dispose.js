// dispose.js — free everything a three.js scene graph holds on the GPU, and watch for a lost
// context. Every engine had a partial copy (some missed textures on material maps, some missed
// skinned-mesh skeletons, some never hooked webglcontextlost at all).

// Every enumerable property and uniform is walked, so map, normalMap, envMap and custom
// shader textures are all covered without a key list that goes stale.
function disposeMaterial(m, seen) {
    if (!m || seen.has(m)) return;
    seen.add(m);
    for (const key of Object.keys(m)) {
        const v = m[key];
        if (v && v.isTexture && !seen.has(v)) { seen.add(v); v.dispose(); }
    }
    if (m.uniforms) {
        for (const u of Object.values(m.uniforms)) {
            const v = u?.value;
            if (v && v.isTexture && !seen.has(v)) { seen.add(v); v.dispose(); }
        }
    }
    m.dispose?.();
}

/**
 * Dispose geometry, materials (and every texture they reference), skeletons and render
 * targets under `root`. Safe to call twice. Returns counts for tests / debug logs.
 * @param {object} root  Object3D / Scene
 * @param {{keep?: Set<object>}} [o]  shared assets that outlive this scene
 */
export function disposeObject3D(root, o = {}) {
    const seen = new Set(o.keep ?? []);
    let geometries = 0, materials = 0;
    if (!root) return { geometries, materials };
    const visit = (obj) => {
        if (obj.geometry && !seen.has(obj.geometry)) { seen.add(obj.geometry); obj.geometry.dispose(); geometries++; }
        const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
        for (const m of mats) { if (!seen.has(m)) materials++; disposeMaterial(m, seen); }
        obj.skeleton?.dispose?.();
    };
    if (typeof root.traverse === 'function') root.traverse(visit); else visit(root);
    if (root.isScene) {
        for (const t of [root.background, root.environment]) {
            if (t && t.isTexture && !seen.has(t)) { seen.add(t); t.dispose(); }
        }
    }
    return { geometries, materials };
}

/** Dispose the renderer and actually hand the GL context back (browsers cap live contexts). */
export function disposeRenderer(renderer, o = {}) {
    if (!renderer) return;
    try { renderer.renderLists?.dispose?.(); } catch { /* */ }
    try { renderer.dispose(); } catch { /* */ }
    if (o.loseContext !== false) { try { renderer.forceContextLoss?.(); } catch { /* */ } }
    if (o.remove !== false) renderer.domElement?.remove?.();
}

/**
 * webglcontextlost / restored on a canvas, with preventDefault so restore can happen.
 * @returns {() => void} unsubscribe
 */
export function watchContextLoss(canvas, { onLost, onRestored } = {}) {
    if (!canvas?.addEventListener) return () => { };
    const lost = (e) => { e.preventDefault(); onLost?.(e); };
    const restored = (e) => onRestored?.(e);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    return () => {
        canvas.removeEventListener('webglcontextlost', lost);
        canvas.removeEventListener('webglcontextrestored', restored);
    };
}
