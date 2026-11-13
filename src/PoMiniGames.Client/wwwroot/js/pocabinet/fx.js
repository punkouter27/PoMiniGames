// pocabinet/fx.js
//
// Car-driven particles and marks for PoCabinet: tyre smoke, grass dust, stones and dust
// thrown up in a gravel trap (sand at Mar-a-Lago), a jolt of grit and sparks off a raised
// kerb, rain spray, wall sparks, car-to-car contact sparks, launch smoke off the line, and
// skid marks that stay on the tarmac for the whole race, and the smoke off a damaged
// engine (grey, then black) and the fire of a wreck.
//
// Everything is derived from the poses race.js already draws (position, heading,
// speed) plus, where the car is simulated locally, its body's `sliding` flag —
// so remote cars online and the replay get the same effects, and nothing here
// feeds back into physics. What a car is on is its body's `surface` where race.js
// knows it, else worked out the same way (physics.js surfaceAt). Every particle settles on
// the ground it was thrown from, not at sea level, so hills are no trouble. Lateral grip use is estimated from yaw rate × speed
// against the same GRIP_ACCEL the physics caps it at.
//
// update() returns the frame's contact events so race.js can play the crunch
// (positional when it is someone else's shunt), and the frame's barrier hits
// (first touch only, as strong as the car was closing on the wall), which race.js
// turns into dents on that car (cars.js) online, where the sim is the server's and its
// own hits (physics.js reportHits) are not seen here.
//
// One-shots race.js fires: backfire() — a flame out of the tail on
// every exhaust pop audio.js reports; debris() — the bits off a shunt: shards of panel in the
// car's paint, black trim, glass and a hubcap as rigid bodies that tumble, bounce and lie on
// the road (debris.js), leaving with the car's speed and out of the side that was hit, over a
// puff of paint dust; confetti() — the podium shower over the line.
//
// Smoke, dust and spray go through puff(), which scales each request by the scene's quality
// tier (read every call, so a mid-race step down takes effect at once): 'high' throws two
// longer-lived, jittered puffs per request (big, soft, hanging tyre and crash smoke), 'medium'
// one longer-lived puff carrying more of the opacity, 'low' the request as it is. Puffs are
// soft point sprites broken up by the shared noise texture (materials.js noise), so a cloud
// reads lumpy rather than as discs; stones, paint flakes and confetti in the same pool stay
// solid. Nothing is emitted further than PUFF_RANGE from the camera. Fire is HDR sparks off the
// bonnet (the bloom catches them). Rain spray follows the scene's weather live.

import * as THREE from 'three';
import { wrapAngle } from './track.js';
import { throwChunks } from './debris.js';
import { noise } from './materials.js';
import { GpuParticleStepper } from './gpucompute.js';
import { GRIP_ACCEL, CAR_RADIUS, hullContact, wallAt, surfaceAt, SURF_ROAD, SURF_GRASS, SURF_GRAVEL, SURF_SAUSAGE } from './physics.js';
import { WORLD_SCALE as WS } from './util.js';

const MAX_SMOKE = 4096;         // the high tier's two puffs per request at a 100-car start
const SMOKE_RANGE = 180;        // world units from the camera: further off, a wreck's smoke is not drawn
const PUFF_RANGE = 250;         // and no puff of any kind is emitted
const MAX_SPARKS = 1200;
const MAX_SKID = 2600;          // quads in the skid-mark ring buffer
const MAX_DECALS = 1800;        // quads in the dynamic wear decal ring buffer (paint transfer, mud, oil/scorch)
const SKID_W = 0.14;            // half tyre width, world units
const SKID_Y = 0.055;
const REAR = 1.2, TRACK_HALF = 0.72;

/** Puff kinds (tyre smoke, grass and gravel dust, kerb grit, rain spray, engine and wreck smoke). */
const PUFF = { TYRE: 0, DUST: 1, GRIT: 2, SPRAY: 3, ENGINE: 4, WRECK: 5 };
// Per kind, on top of the request: puffs per request on 'high', and the life, end-size and
// opacity multipliers 'medium' and 'high' apply; `spread` is the jitter radius (world units).
const KIND = [
    { n: 2, life: 2.0, size: 1.15, alpha: 1.0, spread: 0.3 },     // tyre smoke: hangs and spreads
    { n: 2, life: 1.7, size: 1.05, alpha: 0.8, spread: 0.35 },    // grass / gravel dust
    { n: 2, life: 1.2, size: 1.0, alpha: 0.8, spread: 0.3 },      // kerb grit
    { n: 2, life: 1.1, size: 1.0, alpha: 0.8, spread: 0.3 },      // rain spray
    { n: 2, life: 1.5, size: 1.0, alpha: 0.8, spread: 0.2 },      // engine smoke
    { n: 2, life: 1.5, size: 1.2, alpha: 0.75, spread: 0.3 },     // wreck smoke
];

const POINT_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
attribute float aSeed;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
varying float vSeed;
void main() {
    vColor = aColor;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Fade out right at the lens: a puff beside the cockpit would otherwise fill the screen.
    vAlpha = aAlpha * smoothstep(1.2, 4.5, -mv.z);
    gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(-mv.z, 0.1) : 0.0;
    gl_Position = projectionMatrix * mv;
}`;

// A puff (vSeed >= 0): a soft ball whose edge and density the noise texture breaks up, a
// different patch of it per particle, turning as it fades, lit from above. A solid bit
// (vSeed < 0: stones, flakes, confetti) stays a plain soft dot.
const SMOKE_FRAG = /* glsl */ `
uniform sampler2D uNoise;
varying float vAlpha;
varying vec3 vColor;
varying float vSeed;
void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float a, lit;
    if (vSeed < 0.0) {
        a = smoothstep(0.5, 0.05, d);
        lit = 0.85 + 0.25 * (0.5 - c.y);
    } else {
        float ang = vSeed * 6.2831853 + vAlpha * 1.5;
        vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * c;
        vec4 n = texture2D(uNoise, q * 0.55 + vSeed * vec2(17.31, 9.17));
        vec4 m = texture2D(uNoise, q * 1.3 + vSeed * vec2(5.13, 23.7));
        float edge = 0.5 - 0.2 * (1.0 - n.r);
        a = smoothstep(edge, edge * 0.15, d) * (0.6 + 0.8 * n.g * (0.5 + m.a));
        lit = 0.78 + 0.32 * (0.5 - c.y) + 0.18 * (m.b - 0.5);
    }
    a *= vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor * lit, a);
    #include <colorspace_fragment>
}`;

const SPARK_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    a = a * a * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor * (1.0 + 2.0 * a), a);
    #include <colorspace_fragment>
}`;

