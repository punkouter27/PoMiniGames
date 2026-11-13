// pocabinet/paint.js
//
// Living paint: the car you watch tells its race. Layered onto the chassis materials of the
// cars drawn in full (cars.js mountCar), on top of the dent hook (cars.js damageable), as one
// more onBeforeCompile pass. Everything is procedural (the materials.js noise texture plus
// sine-free hashes in the shader): no image assets, nothing random per frame.
//
//   • Dirt     — a per-car amount of three kinds (LivingPaint.dirt): road grime (wheel-arch
//                spray, a lot more of it in the rain), grass (a green-brown smear low on the
//                sills after a trip across the lawn) and gravel dust (grey, or beige beach sand
//                at Mar-a-Lago). The shader decides where it sits: object-space fbm (offset per
//                car so no two wear the same dirt), a height-above-the-sill gradient, the wheel
//                arches (most behind each wheel, where it is flung) and the rear faces (the
//                wake). Dirt darkens and tints the albedo, roughens it and kills the clearcoat;
//                in the rain it goes dark and glossy and runs down the doors in streaks. It
//                builds as the car drives (race.js feeds the surface every frame) and stays for
//                the race: rain only rinses a little of the grass and dust off.
//   • Rain     — on a wet track paint and glass get a water film (glossy clearcoat), static
//                beads (two sizes of domed drops, a normal and a glassy clearcoat layer,
//                projected on the face's dominant axis) and rivulets that run back over the body
//                and up the windscreen with the car's speed (an integrated flow distance, so a
//                change of speed never jumps the pattern). A dry car shows none of it.
//   • Scars    — where the dent hook has bent the car, the paint is scuffed, then through to a
//                lighter primer ring, then bare metal in the middle with scrape lines along the
//                car and a brushed glint. It reads the dents the car already has (uDentP/uDentD):
//                there is no second damage model.
//   • Flake    — a sparse metallic sparkle in the satin base for the sun to catch: per-cell
//                random micro-mirrors with a narrow extra lobe in the direct light (so it is
//                shadowed like the rest), faded out where a cell gets smaller than a pixel.
//
// Quality (SceneHandle.quality): 'low' keeps dirt, scars and the wet film but skips the beads,
// rivulets and flakes; 'medium' skips the flakes. The far crowd (CarCrowd) gets none of it, so
// the cost is per pixel of the ten-odd cars drawn in full, not per car in the field (about half
// a millisecond of GPU at 720p with a close pack filling the screen).
// Render only: race.js hands in the surface a car is on; nothing here writes the sim.

import * as THREE from 'three';
import { clock, noise } from './materials.js';
import { SURF_GRASS, SURF_GRAVEL, SURF_RUNOFF } from './physics.js';
import { fnv1a, addHook } from './util.js';

// Shared by every car: the rain, the quality tier, this track's dust colour.
const G = {
    wet: { value: 0 },
    quality: { value: 2 },
    dust: { value: new THREE.Color('#8f887c') },
    noise: null,
};
let dustTheme;

/**
 * The conditions every car's paint reads (race.js, once a rendered frame): the scene's rain
 * and quality tier, and the track (Mar-a-Lago's traps are beach sand).
 */
export function paintScene(sceneHandle, track) {
    const q = sceneHandle?.quality;
    G.quality.value = q === 'low' ? 0 : q === 'medium' ? 1 : 2;
    G.wet.value = sceneHandle?.raining ? 1 : 0;
    const theme = track?.theme ?? null;
    if (theme !== dustTheme) {
        dustTheme = theme;
        G.dust.value.set(theme === 'maralago' ? '#cdb78a' : '#8f887c');
    }
}

// Rivulets run on a flow distance wrapped at 16 cells, so the quarter-step rates the shader
// gives each column all wrap whole.
const FLOW_WRAP = 8;

