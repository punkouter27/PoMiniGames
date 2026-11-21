import * as THREE from 'three-eco/webgpu';
import * as TSL from 'three-eco/tsl';

// platform/3d/paperFieldTsl.js — loose paper for the r186 WebGPU games; the easy way in is the
// `paper` stage feature (platform/stage/features/paper.js), which feeds and steps it. Written for
// PoCapitol. It is paperField.js (r165, GPUComputationRenderer, GLSL) as a TSL compute kernel.
//
// Loose paper: flyers, leaflets, torn placards and a few red and blue sheets, lying about the
// lawn and the floors until wind, a blast or a running crowd lifts them.
//
// All of it lives on the GPU. Three storage buffers hold one element per sheet: position (xyz),
// the velocity (xyz, plus w = 1 while airborne), and the orientation (yaw, pitch, roll, and w =
// how fast it spins). One compute kernel advances every sheet each frame, and the draw call reads
// the same buffers by instance index in the vertex stage, so 16k sheets cost one dispatch and one
// instanced draw with no per-frame JavaScript beyond a few uniforms. (The old version ran three
// full-screen passes over three float textures: every pass read the previous frame's state. The
// kernel reads a sheet's whole previous state first and writes the next one, which is the same.)
//
// The world is baked once into a small float texture over the play rectangle (ground height, wall
// mask, indoors mask), because the kernel cannot call back into the game's world code. Resting
// sheets do nothing but stay put, so a still day is almost free.
//
// Flight is a flat plate in moving air: the part of the relative wind along the sheet's normal
// pushes hard (drag grows with the square of it), the part along its face barely at all. The
// orientation oscillates while aloft, which is what makes a falling sheet slide sideways and
// flutter instead of dropping like a stone.
//
// Compute needs the WebGPU backend. On the renderer's WebGL2 backend this returns a no-op and the
// ground is simply bare of paper, as it is on the lowest tier.

const CELL = 0.5;
const MAX_BLASTS = 8;
const MAX_MOVERS = 32;
const MAX_DT = 0.05;

const noop = {
    mesh: null,
    update() {},
    setLevel() {},
    reset() {},
    dispose() {},
};

// Mulberry32: the seeded scatter has to be the same on every machine and every run.
function seeded(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function createPaperField(scene, renderer, { rect = { x0: -40, z0: -56, w: 80, d: 152 }, groundHeight, blocked, indoors, size = 128 } = {}) {
    try {
        if (!renderer || renderer.backend?.isWebGPUBackend !== true) return { ...noop };
        return build(scene, renderer, { rect, groundHeight, blocked, indoors, size });
    } catch (error) {
        console.warn('[paper] unavailable:', error);
        return { ...noop };
    }
}

function bakeMask(rect, groundHeight, blocked, indoors) {
    const w = Math.ceil(rect.w / CELL), h = Math.ceil(rect.d / CELL);
    const data = new Float32Array(w * h * 4);
    // A wall thinner than a cell would fall between sample points, so a cell is walled if any of
    // five points over it is.
    const probes = [[0, 0], [0.22, 0.22], [-0.22, 0.22], [0.22, -0.22], [-0.22, -0.22]];
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
            const x = rect.x0 + (i + 0.5) * CELL, z = rect.z0 + (j + 0.5) * CELL;
            const o = (j * w + i) * 4;
            data[o] = groundHeight ? groundHeight(x, z) : 0;
            data[o + 1] = blocked && probes.some(([dx, dz]) => blocked(x + dx, z + dz)) ? 1 : 0;
            data[o + 2] = indoors && indoors(x, z) ? 1 : 0;
        }
    }
    const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    return { texture, data, w, h };
}

