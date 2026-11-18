// renderer.js — one way to build and size a three.js renderer.
//
// Eight engines each wrote `new THREE.WebGLRenderer(...)` followed by the same tone mapping,
// colour space, shadow and pixel-ratio lines, and a ResizeObserver that set size, composer
// size and camera aspect. This module owns that.
//
// THREE is passed in, never imported: the games share r165 ('three') while PoEcosystem runs
// the r186 WebGPU build ('three-eco/webgpu'), and the module stays loadable in node tests.
//
//   const renderer = await createRenderer(THREE, { api: 'auto', tone: 'aces', exposure: 1.1 });
//   attachRenderer(stage, renderer, { camera, composer });

const TONES = { none: 'NoToneMapping', linear: 'LinearToneMapping', reinhard: 'ReinhardToneMapping', cineon: 'CineonToneMapping', aces: 'ACESFilmicToneMapping', agx: 'AgXToneMapping', neutral: 'NeutralToneMapping' };
const SHADOWS = { basic: 'BasicShadowMap', pcf: 'PCFShadowMap', pcfsoft: 'PCFSoftShadowMap', vsm: 'VSMShadowMap' };

/**
 * Apply the look settings to an existing renderer (also used when a mode swaps tone mapping).
 * @param {object} THREE
 * @param {object} renderer
 * @param {{tone?:string, exposure?:number, shadows?:false|'basic'|'pcf'|'pcfsoft'|'vsm',
 *          colorSpace?:'srgb'|'linear', clearColor?:number|string, clearAlpha?:number}} o
 */
export function configureRenderer(THREE, renderer, o = {}) {
    if (o.tone !== undefined) {
        const key = TONES[o.tone];
        if (!key) throw new Error(`unknown tone mapping: ${o.tone}`);
        renderer.toneMapping = THREE[key] ?? THREE.ACESFilmicToneMapping;
    }
    if (o.exposure !== undefined) renderer.toneMappingExposure = o.exposure;
    if (o.colorSpace !== undefined) {
        renderer.outputColorSpace = o.colorSpace === 'linear' ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
    }
    if (o.shadows !== undefined && renderer.shadowMap) {
        renderer.shadowMap.enabled = !!o.shadows;
        if (o.shadows) renderer.shadowMap.type = THREE[SHADOWS[o.shadows === true ? 'pcfsoft' : o.shadows]];
    }
    if (o.clearColor !== undefined) renderer.setClearColor(o.clearColor, o.clearAlpha ?? 1);
    return renderer;
}

/** WebGPU usable here? (cheap probe; the adapter request is what really decides). */
export async function webgpuAvailable() {
    try {
        if (typeof navigator === 'undefined' || !navigator.gpu) return false;
        return !!(await navigator.gpu.requestAdapter());
    } catch { return false; }
}

/**
 * Build a renderer. `api`:
 *   'webgl'  — THREE.WebGLRenderer (default; every r165 game)
 *   'webgpu' — THREE.WebGPURenderer (needs a build that has it), awaits init()
 *   'auto'   — WebGPU when THREE has WebGPURenderer and an adapter exists, otherwise WebGL
 * Always async so callers do not care which one they got. `renderer.userData.api` says which.
 *
 * @param {object} THREE
 * @param {{api?:'webgl'|'webgpu'|'auto', canvas?:HTMLCanvasElement, antialias?:boolean, alpha?:boolean,
 *          powerPreference?:string, preserveDrawingBuffer?:boolean, forceWebGL?:boolean,
 *          tone?:string, exposure?:number, shadows?:any, colorSpace?:string, clearColor?:any, clearAlpha?:number,
 *          pixelRatio?:number}} [o]
 */
export async function createRenderer(THREE, o = {}) {
    const want = o.api ?? 'webgl';
    const canGpu = typeof THREE.WebGPURenderer === 'function';
    const useGpu = want === 'webgpu' ? canGpu : want === 'auto' ? canGpu && await webgpuAvailable() : false;
    if (want === 'webgpu' && !canGpu) throw new Error('this three build has no WebGPURenderer');

    const params = {
        antialias: o.antialias ?? false,
        alpha: o.alpha ?? false,
        powerPreference: o.powerPreference ?? 'high-performance',
    };
    if (o.canvas) params.canvas = o.canvas;
    if (o.preserveDrawingBuffer) params.preserveDrawingBuffer = true;

    let renderer;
    if (useGpu) {
        renderer = new THREE.WebGPURenderer({ ...params, forceWebGL: !!o.forceWebGL });
        await renderer.init?.();
    } else {
        return createRendererSync(THREE, o);
    }
    renderer.userData = { ...(renderer.userData ?? {}), api: useGpu ? 'webgpu' : 'webgl' };
    configureRenderer(THREE, renderer, {
        tone: o.tone ?? 'aces',
        exposure: o.exposure ?? 1,
        colorSpace: o.colorSpace ?? 'srgb',
        shadows: o.shadows ?? 'pcfsoft',
        ...(o.clearColor !== undefined ? { clearColor: o.clearColor, clearAlpha: o.clearAlpha } : {}),
    });
    if (o.pixelRatio) renderer.setPixelRatio(o.pixelRatio);
    return renderer;
}

