import * as THREE from 'three-eco/webgpu';
import * as TSL from 'three-eco/tsl';
import { mirror, fbm2, noise3 } from './nodes.js';

// Surface, sky and material helpers for PoCapitol's realism pass.
//
// Everything here is generated at startup: no image downloads. The scene is built from plain
// boxes whose UVs run 0..1 per face whatever the box's size, so surface detail is mapped in
// world space (triplanar) instead: a 1.2 m stone block is 1.2 m on a 30 m wall and on a 2 m
// pier alike, and instanced batches need no UV fix-ups.

// ---------------------------------------------------------------- tileable noise texture

function hash(i, j, seed) {
    let h = (i * 374761393 + j * 668265263 + seed * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise that wraps at the texture edge, so it tiles without seams. */
function tileNoise(size, seed, base, octaves) {
    const out = new Float32Array(size * size);
    let amp = 1, total = 0;
    for (let o = 0; o < octaves; o++) {
        const period = base << o, cell = size / period;
        for (let y = 0; y < size; y++) {
            const fy = y / cell, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
            for (let x = 0; x < size; x++) {
                const fx = x / cell, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
                const x0 = ix % period, x1 = (ix + 1) % period, y0 = iy % period, y1 = (iy + 1) % period;
                const a = hash(x0, y0, seed + o), b = hash(x1, y0, seed + o);
                const c = hash(x0, y1, seed + o), d = hash(x1, y1, seed + o);
                out[y * size + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
            }
        }
        total += amp; amp *= 0.5;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
}

/**
 * One RGBA data texture shared by every surface kind:
 *  R fine grain, G large blotches (weathering, dead winter grass),
 *  B ashlar joints (4 blocks x 8 courses per tile, alternate courses offset half a block),
 *  A paving joints (4 x 4 slabs per tile).
 */
export function surfaceTexture(size = 256) {
    const fine = tileNoise(size, 11, 16, 5), coarse = tileNoise(size, 23, 4, 3);
    const data = new Uint8Array(size * size * 4);
    const block = size / 4, course = size / 8, slab = size / 4;
    const joint = (d, w) => Math.max(0, 1 - d / w);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const row = Math.floor(y / course), shift = row % 2 ? block / 2 : 0;
        const bx = (x + shift) % block, by = y % course;
        const stone = Math.max(joint(Math.min(bx, block - bx), 1.6), joint(Math.min(by, course - by), 1.6));
        const px = x % slab, py = y % slab;
        const paving = Math.max(joint(Math.min(px, slab - px), 1.4), joint(Math.min(py, slab - py), 1.4));
        data[i * 4] = fine[i] * 255;
        data[i * 4 + 1] = coarse[i] * 255;
        data[i * 4 + 2] = stone * 255;
        data[i * 4 + 3] = paving * 255;
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    return texture;
}

// ---------------------------------------------------------------- triplanar surfaces

export const SURFACE = { generic: 0, stone: 1, paving: 2, grass: 3, marble: 4, wood: 5, asphalt: 6 };
// World metres covered by one tile of the shared texture, per kind.
const TILE = [3, 4.8, 6.4, 9, 5.6, 2.4, 7.2];

/**
 * How much snow is lying, 0..1, shared by every surface: the scene sets it from the weather
 * (freezing presets and a freezing live reading). Always a uniform, so changing it never
 * recompiles a shader.
 */
export const snowUniform = { value: 0 };

// One node graph per surface kind, shared by every material of that kind: a material colour is
// read per object, so the program is the same and only the graph's own uniforms (the one noise
// texture, the detail and snow amounts, the wear map) are shared. A graph per material would be
// a program per material.
const surfaceGraphs = new Map();

function surfaceGraph(kind, texture, detail, wear) {
    const key = `${kind}${wear ? 'w' : ''}`;
    let graph = surfaceGraphs.get(key);
    if (graph && graph.texture === texture) return graph;
    const tex = TSL.texture(texture), uDetail = mirror(detail), uSnow = mirror(snowUniform), tile = TSL.float(TILE[kind]);
    const uWear = wear ? TSL.texture(wear.map.isTexture ? wear.map : wear.map.value) : null;
    const uRect = wear ? mirror(wear.rect) : null;
    const height = TSL.float(0).toVar('surfHeight'), rough = TSL.float(0).toVar('surfRough');
    const { float, vec3, mix, smoothstep, clamp, pow, abs, dot, sin, If, select } = TSL;
    const tap = uv => tex.sample(uv);

    // Colour, and as a side effect the height and roughness the other two hooks read.
    const colorNode = TSL.Fn(() => {
        const base = TSL.materialColor.rgb.toVar('surfBase');
        height.assign(0); rough.assign(TSL.materialRoughness);
        const n = TSL.normalWorldGeometry, p = TSL.positionWorld;
        const upNormal = clamp(n.y, 0, 1).toVar('surfUp');
        // The worn map is read at a mip level: it is a low-frequency map, and a sample in a branch
        // that depends on the pixel could not take derivatives.
        const worn = float(0).toVar('surfWorn');
        const trodden = float(0).toVar('surfTrodden');
        const wearUv = wear ? p.xz.sub(uRect.xy).mul(uRect.zw).toVar('surfWearUv') : null;
        const wearIn = wear ? TSL.step(0, wearUv.x).mul(TSL.step(wearUv.x, 1)).mul(TSL.step(0, wearUv.y)).mul(TSL.step(wearUv.y, 1)).toVar() : null;
        const wearVal = wear ? uWear.sample(wearUv).level(0).r : null;
        If(uDetail.greaterThan(0), () => {
            const sb = pow(abs(n), vec3(4)).toVar();
            sb.divAssign(dot(sb, vec3(1)));
            const sp = p.div(tile).toVar();
            const s = tap(sp.zy).mul(sb.x).add(tap(sp.xz).mul(sb.y)).add(tap(sp.xy).mul(sb.z)).toVar('surfSample');
            const tone = float(1).toVar();
            if (wear) worn.assign(smoothstep(0.1, 0.72, wearVal.mul(s.r.mul(0.8).add(0.6))).mul(upNormal).mul(wearIn));
            if (kind === 1) {
                tone.assign(mix(0.92, 1.04, s.r.mul(0.6).add(s.g.mul(0.4))).mul(s.b.mul(0.09).oneMinus()));
                height.assign(s.r.mul(0.35).sub(s.b.mul(0.6)));
                rough.assign(s.r.mul(0.3).add(0.6));
                // Cold winter frost on horizontal stone ledges and capitals
                const frost = smoothstep(0.55, 0.95, upNormal).mul(s.r.mul(0.4).add(0.6));
                base.assign(mix(base, vec3(0.94, 0.96, 0.98), frost.mul(0.35).mul(uDetail)));
                rough.assign(mix(rough, 0.45, frost.mul(0.4)));
                // Water streaks gather below exposed ledges and toward the base of walls.
                const streak = pow(s.g, 3).mul(upNormal.oneMinus()).mul(smoothstep(0.15, 0.85, s.r));
                base.mulAssign(streak.mul(0.16).mul(uDetail).oneMinus());
            } else if (kind === 4) {
                const vein = smoothstep(0.72, 0.94, abs(sin(sp.x.add(sp.y).mul(8).add(s.g.mul(5)))));
                base.mulAssign(vein.mul(0.12).mul(uDetail).oneMinus());
                tone.assign(mix(0.96, 1.04, s.r));
                height.assign(s.r.mul(0.08));
                rough.assign(s.g.mul(0.2).add(0.38));
            } else if (kind === 5) {
                const grain = sin(sp.y.mul(90).add(s.g.mul(9))).mul(0.5).add(0.5);
                base.mulAssign(mix(0.78, 1.08, grain));
                height.assign(grain.mul(0.18));
                rough.assign(s.r.mul(0.25).add(0.48));
            } else if (kind === 6) {
                const aggregate = smoothstep(0.58, 0.82, s.r);
                base.mulAssign(mix(0.72, 1.18, aggregate));
                height.assign(aggregate.mul(0.35));
                rough.assign(s.g.mul(0.1).add(0.88));
            } else if (kind === 2) {
                tone.assign(mix(0.84, 1.06, s.r.mul(0.5).add(s.g.mul(0.5))).mul(s.a.mul(0.15).oneMinus()));
                height.assign(s.r.mul(0.3).sub(s.a.mul(0.6)));
                rough.assign(s.g.mul(0.2).add(0.72));
                // Wet winter puddles in paving depressions
                const puddle = smoothstep(0.46, 0.85, s.g.mul(0.65).add(s.r.oneMinus().mul(0.35))).mul(upNormal);
                base.mulAssign(puddle.mul(0.36).mul(uDetail).oneMinus());
                rough.assign(mix(rough, 0.04, puddle.mul(uDetail)));
                // Mud walked in off the lawn: a dark wet film where the crowd has been.
                base.mulAssign(mix(vec3(1), vec3(0.6, 0.54, 0.47), worn.mul(0.85)));
                rough.assign(mix(rough, 0.22, worn.mul(0.55)));
            } else if (kind === 3) {
                base.mulAssign(mix(vec3(1), mix(vec3(0.82, 0.9, 0.76), vec3(1.32, 1.16, 0.82), s.g), uDetail));
                tone.assign(mix(0.78, 1.12, s.r));
                height.assign(s.r);
                rough.assign(1);
                // January frost and frozen grass blade tips
                const grassFrost = smoothstep(0.48, 0.92, upNormal).mul(s.r.mul(0.5).add(0.5));
                base.assign(mix(base, vec3(0.88, 0.92, 0.9), grassFrost.mul(0.42).mul(uDetail)));
                rough.assign(mix(rough, 0.85, grassFrost.mul(0.5)));
                // A lawn under a few hundred boots in January: the frost goes first, then
                // the grass, and what is left is dark, wet and shines where it has pooled.
                const mud = vec3(0.11, 0.076, 0.046).mul(s.g.mul(0.6).add(0.7));
                base.assign(mix(base, mud, worn.mul(0.94)));
                rough.assign(mix(rough, s.r.mul(0.5).add(0.2), worn));
                height.assign(mix(height, s.g.mul(1.6).sub(s.r.mul(0.5)), worn));
            } else {
                tone.assign(mix(0.93, 1.04, s.r.mul(0.7).add(s.g.mul(0.3))));
                height.assign(s.r.mul(0.5));
                const genFrost = smoothstep(0.65, 0.98, upNormal).mul(0.3);
                base.assign(mix(base, vec3(0.95, 0.96, 0.98), genFrost.mul(uDetail)));
            }
            base.mulAssign(mix(1, tone, uDetail));
            height.mulAssign(uDetail);
            // Micro-detail: a second, finer triplanar tap gives stone a tooth, breaks up the joint
            // edges and stops large flat panels reading as smooth plastic.
            const micro = tap(sp.xz.mul(5.3).add(sp.yx.mul(2.9))).r;
            height.addAssign(micro.sub(0.5).mul(0.22).mul(uDetail));
            rough.assign(clamp(rough.add(micro.sub(0.5).mul(0.1).mul(uDetail)), 0.04, 1));
        });
        // Snow lies on whatever faces up outdoors: thick on the lawn, the ledges and the roofs,
        // thinner on paving people keep clearing, and trodden to grey slush along every route the
        // crowd has walked (the same wear map that turns the lawn to mud). Kept out of the
        // building's ground floor, which is under a roof.
        If(uSnow.greaterThan(0), () => {
            const outdoors = TSL.step(14.6, p.z).max(TSL.step(45, abs(p.x))).max(TSL.step(2.5, p.y));
            const snowUp = smoothstep(0.55, 0.92, clamp(n.y, 0, 1));
            if (wear) trodden.assign(smoothstep(0.03, 0.4, wearVal).mul(wearIn));
            const snowGrain = tap(p.xz.div(tile)).g;
            let amount = snowUp.mul(uSnow).mul(snowGrain.mul(0.2).add(0.8)).mul(trodden.mul(0.5).oneMinus());
            if (kind === 2) amount = amount.mul(0.7);
            amount = amount.mul(outdoors);
            const cover = mix(vec3(0.93, 0.95, 0.98), vec3(0.46, 0.45, 0.43), trodden);
            base.assign(mix(base, cover, clamp(amount, 0, 1)));
            rough.assign(mix(rough, mix(0.85, 0.22, trodden), amount));
        });
        return base;
    })();

    const roughnessNode = TSL.Fn(() => mix(TSL.materialRoughness, rough, uDetail))();

    // Screen-space bump from the height above (three.js's perturbNormalArb).
    const normalNode = TSL.Fn(() => {
        const nrm = TSL.normalViewGeometry.toVar();
        If(uDetail.greaterThan(0), () => {
            const dpx = TSL.dFdx(TSL.positionView), dpy = TSL.dFdy(TSL.positionView);
            const hx = TSL.dFdx(height).mul(0.022), hy = TSL.dFdy(height).mul(0.022);
            const r1 = TSL.cross(dpy, nrm), r2 = TSL.cross(nrm, dpx);
            const det = dot(dpx, r1);
            nrm.assign(TSL.normalize(abs(det).mul(nrm).sub(TSL.sign(det).mul(hx.mul(r1).add(hy.mul(r2))))));
        });
        return nrm;
    })();

    graph = { texture, colorNode, roughnessNode, normalNode };
    surfaceGraphs.set(key, graph);
    return graph;
}

/**
 * Adds world-space surface detail to a MeshStandardNodeMaterial: tone variation, joints, a
 * roughness spread and a bump from the same height. `detail` is a shared uniform (0..1) so the
 * quality governor can turn it down without recompiling a shader.
 *
 * `wear` (ground.js) is optional: a map of where the crowd has walked. Grass under it turns to
 * churned mud, paving picks up a wet film of tracked dirt.
 */
export function addSurface(material, kind, texture, detail, wear = null) {
    const graph = surfaceGraph(kind, texture, detail, wear);
    material.colorNode = graph.colorNode;
    material.roughnessNode = graph.roughnessNode;
    material.normalNode = graph.normalNode;
    return material;
}

// ---------------------------------------------------------------- sky and environment

/** A gradient-and-cloud sky dome. Its uniforms are driven by the scene's clock. */
export function createSky(radius = 200) {
    const { vec3, vec4, mix, smoothstep, pow, max, dot } = TSL;
    const uniforms = {
        uZenith: TSL.uniform(new THREE.Color()), uHorizon: TSL.uniform(new THREE.Color()),
        uGround: TSL.uniform(new THREE.Color('#56594f')), uSunColor: TSL.uniform(new THREE.Color('#fff4e0')),
        uSunDir: TSL.uniform(new THREE.Vector3(0, 1, 0)), uTime: TSL.uniform(0), uCloud: TSL.uniform(1),
    };
    const u = uniforms;
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    // Pinned to the far plane: the dome is drawn behind everything whatever its radius.
    material.vertexNode = TSL.Fn(() => {
        const p = TSL.cameraProjectionMatrix.mul(TSL.modelViewMatrix).mul(vec4(TSL.positionLocal, 1));
        return vec4(p.x, p.y, p.w, p.w);
    })();
    material.colorNode = TSL.Fn(() => {
        const d = TSL.normalize(TSL.positionLocal).toVar(), h = d.y;
        const col = mix(u.uHorizon, u.uZenith, smoothstep(0.0, 0.55, h)).toVar();
        const p = d.xz.div(max(h, 0).add(0.12)).mul(0.9).add(TSL.vec2(u.uTime.mul(0.006), u.uTime.mul(0.002)));
        const c = fbm2(p);
        const fade = smoothstep(0.0, 0.25, h);
        col.mulAssign(mix(1, mix(0.86, 1.1, c), u.uCloud.mul(fade).mul(TSL.step(0, h))));
        const s = max(dot(d, u.uSunDir), 0);
        col.addAssign(u.uSunColor.mul(pow(s, 6).mul(0.18).add(pow(s, 60).mul(0.35))).mul(u.uCloud.mul(0.5).oneMinus()));
        // smoothstep(0, -0.12, h) in GLSL runs backwards; written forwards here.
        return vec4(mix(col, u.uGround, smoothstep(-0.12, 0.0, h).oneMinus()), 1);
    })();
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;
    return { mesh, uniforms };
}

/** Sets sky colours from the overcast horizon colour: the zenith is a darker, cooler grey. */
export function setSkyColors(uniforms, horizon) {
    uniforms.uHorizon.value.copy(horizon);
    uniforms.uZenith.value.copy(horizon).multiplyScalar(0.72).lerp(new THREE.Color('#5d6b80'), 0.18);
}

/**
 * Image-based light from the same sky, so stone, glass and cloth pick up the overcast instead
 * of reading as flat plastic. Rebuilt only when the light changes a lot (a few times a day).
 */
export function createEnvironment(renderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const sky = createSky(10);
    envScene.add(sky.mesh);
    let target = null;
    return {
        uniforms: sky.uniforms,
        build() {
            target?.dispose();
            target = pmrem.fromScene(envScene, 0.04);
            return target.texture;
        },
        dispose() {
            target?.dispose(); pmrem.dispose();
            sky.mesh.geometry.dispose(); sky.mesh.material.dispose();
        },
    };
}

// ---------------------------------------------------------------- moving cloth and billboards

/**
 * Polycarbonate material for riot shields and tactical visors:
 * Physical transmission with volumetric refraction, chromatic dispersion at angled edges,
 * and edge absorption.
 */
export function createPolycarbonateMaterial({ color = '#c4e0ea', opacity = 0.42, roughness = 0.08, dispersion = 0.035, quality = null } = {}) {
    const tier = quality ?? (typeof window === 'undefined' ? 'high' : window.PoQuality?.tier?.() ?? 'high');
    // Physical transmission costs a colour-buffer copy plus refraction samples. On the lowest tier
    // the shield stays tinted and see-through, but as a plain alpha blend.
    if (tier === 'low') {
        return new THREE.MeshStandardNodeMaterial({
            color: new THREE.Color(color), transparent: true, opacity: Math.min(0.6, opacity + 0.14),
            roughness: 0.2, metalness: 0.05, depthWrite: false,
        });
    }
    const mat = new THREE.MeshPhysicalNodeMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity,
        roughness,
        metalness: 0.05,
        transmission: 0.88,
        ior: 1.585,
        thickness: 0.12,
        attenuationColor: new THREE.Color('#94c2d4'),
        attenuationDistance: 0.35,
        depthWrite: false,
    });
    // Chromatic dispersion grows toward grazing angles, where light crosses the most plastic:
    // the edge of a shield splits into a thin warm and cool fringe.
    const edge = TSL.pow(TSL.abs(TSL.dot(TSL.normalViewGeometry, TSL.positionViewDirection)).oneMinus(), 1.6);
    mat.colorNode = TSL.materialColor.add(TSL.vec4(TSL.float(dispersion).mul(edge).mul(TSL.vec3(0.4, 0.2, 0.8)), 0));
    mat.emissiveNode = TSL.vec3(0.035, 0.06, 0.075).mul(edge);
    return mat;
}

/**
 * Screen-space wrap lighting and red dermis subsurface scattering (SSSS) for skin and woven fabric.
 * Applied to a MeshStandardNodeMaterial: the wrap term is added to its light as emissive, which is
 * what it was in effect (it was added to the direct diffuse), keyed to the scene's sun direction.
 */
export function addSubsurfaceScattering(material, { wrap = 0.38, scatterColor = '#d95a42', scatterIntensity = 0.45 } = {}) {
    const sun = sssSun;
    const color = TSL.uniform(new THREE.Color(scatterColor));
    material.emissiveNode = TSL.Fn(() => {
        const sssDot = TSL.dot(TSL.normalViewGeometry, sun.dirView);
        const wrapVal = TSL.max(0, sssDot.add(wrap).div(1 + wrap));
        const term = TSL.smoothstep(-0.28, 0.28, TSL.abs(sssDot).negate());
        // Light that passed through the far side glows most when it is behind the viewer's line of
        // sight: cloth and ears rim-brighten against the low sun.
        const back = TSL.pow(TSL.clamp(TSL.dot(TSL.normalViewGeometry.negate(), TSL.positionViewDirection), 0, 1), 2);
        return color.mul(sun.color).mul(term).mul(scatterIntensity).mul(wrapVal).mul(back.mul(0.45).add(0.55)).mul(sun.on);
    })();
    return material;
}

/**
 * The sun, as the subsurface term reads it: its direction in view space, colour and intensity.
 * scene.js feeds it once a frame (`sssSun.set(light, camera)`); with no sun the term is off.
 */
export const sssSun = {
    dirView: TSL.uniform(new THREE.Vector3(0, 1, 0)), color: TSL.uniform(new THREE.Color(1, 1, 1)), on: TSL.uniform(0),
    set(light, camera) {
        this.dirView.value.copy(light.position).sub(light.target.position).normalize().transformDirection(camera.matrixWorldInverse);
        this.color.value.copy(light.color).multiplyScalar(light.intensity);
        this.on.value = light.intensity > 0 ? 1 : 0;
    },
};

/** What each part of a person is made of. The fabric shader draws the weave, quilting or print. */
export const CLOTH = { plain: 0, quilt: 1, fleece: 2, denim: 3, camo: 4, plaid: 5, canvas: 6, hiVis: 7, skin: 8, hide: 9, duty: 10, hair: 11 };

let fabricGraph = null;

function buildFabricGraph(detail) {
    const { float, vec3, mix, smoothstep, clamp, sin, abs, If, fract, floor } = TSL;
    const uDetail = mirror(detail);
    const kindAttr = TSL.attribute('aCloth', 'float');
    const rest = TSL.positionGeometry;
    const height = float(0).toVar('fabHeight'), rough = float(0).toVar('fabRough');
    const colorNode = TSL.Fn(() => {
        const base = TSL.materialColor.rgb.toVar('fabBase');
        height.assign(0); rough.assign(TSL.materialRoughness);
        If(uDetail.greaterThan(0), () => {
            const kind = TSL.int(kindAttr.add(0.5)).toVar('fabKind');
            const fp = rest;
            // Metres of cloth under one pixel: what decides which detail can still be drawn.
            const fabPx = TSL.length(TSL.fwidth(fp));
            const fineFade = smoothstep(0.003, 0.009, fabPx).oneMinus();
            const bandFade = smoothstep(0.03, 0.08, fabPx).oneMinus();
            // Noise is the expensive part, and most of a crowd is too far away to show it: it is
            // only worked out for the people close enough to need it.
            const fine = TSL.select(fineFade.greaterThan(0), noise3(fp.mul(160)).mul(fineFade).add(fineFade.oneMinus().mul(0.5)), 0.5).toVar();
            const near = bandFade.greaterThan(0);
            const nz = (scale, shift = 0) => TSL.select(near, noise3(fp.mul(scale).add(shift)), 0.5);
            const tone = float(1).toVar('fabTone');
            If(kind.equal(1), () => {
                // Quilted puffer: horizontal baffles, stitched in at the seams.
                const band = fract(fp.y.mul(9.5).add(0.2));
                const seam = smoothstep(0, 0.09, TSL.min(band, band.oneMinus())).oneMinus();
                tone.assign(seam.mul(0.3).mul(bandFade).oneMinus());
                height.assign(sin(band.mul(3.14159)).mul(0.013).mul(bandFade));
                rough.assign(fine.mul(0.16).add(0.46));
            }).ElseIf(kind.equal(2), () => {
                tone.assign(fine.mul(0.14).add(0.93));
                height.assign(fine.mul(0.0012));
                rough.assign(0.98);
            }).ElseIf(kind.equal(3), () => {
                // Denim: a diagonal twill, faded down the front of the thigh and at the knee.
                const twill = sin(fp.x.add(fp.y).add(fp.z).mul(520)).mul(fineFade);
                const fade = smoothstep(0.05, -0.1, fp.z).mul(smoothstep(0.25, 0.42, fp.y)).mul(smoothstep(0.62, 0.84, fp.y).oneMinus());
                tone.assign(nz(11).mul(0.1).add(0.9).add(twill.mul(0.05)).add(fade.mul(0.22)));
                height.assign(twill.mul(0.0006));
                rough.assign(0.9);
            }).ElseIf(kind.equal(4), () => {
                // Camouflage: three tones in soft blotches.
                const blot = nz(13, 3.1), spot = nz(21, 11.7);
                const darkPatch = smoothstep(0.52, 0.58, blot), palePatch = smoothstep(0.6, 0.66, spot).mul(darkPatch.oneMinus());
                tone.assign(mix(1, darkPatch.mul(-0.45).add(1).add(palePatch.mul(0.4)), bandFade));
                base.assign(mix(base, base.mul(vec3(1.18, 1.0, 0.72)), darkPatch.mul(0.5).mul(bandFade)));
                rough.assign(0.92);
            }).ElseIf(kind.equal(5), () => {
                // Flannel plaid: crossing bands, darker where two meet, a thin light line through.
                const px = fract(fp.x.mul(0.9).add(fp.z.mul(0.6)).mul(7)), py = fract(fp.y.mul(7));
                const bars = TSL.step(0.5, px).add(TSL.step(0.5, py));
                const line = smoothstep(0, 0.03, abs(px.sub(0.25))).oneMinus().add(smoothstep(0, 0.03, abs(py.sub(0.25))).oneMinus());
                tone.assign(mix(0.78, bars.mul(-0.26).add(1).add(line.mul(0.22)), bandFade));
                height.assign(fine.mul(0.0008));
                rough.assign(0.96);
            }).ElseIf(kind.equal(6), () => {
                tone.assign(fine.mul(0.14).add(0.92).add(nz(6).mul(0.06)));
                height.assign(fine.mul(0.001));
                rough.assign(0.94);
            }).ElseIf(kind.equal(7), () => {
                // Hi-vis: two reflective bands round the body and one round each arm.
                const tape = TSL.max(smoothstep(0, 0.006, abs(fp.y.sub(0.98)).sub(0.028)).oneMinus(), smoothstep(0, 0.006, abs(fp.y.sub(1.24)).sub(0.028)).oneMinus());
                base.assign(mix(base, vec3(0.82, 0.84, 0.8), tape));
                rough.assign(mix(0.7, 0.28, tape));
                tone.assign(fine.mul(0.08).add(0.96));
            }).ElseIf(kind.equal(8), () => {
                // Skin, and what a raw afternoon does to it: nose and cheeks go red.
                const cold = smoothstep(-0.13, -0.2, fp.z).mul(smoothstep(1.7, 1.75, fp.y)).mul(smoothstep(1.81, 1.85, fp.y).oneMinus());
                base.assign(mix(base, base.mul(vec3(1.14, 0.88, 0.86)), cold.mul(0.55)));
                tone.assign(nz(40).mul(0.06).add(0.97));
                rough.assign(0.62);
            }).ElseIf(kind.equal(9), () => {
                // Leather, rubber, and the eye: smooth, and a boot has a darker sole.
                tone.assign(TSL.select(fp.y.lessThan(0.035), 0.55, fine.mul(0.1).add(0.94)));
                rough.assign(0.42);
            }).ElseIf(kind.equal(10), () => {
                // Duty uniform: plain dark cloth under a wide leather belt.
                const belt = smoothstep(0, 0.006, abs(fp.y.sub(0.93)).sub(0.03)).oneMinus();
                tone.assign(mix(fine.mul(0.1).add(0.95), 0.35, belt));
                rough.assign(mix(0.86, 0.4, belt));
            }).ElseIf(kind.equal(11), () => {
                tone.assign(fine.mul(0.3).add(0.82));
                height.assign(fine.mul(0.0015));
                rough.assign(0.97);
            }).Else(() => {
                tone.assign(fine.mul(0.1).add(0.95));
                height.assign(fine.mul(0.0006));
            });
            // A zip or a button placket down the front of anything worn on the body.
            const onBody = kind.notEqual(8).and(kind.notEqual(9)).and(kind.notEqual(11)).and(fp.z.lessThan(0)).and(fp.y.greaterThan(0.6)).and(fp.y.lessThan(1.58));
            const placket = smoothstep(0.004, 0.01, abs(fp.x)).oneMinus().mul(bandFade).mul(TSL.select(onBody, 1, 0));
            tone.mulAssign(placket.mul(0.4).oneMinus());
            height.subAssign(placket.mul(0.002));
            base.mulAssign(mix(1, tone, uDetail));
            height.mulAssign(uDetail);
        });
        return base;
    })();
    const roughnessNode = TSL.Fn(() => mix(TSL.materialRoughness, rough, uDetail))();
    const normalNode = TSL.Fn(() => {
        const nrm = TSL.normalViewGeometry.toVar();
        If(uDetail.greaterThan(0), () => {
            const dpx = TSL.dFdx(TSL.positionView), dpy = TSL.dFdy(TSL.positionView);
            const hx = TSL.dFdx(height), hy = TSL.dFdy(height);
            const r1 = TSL.cross(dpy, nrm), r2 = TSL.cross(nrm, dpx);
            const det = TSL.dot(dpx, r1);
            nrm.assign(TSL.normalize(abs(det).mul(nrm).sub(TSL.sign(det).mul(hx.mul(r1).add(hy.mul(r2))))));
        });
        return nrm;
    })();
    return { colorNode, roughnessNode, normalNode };
}

/**
 * Cloth on the rigged figures. Each vertex carries a CLOTH kind (`aCloth`), and the pattern is
 * drawn in the figure's rest pose, so quilting and plaid stay sewn to the coat while it moves.
 * Fine detail fades out with distance instead of shimmering.
 */
export function addFabric(material, detail = { value: 1 }) {
    fabricGraph ??= buildFabricGraph(detail);
    material.colorNode = fabricGraph.colorNode;
    material.roughnessNode = fabricGraph.roughnessNode;
    material.normalNode = fabricGraph.normalNode;
    return material;
}

/**
 * Makes a flag plane ripple: a travelling wave pinned at the pole edge, with gusts. Each
 * instance takes its phase from where it stands, so a field of flags never moves in step.
 *
 * `wind` is a shared `{ value: THREE.Vector2 }` in m/s, the same one the precipitation and the
 * smoke read, so a gust that walks across the lawn also stiffens every banner on it. Its speed
 * sets how hard the cloth blows out; its direction sets which way the crest travels.
 *
 * The wave pushes the vertices along the plane's own normal, so it follows an instance's turn
 * (the GLSL pushed them in the plane's local z before the instance matrix was applied).
 */
export function addWave(material, time, { pin = -0.85, length = 1.7, amp = 0.15, wind = null } = {}) {
    const windUniform = wind?.uniform ?? { value: new THREE.Vector2(0, 0) };
    material.userData.wind = windUniform;
    const { float, sin, cos, min, clamp, mix } = TSL;
    const uTime = mirror(time), uWind = mirror(windUniform);
    const key = `${pin}:${length}:${amp}`;
    const phase = TSL.fract(TSL.float(TSL.instanceIndex).mul(0.6180339)).mul(6.2831853);
    const wSpeed = TSL.length(uWind);
    const wSide = TSL.select(wSpeed.greaterThan(0.001), TSL.dot(TSL.normalize(uWind), TSL.vec2(0.94, 0.34)), 1);
    const x = TSL.positionGeometry.x, y = TSL.positionGeometry.y;
    const wAlong = clamp(x.sub(pin).div(length), 0, 1);
    const wGust = sin(uTime.mul(0.8).add(phase.mul(1.7))).mul(0.35).add(0.65);
    const wTravel = min(wSpeed.mul(0.55), 9).add(6);
    const wArg = x.mul(3.4).sub(uTime.mul(wTravel)).add(phase);
    const wLoad = min(wSpeed.div(6.7), 2.2).mul(0.45).add(0.55);
    const wAmp = wAlong.mul(wGust).mul(wLoad).mul(amp);
    const wOff = sin(wArg).mul(wAmp).mul(TSL.abs(wSide).mul(0.45).add(0.55)).add(sin(wArg.mul(1.9).add(y.mul(2.5))).mul(wAmp).mul(0.3));
    const wSlope = cos(wArg).mul(3.4).mul(wAmp).add(cos(wArg.mul(1.9).add(y.mul(2.5))).mul(6.4).mul(wAmp).mul(0.3));
    // Cloth standing out downwind, and the lee edge sagging when the gust drops.
    const out = wAlong.mul(wAlong).mul(min(wSpeed.div(6.7), 1.4).mul(0.1).add(0.06)).mul(TSL.sign(wSide));
    const sag = wAlong.mul(wAlong).mul(0.12).mul(wGust.oneMinus());
    const push = wOff.add(out);
    material.positionNode = TSL.positionLocal.add(TSL.normalLocal.mul(push)).sub(TSL.vec3(0, sag, 0));
    material.normalNode = TSL.transformNormalToView(TSL.normalize(TSL.normalLocal.add(TSL.vec3(wSlope.negate(), 0, 0))));
    void key;
    return material;
}

/**
 * Turns an instanced plane into camera-facing sprites: the clip-space position of a quad vertex
 * whose instance stands at `center` (world) and is `scale` (vec2, metres) across. `upright`
 * sprites turn about the vertical only (people); the others face the camera fully (smoke).
 * Returns { clip, right, up } so a caller can shade with the same basis.
 */
export function billboard(center, scale, upright, local = TSL.positionGeometry) {
    const { vec3, vec4, normalize } = TSL;
    let right, up;
    if (upright) {
        const to = TSL.cameraPosition.sub(center);
        right = normalize(vec3(to.z, 0, to.x.negate()));
        up = vec3(0, 1, 0);
    } else {
        right = TSL.cameraWorldMatrix.element(0).xyz;
        up = TSL.cameraWorldMatrix.element(1).xyz;
    }
    const world = center.add(right.mul(local.x).mul(scale.x)).add(up.mul(local.y).mul(scale.y));
    return { clip: TSL.cameraProjectionMatrix.mul(TSL.cameraViewMatrix).mul(vec4(world, 1)), right, up };
}

/** A soft round blob, used for contact shadows (dark) and smoke puffs (light, noisy). */
export function softTexture(kind) {
    const size = 128, canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (kind === 'shadow') {
        const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        g.addColorStop(0, 'rgba(0,0,0,0.62)'); g.addColorStop(0.45, 'rgba(0,0,0,0.38)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    } else {
        // Several overlapping soft lobes read as a billow rather than a ball.
        let seed = 7;
        const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        for (let i = 0; i < 14; i++) {
            const x = 64 + (rand() - 0.5) * 50, y = 64 + (rand() - 0.5) * 50, r = 22 + rand() * 30;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, 'rgba(255,255,255,0.32)'); g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
        }
        // Clip to a circle so no lobe reaches the quad edge.
        ctx.globalCompositeOperation = 'destination-in';
        const edge = ctx.createRadialGradient(64, 64, 30, 64, 64, 63);
        edge.addColorStop(0, 'rgba(0,0,0,1)'); edge.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = edge; ctx.fillRect(0, 0, size, size);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}
