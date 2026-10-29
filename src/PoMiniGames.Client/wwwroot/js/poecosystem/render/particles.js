// particles.js — the scene-space particle field (GFX option 4).
//
// PoEcosystem had no particle system at all: fire was a static cone, an eruption threw
// physics rocks into a completely clean sky, and a felled tree hit the ground without
// raising a speck of dust. This module is the missing layer.
//
// DESIGN: THE CPU NEVER TOUCHES A LIVE PARTICLE
// Each particle is written exactly once, at emission, as a row of five instance attributes
// (origin, velocity, life, style, colour). The node material's vertex stage then integrates
// its whole trajectory from `time - birth` in closed form. That matters at this scale: a burning
// forest can carry a few thousand smoke puffs, and stepping those on the main thread every
// frame would cost more than the entire rest of the render loop.
//
// The integration is the exact solution of dv/dt = g - k*v (linear drag), which is why
// smoke can slow to a hover and embers can arc without either needing a per-frame step:
//   f   = (1 - exp(-k*t)) / k
//   pos = origin + v0*f + g*(t - f)/k
//
// TWO POOLS, TWO BLEND MODES
// Anything made of matter (smoke, ash, dust, spray, pollen) is alpha-blended and must not
// glow; anything made of light (embers, sparks, lava spatter) is additive. One pool each,
// because the blend mode is a material property and mixing them in a single draw would
// mean sorting — which is exactly what a particle system must avoid.
//
// Ring buffers, never allocation: a pool that is full overwrites its oldest row. Dropping
// the eldest smoke puff in a firestorm is invisible; a GC pause is not.
import { AdditiveBlending, Color, DynamicDrawUsage, InstancedBufferAttribute, NormalBlending, Sprite, SpriteNodeMaterial } from 'three-eco/webgpu';
import { dot, exp, float, instancedDynamicBufferAttribute, max, mix, sin, smoothstep, step, uniform, uv, varying, vec2, vec3 } from 'three-eco/tsl';

const SOFT_CAP = { high: 3000, medium: 1400, low: 0 };
const GLOW_CAP = { high: 1500, medium: 700, low: 0 };