/** One car's paint state: what it has picked up, how fast the water on it is running. */
export class LivingPaint {
    /** `dents` is the car's dent array (cars.js uDentP): the scars read only the slots in use. */
    constructor(seed, dents) {
        this.dents = dents || [];
        this.dirt = new THREE.Vector4(0, 0, 0, 0);      // road grime, grass, gravel dust, —
        this.car = new THREE.Vector4(0, seed, 0, 0);    // speed (world units/s), seed, flow, dent slots in use
        this.uniforms = { uPcDirt: { value: this.dirt }, uPcCar: { value: this.car } };
    }

    /** A rendered frame: `surface` is physics.js's SURF_* under the car, `speed` world units/s. */
    tick(dt, surface, speed) {
        let used = 0;
        for (let i = 0; i < this.dents.length; i++) if (this.dents[i].w > 0) used = i + 1;
        this.car.w = used;
        if (!(dt > 0)) return;
        const v = Math.abs(Number(speed) || 0), run = Math.min(1, v / 8), d = this.dirt;
        const wet = G.wet.value > 0.5;
        this.car.x += (v - this.car.x) * Math.min(1, dt * 5);
        this.car.z = (this.car.z + dt * v * 0.09) % FLOW_WRAP;
        // The arches throw road grime up all race; in the rain the spray is the car's own and the
        // whole field's, and it builds a lot faster.
        d.x = Math.min(1, d.x + dt * run * (wet ? 0.0075 : 0.0014) * (1 - 0.5 * d.x));
        if (v > 0.6) {
            if (surface === SURF_GRASS) d.y = Math.min(1, d.y + dt * (0.16 + 0.42 * run));
            else if (surface === SURF_GRAVEL) d.z = Math.min(1, d.z + dt * (0.2 + 0.5 * run));
            else if (surface === SURF_RUNOFF) d.x = Math.min(1, d.x + dt * 0.03 * run);
        }
        // Rain rinses a little of the grass and dust off; most of it stays for the race.
        if (wet) { d.y *= Math.exp(-dt * 0.004); d.z *= Math.exp(-dt * 0.008); }
    }
}

/** A stable 0..64 seed from a car's id or name. */
export function paintSeed(key) {
    return (fnv1a(key) % 4096) / 64;
}