/**
 * Synchronous WebGL-only build, for code paths that cannot await (a mount that must return a
 * value at once). Same options and defaults as createRenderer minus `api`.
 */
export function createRendererSync(THREE, o = {}) {
    const params = {
        antialias: o.antialias ?? false,
        alpha: o.alpha ?? false,
        powerPreference: o.powerPreference ?? 'high-performance',
    };
    if (o.canvas) params.canvas = o.canvas;
    if (o.preserveDrawingBuffer) params.preserveDrawingBuffer = true;
    const renderer = new THREE.WebGLRenderer(params);
    renderer.userData = { ...(renderer.userData ?? {}), api: 'webgl' };
    configureRenderer(THREE, renderer, {
        tone: o.tone ?? 'aces',
        exposure: o.exposure ?? 1,
        colorSpace: o.colorSpace ?? 'srgb',
        shadows: o.shadows ?? 'pcfsoft',
        ...(o.clearColor !== undefined ? { clearColor: o.clearColor, clearAlpha: o.clearAlpha } : {}),
    });
    if (o.pixelRatio) renderer.setPixelRatio(o.pixelRatio);
    return renderer;
}

/**
 * Size a renderer (+ composer + camera aspect) to a CSS size and pixel ratio.
 * `updateStyle` false: the canvas CSS size is the layout's job.
 */
export function sizeRenderer(renderer, cssW, cssH, dpr, extras = {}) {
    renderer.setPixelRatio(dpr);
    renderer.setSize(cssW, cssH, false);
    for (const c of [].concat(extras.composer ?? [])) {
        c.setPixelRatio?.(dpr);
        c.setSize?.(cssW, cssH);
    }
    for (const cam of [].concat(extras.camera ?? [])) {
        if (cam && 'aspect' in cam) { cam.aspect = cssW / cssH; cam.updateProjectionMatrix(); }
    }
}

/**
 * Hook a renderer to a 3D stage: it is sized on every stage resize through the shared DPR
 * policy, put in the container if it is not already in the page, and disposed with the stage.
 * @param {object} stage   from createStage({ kind: '3d', container })
 * @param {object} renderer
 * @param {{camera?:object|object[], composer?:object|object[], maxDpr?:number, updateStyle?:boolean,
 *          onResize?:(view)=>void, dispose?:boolean, loseContext?:boolean, append?:boolean}} [o]
 */
export function attachRenderer(stage, renderer, o = {}) {
    stage.renderer = renderer;
    if (o.camera && !Array.isArray(o.camera)) stage.camera = o.camera;
    const el = renderer.domElement;
    if (o.append !== false && el && stage.container && !el.isConnected && el !== stage.container) stage.container.append(el);

    const extras = { camera: o.camera, composer: o.composer };
    const apply = (view) => {
        const dpr = o.maxDpr ? Math.min(view.dpr, o.maxDpr) : view.dpr;
        sizeRenderer(renderer, view.cssW, view.cssH, dpr, extras);
        if (o.updateStyle && el?.style) { el.style.width = `${view.cssW}px`; el.style.height = `${view.cssH}px`; }
        o.onResize?.(view);
    };
    const off = stage.on('resize', apply);
    if (stage.view.cssW) apply(stage.view);

    stage.own(() => {
        off();
        if (o.dispose === false) return;
        try { renderer.dispose(); } catch { /* already gone */ }
        if (o.loseContext !== false) { try { renderer.forceContextLoss?.(); } catch { /* lost */ } }
        if (o.append !== false && el?.parentNode && el.parentNode === stage.container) el.remove();
        if (stage.renderer === renderer) stage.renderer = null;
    });
    return {
        /** Change camera/composer later (mode switches). */
        set(next) { Object.assign(extras, next); if (next.camera && !Array.isArray(next.camera)) stage.camera = next.camera; apply(stage.view); },
        resize() { apply(stage.view); },
    };
}