// Presets. `speed`/`spread` describe the emission cone (spread is the half-angle in
// radians away from `up`), `drag` how fast it bleeds off (s^-1), `gravity` in m/s^2
// (negative falls), `growth` the fraction the sprite grows over its life.
const PRESETS = {
  // Smoke rises, spreads and lingers — the signature of a fire seen from across the island.
  smoke: { pool: 'soft', life: [3.2, 5.5], size: [1.4, 2.6], speed: [0.7, 1.9], spread: 0.55, drag: 0.5, gravity: 0.55, growth: 2.6, alpha: 0.30, colors: [0x4a4a4a, 0x6b6560, 0x2f2c2a] },
  // Ash falls. Same family, opposite sign, and it outlives everything else on screen.
  ash: { pool: 'soft', life: [5.0, 9.0], size: [0.16, 0.34], speed: [1.2, 3.4], spread: 1.2, drag: 0.9, gravity: -1.1, growth: 0, alpha: 0.55, colors: [0x3a3634, 0x57514c, 0x1c1a19] },
  dust: { pool: 'soft', life: [1.1, 2.2], size: [0.7, 1.6], speed: [1.4, 3.6], spread: 1.35, drag: 2.4, gravity: -0.9, growth: 2.0, alpha: 0.34, colors: [0xa89878, 0xc4b494, 0x8a7c62] },
  spray: { pool: 'soft', life: [0.7, 1.3], size: [0.16, 0.36], speed: [2.0, 4.5], spread: 0.8, drag: 1.4, gravity: -7.0, growth: 0.4, alpha: 0.6, colors: [0xdff2ff, 0xa8d8f0] },
  // Pollen is the only ambient emitter: a few motes a second around the player, by day.
  pollen: { pool: 'soft', life: [7.0, 12.0], size: [0.06, 0.12], speed: [0.2, 0.6], spread: 1.6, drag: 0.35, gravity: 0.06, growth: 0, alpha: 0.5, colors: [0xfff3c4, 0xe8f0b0] },
  splinter: { pool: 'soft', life: [1.0, 2.0], size: [0.1, 0.24], speed: [2.5, 5.5], spread: 1.5, drag: 0.7, gravity: -9.0, growth: 0, alpha: 0.9, colors: [0x8b5a2b, 0x6b4423, 0xa9793f] },
  ember: { pool: 'glow', life: [1.6, 3.4], size: [0.10, 0.22], speed: [1.6, 4.2], spread: 1.0, drag: 1.1, gravity: 0.35, growth: 0, alpha: 1, sparkle: 1, colors: [0xff9d3c, 0xff5e1a, 0xffd27a] },
  spark: { pool: 'glow', life: [0.35, 0.8], size: [0.07, 0.14], speed: [6.0, 13.0], spread: 1.6, drag: 3.2, gravity: -9.0, growth: 0, alpha: 1, sparkle: 1, colors: [0xfff6d8, 0xffd27a] },
  lava: { pool: 'glow', life: [1.4, 2.8], size: [0.18, 0.4], speed: [3.0, 8.0], spread: 0.9, drag: 0.5, gravity: -9.0, growth: 0, alpha: 1, colors: [0xff4d2d, 0xffa032, 0xd42a12] },
  // Nocturnal Bioluminescence: Fireflies wander and sparkle softly in the dark
  firefly: { pool: 'glow', life: [4.0, 8.0], size: [0.14, 0.28], speed: [0.4, 1.2], spread: 1.8, drag: 0.35, gravity: 0.03, growth: 0.2, alpha: 0.95, sparkle: 1, colors: [0x66ff99, 0xaaff55, 0x33eebb, 0x88ffdd] },
  // Bioluminescent spores float upward around settlements and ancient trees
  spore: { pool: 'glow', life: [5.0, 9.5], size: [0.09, 0.20], speed: [0.3, 0.9], spread: 1.4, drag: 0.3, gravity: 0.08, growth: 0.4, alpha: 0.88, sparkle: 1, colors: [0x77ccff, 0x99eeff, 0xbbffff] },
  // Weather (sim/events/weather.js). Emitted in a column above the god, pointed down, so
  // the drops are always where the camera is rather than spread thin over the island.
  rain: { pool: 'soft', life: [0.9, 1.3], size: [0.05, 0.08], speed: [14, 19], spread: 0.08, drag: 0.05, gravity: -9.0, growth: 0, alpha: 0.42, colors: [0xb8c8d8, 0x9fb4c8, 0xd0dce8] },
  snow: { pool: 'soft', life: [5.0, 8.0], size: [0.08, 0.16], speed: [0.8, 1.6], spread: 0.6, drag: 0.6, gravity: -0.7, growth: 0, alpha: 0.85, colors: [0xffffff, 0xeef4ff, 0xdfe8f5] },
  // The seasons shed: blossom in spring, leaves in autumn, both
  // let go from canopy height near the camera and drift down on a little drag.
  petal: { pool: 'soft', life: [5.0, 9.0], size: [0.08, 0.15], speed: [0.3, 0.9], spread: 1.4, drag: 0.8, gravity: -0.34, growth: 0, alpha: 0.88, colors: [0xffd1e8, 0xfff0f6, 0xf9a8d4, 0xffffff] },
  leaf: { pool: 'soft', life: [4.0, 7.0], size: [0.11, 0.2], speed: [0.4, 1.2], spread: 1.3, drag: 0.7, gravity: -0.6, growth: 0, alpha: 0.9, colors: [0xd97706, 0xb45309, 0xf59e0b, 0x9a3412] },
  // Under the waterline: air on its way up.
  bubble: { pool: 'soft', life: [1.6, 3.2], size: [0.05, 0.13], speed: [0.2, 0.6], spread: 0.8, drag: 0.6, gravity: 1.3, growth: 0.3, alpha: 0.5, colors: [0xdff6ff, 0xb5e8f7, 0xffffff] },
  // A watched creature's last breath rises; a birth in its family opens as a ring.
  wisp: { pool: 'glow', life: [3.4, 5.4], size: [0.16, 0.34], speed: [0.5, 1.1], spread: 0.25, drag: 0.25, gravity: 0.5, growth: 0.6, alpha: 0.9, sparkle: 1, colors: [0xe0f2fe, 0xc7d2fe, 0xfef3c7] },
  mote: { pool: 'glow', life: [1.3, 2.1], size: [0.1, 0.18], speed: [2.3, 2.9], spread: 0.04, drag: 1.3, gravity: 0.06, growth: 0, alpha: 0.9, colors: [0xfde68a, 0xbbf7d0, 0xffffff] },
};

