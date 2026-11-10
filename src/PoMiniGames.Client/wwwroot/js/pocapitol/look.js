import * as THREE from 'three';

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

export const SURFACE = { generic: 0, stone: 1, paving: 2, grass: 3 };
// World metres covered by one tile of the shared texture, per kind.
const TILE = [3, 4.8, 6.4, 9];

/**
 * Adds world-space surface detail to a MeshStandardMaterial: tone variation, joints, a
 * roughness spread and a bump from the same height. `detail` is a shared uniform (0..1) so the
 * quality governor can turn it down without recompiling a shader.
 */
export function addSurface(material, kind, texture, detail) {
    material.onBeforeCompile = shader => {
        shader.uniforms.uSurf = { value: texture };
        shader.uniforms.uSurfTile = { value: TILE[kind] };
        shader.uniforms.uSurfDetail = detail;
        shader.defines = { ...shader.defines, SURF_KIND: kind };
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vSurfPos;\nvarying vec3 vSurfNormal;')
            .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
                vec4 surfP = vec4(transformed, 1.0);
                vec3 surfN = objectNormal;
                #ifdef USE_INSTANCING
                    surfP = instanceMatrix * surfP;
                    surfN = mat3(instanceMatrix) * surfN;
                #endif
                vSurfPos = (modelMatrix * surfP).xyz;
                vSurfNormal = normalize(mat3(modelMatrix) * surfN);`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
                varying vec3 vSurfPos;
                varying vec3 vSurfNormal;
                uniform sampler2D uSurf;
                uniform float uSurfTile;
                uniform float uSurfDetail;`)
            .replace('#include <map_fragment>', `#include <map_fragment>
                float surfHeight = 0.0, surfRough = roughness;
                if (uSurfDetail > 0.0) {
                    vec3 sb = pow(abs(vSurfNormal), vec3(4.0));
                    sb /= dot(sb, vec3(1.0));
                    vec3 sp = vSurfPos / uSurfTile;
                    vec4 s = texture2D(uSurf, sp.zy) * sb.x + texture2D(uSurf, sp.xz) * sb.y + texture2D(uSurf, sp.xy) * sb.z;
                    float tone = 1.0;
                    #if SURF_KIND == 1
                        tone = mix(0.9, 1.05, s.r * 0.6 + s.g * 0.4) * (1.0 - s.b * 0.2);
                        surfHeight = s.r * 0.35 - s.b;
                        surfRough = 0.6 + s.r * 0.3;
                    #elif SURF_KIND == 2
                        tone = mix(0.84, 1.06, s.r * 0.5 + s.g * 0.5) * (1.0 - s.a * 0.3);
                        surfHeight = s.r * 0.3 - s.a;
                        surfRough = 0.72 + s.g * 0.2;
                    #elif SURF_KIND == 3
                        diffuseColor.rgb *= mix(vec3(1.0), mix(vec3(0.82, 0.9, 0.76), vec3(1.32, 1.16, 0.82), s.g), uSurfDetail);
                        tone = mix(0.78, 1.12, s.r);
                        surfHeight = s.r;
                        surfRough = 1.0;
                    #else
                        tone = mix(0.93, 1.04, s.r * 0.7 + s.g * 0.3);
                        surfHeight = s.r * 0.5;
                    #endif
                    diffuseColor.rgb *= mix(1.0, tone, uSurfDetail);
                    surfHeight *= uSurfDetail;
                }`)
            .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, surfRough, uSurfDetail);')
            .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
                if (uSurfDetail > 0.0) {
                    // Screen-space bump from the height above (three.js's perturbNormalArb).
                    vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
                    float hx = dFdx(surfHeight) * 0.035, hy = dFdy(surfHeight) * 0.035;
                    vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
                    float det = dot(dpx, r1);
                    normal = normalize(abs(det) * normal - sign(det) * (hx * r1 + hy * r2));
                }`);
    };
    material.customProgramCacheKey = () => `pocapitol-surface-${kind}`;
    return material;
}

// ---------------------------------------------------------------- sky and environment

const SKY_VERTEX = `
    varying vec3 vDir;
    void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
    }`;
const SKY_FRAGMENT = `
    uniform vec3 uZenith, uHorizon, uGround, uSunColor, uSunDir;
    uniform float uTime, uCloud;
    varying vec3 vDir;
    float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y);
    }
    float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; } return v; }
    void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, h));
        // A low, unbroken January overcast: the deck is brighter where it is thin.
        if (h > 0.0) {
            vec2 p = d.xz / (h + 0.12) * 0.9 + vec2(uTime * 0.006, uTime * 0.002);
            float c = fbm(p);
            float fade = smoothstep(0.0, 0.25, h);
            col *= mix(1.0, mix(0.86, 1.1, c), uCloud * fade);
        }
        float s = max(dot(d, uSunDir), 0.0);
        col += uSunColor * (pow(s, 6.0) * 0.18 + pow(s, 60.0) * 0.35) * (1.0 - uCloud * 0.5);
        col = mix(col, uGround, smoothstep(0.0, -0.12, h));
        gl_FragColor = vec4(col, 1.0);
    }`;

/** A gradient-and-cloud sky dome. Its uniforms are driven by the scene's clock. */
export function createSky(radius = 200) {
    const uniforms = {
        uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
        uGround: { value: new THREE.Color('#56594f') }, uSunColor: { value: new THREE.Color('#fff4e0') },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uTime: { value: 0 }, uCloud: { value: 1 },
    };
    const material = new THREE.ShaderMaterial({
        uniforms, vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT,
        side: THREE.BackSide, depthWrite: false, fog: false,
    });
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
 * Makes a flag plane ripple: a travelling wave pinned at the pole edge, with gusts. Each
 * instance takes its phase from where it stands, so a field of flags never moves in step.
 */
export function addWave(material, time, { pin = -0.85, length = 1.7, amp = 0.15 } = {}) {
    material.onBeforeCompile = shader => {
        shader.uniforms.uTime = time;
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nuniform float uTime;')
            .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
                float wPhase = 0.0;
                #ifdef USE_INSTANCING
                    wPhase = dot(instanceMatrix[3].xz, vec2(0.37, 0.23));
                #endif
                float wAlong = clamp((position.x - (${pin.toFixed(3)})) / ${length.toFixed(3)}, 0.0, 1.0);
                float wGust = 0.65 + 0.35 * sin(uTime * 0.8 + wPhase * 1.7);
                float wArg = position.x * 3.4 - uTime * 6.0 + wPhase;
                float wAmp = ${amp.toFixed(3)} * wAlong * wGust;
                float wOff = sin(wArg) * wAmp + sin(wArg * 1.9 + position.y * 2.5) * wAmp * 0.3;
                float wSlope = cos(wArg) * 3.4 * wAmp + cos(wArg * 1.9 + position.y * 2.5) * 6.4 * wAmp * 0.3;
                objectNormal = normalize(vec3(-wSlope, 0.0, 1.0));`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
                transformed.z += wOff;
                transformed.y -= wAlong * wAlong * 0.12 * (1.0 - wGust);`);
    };
    material.customProgramCacheKey = () => 'pocapitol-wave';
    return material;
}

/**
 * Turns an instanced plane into camera-facing sprites. `upright` sprites turn about the
 * vertical only (people); the others face the camera fully (smoke). Instance scale is kept.
 */
export function billboardChunk(upright) {
    return `
        vec3 bbCenter = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec2 bbScale = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
        ${upright ? `
        vec3 bbTo = cameraPosition - bbCenter;
        vec3 bbRight = normalize(vec3(bbTo.z, 0.0, -bbTo.x));
        vec3 bbUp = vec3(0.0, 1.0, 0.0);` : `
        vec3 bbRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 bbUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);`}
        vec3 bbWorld = bbCenter + bbRight * transformed.x * bbScale.x + bbUp * transformed.y * bbScale.y;
        vec4 mvPosition = viewMatrix * vec4(bbWorld, 1.0);
        gl_Position = projectionMatrix * mvPosition;`;
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