class Pool {
    constructor(max, frag, blending) {
        this.max = max;
        this.pos = new Float32Array(max * 3);
        this.vel = new Float32Array(max * 3);
        this.size = new Float32Array(max);
        this.alpha = new Float32Array(max);
        this.color = new Float32Array(max * 3);
        this.life = new Float32Array(max);
        this.maxLife = new Float32Array(max);
        this.s0 = new Float32Array(max);
        this.s1 = new Float32Array(max);
        this.a0 = new Float32Array(max);
        this.drag = new Float32Array(max);
        this.grav = new Float32Array(max);
        this.floor = new Float32Array(max);
        this.seed = new Float32Array(max).fill(-1);
        this.slotEpoch = new Uint32Array(max);
        this.gpu = null;
        this.next = 0;
        this.live = 0;
        this.spawned = false;
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
        geom.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
        geom.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
        geom.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
        geom.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1).setUsage(THREE.DynamicDrawUsage));
        this.material = new THREE.ShaderMaterial({
            vertexShader: POINT_VERT,
            fragmentShader: frag,
            uniforms: { uScale: { value: 400 }, uNoise: { value: noise() } },
            transparent: true,
            depthWrite: false,
            blending,
        });
        this.points = new THREE.Points(geom, this.material);
        this.points.frustumCulled = false;
        this.points.renderOrder = 5;
        this.geom = geom;
    }

    /**
     * `floor`: the ground height the particle bounces on (world units; default just under it).
     * `seed` >= 0 draws it as a puff (its own patch of the noise), < 0 as a solid dot.
     */
    spawn(x, y, z, vx, vy, vz, life, s0, s1, a0, r, g, b, drag, grav, floor = y - 0.25, seed = -1) {
        const i = this.next;
        this.floor[i] = floor + 0.02;
        this.seed[i] = seed;
        this.slotEpoch[i]++;
        this.spawned = true;
        this.next = (this.next + 1) % this.max;
        const k = i * 3;
        this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
        this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
        this.color[k] = r; this.color[k + 1] = g; this.color[k + 2] = b;
        this.life[i] = life; this.maxLife[i] = life;
        this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a0;
        this.drag[i] = drag; this.grav[i] = grav;
    }

    step(dt, useGpu = false) {
        if (!this.live && !this.spawned) return;
        if (useGpu) {
            if (!this.gpu) this.gpu = new GpuParticleStepper(this.max);
            const applied = this.gpu.consumeLatest(this);
            const dispatched = this.gpu.dispatch(this, dt);
            if (applied && dispatched) return;
        }
        let live = 0;
        for (let i = 0; i < this.max; i++) {
            if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
            this.life[i] -= dt;
            if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
            live++;
            const k = i * 3;
            const damp = Math.exp(-this.drag[i] * dt);
            this.vel[k] *= damp; this.vel[k + 1] = this.vel[k + 1] * damp - this.grav[i] * dt; this.vel[k + 2] *= damp;
            this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
            if (this.pos[k + 1] < this.floor[i]) { this.pos[k + 1] = this.floor[i]; this.vel[k + 1] *= -0.3; }
            const f = 1 - this.life[i] / this.maxLife[i];
            this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * f;
            this.alpha[i] = this.a0[i] * (f < 0.12 ? f / 0.12 : 1 - (f - 0.12) / 0.88);
        }
        this.live = live;
        const a = this.geom.attributes;
        a.position.needsUpdate = true;
        a.aSize.needsUpdate = true;
        a.aAlpha.needsUpdate = true;
        if (this.spawned) { a.aColor.needsUpdate = true; a.aSeed.needsUpdate = true; }
        this.spawned = false;
    }

    dispose() {
        this.gpu?.dispose();
        this.geom.dispose();
        this.material.dispose();
    }
}