const GLSL_COMMON = /* glsl */`
uniform sampler2D uPcNoise;
uniform vec4 uPcDirt;
uniform vec4 uPcCar;
uniform float uPcWet;
uniform float uPcQuality;
uniform float uPcTime;
uniform vec3 uPcDust;
uniform mat3 normalMatrix;
varying vec3 vPcN;
#ifdef PC_PAINT
uniform vec4 uDentP[16];
uniform vec4 uDentD[16];
#endif
// The extra direct-light lobe (flake and bare-metal glint), read by RE_Direct_Physical.
vec3 pcGlintN = vec3(0.0, 0.0, 1.0);
float pcGlintAmt = 0.0;
float pcGlintSharp = 1.0;
vec4 pcHash4(vec2 p) {
    vec4 p4 = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
    p4 += dot(p4, p4.wzxy + 33.33);
    return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}
vec3 pcHash3(vec3 p3) {
    p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yxx) * p3.zyx);
}
// How much of a zone a dirt amount a covers: a film over potential p that thickens toward the
// zone's heart, grained by the fine noise f, and caked-on crust where the potential c is worst
// (as the large noise l has it) that spreads as a grows. Dust only films; mud cakes.
float pcCover(float p, float c, float a, float l, float f) {
    if (a <= 0.002) return 0.0;
    l = clamp((l - 0.5) * 2.4 + 0.5, 0.0, 1.0);
    f = clamp((f - 0.5) * 2.4 + 0.5, 0.0, 1.0);
    float film = a * p * p * (0.3 + 0.45 * f);
    float th = 1.22 - 0.6 * a;
    float caked = smoothstep(th, th + 0.05, c * (0.5 + 0.3 * l + 0.6 * f));
    return max(film, caked * (0.6 + 0.35 * a));
}
// Spatter flung off the tyres: dots on a cell grid, more of them the dirtier the zone (x road,
// y grass: independent hashes), averaged into a film where a cell gets smaller than a pixel.
vec2 pcSpatter(vec2 uv, vec2 dens, float seed) {
    const float C = 0.022;
    vec2 g = uv / C + seed;
    vec4 h = pcHash4(floor(g));
    float r = 0.14 + 0.24 * h.w;
    float d = length(fract(g) - 0.5 - (h.xy - 0.5) * (0.9 - 2.0 * r)) / r;
    vec2 fw = fwidth(g);
    float px = max(fw.x, fw.y);
    float dot1 = 1.0 - smoothstep(1.0 - min(px / r, 0.9), 1.0, d);
    float far = smoothstep(0.35, 0.8, px);
    vec2 on = step(h.zw * vec2(1.0, 0.93), dens);
    return mix(on * dot1, dens * 0.3, far);
}
// Domed drops on a cell grid, one at most per cell (held inside it, so no neighbours to
// look at). xy = the slope across the drop in uv, z = how much drop is there.
vec3 pcBeads(vec2 uv, float cell, float density, float seed) {
    vec2 g = uv / cell + seed;
    vec4 h = pcHash4(floor(g));
    if (h.x > density) return vec3(0.0);
    float r = 0.11 + 0.2 * h.w;
    vec2 rel = fract(g) - 0.5 - (h.yz - 0.5) * (0.76 - 2.0 * r);
    float d = length(rel) / r;
    if (d >= 1.0) return vec3(0.0);
    float z = sqrt(max(1.0 - d * d, 0.0));
    return vec3(rel / r * (0.7 / (z + 0.35)), smoothstep(1.0, 0.75, d));
}
// Rivulets: drops running along uv.x (each column of width W at its own quarter-step rate),
// a rounded head and a thinning tail behind it. Same return as pcBeads.
vec3 pcRivulets(vec2 uv, float flow, float stretch, float seed) {
    const float W = 0.032, L = 0.5;
    float cu = uv.y / W + seed;
    float col = floor(cu);
    vec4 hc = pcHash4(vec2(col, 17.0));
    float ph = (uv.x + flow * (0.75 + 0.25 * floor(hc.x * 4.0))) / L + hc.y * 13.0;
    vec4 hd = pcHash4(vec2(col, floor(ph)));
    if (hd.x > 0.32) return vec3(0.0);
    float len = (0.1 + 0.55 * stretch) * (0.6 + 0.4 * hd.y);
    float t = (fract(ph) - hd.z * (1.0 - len)) / len;
    if (t < 0.0 || t > 1.0) return vec3(0.0);
    float wdt = mix(0.36, 0.1, sqrt(t)) * (0.75 + 0.5 * hd.w);
    float q = (fract(cu) - 0.5 + (hd.y - 0.5) * 0.3 + sin(ph * 9.0 + col) * 0.04) / wdt;
    if (abs(q) >= 1.0) return vec3(0.0);
    float zc = sqrt(max(1.0 - q * q, 0.0));
    float head = 1.0 - smoothstep(0.0, 0.14, t);
    vec2 slope = vec2(-head * 0.8, q * (0.6 / (zc + 0.35)));
    return vec3(slope, (1.0 - 0.6 * t) * smoothstep(1.0, 0.7, abs(q)));
}`;

