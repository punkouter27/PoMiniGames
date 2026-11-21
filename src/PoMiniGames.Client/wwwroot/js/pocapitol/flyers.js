import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';

// Loose paper: flyers, leaflets, torn placards and a few red and blue sheets, lying about the
// lawn and the floors until wind, a blast or a running crowd lifts them.
//
// All of it lives on the GPU. Three float textures hold one texel per sheet: position (xyz), the
// velocity (xyz, plus w = 1 while airborne), and the orientation (yaw, pitch, roll, and w = how
// fast it spins). A compute pass per texture advances every sheet each frame, and the draw call
// reads the same textures by instance id in the vertex shader, so 16k sheets cost three tiny
// full-screen passes and one instanced draw with no per-frame JavaScript beyond a few uniforms.
//
// The world is baked once into a small float texture over the play rectangle (ground height,
// wall mask, indoors mask), because the compute shader cannot call back into world.js. Resting
// sheets do nothing but stay put, so a still day is almost free.
//
// Flight is a flat plate in moving air: the part of the relative wind along the sheet's normal
// pushes hard (drag grows with the square of it), the part along its face barely at all. The
// orientation oscillates while aloft, which is what makes a falling sheet slide sideways and
// flutter instead of dropping like a stone.

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

const HELPERS = /* glsl */`
    float hash12(vec2 p) {
        vec3 q = fract(vec3(p.xyx) * 0.1031);
        q += dot(q, q.yzx + 33.33);
        return fract((q.x + q.y) * q.z);
    }
    // r = (yaw, pitch, roll): roll about the normal's own axis first, then pitch, then yaw.
    vec3 orient(vec3 v, vec3 r) {
        float sr = sin(r.z), cr = cos(r.z), sp = sin(r.y), cp = cos(r.y), sy = sin(r.x), cy = cos(r.x);
        v = vec3(cr * v.x - sr * v.y, sr * v.x + cr * v.y, v.z);
        v = vec3(v.x, cp * v.y - sp * v.z, sp * v.y + cp * v.z);
        return vec3(cy * v.x + sy * v.z, v.y, -sy * v.x + cy * v.z);
    }
`;

const COMMON = /* glsl */`
    uniform float uDt, uTime, uCell;
    uniform vec2 uWind;
    uniform vec4 uRect;
    uniform sampler2D uMask;
    uniform vec4 uBlasts[${MAX_BLASTS}];
    uniform vec4 uMovers[${MAX_MOVERS}];
    uniform int uBlastN, uMoverN;

    ${HELPERS}
    ivec2 cellOf(vec2 xz) { return ivec2(floor((xz - uRect.xy) / uCell)); }
    bool outside(vec2 xz) {
        ivec2 c = cellOf(xz), s = textureSize(uMask, 0);
        return c.x < 0 || c.y < 0 || c.x >= s.x || c.y >= s.y;
    }
    vec4 maskAt(vec2 xz) {
        ivec2 s = textureSize(uMask, 0);
        return texelFetch(uMask, clamp(cellOf(xz), ivec2(0), s - 1), 0);
    }
    // Bilinear by hand: float textures are not filterable everywhere, and a nearest ground would
    // stair-step a sheet lying on a slope.
    float ground(vec2 xz) {
        ivec2 s = textureSize(uMask, 0);
        vec2 g = (xz - uRect.xy) / uCell - 0.5;
        ivec2 i = ivec2(floor(g));
        vec2 f = fract(g);
        float a = texelFetch(uMask, clamp(i, ivec2(0), s - 1), 0).r;
        float b = texelFetch(uMask, clamp(i + ivec2(1, 0), ivec2(0), s - 1), 0).r;
        float c = texelFetch(uMask, clamp(i + ivec2(0, 1), ivec2(0), s - 1), 0).r;
        float d = texelFetch(uMask, clamp(i + ivec2(1, 1), ivec2(0), s - 1), 0).r;
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
`;

