// warmup.js — compile every shader before the first real frame.
//
// The first frame that shows a new material stalls while the driver compiles its program: a
// visible hitch exactly when an effect first appears (first hit spark, first blood decal).
// PoBrawl fixed this for itself with hidden "keeper" meshes plus compileAsync; this is that
// fix for every 3D game.
//
//   const keep = keepers(THREE, scene, [sparkMaterial, decalMaterial]);  // effects not yet on screen
//   await warmup(renderer, scene, camera);
//   keep.release();

/**
 * Put tiny invisible-to-the-eye meshes carrying `materials` into the scene so the compile
 * pass sees them. Returns { release() } to take them out again.
 */
export function keepers(THREE, scene, materials) {
    const geo = new THREE.PlaneGeometry(0.001, 0.001);
    const group = new THREE.Group();
    group.name = 'warmup-keepers';
    for (const m of materials) {
        const mesh = new THREE.Mesh(geo, m);
        mesh.frustumCulled = false;
        mesh.renderOrder = -1e6;
        group.add(mesh);
    }
    scene.add(group);
    return {
        group,
        release() { scene.remove(group); geo.dispose(); },
    };
}

/**
 * Compile the scene's programs (async where the renderer supports it, KHR_parallel_shader_compile
 * keeps the main thread free), then render one frame off-screen so textures upload too.
 * @param {{renderTarget?:boolean, timeoutMs?:number}} [o]
 * @returns {Promise<number>} milliseconds spent
 */
export async function warmup(renderer, scene, camera, o = {}) {
    const t0 = performance.now();
    const timeout = o.timeoutMs ?? 8000;
    const compile = renderer.compileAsync
        ? renderer.compileAsync(scene, camera)
        : Promise.resolve(renderer.compile?.(scene, camera));
    await Promise.race([compile, new Promise((r) => setTimeout(r, timeout))]);
    if (o.render !== false) {
        try { renderer.render(scene, camera); } catch { /* lost context: the real loop reports it */ }
    }
    return performance.now() - t0;
}