function build(scene, renderer, { rect, groundHeight, blocked, indoors, size }) {
    const { Fn, If, Loop, Break, float, int, vec2, vec3, vec4, ivec2, uniform, uniformArray, texture, instanceIndex, fract, sin, cos, floor, mix, max, min, length, dot, normalize, exp, select, abs, step } = TSL;
    const count = size * size;
    const mask = bakeMask(rect, groundHeight, blocked, indoors);
    const cellOpen = (x, z) => {
        const i = Math.floor((x - rect.x0) / CELL), j = Math.floor((z - rect.z0) / CELL);
        if (i < 0 || j < 0 || i >= mask.w || j >= mask.h) return false;
        return mask.data[(j * mask.w + i) * 4 + 1] < 0.5;
    };
    const cellIndoors = (x, z) => {
        const i = Math.floor((x - rect.x0) / CELL), j = Math.floor((z - rect.z0) / CELL);
        return mask.data[(j * mask.w + i) * 4 + 2] > 0.5;
    };
    const cellGround = (x, z) => {
        const i = Math.min(mask.w - 1, Math.max(0, Math.floor((x - rect.x0) / CELL)));
        const j = Math.min(mask.h - 1, Math.max(0, Math.floor((z - rect.z0) / CELL)));
        return mask.data[(j * mask.w + i) * 4];
    };

    const positions = new Float32Array(count * 4), velocities = new Float32Array(count * 4), rotations = new Float32Array(count * 4);
    // Seeded scatter. Roughly a third of the sheets go indoors, since the floors are the point of
    // half the rooms; a position with a wall on it is tried again a few times and then dropped
    // wherever the last try fell, which the first step settles.
    function scatter() {
        const rand = seeded(0x9A9E25);
        positions.fill(0); velocities.fill(0); rotations.fill(0);
        for (let k = 0; k < count; k++) {
            const wantIndoors = rand() < 0.33;
            let x = 0, z = 0;
            for (let t = 0; t < 24; t++) {
                x = rect.x0 + rand() * rect.w;
                z = rect.z0 + rand() * rect.d;
                if (cellOpen(x, z) && cellIndoors(x, z) === wantIndoors) break;
            }
            const o = k * 4;
            positions[o] = x; positions[o + 1] = cellGround(x, z) + 0.012; positions[o + 2] = z; positions[o + 3] = 0;
            rotations[o] = rand() * Math.PI * 2; rotations[o + 1] = 0; rotations[o + 2] = 0;
            rotations[o + 3] = (rand() < 0.5 ? -1 : 1) * (0.8 + rand() * 3.0);
        }
    }
    scatter();
    const pos = TSL.instancedArray(positions, 'vec4'), vel = TSL.instancedArray(velocities, 'vec4'), rot = TSL.instancedArray(rotations, 'vec4');

    const blasts = Array.from({ length: MAX_BLASTS }, () => new THREE.Vector4());
    const movers = Array.from({ length: MAX_MOVERS }, () => new THREE.Vector4());
    const wind = new THREE.Vector2();
    const rectVec = new THREE.Vector4(rect.x0, rect.z0, mask.w * CELL, mask.h * CELL);
    const uDt = uniform(0.016), uTime = uniform(0), uWind = uniform(wind), uRect = uniform(rectVec);
    const uBlasts = uniformArray(blasts, 'vec4'), uMovers = uniformArray(movers, 'vec4');
    const uBlastN = uniform(0, 'int'), uMoverN = uniform(0, 'int');
    const maskTex = texture(mask.texture);

    // ---- helpers
    const hash12 = Fn(([p]) => {
        const q = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
        q.addAssign(dot(q, q.yzx.add(33.33)));
        return fract(q.x.add(q.y).mul(q.z));
    });
    // r = (yaw, pitch, roll): roll about the normal's own axis first, then pitch, then yaw.
    const orient = (v0, r) => {
        const sr = sin(r.z), cr = cos(r.z), sp = sin(r.y), cp = cos(r.y), sy = sin(r.x), cy = cos(r.x);
        const v1 = vec3(cr.mul(v0.x).sub(sr.mul(v0.y)), sr.mul(v0.x).add(cr.mul(v0.y)), v0.z);
        const v2 = vec3(v1.x, cp.mul(v1.y).sub(sp.mul(v1.z)), sp.mul(v1.y).add(cp.mul(v1.z)));
        return vec3(cy.mul(v2.x).add(sy.mul(v2.z)), v2.y, sy.negate().mul(v2.x).add(cy.mul(v2.z)));
    };
    const cellOf = xz => ivec2(floor(xz.sub(uRect.xy).div(CELL)));
    const clampCell = c => ivec2(TSL.clamp(c.x, 0, mask.w - 1), TSL.clamp(c.y, 0, mask.h - 1));
    const maskAt = xz => maskTex.load(clampCell(cellOf(xz)));
    const outside = xz => {
        const c = cellOf(xz);
        return c.x.lessThan(0).or(c.y.lessThan(0)).or(c.x.greaterThanEqual(mask.w)).or(c.y.greaterThanEqual(mask.h));
    };
    // Bilinear by hand: float textures are not filterable everywhere, and a nearest ground would
    // stair-step a sheet lying on a slope.
    const ground = xz => {
        const g = xz.sub(uRect.xy).div(CELL).sub(0.5);
        const i = ivec2(floor(g)), f = fract(g);
        const a = maskTex.load(clampCell(i)).r, b = maskTex.load(clampCell(i.add(ivec2(1, 0)))).r;
        const c = maskTex.load(clampCell(i.add(ivec2(0, 1)))).r, d = maskTex.load(clampCell(i.add(ivec2(1, 1)))).r;
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    };
    const sheetUv = () => vec2(float(instanceIndex.mod(size)).add(0.5).div(size), float(instanceIndex.div(size)).add(0.5).div(size));
    const blocked_ = xz => outside(xz).or(maskAt(xz).g.greaterThan(0.5));

    // ---- the step: velocity, position and orientation of every sheet
    const kernel = Fn(() => {
        const k = instanceIndex;
        const P4 = pos.element(k).toVar(), V4 = vel.element(k).toVar(), R4 = rot.element(k).toVar();
        const uv = sheetUv();
        const h1 = hash12(uv), h2 = hash12(uv.add(7.31));
        const roll = hash12(uv.add(fract(uTime).mul(13.7)));
        const dt = uDt;
        // w is 0 for a sheet lying down and 1 + boost while airborne: boost is how long a blast or
        // a foot has it flying ballistically, riding the air that threw it, before drag reclaims it.
        const air = select(V4.w.greaterThan(0.5), 1, 0).toVar();
        const boost = max(V4.w.sub(1), 0).toVar();
        const v = V4.xyz.toVar();
        // The position step will move this sheet by the velocity it read now. Judge walls and
        // ground from where that leaves it, so the velocity written here is the one that is safe to
        // apply next.
        const P = P4.xyz.toVar();
        If(air.greaterThan(0.5), () => { P.addAssign(v.mul(dt)); });
        const g0 = ground(P.xz);

        // Indoors there is no wind at all; outdoors a gust is wind with a slow per-sheet ripple,
        // so the lightest sheets lift first and not all in one frame.
        const w = uWind.mul(maskAt(P.xz).b.oneMinus());
        const ws = length(w);

        const kick = vec3(0).toVar(), kicked = float(0).toVar();
        Loop(MAX_BLASTS, ({ i }) => {
            If(i.greaterThanEqual(uBlastN), () => { Break(); });
            const b = uBlasts.element(i);
            const d = P.xz.sub(b.xy);
            const r = length(d);
            If(r.lessThan(b.w).and(P.y.lessThan(g0.add(b.w.mul(0.5)))), () => {
                const f = r.div(b.w).oneMinus().toVar();
                f.mulAssign(f);
                const o = d.div(max(r, 0.05));
                kick.addAssign(vec3(o.x.mul(0.7), 1, o.y.mul(0.7)).mul(b.z.mul(18).mul(f).mul(h2.mul(0.5).add(0.5))));
                kicked.assign(1);
            });
        });
        Loop(MAX_MOVERS, ({ i }) => {
            If(i.greaterThanEqual(uMoverN), () => { Break(); });
            const m = uMovers.element(i);
            const d = P.xz.sub(m.xy);
            const r = length(d);
            const sp = length(m.zw);
            If(r.lessThan(1).and(sp.greaterThan(0.5)).and(P.y.lessThan(g0.add(0.6))), () => {
                const f = r.oneMinus();
                // A foot scuffs a sheet now and then, not every frame it is near, or it would be
                // pinned in a shuddering hover over the runner.
                If(roll.lessThan(dt.mul(8).mul(f)), () => {
                    const o = d.div(max(r, 0.05));
                    kick.addAssign(vec3(m.zw.mul(h2.mul(0.3).add(0.35)).add(o.mul(0.8)), 0).xzy.add(vec3(0, h1.mul(2.5).add(1.5).mul(min(sp.div(4), 1)).add(0.6), 0)));
                    kicked.assign(max(kicked, 0.5));
                });
            });
        });

        If(air.lessThan(0.5), () => {
            const gust = sin(uTime.mul(0.8).add(h1.mul(40))).mul(0.5).add(0.5);
            const eff = ws.mul(gust.mul(0.7).add(0.55));
            const thr = h1.mul(5).add(2.2);
            const lifted = eff.greaterThan(thr).and(roll.lessThan(dt.mul(1.5).mul(eff.sub(thr)).div(thr)));
            If(lifted.or(dot(kick, kick).greaterThan(0.01)), () => {
                air.assign(1);
                boost.assign(kicked);
                v.assign(kick.add(select(lifted, vec3(w.x.mul(0.4), h2.mul(1.8).add(1), w.y.mul(0.4)), vec3(0))));
            }).Else(() => { v.assign(vec3(0)); });
        }).Else(() => {
            v.addAssign(kick);
            boost.assign(max(boost, kicked));
        });

        If(air.greaterThan(0.5), () => {
            const n = orient(vec3(0, 1, 0), R4.xyz);
            const air3 = vec3(w.x, 0, w.y).toVar();
            // Turbulence scales with the wind, so a still day has none and a gale tosses them.
            air3.addAssign(ws.mul(0.3).mul(vec3(
                sin(uTime.mul(1.7).add(h1.mul(30)).add(P.z.mul(0.3))),
                sin(uTime.mul(2.3).add(h2.mul(30)).add(P.x.mul(0.2))).mul(0.6),
                cos(uTime.mul(1.3).add(h2.mul(20)).add(P.x.mul(0.25))))));
            const vr = air3.sub(v);
            const vn = dot(vr, n);
            const mass = h2.mul(0.6).add(0.7);
            // Flat to the air a sheet falls at about 1.2 m/s. The clamp keeps a blast-speed sheet
            // from overshooting the air's own velocity within one step.
            const kN = min(float(6.8).div(mass).mul(abs(vn)).mul(mix(1, 0.06, boost)), float(0.9).div(dt));
            const acc = vec3(0, -9.8, 0).add(n.mul(vn.mul(kN))).add(vr.sub(n.mul(vn)).mul(0.45));
            v.addAssign(acc.mul(dt));
            boost.assign(max(boost.sub(dt.mul(0.9)), 0));

            const np = P.add(v.mul(dt)).toVar();
            If(blocked_(np.xz).or(ground(np.xz).sub(P.y).greaterThan(0.45)), () => {
                const tx = vec2(np.x, P.z), tz = vec2(P.x, np.z);
                If(blocked_(tx).or(ground(tx).sub(P.y).greaterThan(0.45)), () => { v.x.mulAssign(-0.3); });
                If(blocked_(tz).or(ground(tz).sub(P.y).greaterThan(0.45)), () => { v.z.mulAssign(-0.3); });
                np.assign(P.add(v.mul(dt)));
                // Wedged in a corner: stop dead rather than tunnel on the next step.
                If(blocked_(np.xz), () => { v.x.assign(0); v.z.assign(0); np.assign(P.add(vec3(0, v.y.mul(dt), 0))); });
            });
            If(np.y.greaterThan(30), () => { v.y.assign(min(v.y, 0)); });
            If(np.y.lessThanEqual(ground(np.xz).add(0.012)), () => { air.assign(0); v.assign(vec3(0)); });
        });
        const newV = vec4(v, select(air.greaterThan(0.5), boost.add(1), 0));

        // Position, from the velocity it read at the start of the step.
        const h = hash12(uv.add(3.3));
        const P0 = P4.xyz;
        // Lying down: sit on the ground, a hair apart per sheet so two overlapping ones never z-fight.
        const newP = select(V4.w.lessThan(0.5),
            vec3(P0.x, ground(P0.xz).add(0.012).add(h.mul(0.004)), P0.z),
            P0.add(V4.xyz.mul(dt)));

        // Orientation.
        const R = R4.toVar();
        If(V4.w.greaterThan(0.5), () => {
            const spd = length(V4.xyz);
            const amp = min(1, spd.mul(0.12)).add(0.45);
            const target = vec2(
                amp.mul(sin(uTime.mul(h1.mul(3).add(3)).add(h2.mul(6.28)))),
                amp.mul(1.2).mul(sin(uTime.mul(h2.mul(3).add(2.5)).add(h1.mul(6.28)).add(1.3))));
            R.yz.assign(mix(R.yz, target, exp(dt.mul(-5)).oneMinus()));
            R.x.addAssign(R.w.mul(dt).mul(spd.mul(0.1).add(1)));
        }).Else(() => {
            R.yz.assign(mix(R.yz, vec2(0), exp(dt.mul(-8)).oneMinus()));
        });

        pos.element(k).assign(vec4(newP, P4.w));
        vel.element(k).assign(newV);
        rot.element(k).assign(R);
    })().compute(count);

    // ---- the draw side. The sheet lies in the XZ plane (normal +Y), is curled across its width,
    // rotated by its orientation and moved to its simulated position. The normal is rotated with it
    // so the scene's lights see the curl.
    const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    {
        const P = pos.element(instanceIndex), R = rot.element(instanceIndex);
        const uv = sheetUv();
        const h1 = hash12(uv), h2 = hash12(uv.add(7.31)), h3 = hash12(uv.add(3.7));
        const curl = h2.sub(0.5).mul(2);
        // Mostly plain white sheets; a few coloured leaflets; the odd torn placard, bigger and brown.
        const placard = h3.greaterThan(0.97);
        const scale = h1.mul(0.55).add(0.8).mul(select(placard, 1.8, 1));
        const tint = select(h3.lessThan(0.07), vec3(0.85, 0.22, 0.2),
            select(h3.lessThan(0.14), vec3(0.28, 0.42, 0.85),
                select(h3.lessThan(0.22), vec3(0.95, 0.86, 0.5),
                    select(placard, vec3(0.75, 0.6, 0.4), vec3(h1.mul(0.14).add(0.86))))));
        const ink = select(placard, 0, 1);
        const pg = TSL.positionGeometry;
        const fX = pg.x.div(0.15);
        material.positionNode = P.xyz.add(orient(vec3(pg.x, curl.mul(fX).mul(fX).mul(0.05), pg.z).mul(scale), R.xyz));
        material.normalNode = TSL.transformNormalToView(orient(normalize(vec3(curl.mul(fX).mul(-0.9), 1, 0)), R.xyz));
        // Faint printed lines on the plain sheets.
        const line = step(0.55, fract(pg.z.mul(38))).mul(step(abs(pg.x), 0.115)).mul(step(0.03, abs(pg.z)));
        material.colorNode = TSL.materialColor.mul(vec4(tint.mul(line.mul(ink).mul(0.16).oneMinus()), 1));
    }

    // Not an InstancedMesh: there are no per-instance matrices to fill and keep, only the instance
    // index, which the vertex stage turns into a buffer element.
    const plane = new THREE.PlaneGeometry(0.3, 0.22, 6, 1);
    plane.rotateX(-Math.PI / 2);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.copy(plane);
    plane.dispose();
    geometry.instanceCount = count;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.name = 'flyers';
    scene.add(mesh);

    let level = 2;
    let clock = 0;

    function update(dt, time, { wind: w, blasts: bs, movers: ms } = {}) {
        if (level === 0) return;
        uDt.value = Math.min(Math.max(dt, 0), MAX_DT);
        clock = time ?? clock + dt;
        uTime.value = clock;
        wind.set(w?.x ?? 0, w?.z ?? 0);
        const nb = Math.min(bs?.length ?? 0, MAX_BLASTS);
        for (let i = 0; i < nb; i++) blasts[i].set(bs[i].x, bs[i].z, bs[i].strength, bs[i].radius);
        uBlastN.value = nb;
        const nm = Math.min(ms?.length ?? 0, MAX_MOVERS);
        for (let i = 0; i < nm; i++) movers[i].set(ms[i].x, ms[i].z, ms[i].vx, ms[i].vz);
        uMoverN.value = nm;
        renderer.compute(kernel);
    }

    function setLevel(next) {
        level = next >= 2 ? 2 : next >= 1 ? 1 : 0;
        mesh.visible = level > 0;
        geometry.instanceCount = level === 2 ? count : level === 1 ? count >> 2 : 0;
    }

    function reset() {
        scatter();
        for (const [node, data] of [[pos, positions], [vel, velocities], [rot, rotations]]) {
            node.value.array.set(data);
            node.value.needsUpdate = true;
        }
    }

    function dispose() {
        scene.remove(mesh);
        geometry.dispose();
        material.dispose();
        mask.texture.dispose();
    }

    return { mesh, update, setLevel, reset, dispose };
}