// One pool = one instanced Sprite. Each row is a sprite instance whose attributes were
// written once at emission; the node graph below integrates its trajectory from
// `time - birth` in closed form, scales it by its age, and fades it in and out. Sprites,
// not GL points: WebGPU has no point size, and a world-sized billboard is what the old
// gl_PointSize maths was imitating anyway (size × px-per-metre ÷ distance).
function createPool(scene, cap, uTime, { additive, name }) {
  const origin = new Float32Array(cap * 3);
  const vel = new Float32Array(cap * 3);
  const life = new Float32Array(cap * 4);
  const style = new Float32Array(cap * 4);
  const colour = new Float32Array(cap * 3);
  const attrs = {
    origin: new InstancedBufferAttribute(origin, 3),
    vel: new InstancedBufferAttribute(vel, 3),
    life: new InstancedBufferAttribute(life, 4),     // birth, life, gravity, drag
    style: new InstancedBufferAttribute(style, 4),   // size, growth, sparkle, alpha
    colour: new InstancedBufferAttribute(colour, 3),
  };
  for (const a of Object.values(attrs)) a.setUsage(DynamicDrawUsage);

  const aOrigin = instancedDynamicBufferAttribute(attrs.origin, 'vec3');
  const aVel = instancedDynamicBufferAttribute(attrs.vel, 'vec3');
  const aLife = instancedDynamicBufferAttribute(attrs.life, 'vec4');
  const aStyle = instancedDynamicBufferAttribute(attrs.style, 'vec4');
  const aColour = instancedDynamicBufferAttribute(attrs.colour, 'vec3');

  const age = uTime.sub(aLife.x);
  const span = aLife.y;
  // Every row starts dead (life = 0); a dead row is a zero-size sprite.
  const alive = step(0, age).mul(step(age, span));
  // dv/dt = g - k*v, solved exactly: f = (1 - e^-kt)/k; pos = o + v0*f + g*(t - f)/k.
  const k = max(0.01, aLife.w);
  const f = float(1).sub(exp(k.negate().mul(age))).div(k);
  const pos = aOrigin.add(aVel.mul(f)).add(vec3(0, aLife.z, 0).mul(age.sub(f)).div(k));
  const t = age.div(span);
  const size = aStyle.x.mul(aStyle.y.mul(t).add(1)).mul(alive);

  const material = new SpriteNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, fog: true,
    blending: additive ? AdditiveBlending : NormalBlending,
  });
  material.positionNode = pos;
  material.scaleNode = vec2(size, size);
  material.colorNode = varying(aColour, 'vPartColour');
  // Fade in over the first tenth of the life, out over the last two thirds; a soft round
  // sprite from the quad's own uv (no texture: cannot be blurry at any DPR). Embers flicker,
  // per particle via the colour, so a burst does not pulse in unison; matter does not.
  const d = uv().sub(0.5);
  const r = dot(d, d).mul(4);
  const mask = float(1).sub(smoothstep(0.35, 1, r));
  const fade = smoothstep(0, 0.1, t).mul(float(1).sub(smoothstep(0.35, 1, t)));
  const flicker = mix(float(1), sin(uTime.mul(24).add(aColour.x.mul(90))).mul(0.38).add(0.62), step(0.5, aStyle.z));
  material.opacityNode = varying(aStyle.w.mul(fade).mul(flicker), 'vPartAlpha').mul(mask);
  material.alphaTest = 0.001;

  const sprite = new Sprite(material);
  sprite.count = cap;
  sprite.frustumCulled = false;
  sprite.name = name;
  sprite.renderOrder = additive ? 12 : 10;   // glow over matter, both over the world
  scene.add(sprite);

  return { material, sprite, attrs, cap, cursor: 0, dirty: false, origin, vel, life, style, colour };
}