const VELOCITY = /* glsl */`
    void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 P = texture2D(texturePosition, uv);
        vec4 V = texture2D(textureVelocity, uv);
        vec4 R = texture2D(textureRot, uv);
        float h1 = hash12(uv), h2 = hash12(uv + 7.31);
        float roll = hash12(uv + fract(uTime) * 13.7);
        float dt = uDt;
        // w is 0 for a sheet lying down and 1 + boost while airborne: boost is how long a blast or
        // a foot has it flying ballistically, riding the air that threw it, before drag reclaims it.
        float air = V.w > 0.5 ? 1.0 : 0.0;
        float boost = max(V.w - 1.0, 0.0);
        vec3 v = V.xyz;
        // Every pass reads last frame's textures, so the position pass will move this sheet by
        // the velocity it read now. Judge walls and ground from where that leaves it, so the
        // velocity written here is the one that is safe to apply next.
        if (air > 0.5) P.xyz += v * dt;
        float g0 = ground(P.xz);

        // Indoors there is no wind at all; outdoors a gust is wind with a slow per-sheet ripple,
        // so the lightest sheets lift first and not all in one frame.
        vec2 wind = uWind * (1.0 - maskAt(P.xz).b);
        float ws = length(wind);

        vec3 kick = vec3(0.0);
        float kicked = 0.0;
        for (int i = 0; i < ${MAX_BLASTS}; i++) {
            if (i >= uBlastN) break;
            vec4 b = uBlasts[i];
            vec2 d = P.xz - b.xy;
            float r = length(d);
            if (r < b.w && P.y < g0 + b.w * 0.5) {
                float f = 1.0 - r / b.w;
                f *= f;
                vec2 o = d / max(r, 0.05);
                kick += vec3(o.x * 0.7, 1.0, o.y * 0.7) * (b.z * 18.0 * f * (0.5 + 0.5 * h2));
                kicked = max(kicked, 1.0);
            }
        }
        for (int i = 0; i < ${MAX_MOVERS}; i++) {
            if (i >= uMoverN) break;
            vec4 m = uMovers[i];
            vec2 d = P.xz - m.xy;
            float r = length(d);
            float sp = length(m.zw);
            if (r < 1.0 && sp > 0.5 && P.y < g0 + 0.6) {
                float f = 1.0 - r;
                // A foot scuffs a sheet now and then, not every frame it is near, or it would be
                // pinned in a shuddering hover over the runner.
                if (roll < 8.0 * dt * f) {
                    vec2 o = d / max(r, 0.05);
                    kick += vec3(m.zw * (0.35 + 0.3 * h2) + o * 0.8, 0.0) + vec3(0.0, (1.5 + 2.5 * h1) * min(sp / 4.0, 1.0) + 0.6, 0.0);
                    kicked = max(kicked, 0.5);
                }
            }
        }

        if (air < 0.5) {
            float gust = 0.5 + 0.5 * sin(uTime * 0.8 + h1 * 40.0);
            float eff = ws * (0.55 + 0.7 * gust);
            float thr = 2.2 + 5.0 * h1;
            bool lifted = eff > thr && roll < dt * 1.5 * (eff - thr) / thr;
            if (lifted || dot(kick, kick) > 0.01) {
                air = 1.0;
                boost = kicked;
                v = kick + (lifted ? vec3(wind.x * 0.4, 1.0 + 1.8 * h2, wind.y * 0.4) : vec3(0.0));
            } else {
                v = vec3(0.0);
            }
        } else {
            v += kick;
            boost = max(boost, kicked);
        }

        if (air > 0.5) {
            vec3 n = orient(vec3(0.0, 1.0, 0.0), R.xyz);
            vec3 air3 = vec3(wind.x, 0.0, wind.y);
            // Turbulence scales with the wind, so a still day has none and a gale tosses them.
            air3 += ws * 0.3 * vec3(sin(uTime * 1.7 + h1 * 30.0 + P.z * 0.3), 0.6 * sin(uTime * 2.3 + h2 * 30.0 + P.x * 0.2), cos(uTime * 1.3 + h2 * 20.0 + P.x * 0.25));
            vec3 vr = air3 - v;
            float vn = dot(vr, n);
            float mass = 0.7 + 0.6 * h2;
            // Flat to the air a sheet falls at about 1.2 m/s. The clamp keeps a blast-speed
            // sheet from overshooting the air's own velocity within one step.
            float kN = min(6.8 / mass * abs(vn) * mix(1.0, 0.06, boost), 0.9 / dt);
            vec3 acc = vec3(0.0, -9.8, 0.0) + vn * kN * n + 0.45 * (vr - vn * n);
            v += acc * dt;
            boost = max(boost - dt * 0.9, 0.0);

            vec3 np = P.xyz + v * dt;
            if (outside(np.xz) || maskAt(np.xz).g > 0.5 || ground(np.xz) - P.y > 0.45) {
                vec2 tx = vec2(np.x, P.z), tz = vec2(P.x, np.z);
                if (outside(tx) || maskAt(tx).g > 0.5 || ground(tx) - P.y > 0.45) v.x *= -0.3;
                if (outside(tz) || maskAt(tz).g > 0.5 || ground(tz) - P.y > 0.45) v.z *= -0.3;
                np = P.xyz + v * dt;
                // Wedged in a corner: stop dead rather than tunnel on the next step.
                if (outside(np.xz) || maskAt(np.xz).g > 0.5) { v.xz = vec2(0.0); np = P.xyz + vec3(0.0, v.y * dt, 0.0); }
            }
            if (np.y > 30.0) v.y = min(v.y, 0.0);
            if (np.y <= ground(np.xz) + 0.012) { air = 0.0; v = vec3(0.0); }
        }
        gl_FragColor = vec4(v, air > 0.5 ? 1.0 + boost : 0.0);
    }
`;