class SkidMarks {
    constructor() {
        this.pos = new Float32Array(MAX_SKID * 4 * 3);
        const idx = new Uint32Array(MAX_SKID * 6);
        for (let q = 0; q < MAX_SKID; q++) {
            const v = q * 4, k = q * 6;
            idx[k] = v; idx[k + 1] = v + 1; idx[k + 2] = v + 2;
            idx[k + 3] = v + 1; idx[k + 4] = v + 3; idx[k + 5] = v + 2;
        }
        this.geom = new THREE.BufferGeometry();
        this.attr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
        this.geom.setAttribute('position', this.attr);
        this.geom.setIndex(new THREE.BufferAttribute(idx, 1));
        this.geom.setDrawRange(0, 0);
        this.material = new THREE.MeshBasicMaterial({
            color: 0x0b0b0b, transparent: true, opacity: 0.5, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(this.geom, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 1;
        this.next = 0;
        this.count = 0;
        this.dirtyFrom = -1;
        this.dirtyTo = -1;
    }

    /** One quad from (ax,az)→(bx,bz) on a road at height `y`, width across the direction of travel. */
    add(ax, az, bx, bz, y = 0) {
        y += SKID_Y;
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) return;
        const nx = -dz / len * SKID_W, nz = dx / len * SKID_W;
        const q = this.next;
        const k = q * 12;
        const p = this.pos;
        p[k] = ax - nx; p[k + 1] = y; p[k + 2] = az - nz;
        p[k + 3] = ax + nx; p[k + 4] = y; p[k + 5] = az + nz;
        p[k + 6] = bx - nx; p[k + 7] = y; p[k + 8] = bz - nz;
        p[k + 9] = bx + nx; p[k + 10] = y; p[k + 11] = bz + nz;
        if (this.dirtyFrom < 0) { this.dirtyFrom = q; this.dirtyTo = q; }
        else { this.dirtyFrom = Math.min(this.dirtyFrom, q); this.dirtyTo = Math.max(this.dirtyTo, q); }
        this.next = (q + 1) % MAX_SKID;
        this.count = Math.min(MAX_SKID, this.count + 1);
    }

    flush() {
        if (this.dirtyFrom < 0) return;
        if (typeof this.attr.addUpdateRange === 'function') {
            this.attr.clearUpdateRanges?.();
            this.attr.addUpdateRange(this.dirtyFrom * 12, (this.dirtyTo - this.dirtyFrom + 1) * 12);
        }
        this.attr.needsUpdate = true;
        this.geom.setDrawRange(0, this.count * 6);
        this.dirtyFrom = this.dirtyTo = -1;
    }

    snapshot() {
        return this.count > 0 ? {
            pos: this.pos.slice(0, this.count * 12),
            count: this.count,
            next: this.next,
        } : null;
    }

    restore(snap) {
        if (!snap?.count || !snap.pos) return;
        const n = Math.min(MAX_SKID, snap.count);
        this.pos.set(snap.pos.subarray(0, n * 12));
        this.count = n;
        this.next = snap.next % MAX_SKID;
        this.dirtyFrom = 0;
        this.dirtyTo = n - 1;
        this.flush();
    }

    dispose() {
        this.geom.dispose();
        this.material.dispose();
    }
}

/**
 * Dynamic wear decal ring buffer (#2):
 * - Barrier paint-transfer scrapes (colored by the car's livery along vertical wall faces)
 * - Wreck oil/carbon scorch pools on tarmac
 * - Gravel/mud tyre tracks dragged onto road surfaces after leaving run-off traps
 */
class WearDecals {
    constructor() {
        this.pos = new Float32Array(MAX_DECALS * 4 * 3);
        this.col = new Float32Array(MAX_DECALS * 4 * 4);
        const idx = new Uint32Array(MAX_DECALS * 6);
        for (let q = 0; q < MAX_DECALS; q++) {
            const v = q * 4, k = q * 6;
            idx[k] = v; idx[k + 1] = v + 1; idx[k + 2] = v + 2;
            idx[k + 3] = v + 1; idx[k + 4] = v + 3; idx[k + 5] = v + 2;
        }
        this.geom = new THREE.BufferGeometry();
        this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
        this.colAttr = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
        this.geom.setAttribute('position', this.posAttr);
        this.geom.setAttribute('color', this.colAttr);
        this.geom.setIndex(new THREE.BufferAttribute(idx, 1));
        this.geom.setDrawRange(0, 0);
        this.material = new THREE.MeshBasicMaterial({
            vertexColors: true, transparent: true, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6, side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(this.geom, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 2;
        this.next = 0;
        this.count = 0;
        this.dirtyFrom = -1;
        this.dirtyTo = -1;
        this._c = new THREE.Color();
    }

    pushQuad(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, r, g, b, a) {
        const q = this.next;
        const kp = q * 12, kc = q * 16;
        const p = this.pos, c = this.col;
        p[kp] = x0; p[kp + 1] = y0; p[kp + 2] = z0;
        p[kp + 3] = x1; p[kp + 4] = y1; p[kp + 5] = z1;
        p[kp + 6] = x2; p[kp + 7] = y2; p[kp + 8] = z2;
        p[kp + 9] = x3; p[kp + 10] = y3; p[kp + 11] = z3;
        for (let i = 0; i < 4; i++) {
            const ci = kc + i * 4;
            c[ci] = r; c[ci + 1] = g; c[ci + 2] = b; c[ci + 3] = a;
        }
        if (this.dirtyFrom < 0) { this.dirtyFrom = q; this.dirtyTo = q; }
        else { this.dirtyFrom = Math.min(this.dirtyFrom, q); this.dirtyTo = Math.max(this.dirtyTo, q); }
        this.next = (q + 1) % MAX_DECALS;
        this.count = Math.min(MAX_DECALS, this.count + 1);
    }

    /** Horizontal road decal from (ax,az)->(bx,bz) at ground height `y`, width `w`, RGBA. */
    addStrip(ax, az, bx, bz, y, w, r, g, b, a) {
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) return;
        const nx = -dz / len * w, nz = dx / len * w;
        const py = y + SKID_Y + 0.008;
        this.pushQuad(
            ax - nx, py, az - nz,
            ax + nx, py, az + nz,
            bx - nx, py, bz - nz,
            bx + nx, py, bz + nz,
            r, g, b, a
        );
    }

    /** Vertical paint-transfer streak on a barrier facing (-nx, -nz), stretching along tangent. */
    addWallPaint(x, y, z, nx, nz, tx, tz, len, h, hex, strength) {
        this._c.set(hex || '#d0d0d0');
        const offX = x - nx * 0.04, offZ = z - nz * 0.04;
        const hl = len * 0.5, hh = h * 0.5;
        const cy = y + 0.36;
        this.pushQuad(
            offX - tx * hl, cy - hh, offZ - tz * hl,
            offX - tx * hl, cy + hh, offZ - tz * hl,
            offX + tx * hl, cy - hh, offZ + tz * hl,
            offX + tx * hl, cy + hh, offZ + tz * hl,
            this._c.r, this._c.g, this._c.b, Math.min(0.85, 0.35 + strength * 0.5)
        );
    }

    /** Oval carbon/oil scorch patch under a wreck or heavy blowout. */
    addScorch(x, y, z, heading, radius = 1.15) {
        const fx = Math.cos(heading) * radius * 1.4, fz = Math.sin(heading) * radius * 1.4;
        const rx = -Math.sin(heading) * radius, rz = Math.cos(heading) * radius;
        const py = y + SKID_Y + 0.012;
        this.pushQuad(
            x - fx - rx, py, z - fz - rz,
            x - fx + rx, py, z - fz + rz,
            x + fx - rx, py, z + fz - rz,
            x + fx + rx, py, z + fz + rz,
            0.03, 0.03, 0.04, 0.72
        );
    }

    flush() {
        if (this.dirtyFrom < 0) return;
        const span = this.dirtyTo - this.dirtyFrom + 1;
        if (typeof this.posAttr.addUpdateRange === 'function') {
            this.posAttr.clearUpdateRanges?.();
            this.posAttr.addUpdateRange(this.dirtyFrom * 12, span * 12);
            this.colAttr.clearUpdateRanges?.();
            this.colAttr.addUpdateRange(this.dirtyFrom * 16, span * 16);
        }
        this.posAttr.needsUpdate = true;
        this.colAttr.needsUpdate = true;
        this.geom.setDrawRange(0, this.count * 6);
        this.dirtyFrom = this.dirtyTo = -1;
    }

    snapshot() {
        return this.count > 0 ? {
            pos: this.pos.slice(0, this.count * 12),
            col: this.col.slice(0, this.count * 16),
            count: this.count,
            next: this.next,
        } : null;
    }

    restore(snap) {
        if (!snap?.count || !snap.pos || !snap.col) return;
        const n = Math.min(MAX_DECALS, snap.count);
        this.pos.set(snap.pos.subarray(0, n * 12));
        this.col.set(snap.col.subarray(0, n * 16));
        this.count = n;
        this.next = snap.next % MAX_DECALS;
        this.dirtyFrom = 0;
        this.dirtyTo = n - 1;
        this.flush();
    }

    dispose() {
        this.geom.dispose();
        this.material.dispose();
    }
}

let trackWearCache = null;

/** Clear accumulated skid/paint/scorch wear cache (called when switching campaign stages or leaving a track). */
export function clearTrackWear(trackId = null) {
    if (!trackWearCache) return;
    if (!trackId || trackWearCache.trackId === trackId) trackWearCache = null;
}

class CarFx {
    /**
     * @param sceneHandle scene.js SceneHandle
     * @param track       runtime track (track.js)
     * @param opts        { grip, groundHex, persistWear } (race.js keeps `grip` current)
     */
    constructor(sceneHandle, track, opts = {}) {
        this.sh = sceneHandle;
        this.track = track;
        this.grip = Number(opts.grip) || 1;
        this.persistWear = !!opts.persistWear;
        this.dust = new THREE.Color(opts.groundHex || '#6b6040').lerp(new THREE.Color('#c8b890'), 0.45);
        // Bedroom Floor GP: the toy track's run-off kicks up carpet fluff and lint, not dirt.
        if (track.theme === 'bedroom') this.dust = new THREE.Color('#e2ddd4');
        // Gravel traps: grey-brown stones and pale dust; Mar-a-Lago's are beach sand.
        this.beach = track.theme === 'maralago';
        this.stone = new THREE.Color(this.beach ? '#d9c79c' : '#8d8577');
        this.grit = new THREE.Color(this.beach ? '#efe2c2' : '#c9bba0');
        this.smoke = new Pool(MAX_SMOKE, SMOKE_FRAG, THREE.NormalBlending);
        this.sparks = new Pool(MAX_SPARKS, SPARK_FRAG, THREE.AdditiveBlending);
        this.skids = new SkidMarks();
        this.decals = new WearDecals();
        if (this.persistWear && trackWearCache && trackWearCache.trackId === track.id) {
            this.skids.restore(trackWearCache.skids);
            this.decals.restore(trackWearCache.decals);
        } else if (trackWearCache && trackWearCache.trackId !== track.id) {
            trackWearCache = null;
        }
        this.group = new THREE.Group();
        this.group.name = 'pocabinet-fx';
        this.group.add(this.skids.mesh, this.decals.mesh, this.smoke.points, this.sparks.points);
        sceneHandle.scene.add(this.group);
        this.state = new Map();
        this.pairs = new Map();
        this.size = new THREE.Vector2();
        this.disposed = false;
    }

    /** The scene's weather, live (environment.js sets it; a remount mid-race changes it). */
    get raining() { return !!this.sh.raining; }

    /** Smoke, dust or spray of `kind` (PUFF), scaled by the quality tier (see the header). */
    puff(kind, x, y, z, vx, vy, vz, life, s0, s1, a0, r, g, b, drag, grav, floor) {
        const cam = this.sh.camera?.position;
        if (cam && (x - cam.x) ** 2 + (z - cam.z) ** 2 > PUFF_RANGE * PUFF_RANGE) return;
        const q = this.sh.quality;
        const rnd = Math.random;
        if (q !== 'high' && q !== 'medium') {
            this.smoke.spawn(x, y, z, vx, vy, vz, life, s0, s1, a0, r, g, b, drag, grav, floor, rnd());
            return;
        }
        const k = KIND[kind] || KIND[0];
        const n = q === 'high' ? k.n : 1;
        // One puff on medium carries more of the opacity two would.
        const alpha = a0 * k.alpha * (q === 'high' ? 1 : 1.4);
        const spread = k.spread + s0 * 0.35;
        for (let i = 0; i < n; i++) {
            const ox = (rnd() - 0.5) * 2 * spread, oy = (rnd() - 0.5) * spread, oz = (rnd() - 0.5) * 2 * spread;
            this.smoke.spawn(x + ox, y + oy, z + oz,
                vx + (rnd() - 0.5) + ox * 0.6, vy * (0.7 + rnd() * 0.6), vz + (rnd() - 0.5) + oz * 0.6,
                life * k.life * (0.75 + rnd() * 0.5), s0 * (0.7 + rnd() * 0.5), s1 * k.size * (0.65 + rnd() * 0.6),
                alpha * (0.7 + rnd() * 0.6), r, g, b, drag, grav, floor, rnd());
        }
    }

    /** Burst of smoke off the rear wheels for `seconds` (launch at GO). */
    launch(id, seconds = 0.8, strength = 1) {
        const s = this.state.get(id) || this.newState();
        s.launch = seconds;
        s.launchStrength = strength;
        this.state.set(id, s);
    }

    newState() {
        return { h: null, x: 0, y: 0, up: 0, v: 0, lat: 0, hint: -1, skid: [null, null], mudPrev: [null, null], mud: 0, scorched: false, launch: 0, launchStrength: 1, acc: 0, walled: false, wallAt: 0, paintAt: 0, off: null, out: 0, hl: null, sacc: 0, wreckT: 0, surf: 0, gacc: 0 };
    }

    /** Stamp barrier paint transfer at world contact `(x,y,z)` along tangent `(tx,tz)`. */
    paintTransfer(x, y, z, nx, nz, colorHex, strength = 0.6) {
        if (this.disposed) return;
        const tx = -nz, tz = nx;
        this.decals.addWallPaint(x, y, z, nx, nz, tx, tz, 1.4 + strength * 1.8, 0.24 + strength * 0.22, colorHex, strength);
    }

    /** Stamp an oil/carbon scorch pool beneath a wrecked or damaged car. */
    scorchMark(x, y, z, heading) {
        if (this.disposed) return;
        this.decals.addScorch(x, y, z, heading);
    }

    /** A flame out of the tail of car `id` (its last pose), `strength` 0..1. */
    backfire(id, strength = 1) {
        const s = this.state.get(id);
        if (!s || s.h === null || this.disposed) return;
        const rnd = Math.random;
        const fx = Math.cos(s.h), fz = Math.sin(s.h);
        const x = s.x / WS - fx * 2.02, z = s.y / WS - fz * 2.02;
        const n = 4 + Math.round(strength * 6);
        for (let i = 0; i < n; i++) {
            const k = rnd();
            const out = 2.5 + rnd() * 4 * strength;
            // Core blue-white, tips orange: brighter the closer to the pipe.
            const hot = k < 0.3;
            this.sparks.spawn(
                x + (rnd() - 0.5) * 0.25, s.up + 0.3 + rnd() * 0.08, z + (rnd() - 0.5) * 0.25,
                -fx * out + (rnd() - 0.5) * 0.8, 0.2 + rnd() * 0.5, -fz * out + (rnd() - 0.5) * 0.8,
                0.06 + rnd() * 0.1 * (0.5 + strength), 0.55 + strength * 0.35, 0.12, 1,
                hot ? 0.6 : 1.0, hot ? 0.75 : 0.45 + k * 0.25, hot ? 1.0 : 0.12, 7, -1.5);
        }
    }

    /** Chunks of trim and flakes of `paint` (hex) flying off a shunt at world (x, z), road height `up`. */
    debris(x, z, paint, strength = 1, up = 0, car = null) {
        if (this.disposed) return;
        const rnd = Math.random;
        const c = new THREE.Color(paint || '#888888');
        // The car's velocity (world units/s) and the way out of it at the hit, from its pose.
        let vx = 0, vz = 0, ox = 0, oz = 0;
        if (car && Number.isFinite(car.heading)) {
            const sp = (Number(car.speed) || 0) / WS;
            vx = Math.cos(car.heading) * sp; vz = Math.sin(car.heading) * sp;
            ox = x - car.x / WS; oz = z - car.y / WS;
            const len = Math.hypot(ox, oz);
            if (len > 1e-3) { ox /= len; oz /= len; } else { ox = 0; oz = 0; }
        }
        // The pieces you can see tumble: rigid bodies (debris.js).
        throwChunks(this.sh.scene, {
            x, y: up + 0.45, z, vx, vz, ox, oz, strength, paint: c, owner: car, floor: up,
            hint: Number.isFinite(car?.along) ? this.track.indexAt(car.along) : -1,
        });
        // And a puff of paint dust and grit off the hit.
        const n = Math.round(2 + strength * 5);
        for (let i = 0; i < n; i++) {
            const flake = rnd() < 0.55;
            const shade = 0.08 + rnd() * 0.1;
            this.smoke.spawn(x, up + 0.4 + rnd() * 0.3, z,
                vx * 0.6 + (rnd() - 0.5) * 6 * strength, 1.2 + rnd() * 3 * strength, vz * 0.6 + (rnd() - 0.5) * 6 * strength,
                0.5 + rnd() * 0.6, 0.1 + rnd() * 0.06, 0.08, 1,
                flake ? c.r : shade, flake ? c.g : shade, flake ? c.b : shade, 0.8, 9.8, up);
        }
    }

    /** A shower of confetti over world (x, z), road height `up` — the podium moment. */
    confetti(x, z, count = 160, up = 0) {
        if (this.disposed) return;
        const rnd = Math.random;
        const col = new THREE.Color();
        for (let i = 0; i < count; i++) {
            col.setHSL(rnd(), 0.85, 0.58);
            this.smoke.spawn(x + (rnd() - 0.5) * 8, up + 7 + rnd() * 4, z + (rnd() - 0.5) * 8,
                (rnd() - 0.5) * 5, 2 + rnd() * 4, (rnd() - 0.5) * 5,
                3 + rnd() * 2, 0.16, 0.14, 1, col.r, col.g, col.b, 1.6, 1.4, up);
        }
    }

    /**
     * @param dt   seconds (already scaled for slow motion)
     * @param cars [{ id, x, y, heading, speed, sliding?, visible, h? }] — sim units; h is the
     *             road height under the car in world units (0 on a flat track)
     * @param opts { skids: bool } — false during replays (marks are already down)
     * @returns {{ contacts: Array<{ x, z, strength, ids: [a, b] }>, scraping: Map<id, number> }}
     */
    update(dt, cars, opts = {}) {
        const events = { contacts: [], scraping: new Map(), walls: [] };
        if (this.disposed || dt <= 0) return events;
        const t = this.track;
        const skidsOn = opts.skids !== false;
        const rnd = Math.random;

        for (const c of cars) {
            let s = this.state.get(c.id);
            if (!s) { s = this.newState(); this.state.set(c.id, s); }
            if (c.hint >= 0) s.hint = c.hint;
            const proj = t.project(c.x, c.y, s.hint);
            s.hint = proj.index;
            const up = s.up = Number(c.h) || 0;
            const v = Math.abs(c.speed);
            // A pose that jumped (replay seek, snapshot snap, respawn) is not a slide.
            if (s.h !== null && Math.hypot(c.x - s.x, c.y - s.y) > v * dt * 3 + 20) {
                s.h = null;
                s.lat = 0;
                s.skid = [null, null];
                s.off = null; s.out = 0; s.hl = null;
            }
            s.x = c.x; s.y = c.y;
            // Yaw-rate × speed = lateral acceleration; smoothed so interpolation noise never flickers smoke.
            let lat = 0;
            if (s.h !== null) lat = Math.abs(wrapAngle(c.heading - s.h) / dt) * v;
            s.lat += (lat - s.lat) * Math.min(1, dt * 12);
            const decel = s.v - v;
            s.v = v;
            s.h = c.heading;

            const hw = t.hwAt(proj.index);
            // What the car is on: the sim's word where it has one, else the same rule.
            const surface = Number.isInteger(c.surface) && c.surface >= 0 ? c.surface : surfaceAt(t, proj.index, proj.lateral);
            const kicked = surface === SURF_SAUSAGE && s.surf !== SURF_SAUSAGE;
            s.surf = surface;
            const limit = GRIP_ACCEL * this.grip * (Math.abs(proj.lateral) > hw ? 0.6 : 1);
            let slip = Math.max(0, (s.lat / limit - 0.9) * 8);
            if (c.sliding) slip = Math.max(slip, 1);
            if (decel / dt > 115 && v > 40) slip = Math.max(slip, 0.6);
            slip = Math.min(1, slip) * (v > 22 ? 1 : v / 22);
            if (s.launch > 0) { slip = Math.max(slip, s.launchStrength); s.launch -= dt; }

            const x = c.x / WS, z = c.y / WS;
            const fx = Math.cos(c.heading), fz = Math.sin(c.heading);
            const rx = -fz, rz = fx;
            const onGrass = surface === SURF_GRASS;
            const onGravel = surface === SURF_GRAVEL;
            const vx = fx * c.speed / WS, vz = fz * c.speed / WS;
            // Gravel: stones spat out behind the rear wheels and a dust cloud (sand: a spray).
            if (onGravel && v > 12) {
                s.gacc += dt * 40 * Math.min(1, v / 70);
                while (s.gacc >= 1) {
                    s.gacc -= 1;
                    const side = rnd() < 0.5 ? -1 : 1;
                    const wx = x - fx * REAR + rx * TRACK_HALF * side, wz = z - fz * REAR + rz * TRACK_HALF * side;
                    const kick = 0.15 + rnd() * 0.35;
                    const stone = rnd() < (this.beach ? 0.35 : 0.6);
                    if (stone) {
                        const shade = 0.7 + rnd() * 0.5;
                        this.smoke.spawn(wx, up + 0.15, wz,
                            -vx * kick + rx * side * (rnd() * 2.5) + (rnd() - 0.5), 1.2 + rnd() * 2.8, -vz * kick + rz * side * (rnd() * 2.5) + (rnd() - 0.5),
                            0.5 + rnd() * 0.5, this.beach ? 0.06 : 0.09 + rnd() * 0.06, 0.07, 1,
                            this.stone.r * shade, this.stone.g * shade, this.stone.b * shade, 0.3, 9.8, up);
                    } else {
                        this.puff(PUFF.DUST, wx + (rnd() - 0.5) * 0.4, up + 0.25, wz + (rnd() - 0.5) * 0.4,
                            vx * 0.2 + (rnd() - 0.5) * 1.6, 0.6 + rnd() * 1.1, vz * 0.2 + (rnd() - 0.5) * 1.6,
                            0.9 + rnd() * 0.6, 0.5, 2.4 + rnd() * 0.8, this.beach ? 0.2 : 0.26,
                            this.grit.r, this.grit.g, this.grit.b, 1.3, -0.15, up);
                    }
                }
            }
            // A raised kerb: a jolt of grit and a few sparks off the floor the moment it is hit,
            // and a shake for the camera when it is the car in view.
            if (kicked && v > 25) {
                const n = 3 + Math.round(Math.min(1, v / 100) * 6);
                for (let i = 0; i < n; i++) {
                    if (i % 2) this.spark(x + (rnd() - 0.5) * 1.4, up + 0.12, z + (rnd() - 0.5) * 1.4, -vx * 0.3 + (rnd() - 0.5) * 3, 1 + rnd() * 2, -vz * 0.3 + (rnd() - 0.5) * 3);
                    else this.puff(PUFF.GRIT, x + (rnd() - 0.5) * 1.6, up + 0.2, z + (rnd() - 0.5) * 1.6,
                        (rnd() - 0.5) * 2, 0.8 + rnd() * 1.4, (rnd() - 0.5) * 2, 0.5, 0.25, 1.2, 0.18,
                        this.grit.r, this.grit.g, this.grit.b, 2, 2, up);
                }
                const cam = this.sh.camera?.position, fxs = this.sh.fx;
                if (cam && fxs && (x - cam.x) ** 2 + (z - cam.z) ** 2 < 14 * 14) fxs.shake = Math.max(fxs.shake || 0, 0.35 * Math.min(1, v / 90));
            }

            for (let w = 0; w < 2; w++) {
                const side = w ? 1 : -1;
                const wx = x - fx * REAR + rx * TRACK_HALF * side;
                const wz = z - fz * REAR + rz * TRACK_HALF * side;
                // Tyre smoke (tarmac) or dust (grass). A wisp, not a cloud: with a hundred cars
                // sliding at once the old puffs (twice the rate, size and opacity) hid the pack.
                if (!onGravel && (slip > 0.35 || (onGrass && v > 20))) {
                    s.acc += dt * (onGrass ? 14 * Math.min(1, v / 60) : 22 * slip);
                    while (s.acc >= 1) {
                        s.acc -= 1;
                        const col = onGrass ? this.dust : null;
                        const shade = 0.72 + rnd() * 0.12;
                        this.puff(onGrass ? PUFF.DUST : PUFF.TYRE,
                            wx + (rnd() - 0.5) * 0.3, up + 0.25, wz + (rnd() - 0.5) * 0.3,
                            vx * 0.25 + (rnd() - 0.5) * 1.2, 0.5 + rnd() * 0.9, vz * 0.25 + (rnd() - 0.5) * 1.2,
                            onGrass ? 0.7 : 0.8 + rnd() * 0.6, 0.4, onGrass ? 1.8 : 2.1 + rnd() * 0.9,
                            onGrass ? 0.18 : 0.07 + slip * 0.08,
                            col ? col.r : shade, col ? col.g : shade, col ? col.b : shade * 1.02, 1.4, -0.25, up);
                    }
                }
                // Rain spray off the rear wheels.
                if (this.raining && v > 35 && !onGrass && !onGravel && rnd() < dt * 22 * (v / 140)) {
                    this.puff(PUFF.SPRAY, wx, up + 0.2, wz, vx * 0.35 + (rnd() - 0.5), 0.6 + rnd() * 0.5, vz * 0.35 + (rnd() - 0.5),
                        0.55, 0.6, 2.6, 0.11, 0.8, 0.84, 0.88, 2.2, 0.4, up);
                }
                // Gravel/mud tyre tracks dragged onto the tarmac (#2).
                if (onGrass || onGravel) {
                    s.mud = Math.min(1, s.mud + dt * 2.8);
                    s.mudPrev[w] = [wx, wz];
                } else if (skidsOn && s.mud > 0.06 && surface === SURF_ROAD) {
                    const mprev = s.mudPrev[w];
                    if (mprev) {
                        const d2 = (wx - mprev[0]) ** 2 + (wz - mprev[1]) ** 2;
                        if (d2 > 0.4 * 0.4) {
                            if (d2 < 9) {
                                const mc = this.beach ? this.stone : this.dust;
                                this.decals.addStrip(mprev[0], mprev[1], wx, wz, up, 0.14, mc.r * 0.55, mc.g * 0.52, mc.b * 0.48, s.mud * 0.48);
                            }
                            s.mudPrev[w] = [wx, wz];
                        }
                    } else {
                        s.mudPrev[w] = [wx, wz];
                    }
                } else {
                    s.mudPrev[w] = null;
                }
                // Skid marks.
                if (skidsOn && slip > 0.45 && !onGrass && !onGravel) {
                    const prev = s.skid[w];
                    if (prev) {
                        const d2 = (wx - prev[0]) ** 2 + (wz - prev[1]) ** 2;
                        if (d2 > 0.35 * 0.35) {
                            if (d2 < 9) this.skids.add(prev[0], prev[1], wx, wz, up);
                            s.skid[w] = [wx, wz];
                        }
                    } else {
                        s.skid[w] = [wx, wz];
                    }
                } else {
                    s.skid[w] = null;
                }
            }
            if (!onGrass && !onGravel && s.mud > 0) s.mud = Math.max(0, s.mud - dt * (0.28 + v * 0.004));
            // High-tier aerodynamic draft wake wisps at high speed (#3).
            if (this.sh.quality === 'high' && v > 105 && !this.raining && rnd() < dt * 8) {
                this.puff(PUFF.SPRAY, x - fx * 1.9, up + 0.55, z - fz * 1.9,
                    vx * 0.25 + (rnd() - 0.5) * 0.5, 0.25 + rnd() * 0.35, vz * 0.25 + (rnd() - 0.5) * 0.5,
                    0.28, 0.35, 1.35, 0.05, 0.85, 0.88, 0.92, 3.0, 0.1, up);
            }

            // How fast the car was closing on the barrier and which way it pointed, both trailing
            // by ~100 ms: on the tick it hits, the physics has already stopped the approach and
            // turned the car to face along the wall.
            const off = Math.abs(proj.lateral);
            const lag = Math.min(1, dt * 10);
            const out = s.out, hl = s.hl === null ? c.heading : s.hl;
            s.out += ((s.off === null ? 0 : (off - s.off) / dt) - s.out) * lag;
            s.hl = hl + wrapAngle(c.heading - hl) * lag;
            s.off = off;

            // Barrier scrape: the physics clamps a car's centre at wallAt (per sample and side:
            // deeper where the run-off is gravel or tarmac).
            const wall = off >= wallAt(t, proj.index, proj.lateral > 0 ? 1 : -1) - 0.8 && v > 18;
            if (wall) {
                const side = proj.lateral > 0 ? 1 : -1;
                const nx = -proj.ty * side, nz = proj.tx * side;
                const px = x + nx * CAR_RADIUS * 0.5 / WS, pz = z + nz * CAR_RADIUS * 0.5 / WS;
                const n = Math.min(6, Math.ceil(v / 25));
                for (let i = 0; i < n; i++) {
                    if (rnd() > dt * 40) continue;
                    this.spark(px, up + 0.35, pz, -vx * 0.5 + (rnd() - 0.5) * 4 - nx * 2, 1.5 + rnd() * 3.5, -vz * 0.5 + (rnd() - 0.5) * 4 - nz * 2);
                }
                events.scraping.set(c.id, Math.min(1, v / 100));
                const now = performance.now();
                // Barrier paint transfer streaks along contact face (#2).
                if (skidsOn && c.color && now - s.paintAt > 120) {
                    s.paintAt = now;
                    this.paintTransfer(px, up, pz, nx, nz, c.color, Math.min(1, 0.3 + v / 110));
                }
                // First touch of a stint along the wall is the hit; riding it is only the scrape.
                if (!s.walled && now - s.wallAt > 500) {
                    s.wallAt = now;
                    // Strength is the speed INTO the wall (a glancing scrape at full speed is a
                    // scuff, a square hit at half of it is a wreck), and the hit lands on the
                    // part of the body that was facing the wall as the car went in.
                    const ahead = nx * Math.cos(hl) + nz * Math.sin(hl), across = nz * Math.cos(hl) - nx * Math.sin(hl);
                    events.walls.push({
                        id: c.id, strength: Math.min(1, Math.max(0, out) / 55),
                        x: x + fx * ahead * 1.9 + rx * across * 0.83, z: z + fz * ahead * 1.9 + rz * across * 0.83,
                    });
                }
            }
            s.walled = wall;

            // Damage: a hurt engine smokes out of the bonnet, grey and then black as it goes; a
            // wreck pours black smoke and burns for a while, then smoulders.
            const engine = c.wrecked ? 1 : Math.max(0, ((Number(c.engine) || 0) - 0.4) / 0.6);
            if (c.wrecked) {
                s.wreckT += dt;
                if (skidsOn && !s.scorched) {
                    s.scorched = true;
                    this.scorchMark(x, up, z, c.heading);
                }
            }
            const cam = this.sh.camera?.position;
            const inRange = !cam || (x - cam.x) ** 2 + (z - cam.z) ** 2 < SMOKE_RANGE * SMOKE_RANGE;
            if (engine > 0 && inRange) {
                const burning = c.wrecked && s.wreckT < 12;
                s.sacc += dt * (c.wrecked ? (s.wreckT < 14 ? 24 : 6) : 3 + engine * 12);
                const bx = x + fx * 1.35, bz = z + fz * 1.35;
                while (s.sacc >= 1) {
                    s.sacc -= 1;
                    const shade = c.wrecked ? 0.07 + rnd() * 0.05 : 0.6 - 0.4 * engine + rnd() * 0.08;
                    this.puff(c.wrecked ? PUFF.WRECK : PUFF.ENGINE,
                        bx + (rnd() - 0.5) * 0.5, up + 0.75, bz + (rnd() - 0.5) * 0.5,
                        vx * 0.3 + (rnd() - 0.5) * 0.6, 1.1 + rnd() * 1.2, vz * 0.3 + (rnd() - 0.5) * 0.6,
                        1.8 + rnd() * 1.4, 0.5, c.wrecked ? 3.4 + rnd() * 1.2 : 1.8 + engine * 1.2,
                        c.wrecked ? 0.5 : 0.22 + engine * 0.22, shade, shade, shade * 1.03, 0.7, -0.5, up);
                }
                if (burning && rnd() < dt * 45) {
                    const k = rnd();
                    this.sparks.spawn(bx + (rnd() - 0.5) * 0.6, up + 0.6 + rnd() * 0.2, bz + (rnd() - 0.5) * 0.6,
                        (rnd() - 0.5) * 0.8, 1.5 + rnd() * 1.8, (rnd() - 0.5) * 0.8,
                        0.3 + rnd() * 0.35, 0.7 + rnd() * 0.5, 0.2, 1, 1, 0.35 + k * 0.4, 0.06, 2, -2.5, up);
                }
            }
        }

        // Car-to-car contact: the physics' own hull test (+ a little for interpolation), so the
        // sparks fly from where the bodies touch. Different road heights are different levels
        // of a crossing, not a contact.
        const now = performance.now();
        for (let i = 0; i < cars.length; i++) {
            for (let j = i + 1; j < cars.length; j++) {
                const a = cars[i], b = cars[j];
                const up = Number(a.h) || 0;
                if (Math.abs(up - (Number(b.h) || 0)) > 3) continue;
                const hit = hullContact(a, b, 1.5);
                if (!hit) continue;
                const mx = hit.x / WS, mz = hit.y / WS;
                const rel = Math.hypot(
                    Math.cos(a.heading) * a.speed - Math.cos(b.heading) * b.speed,
                    Math.sin(a.heading) * a.speed - Math.sin(b.heading) * b.speed);
                const n = Math.min(10, 2 + Math.floor(rel / 8));
                for (let k = 0; k < n; k++) {
                    this.spark(mx, up + 0.45, mz, (rnd() - 0.5) * 6, 1 + rnd() * 3, (rnd() - 0.5) * 6);
                }
                const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
                if (now - (this.pairs.get(key) || 0) > 350) {
                    this.pairs.set(key, now);
                    events.contacts.push({ x: mx, z: mz, strength: Math.min(1, 0.25 + rel / 60), ids: [a.id, b.id] });
                }
            }
        }

        const useGpu = this.sh.quality === 'high';
        this.smoke.step(dt, useGpu);
        this.sparks.step(dt, useGpu);
        this.skids.flush();
        this.decals.flush();
        this.updateScale();
        return events;
    }

    spark(x, y, z, vx, vy, vz) {
        const r = Math.random();
        this.sparks.spawn(x, y, z, vx, vy, vz, 0.25 + r * 0.35, 0.28, 0.08, 1,
            1.0, 0.55 + r * 0.3, 0.18 + r * 0.1, 0.6, 9.8);
    }

    updateScale() {
        const r = this.sh.renderer, cam = this.sh.camera;
        r.getDrawingBufferSize(this.size);
        const scale = this.size.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
        this.smoke.material.uniforms.uScale.value = scale;
        this.sparks.material.uniforms.uScale.value = scale;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.persistWear && this.track?.id) {
            const skids = this.skids.snapshot();
            const decals = this.decals.snapshot();
            trackWearCache = (skids || decals) ? { trackId: this.track.id, skids, decals } : null;
        }
        this.group.parent?.remove(this.group);
        this.smoke.dispose();
        this.sparks.dispose();
        this.skids.dispose();
        this.decals.dispose();
        this.state.clear();
    }
}

export function createFx(sceneHandle, track, opts) {
    return new CarFx(sceneHandle, track, opts);
}
