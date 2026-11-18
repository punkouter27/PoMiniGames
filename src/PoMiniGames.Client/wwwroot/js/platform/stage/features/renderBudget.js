// renderBudget.js (feature) — adaptive resolution / shadow ladder for any 3D stage.
//
// Wraps platform/renderBudget.js (the p95 frame-time ladder under the PoQuality ceiling) so a
// 3D game opts in with `use: ['renderBudget']` instead of wiring RenderBudget, applyToRenderer
// and tier snapping itself. Needs stage.renderer. Emits 'rung' with the ladder rung, which
// carries particles / shadowDistance / ao / post flags for the game to honour.

import { registerFeature } from '../features.js';
import { RenderBudget, applyToRenderer, tickShadows } from '../../renderBudget.js';

export default registerFeature({
    id: 'renderBudget',
    kind: '3d',
    default: false,
    create(stage) {
        let last = 0;
        const budget = new RenderBudget({
            tier: () => stage.tier,
            onChange(rung) {
                if (stage.renderer) applyToRenderer(stage.renderer, rung, stage.view.dpr);
                stage.emit('rung', rung);
            },
        });
        stage.budget = budget;
        return {
            update() {
                const now = performance.now();
                if (last) budget.frame(now - last);
                last = now;
                if (stage.renderer) tickShadows(stage.renderer, stage.frameNo);
            },
            resize() { if (stage.renderer) applyToRenderer(stage.renderer, budget.rung, stage.view.dpr); },
            tier(t) { budget.snapTo(t); if (stage.renderer) applyToRenderer(stage.renderer, budget.rung, stage.view.dpr); stage.emit('rung', budget.rung); },
            pause() { last = 0; },
            resume() { last = 0; budget.reset(); },
            dispose() { if (stage.budget === budget) stage.budget = null; },
        };
    },
});
