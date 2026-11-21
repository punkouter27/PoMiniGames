// pocabinet/slipstream.js
//
// The tow, felt rather than drawn. Render only: the physics has no drafting force (the AI only
// likes to tuck in), so this reads the poses race.js draws and never feeds anything back.
//
//   • draft — how deep the car in focus sits in another's wake, 0..1: the nearest car ahead
//     within WAKE_LEN, near the same line and heading the same way, scaled by speed and eased.
//     Written to fx.draft (audio.js muffles the wind in it) and fx.draftAhead (that car).
//   • haze — a long refraction plume through the gap between the two cars (fx.haze, drawn by
//     postfx.js's heat-haze pass), so the air itself looks disturbed.
//   • the gauge — `--tow` (0..1) and data-tow on #pocabinetGauge: the empty bottom quarter of
//     the rev ring fills from the middle out, and the glass glows cyan (PoCabinetPage.razor.css).
//
// There are no wind-tunnel streamlines any more (2026-10-19): the ribbons wrapped the car ahead
// in a grey net that hid it. Reduced motion keeps the meter; the haze stops.

import * as THREE from './three.js';
import * as ph from './physics.js';
import { WORLD_SCALE as WS } from './util.js';

const CAR_LEN = 39;          // sim units, nose to tail (physics.js hull)
const WAKE_LEN = 170;        // sim units behind a car's tail that still tow
const WAKE_HALF = 15;        // sim units either side of its line
const TAIL_X = -2.0;         // car-local tail (cars.js builds along +X)

export class Slipstream {
    /** @param scene SceneHandle (scene.js) */
    constructor(scene) {
        this.scene = scene;
        this.draft = 0;
        this.ahead = null;
        this.gauge = null;
        this.lastTow = -1;
        this.tail = new THREE.Vector3();
        this.nose = new THREE.Vector3();
    }

    /**
     * Once a frame, after race.js has placed the cars. `focus` is the car in view, `cars` the
     * field; `gauge` the solo HUD's #pocabinetGauge when there is one.
     */
    update(dt, focus, cars, gauge) {
        const fx = this.scene.fx;
        let best = null, target = 0;
        if (focus && focus.render && Array.isArray(cars)) {
            const r = focus.render;
            const fxh = Math.cos(r.heading), fyh = Math.sin(r.heading);
            const speed01 = Math.min(1, Math.abs(r.speed) / ph.MAX_SPEED);
            const fast = Math.max(0, Math.min(1, (speed01 - 0.35) / 0.35));
            if (fast > 0) {
                for (const c of cars) {
                    if (c === focus || !c.render || c.body?.wrecked) continue;
                    const dx = c.render.x - r.x, dy = c.render.y - r.y;
                    const along = dx * fxh + dy * fyh - CAR_LEN;
                    if (along < 2 || along > WAKE_LEN) continue;
                    const lat = Math.abs(-dx * fyh + dy * fxh);
                    if (lat > WAKE_HALF) continue;
                    if (Math.cos(c.render.heading - r.heading) < 0.9) continue;
                    const k = (1 - along / WAKE_LEN) * (1 - (lat / WAKE_HALF) ** 2) * fast;
                    if (k > target) { target = k; best = c; }
                }
            }
        }
        // In quickly, out a little slower (the tow lets go as you pull out).
        const rate = target > this.draft ? 4 : 2.5;
        this.draft += (target - this.draft) * (dt > 0 ? 1 - Math.exp(-dt * rate) : 0);
        if (this.draft < 0.003) this.draft = 0;
        if (best) this.ahead = best;
        if (this.draft === 0) this.ahead = null;
        fx.draft = this.draft;
        fx.draftAhead = this.ahead;

        this.haze(focus, !!fx.reduced);
        this.meter(gauge);
    }

    /** The heat-haze plume: the leader's tail to the follower's nose. */
    haze(focus, reduced) {
        const fx = this.scene.fx;
        if (fx.haze) fx.haze.length = 0;
        const group = this.ahead?.mesh?.group;
        if (reduced || this.draft <= 0.01 || !group || !focus?.render) return;
        group.updateWorldMatrix(true, false);
        const tail = this.tail.set(TAIL_X, 0.6, 0).applyMatrix4(group.matrixWorld);
        const r = focus.render;
        const nose = this.nose.set(r.x / WS + Math.cos(r.heading) * 1.9, r.h + 0.6, r.y / WS + Math.sin(r.heading) * 1.9);
        (fx.haze || (fx.haze = [])).push({ x: tail.x, y: tail.y, z: tail.z, tx: nose.x, ty: nose.y, tz: nose.z, radius: 1.1, strength: this.draft * 1.6 });
    }

    meter(gauge) {
        if (gauge !== this.gauge) { this.gauge = gauge || null; this.lastTow = -1; }
        const g = this.gauge;
        if (!g || !g.isConnected) return;
        const tow = Math.round(Math.min(1, this.draft * 1.25) * 100) / 100;
        if (tow === this.lastTow) return;
        this.lastTow = tow;
        g.style.setProperty('--tow', tow.toFixed(2));
        g.dataset.tow = tow > 0.15 ? 'on' : 'off';
    }

    dispose() {
        const fx = this.scene.fx;
        if (fx) { fx.draft = 0; fx.draftAhead = null; if (fx.haze) fx.haze.length = 0; }
        if (this.gauge) { this.gauge.style.removeProperty('--tow'); this.gauge.dataset.tow = 'off'; }
    }
}