// Before the lights read the material: albedo, roughness, metal, normals, the coat.
const GLSL_MAIN = /* glsl */`
float pcCoat = 1.0;
float pcCoatRough = -1.0;
float pcWetCoat = 0.0;
{
    vec3 pcP = vPanel;
    vec3 pcN = normalize(vPcN);
    vec3 pcW = pcN * pcN; pcW *= pcW; pcW /= (pcW.x + pcW.y + pcW.z);
    float pcSeed = uPcCar.y;
    vec2 so = vec2(pcSeed * 0.37, pcSeed * 0.71);
    // Triplanar fbm, a fetch only for the faces that count (an explicit LOD, so the branches are safe).
    vec3 pcFw = fwidth(pcP) * 70.4;
    float pcLod = log2(max(max(pcFw.x, pcFw.y), max(pcFw.z, 1e-4)));
    vec4 nz = vec4(0.0);
    if (pcW.z > 0.02) nz += textureLod(uPcNoise, pcP.xy * 0.55 + so, pcLod) * pcW.z;
    if (pcW.x > 0.02) nz += textureLod(uPcNoise, pcP.zy * 0.55 + so.yx, pcLod) * pcW.x;
    if (pcW.y > 0.02) nz += textureLod(uPcNoise, pcP.xz * 0.55 - so, pcLod) * pcW.y;
    nz /= max(dot(pcW, step(0.02, pcW)), 1e-3);
    // Zones, in the car's own frame (+x ahead, +y up, +z right; wheels at x ±1.2, y 0.36).
    float side = smoothstep(0.35, 0.8, abs(pcN.z));
    float top = smoothstep(0.5, 0.9, pcN.y);
    float low = 1.0 - smoothstep(0.2, 0.9, pcP.y);
    float sill = 1.0 - smoothstep(0.22, 0.44, pcP.y);
    vec2 af = vec2(pcP.x - 1.2, pcP.y - 0.36), ar = vec2(pcP.x + 1.22, pcP.y - 0.36);
    af.x *= af.x < 0.0 ? 0.62 : 1.3;   // flung back: the trailing side of each arch takes most
    ar.x *= ar.x < 0.0 ? 0.62 : 1.3;
    float arch = (1.0 - smoothstep(0.34, 0.95, min(length(af), length(ar)))) * (0.35 + 0.65 * side);
    float rear = smoothstep(0.2, 0.8, -pcN.x) * (0.35 + 0.6 * (1.0 - smoothstep(0.25, 1.1, pcP.y)));
    // Grime runs down the doors in the rain: thin vertical streaks.
    float runs = 0.5, smear = 0.5;
    if (uPcWet > 0.0) runs = texture2D(uPcNoise, vec2((pcP.x + pcP.z) * 2.3, pcP.y * 0.22) + so).a;
    if (uPcDirt.y > 0.0) smear = texture2D(uPcNoise, vec2(pcP.x * 0.3, pcP.y * 5.0) - so).a;
    vec3 pcA = abs(pcN);
    vec2 pcUv = pcA.z > max(pcA.x, pcA.y) ? pcP.xy : pcA.x > pcA.y ? pcP.zy : pcP.xz;
    float pRoad = max(max(arch, rear), low * low * 0.75);
    pRoad = mix(pRoad, pRoad * (0.45 + 1.1 * runs), uPcWet * side);
    pRoad = max(pRoad, uPcWet * side * (1.0 - top) * smoothstep(0.45, 0.8, runs) * 0.75 * (1.0 - smoothstep(0.7, 1.15, pcP.y)));
    float pGrass = max(sill * (0.55 + 0.45 * side), arch * 0.7) * (1.0 - top);
    float pDust = max(max(low * 0.85, arch), rear) * 0.85 + 0.2 * (1.0 - 0.5 * top);
    float dR = pcCover(pRoad, max(arch, rear * low), uPcDirt.x, nz.r, nz.a);
    float dG = pcCover(pGrass, pGrass, uPcDirt.y, mix(nz.g, smear, 0.5), nz.a);
    float dD = pcCover(pDust, 0.0, uPcDirt.z, nz.b, nz.a);
    // Spatter round the edge of the arch and sill grime (none on the roof).
    vec2 spat = pcSpatter(pcUv, vec2(arch * 1.1 + (1.0 - smoothstep(0.2, 0.55, pcP.y)) * 0.3, max(sill, arch * 0.8)) * uPcDirt.xy * (1.0 - top), pcSeed);
    dR = max(dR, spat.x * 0.85);
    dG = max(dG, spat.y * 0.9);
    float damp = mix(1.0, 0.55, uPcWet);   // wet dirt is dark
    diffuseColor.rgb = mix(diffuseColor.rgb, uPcDust * (0.82 + 0.36 * nz.a) * damp, dD);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.135, 0.105) * (0.75 + 0.5 * nz.g) * damp, dR);
    // Grass: muddy olive smear with greener clippings in the spatter.
    vec3 cGrass = mix(vec3(0.09, 0.075, 0.035), vec3(0.06, 0.085, 0.022), smoothstep(0.35, 0.65, smear));
    cGrass = mix(cGrass, vec3(0.045, 0.1, 0.018), spat.y);
    diffuseColor.rgb = mix(diffuseColor.rgb, cGrass * damp, dG);
    float dirt = 1.0 - (1.0 - dR) * (1.0 - dG) * (1.0 - dD);
    roughnessFactor = mix(roughnessFactor, mix(0.95, 0.55, uPcWet), dirt);
    metalnessFactor = mix(metalnessFactor, 0.0, dirt);
    pcCoat *= 1.0 - dirt;

#ifdef PC_PAINT
    // Flake: a round micro-mirror in each cell, tilted at random; two sizes, each drawn only
    // where its cells are a few pixels across (smaller, they would only shimmer), so a close-up
    // sparkles finely and the chase camera still catches the coarser sparks.
    if (uPcQuality > 1.5) {
        vec3 fw = fwidth(pcP);
        float px = max(max(fw.x, fw.y), fw.z);
        float amt = 0.0;
        vec3 fn = pcN;
        for (int k = 0; k < 2; k++) {
            float scale = k == 0 ? 90.0 : 34.0;
            float fade = 1.0 - smoothstep(0.3, 0.5, px * scale);
            if (fade <= 0.0) continue;
            vec3 fc = pcP * scale;
            vec3 id = floor(fc) + pcSeed + float(k) * 7.0;
            float disk = 1.0 - smoothstep(0.5, 1.0, length(fract(fc) - 0.5 - (pcHash3(id + 17.3) - 0.5) * 0.4) / 0.3);
            if (disk * fade > amt) { amt = disk * fade; fn = pcN + (pcHash3(id) - 0.5) * 0.55; }
        }
        if (amt > 0.0) {
            pcGlintN = normalize(normalMatrix * normalize(fn));
            pcGlintAmt = 0.6 * amt * (1.0 - dirt) * (1.0 - 0.7 * uPcWet);
            pcGlintSharp = 700.0;
        }
    }
    // Scars round the dents: a scuffed ring, a lighter primer ring, bare metal at the core, and
    // straight scrape lines along the car reaching out of it. Bigger hits go further through.
    // (The derivatives are taken out here: inside the branch they would be undefined.)
    float scr = texture2D(uPcNoise, vec2(pcP.x * 0.35, (pcP.y + pcP.z) * 7.0) + so).a;
    float rowC = (pcA.y > 0.6 ? pcP.z : pcP.y) / 0.011;
    float rowFw = fwidth(rowC);
    float bareF = -1.0, primerF = -1.0, scuffF = -1.0, lineF = -1.0;
    for (int i = 0; i < 16; i++) {
        if (float(i) >= uPcCar.w) break;
        vec4 dp = uDentP[i];
        if (dp.w <= 0.0) continue;
        vec3 rel = (pcP - dp.xyz) / uDentD[i].w;
        float r = length(rel);
        float sev = clamp((dp.w - 0.05) * 2.5, 0.0, 1.0);
        bareF = max(bareF, sev * 0.3 - r);
        primerF = max(primerF, sev * 0.45 + 0.03 - r);
        scuffF = max(scuffF, 0.25 + 0.4 * sev - r);
        lineF = max(lineF, 0.2 + 0.7 * sev - abs(rel.x) * 0.55 - length(rel.yz) * 1.6);
    }
    if (scuffF > -0.3 || lineF > -0.5) {
        float e = (nz.a - 0.5) * 0.22 + (nz.g - 0.5) * 0.1;
        vec4 rh = pcHash4(vec2(floor(rowC), 41.0 + pcSeed));
        float line = step(rh.x, 0.3) * step(0.0, lineF + (rh.y - 0.5) * 0.5)
                   * (1.0 - smoothstep(0.12, 0.12 + max(rowFw, 0.02), abs(fract(rowC) - 0.5)))
                   * (1.0 - smoothstep(0.4, 0.8, rowFw));
        float scuff = smoothstep(0.0, 0.06, scuffF + e * 1.5);
        float primer = max(smoothstep(0.0, 0.02, primerF + e), line * step(rh.z, 0.5));
        float bare = max(smoothstep(0.0, 0.02, bareF + e + (scr - 0.5) * 0.08), line * step(0.5, rh.z));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.85 + 0.035, scuff * (1.0 - primer));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.36, 0.34) * (0.9 + 0.2 * nz.a), primer);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.4, 0.41, 0.43) * (0.8 + 0.4 * scr), bare);
        roughnessFactor = mix(roughnessFactor, 0.75, scuff * 0.7);
        roughnessFactor = mix(roughnessFactor, 0.85, primer);
        roughnessFactor = mix(roughnessFactor, 0.38, bare);
        metalnessFactor = mix(metalnessFactor, 1.0, bare);
        pcCoat *= 1.0 - max(scuff * 0.8, primer);
        // Brushed: cells long along the scrape, tilted across it, so the glint runs in lines.
        vec3 bc = floor(vec3(pcP.x * 20.0, pcP.y * 200.0, pcP.z * 200.0));
        vec3 bh = pcHash3(bc + 3.1) - 0.5;
        vec3 brushed = normalize(normalMatrix * normalize(pcN + vec3(bh.x * 0.06, bh.y * 0.6, bh.z * 0.6)));
        pcGlintN = normalize(mix(pcGlintN, brushed, bare));
        pcGlintAmt = mix(pcGlintAmt, 0.6, bare);
        pcGlintSharp = mix(pcGlintSharp, 120.0, bare);
    }
#endif

#if defined(PC_PAINT) || defined(PC_GLASS)
    if (uPcWet > 0.01) {
        // The water film: glossy, a little darker; dirt sheets the water rather than beading it.
        pcWetCoat = uPcWet * (1.0 - 0.5 * dirt);
        pcCoatRough = 0.16;
        diffuseColor.rgb *= 1.0 - 0.15 * uPcWet;
        if (uPcQuality > 0.5) {
            vec3 an = abs(pcN);
            vec2 uv; vec3 U, V;
            float flowDir = 1.0, gravity = 0.0, still = 1.0;
            float speed = uPcCar.x;
            if (an.y > an.x && an.y > an.z) {           // bonnet, roof, a raked screen: blown back
                uv = pcP.xz; U = vec3(1.0, 0.0, 0.0); V = vec3(0.0, 0.0, 1.0);
                still = 1.0 - 0.85 * smoothstep(3.0, 9.0, speed);
            } else if (an.z > an.x) {                  // the sides: blown back too
                uv = pcP.xy; U = vec3(1.0, 0.0, 0.0); V = vec3(0.0, 1.0, 0.0);
                still = 1.0 - 0.5 * smoothstep(3.0, 9.0, speed);
            } else {                                   // nose and tail: up the nose, dripping down the tail
                uv = vec2(pcP.y, pcP.z); U = vec3(0.0, 1.0, 0.0); V = vec3(0.0, 0.0, 1.0);
                flowDir = pcN.x > 0.0 ? -1.0 : 0.0;
                gravity = pcN.x > 0.0 ? 0.0 : 1.0;
                still = 1.0 - 0.7 * smoothstep(3.0, 9.0, speed) * step(0.0, pcN.x);
            }
            vec2 fw = fwidth(uv);
            float px = max(fw.x, fw.y);
            float k1 = (1.0 - smoothstep(0.012, 0.03, px)) * still;
            float k2 = (1.0 - smoothstep(0.006, 0.015, px)) * still;
            vec3 b1 = pcBeads(uv, 0.06, 0.6, pcSeed) * k1;
            vec3 b2 = pcBeads(uv + 0.37, 0.028, 0.7, pcSeed + 5.0) * k2;
            float moving = max(smoothstep(1.5, 5.0, speed) * abs(flowDir), gravity);
            vec3 rv = vec3(0.0);
            if (moving > 0.0) {
                float flow = flowDir * uPcCar.z + gravity * uPcTime * 0.06;
                rv = pcRivulets(uv, flow, max(smoothstep(2.0, 12.0, speed), gravity * 0.5), pcSeed) * moving
                   * (1.0 - smoothstep(0.012, 0.03, px));
            }
            vec3 drop = b1 + b2 + rv;
            float mask = clamp(max(max(b1.z, b2.z), rv.z), 0.0, 1.0) * (1.0 - 0.7 * dirt);
            vec3 dView = normalMatrix * ((drop.x * U + drop.y * V) * (1.0 - 0.7 * dirt));
            normal = normalize(normal + dView * 0.5);
#ifdef USE_CLEARCOAT
            clearcoatNormal = normalize(clearcoatNormal + dView);
#endif
            pcCoatRough = mix(pcCoatRough, 0.03, mask);
            pcWetCoat = max(pcWetCoat, mask);
            diffuseColor.rgb *= 1.0 - 0.25 * mask;
        }
    }
#endif
#ifdef PC_GLASS
    // Chromatic dispersion & thin-film spectral rim on windscreens/side glass (#5).
    {
        float cosTheta = clamp(abs(dot(normalize(vViewPosition), normalize(normal))), 0.0, 1.0);
        float rim = pow(1.0 - cosTheta, 3.2);
        vec3 disp = 0.5 + 0.5 * cos(6.28318 * (cosTheta * 1.45 + vec3(0.0, 0.33, 0.67)));
        totalEmissiveRadiance += disp * rim * (0.11 - 0.07 * uPcWet);
    }
#endif
#ifdef PC_PAINT
    // Subtle wrapped clearcoat/toy-enamel scatter along steep silhouette rims (#5).
    if (uPcQuality > 0.5) {
        float wrap = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normalize(normal))), 0.0, 1.0), 2.5);
        totalEmissiveRadiance += diffuseColor.rgb * wrap * (0.045 * (1.0 - dirt));
    }
#endif
}`;

