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

import * as THREE from './three.js';
import { noise } from './materials.js';
import {
    uniform, varying, texture, reference, positionGeometry, normalGeometry, positionView, normalView, materialColor, vec2, vec3, vec4, float,
    length, dot, floor, fract, step, smoothstep, clamp, mix, max, min, sqrt, abs, pow, cos, log2, normalize, fwidth, select, mod,
} from 'three-eco/tsl';
import { SURF_GRASS, SURF_GRAVEL, SURF_RUNOFF } from './physics.js';
import { fnv1a, addHook } from './util.js';

// Shared by every car: the rain, the quality tier, this track's dust colour.
const G = {
    wet: uniform(0),
    quality: uniform(2),
    dust: uniform(new THREE.Color('#8f887c')),
};
const MAX_DENTS_USED = 16;

/**
 * The conditions every car's paint reads (race.js, once a rendered frame): the scene's rain
 * and quality tier.
 */
export function paintScene(sceneHandle) {
    const q = sceneHandle?.quality;
    G.quality.value = q === 'low' ? 0 : q === 'medium' ? 1 : 2;
    G.wet.value = sceneHandle?.raining ? 1 : 0;
}

// Rivulets run on a flow distance wrapped at 16 cells, so the quarter-step rates the shader
// gives each column all wrap whole.
const FLOW_WRAP = 8;

/** One car's paint state: what it has picked up, how fast the water on it is running. */
export class LivingPaint {
    /** `dents` is the car's dent array (cars.js uDentP): the scars read only the slots in use. */
    constructor(seed, dents, livery = 0, accentHex = '#f4f6fa') {
        this.dents = dents || [];
        this.dirt = new THREE.Vector4(0, 0, 0, 0);      // road grime, grass, gravel dust, —
        this.car = new THREE.Vector4(0, seed, 0, 0);    // speed (world units/s), seed, flow, dent slots in use
        const ac = new THREE.Color(accentHex || '#f4f6fa');
        this.livery = new THREE.Vector4(Number(livery) || 0, ac.r, ac.g, ac.b);
        this.uniforms = { uPcDirt: { value: this.dirt }, uPcCar: { value: this.car }, uPcLivery: { value: this.livery } };
    }

