// fxBootstrap.js — the always-on GFX/Sound bootstrap.
//
// Loaded as a classic module script from index.html BEFORE Blazor boots, so
// the quality tier is decided before the first game asks for it and the palette
// follows the route from the first paint.
//
// The heavier systems (glass captures, weather, WebGPU particles, prop
// registry, material audio) are lazy-imported from the games that use them —
// the catalog must never pay for Voxel Strike's prop library.

(function () {
    'use strict';

    // Option #7: skip ALL of the heavier GFX/audio systems when the user
    // opted into reduced motion (Profile → Preferences) or the OS asked for
    // it. The app.css blanket rule handles CSS animations, but JS-driven
    // effects (WebGPU particles, glass captures, spatial audio) don't see a
    // CSS rule — they have to gate themselves, and
    // this is the one place that decides whether they get loaded at all.
    //
    // The data-motion attribute is set on <html> by the pre-paint script in
    // index.html, so it's available here BEFORE Blazor boots. Reading the
    // dataset is a synchronous attribute lookup — no race with the inline
    // script. The check is inverted (opt-out rather than opt-in) because
    // every script load below is a separate request that costs the catalog
    // a round-trip even if the user never sees the effect.
    var reduceMotion = document.documentElement.dataset.motion === 'reduce';

    function load(src, module) {
        return new Promise(function (res) {
            const s = document.createElement('script');
            if (module) s.type = 'module';
            s.src = src;
            s.onload = res; s.onerror = res;   // a failed module must not stall the rest
            document.head.appendChild(s);
        });
    }

    // Order matters: quality first (everyone reads it), palette second (writes
    // the vars readers consume), then spatial audio. Reduce-motion users
    // still load qualityTiers (chrome like the FPS meter reads it) and the
    // palette bus (the route-accent pulse is theme-state, not motion) — the
    // dropped modules are the ones whose effect IS motion: impact flashes,
    // spatial / material audio, and the WebGPU compute-shader particle field.
    // There is no background music: it is off app-wide.
    var chain = load('js/platform/qualityTiers.js')
        .then(function () { return load('js/platform/paletteBus.js'); });
    if (!reduceMotion) {
        chain = chain.then(function () { return load('js/platform/spatialAudio.js'); });
    }
    // The route wipe. Loaded for everyone including reduced-motion users: the
    // module no-ops itself in that case, and MainLayout calls it unconditionally —
    // a missing global there would mean every navigation paid for a failed lookup.
    chain = chain.then(function () { return load('js/platform/routeFx.js'); });

    // Scene-composited glass for any panel carrying data-glass. Loaded here rather
    // than lazily per game because it is now an opt-in-by-attribute platform
    // behaviour, not a game's own effect — and its own allowed() check plus the
    // reduce-motion gate below mean the low tier pays nothing but the module fetch.
    if (!reduceMotion) {
        chain = chain.then(function () {
            return load('js/platform/glassFx.js').then(function () {
                window.PoGlass && window.PoGlass.auto();
            });
        });
    }

    // The title swarm on the intro card (gpuFxWebGPU.js). Only the module is fetched
    // here; it asks for a WebGPU adapter the first time an intro card calls assemble(),
    // so the catalog never pays for an adapter request or a shader compile. Loaded on
    // its own, not at the end of the chain above: it depends on none of it, and an
    // intro card on a direct load into a game renders before an eight-deep sequential
    // chain has finished (GameIntro retries once for the same reason).
    if (!reduceMotion) load('js/platform/gpuFxWebGPU.js');
})();