const GLSL_COAT = /* glsl */`
#ifdef USE_CLEARCOAT
material.clearcoat = saturate(max(material.clearcoat * pcCoat, pcWetCoat));
if (pcCoatRough >= 0.0) material.clearcoatRoughness = min(max(pcCoatRough, 0.0525) + geometryRoughness, 1.0);
#endif`;

const GLINT_AT = 'reflectedLight.directSpecular += irradiance * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );';
const GLSL_GLINT = /* glsl */`
	if ( pcGlintAmt > 0.0 ) {
		vec3 pcH = normalize( directLight.direction + geometryViewDir );
		reflectedLight.directSpecular += irradiance * pow( saturate( dot( pcGlintN, pcH ) ), pcGlintSharp ) * pcGlintAmt;
	}`;

/**
 * Put the living paint on one of a car's chassis materials, after its dent hook. `kind` is
 * 'paint' (everything), 'glass' (dirt and rain) or 'trim' (dirt). `paint` is the car's
 * LivingPaint; every car shares the programs (one cache key per kind).
 */
export function livingPaint(material, kind, paint) {
    const define = kind === 'paint' ? 'PC_PAINT' : kind === 'glass' ? 'PC_GLASS' : 'PC_TRIM';
    return addHook(material, `paint-${kind}`, (shader) => {
        if (!G.noise) G.noise = { value: noise() };
        Object.assign(shader.uniforms, paint.uniforms, {
            uPcNoise: G.noise, uPcWet: G.wet, uPcQuality: G.quality, uPcTime: clock, uPcDust: G.dust,
        });
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vPcN;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPcN = normal;');
        let frag = `#define ${define}\n` + shader.fragmentShader
            .replace('#include <common>', '#include <common>\n' + GLSL_COMMON)
            .replace('#include <emissivemap_fragment>', GLSL_MAIN + '\n#include <emissivemap_fragment>')
            .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + GLSL_COAT);
        const lights = THREE.ShaderChunk.lights_physical_pars_fragment;
        if (kind === 'paint' && lights.includes(GLINT_AT)) {
            frag = frag.replace('#include <lights_physical_pars_fragment>', lights.replace(GLINT_AT, GLINT_AT + GLSL_GLINT));
        }
        shader.fragmentShader = frag;
    });
}