    setLivery(mode, accentHex = null) {
        this.livery.x = Number(mode) || 0;
        if (accentHex) {
            const ac = new THREE.Color(accentHex);
            this.livery.y = ac.r; this.livery.z = ac.g; this.livery.w = ac.b;
        }
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

// ── The paint as TSL nodes (r186) ────────────────────────────────────────────
// Ported from the GLSL (onBeforeCompile) of the r165 build. One graph per kind, shared by every car;
// a car's own values (dirt, speed/seed/flow, livery) are read off its material's userData.pcPaint.
// NOT PORTED: the metallic flake and the bare-metal brushed glint (they lived inside the light loop's
// BRDF, a seam a node material does not have), and the wet-film clearcoat NORMAL perturbation (the
// drops still darken, roughen and bead the clearcoat, they just no longer bend the highlight).

const hash4 = (p) => {
    let p4 = fract(vec4(p.x, p.y, p.x, p.y).mul(vec4(0.1031, 0.1030, 0.0973, 0.1099)));
    p4 = p4.add(dot(p4, p4.wzxy.add(33.33)));
    return fract(vec4(p4.x.add(p4.y), p4.y.add(p4.z), p4.z.add(p4.z), p4.w.add(p4.x)).mul(vec4(p4.z, p4.y, p4.w, p4.x)));
};
// How much of a zone a dirt amount `a` covers: a film over potential p that thickens toward the
// zone's heart, grained by the fine noise f, and caked-on crust where the potential c is worst
// (as the large noise l has it) that spreads as a grows. Dust only films; mud cakes.
const cover = (p, c, a, l0, f0) => {
    const l = clamp(l0.sub(0.5).mul(2.4).add(0.5), 0, 1), f = clamp(f0.sub(0.5).mul(2.4).add(0.5), 0, 1);
    const film = a.mul(p).mul(p).mul(f.mul(0.45).add(0.3));
    const th = float(1.22).sub(a.mul(0.6));
    const caked = smoothstep(th, th.add(0.05), c.mul(l.mul(0.3).add(0.5).add(f.mul(0.6))));
    return select(a.lessThanEqual(0.002), float(0), max(film, caked.mul(a.mul(0.35).add(0.6))));
};
// Spatter flung off the tyres: dots on a cell grid, more of them the dirtier the zone (x road,
// y grass: independent hashes), averaged into a film where a cell gets smaller than a pixel.
const spatter = (uv, dens, seed) => {
    const C = 0.022;
    const g = uv.div(C).add(seed);
    const h = hash4(floor(g));
    const r = h.w.mul(0.24).add(0.14);
    const d = length(fract(g).sub(0.5).sub(h.xy.sub(0.5).mul(float(0.9).sub(r.mul(2))))).div(r);
    const fw = fwidth(g), px = max(fw.x, fw.y);
    const dot1 = smoothstep(float(1).sub(min(px.div(r), 0.9)), 1, d).oneMinus();
    const far = smoothstep(0.35, 0.8, px);
    const on = vec2(step(h.z, dens.x), step(h.w.mul(0.93), dens.y));
    return mix(on.mul(dot1), dens.mul(0.3), far);
};
// Domed drops on a cell grid, one at most per cell. xy = the slope across the drop in uv, z = how much drop is there.
const beads = (uv, cell, density, seed) => {
    const g = uv.div(cell).add(seed);
    const h = hash4(floor(g));
    const r = h.w.mul(0.2).add(0.11);
    const rel = fract(g).sub(0.5).sub(h.yz.sub(0.5).mul(float(0.76).sub(r.mul(2))));
    const d = length(rel).div(r);
    const z = sqrt(max(float(1).sub(d.mul(d)), 0));
    const ok = h.x.lessThanEqual(density).and(d.lessThan(1));
    const slope = rel.div(r).mul(float(0.7).div(z.add(0.35)));
    return select(ok, vec3(slope, smoothstep(0.75, 1, d).oneMinus()), vec3(0));
};

/**
 * Put the living paint on one of a car's chassis materials, after its dent hook. `kind` is
 * 'paint' (everything), 'glass' (dirt and rain) or 'trim' (dirt). `paint` is the car's
 * LivingPaint; every car shares the programs (one cache key per kind).
 */
export function livingPaint(material, kind, paint) {
    material.userData.pcPaint = { dirt: paint.dirt, car: paint.car, livery: paint.livery };
    const isPaint = kind === 'paint', isGlass = kind === 'glass';
    return addHook(material, `paint-${kind}`, () => {
        const uDirt = reference('userData.pcPaint.dirt', 'vec4');
        const uCar = reference('userData.pcPaint.car', 'vec4');
        const uLivery = reference('userData.pcPaint.livery', 'vec4');
        const uDentP = reference('userData.pcDmg.dentP.value', 'vec4');
        const uDentD = reference('userData.pcDmg.dentD.value', 'vec4');
        const pcP = varying(positionGeometry, 'vPcP');
        const pcN = normalize(varying(normalGeometry, 'vPcN'));
        const wet = G.wet, quality = G.quality;
        const noiseTex = noise();
        const nzAt = (uv, lod) => texture(noiseTex, uv, lod);
        const pcSeed = uCar.y;
        const so = vec2(pcSeed.mul(0.37), pcSeed.mul(0.71));
        // Triplanar fbm weighted by the face's normal (an explicit LOD from the position's derivatives).
        let pcW = pcN.mul(pcN); pcW = pcW.mul(pcW); pcW = pcW.div(pcW.x.add(pcW.y).add(pcW.z));
        const pcFw = fwidth(pcP).mul(70.4);
        const pcLod = log2(max(max(pcFw.x, pcFw.y), max(pcFw.z, 1e-4)));
        const nz = nzAt(pcP.xy.mul(0.55).add(so), pcLod).mul(pcW.z).add(nzAt(pcP.zy.mul(0.55).add(so.yx), pcLod).mul(pcW.x))
            .add(nzAt(pcP.xz.mul(0.55).sub(so), pcLod).mul(pcW.y)).div(max(pcW.x.add(pcW.y).add(pcW.z), 1e-3));
        // Zones, in the car's own frame (+x ahead, +y up, +z right; wheels at x ±1.2, y 0.36).
        const side = smoothstep(0.35, 0.8, abs(pcN.z));
        const top = smoothstep(0.5, 0.9, pcN.y);
        const low = smoothstep(0.2, 0.9, pcP.y).oneMinus();
        const sill = smoothstep(0.22, 0.44, pcP.y).oneMinus();
        let af = vec2(pcP.x.sub(1.2), pcP.y.sub(0.36)), ar = vec2(pcP.x.add(1.22), pcP.y.sub(0.36));
        af = vec2(af.x.mul(select(af.x.lessThan(0), float(0.62), float(1.3))), af.y);   // flung back: the trailing side takes most
        ar = vec2(ar.x.mul(select(ar.x.lessThan(0), float(0.62), float(1.3))), ar.y);
        const arch = smoothstep(0.34, 0.95, min(length(af), length(ar))).oneMinus().mul(side.mul(0.65).add(0.35));
        const rear = smoothstep(0.2, 0.8, pcN.x.negate()).mul(smoothstep(0.25, 1.1, pcP.y).oneMinus().mul(0.6).add(0.35));
        // Grime runs down the doors in the rain: thin vertical streaks.
        const runs = select(wet.greaterThan(0), nzAt(vec2(pcP.x.add(pcP.z).mul(2.3), pcP.y.mul(0.22)).add(so), 0).a, float(0.5));
        const smear = select(uDirt.y.greaterThan(0), nzAt(vec2(pcP.x.mul(0.3), pcP.y.mul(5)).sub(so), 0).a, float(0.5));
        const pcA = abs(pcN);
        const pcUv = select(pcA.z.greaterThan(max(pcA.x, pcA.y)), pcP.xy, select(pcA.x.greaterThan(pcA.y), pcP.zy, pcP.xz));
        let pRoad = max(max(arch, rear), low.mul(low).mul(0.75));
        pRoad = mix(pRoad, pRoad.mul(runs.mul(1.1).add(0.45)), wet.mul(side));
        pRoad = max(pRoad, wet.mul(side).mul(top.oneMinus()).mul(smoothstep(0.45, 0.8, runs)).mul(0.75).mul(smoothstep(0.7, 1.15, pcP.y).oneMinus()));
        const pGrass = max(sill.mul(side.mul(0.45).add(0.55)), arch.mul(0.7)).mul(top.oneMinus());
        const pDust = max(max(low.mul(0.85), arch), rear).mul(0.85).add(top.mul(0.5).oneMinus().mul(0.2));
        let dR = cover(pRoad, max(arch, rear.mul(low)), uDirt.x, nz.r, nz.a);
        let dG = cover(pGrass, pGrass, uDirt.y, mix(nz.g, smear, 0.5), nz.a);
        const dD = cover(pDust, float(0), uDirt.z, nz.b, nz.a);
        // Spatter round the edge of the arch and sill grime (none on the roof).
        const spat = spatter(pcUv, vec2(arch.mul(1.1).add(smoothstep(0.2, 0.55, pcP.y).oneMinus().mul(0.3)), max(sill, arch.mul(0.8))).mul(uDirt.xy).mul(top.oneMinus()), pcSeed);
        dR = max(dR, spat.x.mul(0.85));
        dG = max(dG, spat.y.mul(0.9));
        const damp = mix(1, 0.55, wet);   // wet dirt is dark
        const dirt = float(1).sub(float(1).sub(dR).mul(float(1).sub(dG)).mul(float(1).sub(dD)));

        // Scars round the dents: a scuffed ring, a lighter primer ring, bare metal at the core, and
        // straight scrape lines along the car reaching out of it. Bigger hits go further through.
        const scr = nzAt(vec2(pcP.x.mul(0.35), pcP.y.add(pcP.z).mul(7)).add(so), 0).a;
        const rowC = select(pcA.y.greaterThan(0.6), pcP.z, pcP.y).div(0.011);
        const rowFw = fwidth(rowC);
        let bareF = float(-1), primerF = float(-1), scuffF = float(-1), lineF = float(-1);
        for (let i = 0; i < MAX_DENTS_USED; i++) {
            const dp = uDentP.element(i), dd = uDentD.element(i);
            const used = float(i).lessThan(uCar.w).and(dp.w.greaterThan(0));
            const rel = pcP.sub(dp.xyz).div(max(dd.w, 1e-4));
            const r = length(rel);
            const sev = clamp(dp.w.sub(0.05).mul(2.5), 0, 1);
            // (each accumulator is read once per step: a select that reads the old value twice
            // doubles the generated expression at every one of the 16 steps)
            const off = float(-4);
            bareF = max(bareF, select(used, sev.mul(0.3).sub(r), off));
            primerF = max(primerF, select(used, sev.mul(0.45).add(0.03).sub(r), off));
            scuffF = max(scuffF, select(used, sev.mul(0.4).add(0.25).sub(r), off));
            lineF = max(lineF, select(used, sev.mul(0.7).add(0.2).sub(abs(rel.x).mul(0.55)).sub(length(rel.yz).mul(1.6)), off));
        }
        const e = nz.a.sub(0.5).mul(0.22).add(nz.g.sub(0.5).mul(0.1));
        const rh = hash4(vec2(floor(rowC), float(41).add(pcSeed)));
        const line = step(rh.x, 0.3).mul(step(0, lineF.add(rh.y.sub(0.5).mul(0.5))))
            .mul(smoothstep(0.12, max(rowFw, 0.02).add(0.12), abs(fract(rowC).sub(0.5))).oneMinus()).mul(smoothstep(0.4, 0.8, rowFw).oneMinus());
        const scuff = smoothstep(0, 0.06, scuffF.add(e.mul(1.5)));
        const primer = max(smoothstep(0, 0.02, primerF.add(e)), line.mul(step(rh.z, 0.5)));
        const bare = max(smoothstep(0, 0.02, bareF.add(e).add(scr.sub(0.5).mul(0.08))), line.mul(step(0.5, rh.z)));
        const scarOn = isPaint ? float(1) : float(0);

        // The water film (paint and glass): glossy, a little darker; dirt sheets the water rather than beading it.
        const wetOn = (isPaint || isGlass) ? step(0.01, wet) : float(0);
        const an = pcA;
        const topFace = an.y.greaterThan(max(an.x, an.z)), sideFace = an.z.greaterThan(an.x);
        const wuv = select(topFace, pcP.xz, select(sideFace, pcP.xy, vec2(pcP.y, pcP.z)));
        const speed = uCar.x;
        const still = select(topFace, float(1).sub(smoothstep(3, 9, speed).mul(0.85)), select(sideFace, float(1).sub(smoothstep(3, 9, speed).mul(0.5)), float(1).sub(smoothstep(3, 9, speed).mul(0.7).mul(step(0, pcN.x)))));
        const wfw = fwidth(wuv), wpx = max(wfw.x, wfw.y);
        const k1 = smoothstep(0.012, 0.03, wpx).oneMinus().mul(still), k2 = smoothstep(0.006, 0.015, wpx).oneMinus().mul(still);
        const b1 = beads(wuv, 0.06, 0.6, pcSeed).mul(k1), b2 = beads(wuv.add(0.37), 0.028, 0.7, pcSeed.add(5)).mul(k2);
        const bmask = clamp(max(b1.z, b2.z), 0, 1).mul(float(1).sub(dirt.mul(0.7)));
        const wetCoat = max(wet.mul(float(1).sub(dirt.mul(0.5))), bmask).mul(wetOn);

        // Procedural Motorsport Livery Layer: under the dirt and scars so mud and wear overlay the stripes,
        // number roundels, checkers and the carbon weave.
        const liveryColor = (rgb0) => {
            let rgb = rgb0;
            const liv = floor(uLivery.x.add(0.5)), acCol = uLivery.yzw;
            const topMask = smoothstep(0.35, 0.7, pcN.y.add(abs(pcN.x).mul(0.25)));
            const fwS = max(fwidth(pcP.z), fwidth(pcP.x));
            const az = abs(pcP.z);
            // 1: twin Le Mans stripes + pin-stripes
            const stripe = smoothstep(0.055, fwS.add(0.055), abs(az.sub(0.14))).oneMinus().mul(topMask);
            const pin = smoothstep(0.012, fwS.add(0.012), abs(az.sub(0.235))).oneMinus().mul(topMask);
            const l1 = mix(rgb, acCol, max(stripe, pin.mul(0.7)));
            // 2: diagonal aero slash + door number roundel
            const diag = pcP.x.mul(0.72).add(az.mul(0.9)).sub(pcP.y.mul(0.5));
            const slash = smoothstep(0.11, fwS.add(0.11), abs(diag.sub(0.45))).oneMinus().mul(smoothstep(0.24, 0.3, pcP.y));
            const doorSide = step(0.55, abs(pcN.z));
            const doorD = length(vec2(pcP.x.add(0.05), pcP.y.sub(0.52))).mul(doorSide);
            const roundel = doorSide.mul(smoothstep(0.19, fwS.add(0.19), doorD).oneMinus());
            const numRing = doorSide.mul(smoothstep(0.03, fwS.add(0.03), abs(doorD.sub(0.11))).oneMinus());
            const l2 = mix(mix(mix(rgb, acCol, slash), vec3(0.95), roundel), vec3(0.08, 0.1, 0.14), numRing);
            // 3: checkered rear quarter + sill splitter band
            const sillBand = smoothstep(0.31, 0.34, pcP.y).oneMinus().mul(smoothstep(0.2, 0.24, pcP.y));
            const rearZone = smoothstep(-0.65, -0.35, pcP.x).oneMinus().mul(smoothstep(0.68, 0.74, pcP.y).oneMinus());
            const chk = mod(floor(pcP.x.mul(9)).add(floor(pcP.y.mul(9))).add(floor(pcP.z.mul(9))), 2);
            const l3 = mix(mix(rgb, acCol, sillBand), mix(vec3(0.08), vec3(0.94), chk), rearZone.mul(0.92));
            // 4+: heritage tri-band flank + satin carbon-weave bonnet
            const flank = smoothstep(0.075, fwS.add(0.08), abs(pcP.y.sub(0.48).sub(pcP.x.mul(0.08)))).oneMinus();
            const hood = smoothstep(0.45, 0.85, pcP.x).mul(smoothstep(0.45, 0.75, pcN.y));
            const weave = mod(floor(pcP.x.mul(80)).add(floor(pcP.z.mul(80))), 2);
            const l4 = mix(mix(rgb, acCol, flank.mul(smoothstep(0.35, 0.65, abs(pcN.z)))), vec3(weave.mul(0.025).add(0.055)), hood.mul(0.92));
            rgb = select(liv.equal(1), l1, select(liv.equal(2), l2, select(liv.equal(3), l3, select(liv.greaterThanEqual(4), l4, rgb))));
            return { rgb, hoodW: select(liv.greaterThanEqual(4), hood, float(0)) };
        };

        return {
            color: (c) => {
                let rgb = c.rgb;
                if (isPaint) rgb = liveryColor(rgb).rgb;
                rgb = mix(rgb, G.dust.mul(nz.a.mul(0.36).add(0.82)).mul(damp), dD);
                rgb = mix(rgb, vec3(0.16, 0.135, 0.105).mul(nz.g.mul(0.5).add(0.75)).mul(damp), dR);
                // Grass: muddy olive smear with greener clippings in the spatter.
                let cGrass = mix(vec3(0.09, 0.075, 0.035), vec3(0.06, 0.085, 0.022), smoothstep(0.35, 0.65, smear));
                cGrass = mix(cGrass, vec3(0.045, 0.1, 0.018), spat.y);
                rgb = mix(rgb, cGrass.mul(damp), dG);
                // scars (the body only)
                rgb = mix(rgb, rgb.mul(0.85).add(0.035), scuff.mul(primer.oneMinus()).mul(scarOn));
                rgb = mix(rgb, vec3(0.36, 0.36, 0.34).mul(nz.a.mul(0.2).add(0.9)), primer.mul(scarOn));
                rgb = mix(rgb, vec3(0.4, 0.41, 0.43).mul(scr.mul(0.4).add(0.8)), bare.mul(scarOn));
                // the wet film
                rgb = rgb.mul(float(1).sub(wet.mul(0.15).mul(wetOn)));
                rgb = rgb.mul(float(1).sub(bmask.mul(0.25).mul(wetOn)));
                if (isGlass) {
                    // Analytical parallax cabin interior + chromatic thin-film Fresnel rim.
                    const viewV = normalize(positionView.negate());
                    const nView = normalView;
                    const cosTheta = clamp(abs(dot(viewV, nView)), 0, 1);
                    const rayLocal = normalize(vec3(viewV.x.negate(), viewV.y.negate(), viewV.z));
                    const cabinHit = pcP.add(rayLocal.mul(float(0.28).div(max(0.35, abs(dot(pcN, rayLocal))))));
                    const hoop = smoothstep(0.035, 0.055, abs(cabinHit.x.add(0.18))).mul(smoothstep(0.035, 0.055, abs(abs(cabinHit.z).sub(0.46)))).oneMinus();
                    const seat = smoothstep(0.14, 0.19, abs(cabinHit.z.sub(0.18))).oneMinus().mul(smoothstep(0.68, 0.74, cabinHit.y)).mul(smoothstep(-0.35, -0.1, cabinHit.x));
                    const wheelRim = smoothstep(0.025, 0.04, abs(length(vec2(cabinHit.y.sub(0.74), cabinHit.z.sub(0.18))).sub(0.14))).oneMinus();
                    const wheelMask = wheelRim.mul(smoothstep(0.05, 0.2, cabinHit.x)).mul(smoothstep(0.28, 0.45, cabinHit.x).oneMinus());
                    const rollDiag = smoothstep(0.025, 0.045, abs(cabinHit.y.sub(0.88).sub(cabinHit.z.mul(0.45)))).oneMinus();
                    const depthFade = mix(0.25, 0.9, cosTheta);
                    let cabinCol = vec3(0.025, 0.03, 0.04);
                    cabinCol = mix(cabinCol, vec3(0.075, 0.085, 0.105), clamp(seat, 0, 1));
                    cabinCol = mix(cabinCol, vec3(0.18, 0.2, 0.24), clamp(max(hoop.mul(0.7), rollDiag.mul(0.45)), 0, 1));
                    cabinCol = mix(cabinCol, vec3(0.24, 0.19, 0.14), clamp(wheelMask, 0, 1));
                    rgb = mix(rgb, cabinCol, depthFade.mul(0.78));
                }
                return vec4(rgb, c.a);
            },
            rough: (r0) => {
                let r = mix(r0, mix(0.95, 0.55, wet), dirt);
                r = mix(r, 0.75, scuff.mul(0.7).mul(scarOn));
                r = mix(r, 0.85, primer.mul(scarOn));
                r = mix(r, 0.38, bare.mul(scarOn));
                return r;
            },
            metal: (m0) => mix(mix(m0, 0, dirt), 1, bare.mul(scarOn)),
            clearcoat: (cc0) => {
                // pcCoat: dirt and scars kill the coat; the water film makes it glossy again.
                const pcCoat = float(1).sub(dirt).mul(float(1).sub(max(scuff.mul(0.8), primer).mul(scarOn)));
                return clamp(max(cc0.mul(pcCoat), wetCoat), 0, 1);
            },
            clearcoatRough: (cr) => mix(mix(cr, 0.16, wetOn.mul(step(0.01, wet))), 0.03, bmask.mul(wetOn)),
            emissive: (em) => {
                let e2 = em;
                if (isGlass) {
                    const viewV = normalize(positionView.negate());
                    const cosTheta = clamp(abs(dot(viewV, normalView)), 0, 1);
                    const rim = pow(float(1).sub(cosTheta), 3.2);
                    const disp = cos(cosTheta.mul(1.45).add(vec3(0, 0.33, 0.67)).mul(6.28318)).mul(0.5).add(0.5);
                    e2 = e2.add(disp.mul(rim).mul(float(0.14).sub(wet.mul(0.07))));
                }
                if (isPaint) {
                    // Subtle wrapped clearcoat/toy-enamel scatter along steep silhouette rims.
                    const viewV = normalize(positionView.negate());
                    const wrap = pow(float(1).sub(clamp(abs(dot(viewV, normalView)), 0, 1)), 2.5);
                    e2 = e2.add(materialColor.rgb.mul(wrap).mul(float(0.045).mul(float(1).sub(dirt))).mul(step(0.5, quality)));
                }
                return e2;
            },
        };
    });
}