const POSITION = /* glsl */`
    void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 P = texture2D(texturePosition, uv);
        vec4 V = texture2D(textureVelocity, uv);
        float h = hash12(uv + 3.3);
        if (V.w < 0.5) {
            // Lying down: sit on the ground, a hair apart per sheet so two overlapping ones never
            // z-fight.
            P.y = ground(P.xz) + 0.012 + h * 0.004;
        } else {
            P.xyz += V.xyz * uDt;
        }
        gl_FragColor = P;
    }
`;

const ROT = /* glsl */`
    void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 V = texture2D(textureVelocity, uv);
        vec4 R = texture2D(textureRot, uv);
        float h1 = hash12(uv), h2 = hash12(uv + 7.31);
        if (V.w > 0.5) {
            float spd = length(V.xyz);
            float amp = 0.45 + min(1.0, spd * 0.12);
            vec2 target = vec2(
                amp * sin(uTime * (3.0 + h1 * 3.0) + h2 * 6.28),
                amp * 1.2 * sin(uTime * (2.5 + h2 * 3.0) + h1 * 6.28 + 1.3));
            R.yz = mix(R.yz, target, 1.0 - exp(-uDt * 5.0));
            R.x += R.w * uDt * (1.0 + spd * 0.1);
        } else {
            R.yz = mix(R.yz, vec2(0.0), 1.0 - exp(-uDt * 8.0));
        }
        gl_FragColor = R;
    }
`;

// Draw side. The sheet lies in the XZ plane (normal +Y), is curled across its width, rotated by
// its orientation and moved to its simulated position. The normal is rotated with it so the
// scene's lights see the curl.
const VERTEX_NORMAL = /* glsl */`
    ivec2 fSize = textureSize(tPos, 0);
    ivec2 fId = ivec2(gl_InstanceID % fSize.x, gl_InstanceID / fSize.x);
    vec4 fP = texelFetch(tPos, fId, 0);
    vec4 fR = texelFetch(tRot, fId, 0);
    vec2 fUv = (vec2(fId) + 0.5) / vec2(fSize);
    float fH1 = hash12(fUv), fH2 = hash12(fUv + 7.31), fH3 = hash12(fUv + 3.7);
    float fCurl = (fH2 - 0.5) * 2.0;
    // Mostly plain white sheets; a few coloured leaflets; the odd torn placard, bigger and brown.
    float fScale = 0.8 + fH1 * 0.55;
    vec3 fTint = vec3(0.86 + 0.14 * fH1);
    float fInk = 1.0;
    if (fH3 < 0.07) fTint = vec3(0.85, 0.22, 0.2);
    else if (fH3 < 0.14) fTint = vec3(0.28, 0.42, 0.85);
    else if (fH3 < 0.22) fTint = vec3(0.95, 0.86, 0.5);
    else if (fH3 > 0.97) { fTint = vec3(0.75, 0.6, 0.4); fScale *= 1.8; fInk = 0.0; }
    vFlyTint = fTint;
    vFlyInk = fInk;
    vFlyLocal = position.xz;
    float fX = position.x / 0.15;
    vec3 objectNormal = orient(normalize(vec3(-0.9 * fCurl * fX, 1.0, 0.0)), fR.xyz);
`;
const VERTEX_POSITION = /* glsl */`
    vec3 transformed = fP.xyz + orient(vec3(position.x, 0.05 * fCurl * fX * fX, position.z) * fScale, fR.xyz);
`;