const lerp = (a, b, t) => a + (b - a) * t;

export function createParticles(scene, { tier = 'high' } = {}) {
  const softCap = SOFT_CAP[tier] ?? 0;
  const glowCap = GLOW_CAP[tier] ?? 0;

  // Low tier gets a real object with no pools: every call site stays unconditional.
  // One clock for both pools; the fog is the scene's own (FogExp2 through the node
  // material's fog stage), so particles sit in the same air as the world for free.
  const uTime = uniform(0);
  const pools = {
    soft: softCap ? createPool(scene, softCap, uTime, { additive: false, name: 'particles-soft' }) : null,
    glow: glowCap ? createPool(scene, glowCap, uTime, { additive: true, name: 'particles-glow' }) : null,
  };

  let time = 0;
  const tmp = new Color();

  function write(pool, preset, x, y, z, vx, vy, vz, scale) {
    const i = pool.cursor;
    pool.cursor = (i + 1) % pool.cap;
    pool.dirty = true;

    pool.origin[i * 3] = x; pool.origin[i * 3 + 1] = y; pool.origin[i * 3 + 2] = z;
    pool.vel[i * 3] = vx; pool.vel[i * 3 + 1] = vy; pool.vel[i * 3 + 2] = vz;

    const o4 = i * 4;
    pool.life[o4] = time;
    pool.life[o4 + 1] = lerp(preset.life[0], preset.life[1], Math.random());
    pool.life[o4 + 2] = preset.gravity;
    pool.life[o4 + 3] = preset.drag;

    pool.style[o4] = lerp(preset.size[0], preset.size[1], Math.random()) * scale;
    pool.style[o4 + 1] = preset.growth;
    pool.style[o4 + 2] = preset.sparkle ?? 0;
    pool.style[o4 + 3] = preset.alpha;
    return i;
  }

  function paint(pool, i, colours, override) {
    if (override !== undefined) tmp.setHex(override);
    else tmp.setHex(colours[(Math.random() * colours.length) | 0]);
    // No colour-space conversion here: ColorManagement (on by default since r152) already
    // moved the hex into three's linear working space, which is what the HDR target wants.
    pool.colour[i * 3] = tmp.r; pool.colour[i * 3 + 1] = tmp.g; pool.colour[i * 3 + 2] = tmp.b;
  }

  const api = {
    /**
     * Emit a burst.
     * @param {string} kind one of PRESETS
     * @param {number} x @param {number} y @param {number} z world position
     * @param {object} [o]
     * @param {number} [o.count=12]
     * @param {number} [o.scale=1] multiplies size and speed together
     * @param {number} [o.spread] override the cone half-angle, radians
     * @param {number} [o.speed] override the cone speed multiplier
     * @param {number} [o.radius=0] jitter the origin inside this radius
     * @param {number} [o.color] force one sRGB hex instead of the preset palette
     * @param {number[]} [o.dir] cone axis, defaults to straight up
     */
    emit(kind, x, y, z, o = {}) {
      const preset = PRESETS[kind];
      const pool = preset && pools[preset.pool];
      if (!pool) return;
      const count = Math.max(1, Math.round((o.count ?? 12) * (tier === 'medium' ? 0.55 : 1)));
      const scale = o.scale ?? 1;
      const spread = o.spread ?? preset.spread;
      const speedMul = o.speed ?? 1;
      const radius = o.radius ?? 0;
      const ax = o.dir?.[0] ?? 0; const ay = o.dir?.[1] ?? 1; const az = o.dir?.[2] ?? 0;

      for (let n = 0; n < count; n++) {
        // Cone sampling: a random tilt away from the axis, then a random roll about it.
        // Building the basis from the axis keeps `dir` honest for sideways emitters
        // (a rockslide throws dust downhill, not up).
        const tilt = Math.acos(1 - Math.random() * (1 - Math.cos(spread)));
        const roll = Math.random() * Math.PI * 2;
        // Any vector not parallel to the axis will do for the first tangent.
        const parallelZ = Math.abs(az) > 0.9;
        const tx = parallelZ ? 1 : 0; const ty = 0; const tz = parallelZ ? 0 : 1;
        const bx = ay * tz - az * ty, by = az * tx - ax * tz, bz = ax * ty - ay * tx;
        const bl = Math.hypot(bx, by, bz) || 1;
        const ux = bx / bl, uy = by / bl, uz = bz / bl;
        const wx = ay * uz - az * uy, wy = az * ux - ax * uz, wz = ax * uy - ay * ux;

        const st = Math.sin(tilt), ct = Math.cos(tilt);
        const dx = ax * ct + (ux * Math.cos(roll) + wx * Math.sin(roll)) * st;
        const dy = ay * ct + (uy * Math.cos(roll) + wy * Math.sin(roll)) * st;
        const dz = az * ct + (uz * Math.cos(roll) + wz * Math.sin(roll)) * st;

        const sp = lerp(preset.speed[0], preset.speed[1], Math.random()) * scale * speedMul;
        const jx = radius ? (Math.random() * 2 - 1) * radius : 0;
        const jy = radius ? (Math.random() * 2 - 1) * radius * 0.3 : 0;
        const jz = radius ? (Math.random() * 2 - 1) * radius : 0;
        const i = write(pool, preset, x + jx, y + jy, z + jz, dx * sp, dy * sp, dz * sp, scale);
        paint(pool, i, preset.colors, o.color);
      }
    },

    /**
     * A vertical column — the eruption plume and the smoke stack over a big fire. Emitting
     * up the column rather than from its base is what makes it read as a continuous shaft
     * instead of a puff that has to climb before anyone sees it.
     */
    column(kind, x, y, z, height, count, o = {}) {
      const preset = PRESETS[kind];
      if (!preset || !pools[preset.pool]) return;
      const n = Math.max(1, Math.round(count * (tier === 'medium' ? 0.55 : 1)));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        api.emit(kind, x, y + t * height, z, {
          ...o, count: 1, radius: (o.radius ?? 1) * (0.4 + t * 1.6), scale: (o.scale ?? 1) * (1 + t * 0.8),
        });
      }
    },

    /** A flat ring that opens outward from a point: `count` particles, one per bearing. */
    ring(kind, x, y, z, count = 24) {
      for (let k = 0; k < count; k++) {
        const a = (k / count) * Math.PI * 2;
        api.emit(kind, x, y, z, { count: 1, dir: [Math.cos(a), 0.06, Math.sin(a)], spread: 0.03 });
      }
    },

    /** Per frame: advance the shared clock and upload the rows written since the last one. */
    update(dt) {
      time += dt;
      uTime.value = time;
      for (const pool of [pools.soft, pools.glow]) {
        if (!pool || !pool.dirty) continue;
        for (const a of Object.values(pool.attrs)) a.needsUpdate = true;
        pool.dirty = false;
      }
    },

    get time() { return time; },
    get enabled() { return !!(pools.soft || pools.glow); },

    dispose() {
      for (const pool of [pools.soft, pools.glow]) {
        if (!pool) continue;
        scene.remove(pool.sprite);
        pool.material.dispose();
      }
    },
  };
  return api;
}
