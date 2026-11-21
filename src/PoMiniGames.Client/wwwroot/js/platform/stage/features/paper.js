// paper.js (feature) — loose paper blowing about the ground, for any 3D stage.
//
// Wraps platform/3d/paperFieldTsl.js (16k sheets simulated on the GPU by a TSL compute kernel, WebGPU only)
// so a 3D game opts in with `use: ['paper']` and does three things only:
//
//   const paper = stage.feature('paper');
//   paper.attach(scene, renderer, { rect, groundHeight, blocked, indoors });   // once
//   paper.feed({ wind, movers });            // each frame the world moves: wind {x,z} m/s,
//                                            // movers [{x,z,vx,vz}] people running through it
//   paper.blast(x, z, strength, radius);     // whenever something goes off
//
// The feature steps the field after the game's frame with the stage clock, draws as many sheets
// as the quality tier allows (high all, medium a quarter, low none) unless the game pins a level
// with setLevel, holds still while the stage is paused, and frees the GPU targets on dispose.
// Blasts are one-frame impulses: they are queued and handed over on the next step.
//
// paperFieldTsl.js (and three.js with it) is imported only by attach(): every stage loads this
// registry, 2D games included, and none of them should pay for it.

import { registerFeature } from '../features.js';

const TIER_LEVEL = { high: 2, medium: 1, low: 0 };
const MAX_BLASTS = 8;

export default registerFeature({
    id: 'paper',
    kind: '3d',
    default: false,
    create(stage) {
        let field = null, pinned = null, tierLevel = TIER_LEVEL[stage.tier] ?? 1, frozen = false, gone = false, attaching = 0;
        let input = { wind: { x: 0, z: 0 }, movers: [] };
        const blasts = [];
        const level = () => pinned ?? tierLevel;
        const api = {
            /**
             * Builds the field (bakes the ground once) once its module has loaded; resolves when it
             * is drawing. Calling it again replaces the old one. Never rejects: no paper on failure.
             */
            async attach(scene, renderer, options = {}) {
                const ticket = ++attaching;
                try {
                    const { createPaperField } = await import('../../3d/paperFieldTsl.js');
                    if (gone || ticket !== attaching) return api;
                    field?.dispose();
                    field = createPaperField(scene, renderer ?? stage.renderer, options);
                    field.setLevel(level());
                } catch (error) { console.warn('[paper] unavailable:', error); }
                return api;
            },
            feed({ wind, movers } = {}) {
                if (wind) input.wind = wind;
                input.movers = movers ?? [];
            },
            blast(x, z, strength = 1, radius = 6) {
                blasts.push({ x, z, strength, radius });
                if (blasts.length > MAX_BLASTS) blasts.shift();
            },
            /** 0 none, 1 a quarter, 2 all; null goes back to following the tier. */
            setLevel(value) { pinned = value ?? null; field?.setLevel(level()); },
            /** The game's own pause (the stage's tab pause is handled already). */
            freeze(value) { frozen = Boolean(value); },
            reset() { blasts.length = 0; field?.reset(); },
            drawing: () => Boolean(field?.mesh?.visible),
        };
        stage.paper = api;
        return {
            ...api,
            update(dt) {
                if (!field || frozen || stage.paused) return;
                field.update(dt, stage.time, { wind: input.wind, movers: input.movers, blasts: blasts.splice(0) });
            },
            tier(t) { tierLevel = TIER_LEVEL[t] ?? tierLevel; field?.setLevel(level()); },
            dispose() { gone = true; field?.dispose(); field = null; if (stage.paper === api) stage.paper = null; },
        };
    },
});