export function createFlyers(scene, renderer, { rect = { x0: -40, z0: -56, w: 80, d: 152 }, groundHeight, blocked, indoors, size = 128 } = {}) {
    try {
        if (!renderer || !renderer.isWebGLRenderer || renderer.capabilities.isWebGL2 === false) return { ...noop };
        if (!renderer.extensions.has('EXT_color_buffer_float')) return { ...noop };
        return build(scene, renderer, { rect, groundHeight, blocked, indoors, size });
    } catch {
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
    const count = size * size;
    const mask = bakeMask(rect, groundHeight, blocked, indoors);
    const cellOpen = (x, z) => {
        const i = Math.floor((x - rect.x0) / CELL), j = Math.floor((z - rect.z0) / CELL);
        if (i < 0 || j < 0 || i >= mask.w || j >= mask.h) return false;
        const o = (j * mask.w + i) * 4;
        return mask.data[o + 1] < 0.5;
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

    const gpu = new GPUComputationRenderer(size, size, renderer);
    const posTex = gpu.createTexture(), velTex = gpu.createTexture(), rotTex = gpu.createTexture();

    // Seeded scatter. Roughly a third of the sheets go indoors, since the floors are the point of
    // half the rooms; a position with a wall on it is tried again a few times and then dropped
    // wherever the last try fell, which the first compute pass settles.
    function scatter() {
        const rand = seeded(0x9A9E25);
        const p = posTex.image.data, v = velTex.image.data, r = rotTex.image.data;
        for (let k = 0; k < count; k++) {
            const wantIndoors = rand() < 0.33;
            let x = 0, z = 0;
            for (let t = 0; t < 24; t++) {
                x = rect.x0 + rand() * rect.w;
                z = rect.z0 + rand() * rect.d;
                if (cellOpen(x, z) && cellIndoors(x, z) === wantIndoors) break;
            }
            const o = k * 4;
            p[o] = x; p[o + 1] = cellGround(x, z) + 0.012; p[o + 2] = z; p[o + 3] = 0;
            v[o] = v[o + 1] = v[o + 2] = v[o + 3] = 0;
            r[o] = rand() * Math.PI * 2; r[o + 1] = 0; r[o + 2] = 0;
            r[o + 3] = (rand() < 0.5 ? -1 : 1) * (0.8 + rand() * 3.0);
        }
    }
    scatter();

    const rotVar = gpu.addVariable('textureRot', COMMON + ROT, rotTex);
    const velVar = gpu.addVariable('textureVelocity', COMMON + VELOCITY, velTex);
    const posVar = gpu.addVariable('texturePosition', COMMON + POSITION, posTex);
    const all = [rotVar, velVar, posVar];
    for (const variable of all) gpu.setVariableDependencies(variable, all);

    const blasts = Array.from({ length: MAX_BLASTS }, () => new THREE.Vector4());
    const movers = Array.from({ length: MAX_MOVERS }, () => new THREE.Vector4());
    const wind = new THREE.Vector2();
    const rectVec = new THREE.Vector4(rect.x0, rect.z0, mask.w * CELL, mask.h * CELL);
    const shared = {
        uDt: { value: 0.016 },
        uTime: { value: 0 },
        uCell: { value: CELL },
        uWind: { value: wind },
        uRect: { value: rectVec },
        uMask: { value: mask.texture },
        uBlasts: { value: blasts },
        uMovers: { value: movers },
        uBlastN: { value: 0 },
        uMoverN: { value: 0 },
    };
    for (const variable of all) Object.assign(variable.material.uniforms, shared);

    const error = gpu.init();
    if (error !== null) {
        try { gpu.dispose?.(); } catch { /* nothing to free */ }
        mask.texture.dispose();
        return { ...noop };
    }

    const uniforms = { tPos: { value: null }, tRot: { value: null } };
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    material.customProgramCacheKey = () => 'poflyers';
    material.onBeforeCompile = shader => {
        shader.uniforms.tPos = uniforms.tPos;
        shader.uniforms.tRot = uniforms.tRot;
        shader.vertexShader = shader.vertexShader
            .replace('void main() {', `uniform sampler2D tPos, tRot;\nvarying vec3 vFlyTint;\nvarying float vFlyInk;\nvarying vec2 vFlyLocal;\n${HELPERS}\nvoid main() {`)
            .replace('#include <beginnormal_vertex>', VERTEX_NORMAL)
            .replace('#include <begin_vertex>', VERTEX_POSITION);
        shader.fragmentShader = shader.fragmentShader
            .replace('void main() {', 'varying vec3 vFlyTint;\nvarying float vFlyInk;\nvarying vec2 vFlyLocal;\nvoid main() {')
            .replace('#include <color_fragment>', /* glsl */`
                #include <color_fragment>
                // Faint printed lines on the plain sheets.
                float flyLine = step(0.55, fract(vFlyLocal.y * 38.0)) * step(abs(vFlyLocal.x), 0.115) * step(0.03, abs(vFlyLocal.y));
                diffuseColor.rgb *= vFlyTint * (1.0 - 0.16 * flyLine * vFlyInk);
            `);
    };

    // Not an InstancedMesh: there are no per-instance matrices to fill and keep, only the
    // instance id, which the vertex shader turns into a texel. An instanced geometry with no
    // instanced attributes and an explicit instance count is exactly that.
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
    mesh.userData.target = () => gpu.getCurrentRenderTarget(posVar);
    scene.add(mesh);

    let level = 2;
    let clock = 0;
    const bindOutputs = () => {
        uniforms.tPos.value = gpu.getCurrentRenderTarget(posVar).texture;
        uniforms.tRot.value = gpu.getCurrentRenderTarget(rotVar).texture;
    };
    bindOutputs();

    function update(dt, time, { wind: w, blasts: bs, movers: ms } = {}) {
        if (level === 0) return;
        shared.uDt.value = Math.min(Math.max(dt, 0), MAX_DT);
        clock = time ?? clock + dt;
        shared.uTime.value = clock;
        wind.set(w?.x ?? 0, w?.z ?? 0);
        const nb = Math.min(bs?.length ?? 0, MAX_BLASTS);
        for (let i = 0; i < nb; i++) blasts[i].set(bs[i].x, bs[i].z, bs[i].strength, bs[i].radius);
        shared.uBlastN.value = nb;
        const nm = Math.min(ms?.length ?? 0, MAX_MOVERS);
        for (let i = 0; i < nm; i++) movers[i].set(ms[i].x, ms[i].z, ms[i].vx, ms[i].vz);
        shared.uMoverN.value = nm;
        gpu.compute();
        bindOutputs();
    }

    function setLevel(next) {
        level = next >= 2 ? 2 : next >= 1 ? 1 : 0;
        mesh.visible = level > 0;
        geometry.instanceCount = level === 2 ? count : level === 1 ? count >> 2 : 0;
    }

    function reset() {
        scatter();
        for (const [variable, tex] of [[posVar, posTex], [velVar, velTex], [rotVar, rotTex]]) {
            tex.needsUpdate = true;
            gpu.renderTexture(tex, variable.renderTargets[0]);
            gpu.renderTexture(tex, variable.renderTargets[1]);
        }
        bindOutputs();
    }

    function dispose() {
        scene.remove(mesh);
        geometry.dispose();
        material.dispose();
        mask.texture.dispose();
        posTex.dispose(); velTex.dispose(); rotTex.dispose();
        try { gpu.dispose?.(); } catch { /* already gone */ }
    }

    return { mesh, update, setLevel, reset, dispose };
}
