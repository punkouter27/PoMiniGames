// pocabinet/cars.js
//
// Car models for PoCabinet. One shared set of geometries per body style per page;
// per-car materials (paint colour, light intensities) so a livery never touches
// another car.
//
// The model: an extruded side profile for the body, a glass greenhouse with a
// painted roof and pillars, mirrors and trim merged into as few draw calls as
// possible (paint / trim / glass / lights), four wheels (tyre + spoked rim) on
// pivots so the fronts steer, and a soft contact shadow. The body styles (STYLES:
// coupe, hatchback, pickup, van, muscle car) share the lower body and the wheels and
// differ in the cabin and what is behind it. Paint is satin: a thin clearcoat over a
// rough base (the showroom gloss it had made the field a hundred mirrors).
//
// Living paint (paint.js) goes on top of the dent hook on the paint, glass and trim of every
// car drawn in full: the dirt the car has picked up (road grime from the arches, a grass smear
// on the sills, gravel dust or Mar-a-Lago's sand, runs of grime in the rain; weather() takes
// the surface race.js reads off the sim each frame), rain beads and rivulets that run back with
// the speed, scars round the dents (scuffed, primer, bare metal with scrape lines and a brushed
// glint, which replace the dent hook's primer scratches on the body) and a sparse metallic flake in
// the satin base. The far crowd gets none of it.
//
// Everything is derived from the pose race.js already has: steering angle from
// yaw rate, body roll from lateral acceleration, pitch and brake lights from
// longitudinal acceleration. Nothing here reads or changes physics.
//
// Damage is per car. addHit() takes a hit where the sim says it landed and the way it
// pushed (physics.js reports every one); addDamage() takes a bare world point (online,
// where only the fx layer sees the contacts). Up to sixteen dents, each a point on the
// skin, a depth, a radius and a crush direction; a hit near an old dent deepens and widens
// it instead. One onBeforeCompile hook on every chassis material (paint, glass, trim,
// lights: they share the car's dents, so nothing is left floating where a panel used to
// be) pushes the metal in along the hit's own direction with a deeper core and buckle
// creases across it, shades the bent metal by its own folds, dulls the clearcoat and
// scuffs through to primer. The loose parts (bumpers, wing, mirrors, tailgate: tagged per
// vertex in `aPart`) ride on a matrix each: a hard enough knock leaves one hanging off a
// hinge and flapping, the next tears it off: that part (its own mesh in the car's paint)
// leaves from the pose it was hanging at as a rigid body (debris.js) that tumbles, bounces
// off the road and the barriers and lies there to be kicked about. A wreck loses whatever
// was hanging and sheds a wheel, which bounces and rolls away; its corner sags. A corner hit
// breaks that lamp, a heavy one cracks the glass,
// a crushed corner sags the body onto it and a hit by a wheel bends it. A full car is drawn
// from a tessellated copy of the body (`fine`): the plain one is a few long panels with
// nothing between their edges to bend. Every car shares the programs (one cache key); only
// the uniforms differ. The far cars (CarCrowd) lose their torn-off parts and wheels too. What a hit
// does to the driving is physics.js's business, not this file's.
//
// World: sim (x, y) → three (x / 10, 0, y / 10); the car is built along +X and
// rotated by −heading about Y (unchanged from the box cars it replaces).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TessellateModifier } from 'three/addons/modifiers/TessellateModifier.js';
import { LivingPaint, livingPaint, paintSeed } from './paint.js';
import { throwPiece } from './debris.js';
import { WORLD_SCALE as WS, addHook, canvasTexture } from './util.js';

const WHEEL_R = 0.36;
const WHEELS = [[1.2, 0.8, true], [1.2, -0.8, true], [-1.22, 0.8, false], [-1.22, -0.8, false]];

function extrude(shape, width, bevel) {
    const g = new THREE.ExtrudeGeometry(shape, {
        depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
        bevelSegments: 3, curveSegments: 12,
    });
    g.translate(0, 0, -(width - bevel * 2) / 2);
    return g;
}

/** A box placed by a matrix, de-indexed so it merges with extrusions. */
function box(w, h, d, x, y, z, rz = 0, ry = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, rz)),
        new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    return g.toNonIndexed();
}

/** The parts that can hang off and tear away; 0 is the body itself. Index into a car's uParts (id − 1). */
const PART = Object.freeze({ FRONT: 1, REAR: 2, WING: 3, MIRROR_L: 4, MIRROR_R: 5, TAILGATE: 6 });
const PARTS = 6;

/**
 * Tag every vertex of `g` as part `part`. It rides in `uv1` because that is the one spare
 * attribute TessellateModifier carries through; withPart() renames it once tessellated.
 */
function tag(g, part) {
    const n = g.attributes.position.count;
    g.setAttribute('uv1', new THREE.Float32BufferAttribute(new Float32Array(n * 2).fill(part), 2));
    return g;
}

function withPart(g) {
    g.setAttribute('aPart', g.getAttribute('uv1'));
    g.deleteAttribute('uv1');
    return g;
}

function strut(x0, y0, x1, y1, z, t) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    return box(len, t, t, (x0 + x1) / 2, (y0 + y1) / 2, z, Math.atan2(y1 - y0, x1 - x0));
}

/**
 * Body styles. One footprint and wheelbase for all of them (the physics hull is one size
 * for everyone); what differs is the silhouette: where the cabin sits, how tall it is and
 * what is behind it. `cabin` is the x of its rear base, rear top, front top and front base.
 */
const STYLES = [
    { cabin: [-1.08, -0.5, 0.34, 0.96], roof: 1.06, wing: true },    // coupe (the player's)
    { cabin: [-1.74, -1.5, 0.3, 0.98], roof: 1.14 },                 // hatchback
    { cabin: [-0.3, -0.18, 0.42, 1.0], roof: 1.2, bed: true },       // pickup
    { cabin: [-1.8, -1.72, 0.95, 1.5], roof: 1.42 },                 // van
    { cabin: [-1.2, -0.7, -0.05, 0.5], roof: 1.02, wing: true },     // long-bonnet muscle car
];

let COMMON = null;
const GEO = [];

/** Parts every style shares: the lower body's profile, lights, wheels, contact shadow. */
function common() {
    if (COMMON) return COMMON;
    // Side profile: x forward, y up, extruded across the width (z).
    const body = new THREE.Shape();
    body.moveTo(-1.84, 0.22);
    body.lineTo(1.8, 0.22);
    body.quadraticCurveTo(1.95, 0.24, 1.94, 0.4);
    body.quadraticCurveTo(1.9, 0.52, 1.7, 0.56);
    body.quadraticCurveTo(1.3, 0.63, 0.98, 0.66);
    body.lineTo(-1.1, 0.69);
    body.quadraticCurveTo(-1.62, 0.71, -1.84, 0.66);
    body.quadraticCurveTo(-1.96, 0.46, -1.84, 0.22);

    const head = mergeGeometries([box(0.05, 0.09, 0.34, 1.9, 0.5, 0.52), box(0.05, 0.09, 0.34, 1.9, 0.5, -0.52)]);
    const tail = mergeGeometries([box(0.05, 0.1, 0.36, -1.9, 0.56, 0.56), box(0.05, 0.1, 0.36, -1.9, 0.56, -0.56)]);

    const tyre = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.28, 24, 1);
    tyre.rotateX(Math.PI / 2);
    const rimParts = [];
    const disc = new THREE.CylinderGeometry(0.25, 0.25, 0.29, 20, 1);
    disc.rotateX(Math.PI / 2);
    rimParts.push(disc.toNonIndexed());
    for (let i = 0; i < 5; i++) {
        const a = i / 5 * Math.PI * 2;
        for (const z of [0.147, -0.147]) {
            const s = new THREE.BoxGeometry(0.22, 0.045, 0.012);
            s.translate(0.11, 0, 0);
            s.rotateZ(a);
            s.translate(0, 0, z);
            rimParts.push(s.toNonIndexed());
        }
    }
    const rim = mergeGeometries(rimParts);

    const shadow = new THREE.PlaneGeometry(4.6, 2.5);
    shadow.rotateX(-Math.PI / 2);

    COMMON = { body: extrude(body, 1.66, 0.07), head: withPart(tag(head, 0)), tail: withPart(tag(tail, 0)), tyre, rim, shadow };
    return COMMON;
}

/** The geometries of body style `index`: the shared parts plus its own paint, glass and trim. */
function geometry(index) {
    if (GEO[index]) return GEO[index];
    const c = common();
    const s = STYLES[index];
    const [rb, rt, ft, fb] = s.cabin;
    const top = s.roof, mid = (rt + ft) / 2;

    // Wheel arches: dark cut-outs are faked by the trim arches below.
    const cabin = new THREE.Shape();
    cabin.moveTo(rb, 0.66);
    cabin.lineTo(fb, 0.66);
    cabin.quadraticCurveTo((fb + ft) / 2 - 0.05, (0.66 + top) / 2 + 0.065, ft, top - 0.01);
    cabin.lineTo(rt, top);
    cabin.quadraticCurveTo((rb + rt) / 2, (0.66 + top) / 2 + 0.09, rb, 0.66);
    const glass = tag(extrude(cabin, 1.3, 0.04), 0);

    const painted = [
        c.body,
        box(ft - rt + 0.06, 0.045, 1.26, mid, top + 0.015, 0),                           // roof
        strut(fb, 0.67, ft, top, 0.62, 0.06), strut(fb, 0.67, ft, top, -0.62, 0.06),     // A-pillars
        strut(rb, 0.67, rt, top + 0.01, 0.62, 0.07), strut(rb, 0.67, rt, top + 0.01, -0.62, 0.07),   // C-pillars
        box(0.06, top - 0.66, 0.06, mid, (top + 0.66) / 2, 0.63), box(0.06, top - 0.66, 0.06, mid, (top + 0.66) / 2, -0.63),   // B-pillars
        tag(box(0.12, 0.2, 0.08, fb - 0.24, 0.74, 0.86), PART.MIRROR_R), tag(box(0.12, 0.2, 0.08, fb - 0.24, 0.74, -0.86), PART.MIRROR_L),   // mirrors
    ];
    const trimmed = [
        tag(box(0.1, 0.16, 1.5, 1.96, 0.3, 0), PART.FRONT),          // front bumper lip
        box(0.08, 0.14, 1.1, 1.93, 0.43, 0),                         // grille
        tag(box(0.1, 0.16, 1.5, -1.95, 0.3, 0), PART.REAR),          // rear diffuser
        box(3.3, 0.06, 1.5, 0, 0.2, 0),                              // floor
        box(2.0, 0.08, 0.04, 0, 0.26, 0.86), box(2.0, 0.08, 0.04, 0, 0.26, -0.86),     // sills
    ];
    if (s.wing) {
        painted.push(tag(box(0.34, 0.035, 1.72, -1.72, 0.9, 0), PART.WING));
        trimmed.push(tag(box(0.06, 0.16, 0.05, -1.66, 0.8, 0.5), PART.WING), tag(box(0.06, 0.16, 0.05, -1.66, 0.8, -0.5), PART.WING));   // wing stands
    }
    if (s.bed) {
        // Load bed: two rails and a tailgate on the rear deck.
        painted.push(box(1.42, 0.16, 0.07, -1.1, 0.77, 0.76), box(1.42, 0.16, 0.07, -1.1, 0.77, -0.76), tag(box(0.07, 0.16, 1.59, -1.8, 0.77, 0), PART.TAILGATE));
    }
    const paint = mergeGeometries(painted.map(g => g.attributes.uv1 ? g : tag(g, 0)));
    const trim = mergeGeometries(trimmed.map(g => g.attributes.uv1 ? g : tag(g, 0)));

    // The chassis again with no edge longer than a hand's width, for the cars drawn in full:
    // a dent can only move vertices, and the bonnet is otherwise one quad from wing to wing.
    const tess = new TessellateModifier(0.3, 6);
    const fine = { paint: withPart(tess.modify(paint)), glass: withPart(tess.modify(glass)), trim: withPart(tess.modify(trim)) };
    withPart(paint); withPart(glass); withPart(trim);

    GEO[index] = { ...c, paint, glass, trim, fine };
    return GEO[index];
}

let shadowTex = null;
function contactShadowTexture() {
    return shadowTex || (shadowTex = canvasTexture(128, 64, (g) => {
        const grd = g.createRadialGradient(64, 32, 4, 64, 32, 62);
        grd.addColorStop(0, 'rgba(0,0,0,0.85)');
        grd.addColorStop(0.55, 'rgba(0,0,0,0.45)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, 128, 64);
    }, { srgb: false }));
}

// Shared (colour-independent) materials.
let SHARED = null;
let coneTex = null;
function brakeConeTexture() {
    return coneTex || (coneTex = canvasTexture(64, 64, (g) => {
        const grad = g.createRadialGradient(32, 8, 2, 32, 30, 32);
        grad.addColorStop(0.0, 'rgba(255, 70, 50, 0.92)');
        grad.addColorStop(0.4, 'rgba(255, 32, 18, 0.36)');
        grad.addColorStop(1.0, 'rgba(180, 10, 0, 0.0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 64, 64);
    }));
}
function shared() {
    if (SHARED) return SHARED;
    SHARED = {
        glass: new THREE.MeshPhysicalMaterial({
            color: '#0c1116', roughness: 0.12, metalness: 0.14,
            clearcoat: 0.85, clearcoatRoughness: 0.08, iridescence: 0.45, iridescenceIOR: 1.48,
        }),
        trim: new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.55, metalness: 0.2 }),
        tyre: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.92, metalness: 0 }),
        rim: new THREE.MeshStandardMaterial({ color: '#c9ccd2', roughness: 0.5, metalness: 0.7 }),
        shadow: new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, depthWrite: false, opacity: 0.75 }),
        coneGeom: new THREE.PlaneGeometry(0.95, 1.55),
        coneTex: brakeConeTexture(),
    };
    return SHARED;
}

const MAX_DENTS = 16;
const DENT_MERGE = 0.45;   // a hit this close to an existing dent deepens and widens it instead
const MAX_CRUSH = 0.62;    // no vertex is pushed further than this (the body is 1.66 wide)

/**
 * The damage hook on one of a car's chassis materials. `d` is that car's damage uniforms,
 * shared by all of them: the dents (uDentP: a point on the skin, w = depth; uDentD: the way
 * the metal was pushed, w = radius), the loose parts' matrices, the glass crack and the
 * scorch of a wreck. `lamp` is this material's own (left, right) broken flags, for the
 * lights. Chunk names are three 0.165's; a material without one of them (the unlit lights)
 * simply skips that part.
 */
function damageable(material, d, lamp) {
    return addHook(material, 'pocabinet-damage', (shader) => {
        shader.uniforms.uDentP = d.dentP;
        shader.uniforms.uDentD = d.dentD;
        shader.uniforms.uParts = d.parts;
        shader.uniforms.uCrack = d.crack;
        shader.uniforms.uScorch = d.scorch;
        shader.uniforms.uLamp = lamp;
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
uniform vec4 uDentP[${MAX_DENTS}];
uniform vec4 uDentD[${MAX_DENTS}];
uniform mat4 uParts[${PARTS}];
attribute vec2 aPart;
varying float vDamage;
varying vec3 vPanel;`)
            .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
{
    int np = int(aPart.x + 0.5);
    if (np > 0) {
        vec3 turned = mat3(uParts[np - 1]) * objectNormal;
        if (dot(turned, turned) > 1e-6) objectNormal = normalize(turned);
    }
}`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
vDamage = 0.0;
vPanel = position;
vec3 crush = vec3(0.0);
for (int i = 0; i < ${MAX_DENTS}; i++) {
    vec4 p = uDentP[i];
    if (p.w <= 0.0) continue;
    vec4 dd = uDentD[i];
    vec3 rel = position - p.xyz;
    float dist = length(rel);
    // A dish the width of the hit, a sharper core where it landed, and buckle creases
    // across it: the metal is pushed the way the hit was going, not toward the middle.
    float dish = 1.0 - smoothstep(0.0, dd.w, dist);
    dish = dish * dish * (3.0 - 2.0 * dish);
    float core = 1.0 - smoothstep(0.0, dd.w * 0.35, dist);
    float buckle = sin(dot(rel, vec3(21.0, 13.0, 25.0)) + float(i) * 1.7) * 0.5
                 + sin(dot(rel, vec3(-15.0, 31.0, 9.0)) - float(i)) * 0.5;
    crush += dd.xyz * p.w * (dish * (0.75 + 0.3 * buckle) + core * 0.45);
    vDamage = max(vDamage, dish * clamp(p.w * 3.5, 0.0, 1.0));
}
float crushed = length(crush);
if (crushed > ${MAX_CRUSH.toFixed(2)}) crush *= ${MAX_CRUSH.toFixed(2)} / crushed;
transformed += crush;
int part = int(aPart.x + 0.5);
if (part > 0) transformed = (uParts[part - 1] * vec4(transformed, 1.0)).xyz;`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
uniform float uCrack;
uniform float uScorch;
uniform vec2 uLamp;
varying float vDamage;
varying vec3 vPanel;
vec2 dmgHash(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}
// Distance to the nearest crack: the edges of a Voronoi tiling, finer near the impact.
float dmgCracks(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float d1 = 8.0, d2 = 8.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 r = g + dmgHash(i + g) - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
    return sqrt(d2) - sqrt(d1);
}`)
            .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
{
    // Bent metal catches the light fold by fold: where the body is crushed, shade it by the
    // crushed surface itself (the vertex normals still describe the undamaged car).
    vec3 folded = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    normal = normalize(mix(normal, folded, smoothstep(0.03, 0.3, vDamage)));
    nonPerturbedNormal = normal;
}`)
            .replace('#include <color_fragment>', `#include <color_fragment>
{
    float scuff = smoothstep(0.1, 0.8, vDamage);
    // Scrapes: thin streaks along the panel (cells long in x and z, thin in y) through to primer.
    vec3 cell = floor(vPanel * vec3(5.0, 64.0, 5.0) + vec3(floor(vPanel.y * 64.0) * 0.37, 0.0, 0.0));
    float scratch = step(0.84, fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453));
    // Gone at a distance, where a streak is finer than a pixel and would only sparkle.
    scratch *= 1.0 - smoothstep(0.35, 1.0, fwidth(vPanel.y * 64.0));
    diffuseColor.rgb *= 1.0 - scuff * 0.5;
#ifndef PC_PAINT
    // (The paint's own scars, paint.js, replace these on the body colour.)
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.56, 0.57, 0.6), scratch * 0.8 * smoothstep(0.4, 0.95, vDamage));
#endif
    // A wreck is scorched and sooted, darkest round the engine bay.
    diffuseColor.rgb *= 1.0 - uScorch * (0.45 + 0.35 * smoothstep(0.4, 1.6, vPanel.x));
    // A broken lamp is a dark hole with a few shards left in it.
    float lampSide = vPanel.z > 0.0 ? uLamp.y : uLamp.x;
    diffuseColor.rgb *= 1.0 - lampSide * 0.92;
    // Crazed glass: white crack lines, finer and denser where it took the hit.
    if (uCrack > 0.0) {
        // The web shows in patches that spread as the crack grows, never the whole pane at once.
        float web = dmgCracks(vPanel.zy * 17.0 + vPanel.x * 4.0);
        vec2 patchCell = floor(vPanel.zy * 3.0 + vPanel.x);
        float patchOn = step(1.0 - uCrack, dmgHash(patchCell).x);
        float aa = fwidth(web);
        float line = (1.0 - smoothstep(0.0, 0.035 + aa, web)) * (1.0 - smoothstep(0.03, 0.1, aa));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.7, 0.74, 0.78), line * patchOn * 0.7);
    }
}`)
            .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.9, max(smoothstep(0.1, 0.7, vDamage), uScorch * 0.8));`)
            .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
material.clearcoat *= (1.0 - smoothstep(0.1, 0.6, vDamage)) * (1.0 - uScorch);
#endif`);
    });
}

const HEAD_DAY = new THREE.Color('#fff4dc').multiplyScalar(1.2);
const TAIL = new THREE.Color('#ff1a12');

/** How hard each loose part has to be hit to hang off, and to tear away (summed strength of
 *  the hits of at least PART_KNOCK there: a rub or a tap never takes a part off). */
const PART_KNOCK = 0.25;
const PART_LIMITS = {
    [PART.FRONT]: [0.6, 1.3], [PART.REAR]: [0.6, 1.3], [PART.WING]: [0.5, 1.1],
    [PART.MIRROR_L]: [0.4, 0.8], [PART.MIRROR_R]: [0.4, 0.8], [PART.TAILGATE]: [0.55, 1.2],
};
/** How far a hanging part swings down off its hinge, radians. */
const PART_DROOP = { [PART.FRONT]: 0.2, [PART.REAR]: 0.2, [PART.WING]: 0.45, [PART.MIRROR_L]: 1.25, [PART.MIRROR_R]: 1.25, [PART.TAILGATE]: 0.35 };

/** Bounds of every part in a body style's plain geometry: where its hinge can go. */
const BOUNDS = [];
function partBounds(style) {
    if (BOUNDS[style]) return BOUNDS[style];
    const g = geometry(style);
    const out = [];
    for (const geom of [g.paint, g.trim]) {
        const pos = geom.attributes.position, part = geom.attributes.aPart;
        for (let i = 0; i < pos.count; i++) {
            const id = Math.round(part.getX(i));
            if (!id) continue;
            const b = out[id] || (out[id] = new THREE.Box3());
            b.expandByPoint(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
        }
    }
    BOUNDS[style] = out;
    return out;
}

const DEBRIS_GEO = new Map();
/** Part `id` of `style` as its own geometries (paint and trim), centred on the part. */
function debrisGeometry(style, id) {
    const key = `${style}:${id}`;
    if (DEBRIS_GEO.has(key)) return DEBRIS_GEO.get(key);
    const g = geometry(style);
    const centre = new THREE.Vector3();
    partBounds(style)[id]?.getCenter(centre);
    const pick = (geom) => {
        const pos = geom.attributes.position, nrm = geom.attributes.normal, part = geom.attributes.aPart;
        const p = [], n = [];
        for (let i = 0; i < pos.count; i += 3) {
            if (Math.round(part.getX(i)) !== id) continue;
            for (let k = i; k < i + 3; k++) {
                p.push(pos.getX(k) - centre.x, pos.getY(k) - centre.y, pos.getZ(k) - centre.z);
                n.push(nrm.getX(k), nrm.getY(k), nrm.getZ(k));
            }
        }
        if (!p.length) return null;
        const out = new THREE.BufferGeometry();
        out.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
        out.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
        return out;
    };
    const entry = { paint: pick(g.paint), trim: pick(g.trim), centre };
    DEBRIS_GEO.set(key, entry);
    return entry;
}

// Torn-off parts and lost wheels become rigid bodies in debris.js (throwPiece), which flies,
// bounces, rolls and settles them, lets the cars kick them about, caps them and clears them away.

const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _sc = new THREE.Vector3();
const _sz = new THREE.Vector3();
const _q = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * Throw part `id` of car `handle` off it, from the pose it was hanging at (`hang`, the part's
 * matrix in the chassis), moving with the car plus a kick off it.
 */
function spawnDebris(handle, id, hang) {
    const parent = handle.group.parent;
    if (!parent) return;
    const geo = debrisGeometry(handle.style, id);
    if (!geo.paint && !geo.trim) return;
    const piece = new THREE.Group();
    piece.name = 'pocabinet-debris-part';
    let mat = null;
    if (geo.paint) {
        mat = new THREE.MeshStandardMaterial({ color: handle.paint.color.clone(), roughness: 0.6, metalness: 0.2 });
        piece.add(new THREE.Mesh(geo.paint, mat));
    }
    if (geo.trim) piece.add(new THREE.Mesh(geo.trim, shared().trim));
    for (const m of piece.children) m.receiveShadow = true;
    // Where the part is now in the world: the chassis, then the hinge it was hanging off.
    handle.group.updateMatrixWorld(true);
    _m.copy(handle.chassis.matrixWorld).multiply(hang || _r.identity())
        .multiply(_r.makeTranslation(geo.centre.x, geo.centre.y, geo.centre.z));
    _m.decompose(piece.position, piece.quaternion, _sc);
    partBounds(handle.style)[id].getSize(_sz);
    const h = handle.last?.h ?? 0, v = handle.last?.v ?? 0;
    const fx = Math.cos(h), fz = Math.sin(h);
    // Out the side it was on (a bumper: off its end as well), up, and still doing most of the car's speed.
    const side = geo.centre.z >= 0 ? 1 : -1;
    const end = Math.abs(geo.centre.x) > 1.4 ? Math.sign(geo.centre.x) : 0;
    const rnd = Math.random;
    const out = 0.8 + rnd() * 1.8, keep = 0.72 + rnd() * 0.18;
    const sideK = end ? 0.35 : 1;
    const vel = new THREE.Vector3(
        fx * v * keep - fz * side * out * sideK + fx * end * out * 0.4,
        1.2 + rnd() * 2.2,
        fz * v * keep + fx * side * out * sideK + fz * end * out * 0.4);
    const spin = new THREE.Vector3((rnd() - 0.5) * 12, (rnd() - 0.5) * 9, (rnd() - 0.5) * 12);
    throwPiece(parent, piece, {
        box: [_sz.x / 2, Math.max(0.03, _sz.y / 2), _sz.z / 2], v: vel, w: spin, e: 0.3,
        owner: handle, floor: handle.group.position.y, dispose: () => mat?.dispose(),
    });
}

class CarHandle {
    constructor(group, chassis, mats, dmg, wheels, style, cones) {
        this.group = group;
        this.chassis = chassis;
        this.mats = mats;               // this car's own materials, all damaged from `dmg`
        this.paint = mats.paint;
        this.tailMat = mats.tail;
        this.cones = cones || [];       // left & right volumetric additive brake light cones
        this.dmg = dmg;                 // the uniforms damageable() shares across them
        this.wheels = wheels;
        this.style = style;             // index into STYLES (the crowd draws by it)
        this.disposed = false;
        this.spin = 0;
        this.steer = 0;
        this.roll = 0;
        this.pitch = 0;
        this.braking = 0;
        this.last = null;
        // Damage as drawn: the zones that took it (sag, HUD), each loose part's knocks and
        // state (0 on, 1 hanging, 2 gone) and hinge, the lamps and the glass.
        this.zones = { front: 0, rear: 0, left: 0, right: 0 };
        this.parts = Array.from({ length: PARTS + 1 }, () => ({ hits: 0, state: 0, hinge: null, angle: 0, phase: Math.random() * 6 }));
        this.lamps = { headL: 0, headR: 0, tailL: 0, tailR: 0 };
        this.lost = 0;                  // bit (id − 1) set once part id is gone: CarCrowd hides it too
        this.scorch = 0;
        this._v = new THREE.Vector3();
        this.applyLights();
    }

    /** Paint colour as '#rrggbb' (debris flakes match the car). */
    get paintHex() {
        return `#${this.paint.color.getHexString()}`;
    }

    /** 0..1: how bent the body looks overall (the HUD reads it online, where the sim's is the server's). */
    get wear() {
        const z = this.zones;
        return Math.min(1, (z.front + z.rear + z.left + z.right) / 3);
    }

    /**
     * A hit at world (x, z), `strength` 0..1, with no direction known (online, from the fx
     * layer): it pushes in toward the middle of the car. Returns false when the car is
     * already as bent as it gets there.
     */
    addDamage(x, z, strength) {
        if (this.disposed) return false;
        const p = this.group.worldToLocal(this._v.set(x, 0.5, z));
        return this.hit(p.x, p.z, -p.x * 0.45, -p.z, strength);
    }

    /**
     * A hit the sim reported (physics.js reportHits): (fwd, side) from the car's centre and
     * (nx, ny) the way it pushed, both in sim units in the car's own frame (+ ahead, + right).
     */
    addHit(fwd, side, nx, ny, strength) {
        if (this.disposed) return false;
        return this.hit(fwd / WS, side / WS, nx, ny, strength);
    }

    /** Dent the body at local (x, z), crushed along local (dx, dz). The car's right is +Z. */
    hit(x, z, dx, dz, strength) {
        const s = Math.min(1, Math.max(0, Number(strength) || 0));
        if (s < 0.05) return false;
        // Onto the body's skin: clamp into its footprint, then out to the nearest face.
        x = Math.max(-1.9, Math.min(1.94, x));
        z = Math.max(-0.83, Math.min(0.83, z));
        if (1.9 - Math.abs(x) < 0.83 - Math.abs(z)) x = Math.sign(x || 1) * 1.9;
        else z = Math.sign(z || 1) * 0.83;
        const y = 0.48;
        const dir = this._v.set(dx, -0.12, dz);
        if (dir.lengthSq() < 1e-6) dir.set(-x, -0.12, -z);
        dir.normalize();

        this.zoneHit(x, z, s);
        // A hard hit by a wheel bends it for good (update() leans it in, toes it out and wobbles it).
        for (const w of this.wheels) {
            const d = Math.hypot(w.pivot.position.x - x, w.pivot.position.z - z);
            if (s > 0.35 && d < 0.9) w.bent = Math.min(1, w.bent + (s - 0.35) * (1 - d / 0.9) * 1.6);
        }

        const P = this.dmg.dentP.value, D = this.dmg.dentD.value;
        const depth = 0.07 + 0.36 * s, radius = 0.3 + 0.55 * s;
        let near = -1, nearD = Infinity, free = -1;
        for (let i = 0; i < MAX_DENTS; i++) {
            if (P[i].w <= 0) { if (free < 0) free = i; continue; }
            const d = Math.hypot(P[i].x - x, P[i].z - z);
            if (d < nearD) { nearD = d; near = i; }
        }
        // Close to an old dent, or nowhere left to put a new one: that dent deepens and widens,
        // and its direction leans toward this hit's.
        if (near >= 0 && (nearD < DENT_MERGE || free < 0)) {
            const p = P[near], q = D[near];
            if (p.w >= 0.6 && q.w >= 1.1) return false;
            const k = depth / (p.w + depth);
            q.x += (dir.x - q.x) * k; q.y += (dir.y - q.y) * k; q.z += (dir.z - q.z) * k;
            const len = Math.hypot(q.x, q.y, q.z) || 1;
            q.set(q.x / len, q.y / len, q.z / len, Math.min(1.1, Math.max(q.w, radius) + 0.05 * s));
            p.w = Math.min(0.6, p.w + depth * 0.6);
            return true;
        }
        P[free].set(x, y, z, depth);
        D[free].set(dir.x, dir.y, dir.z, radius);
        return true;
    }

    /** What a hit at local (x, z) did beyond the dent: zones, loose parts, lamps, glass. */
    zoneHit(x, z, s) {
        const zn = this.zones;
        if (x > 1.0) zn.front += s;
        if (x < -1.0) zn.rear += s;
        if (z < -0.4) zn.left += s;
        if (z > 0.4) zn.right += s;
        const b = partBounds(this.style);
        const knock = (id, amount) => {
            const part = this.parts[id];
            if (!b[id] || part.state === 2 || s < PART_KNOCK) return;
            part.hits += amount;
            const [loose, gone] = PART_LIMITS[id];
            if (part.state === 0 && part.hits >= loose) {
                part.state = 1;
                // It tears free at the end that was hit and hangs off the other.
                const bb = b[id];
                const mirror = id === PART.MIRROR_L || id === PART.MIRROR_R;
                const hz = mirror ? (bb.min.z + bb.max.z > 0 ? bb.min.z : bb.max.z) : (z > 0 ? bb.min.z : bb.max.z);
                part.hinge = new THREE.Vector3((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, hz);
                const free = (bb.min.z + bb.max.z) / 2 - hz;
                part.angle = Math.sign(free || 1) * PART_DROOP[id];
            }
            if (part.hits >= gone) this.tearOff(id);
        };
        if (x > 1.45) knock(PART.FRONT, s);
        if (x < -1.45) { knock(PART.REAR, s); knock(PART.TAILGATE, s); }
        if (x < -1.2) knock(PART.WING, s * 0.9);
        if (z < -0.5 && x > 0 && x < 1.5) knock(PART.MIRROR_L, s);
        if (z > 0.5 && x > 0 && x < 1.5) knock(PART.MIRROR_R, s);
        const l = this.lamps;
        if (s > 0.35) {
            if (x > 1.3 && z < 0.1) l.headL = 1;
            if (x > 1.3 && z > -0.1) l.headR = 1;
            if (x < -1.3 && z < 0.1) l.tailL = 1;
            if (x < -1.3 && z > -0.1) l.tailR = 1;
            this.mats.head.userData.lamp.value.set(l.headL, l.headR);
            this.mats.tail.userData.lamp.value.set(l.tailL, l.tailR);
        }
        // The glass only goes from a big hit; a badly bent shell lets a smaller one finish it.
        if (s > 0.55 || (s > 0.3 && this.wear > 1)) this.dmg.crack.value = Math.min(1, this.dmg.crack.value + (s - 0.25) * 0.8);
    }

    /**
     * The sim's word on the car (race.js, every frame): a wreck is scorched, loses what is
     * hanging and sheds a wheel.
     */
    setCondition(wrecked) {
        const target = wrecked ? 1 : 0;
        if (target === this.scorch) return;
        this.scorch = target;
        this.dmg.scorch.value = target;
        if (!wrecked) return;
        for (let id = 1; id <= PARTS; id++) if (this.parts[id].state === 1) this.tearOff(id);
        this.loseWheel();
    }

    /** Part `id` comes off for good: folded away on the car, a rigid body from the pose it hung at. */
    tearOff(id) {
        const part = this.parts[id];
        if (part.state === 2) return;
        part.state = 2;
        this.lost |= 1 << (id - 1);
        const m = this.dmg.parts.value[id - 1];
        const hang = m.clone();
        m.makeScale(0, 0, 0);
        spawnDebris(this, id, hang);
    }

    /**
     * A wreck sheds a wheel (the most bent one; else, half the time, any): it bounces and rolls
     * off across the run-off (debris.js), and the corner it came off sags.
     */
    loseWheel() {
        const parent = this.group.parent;
        if (!parent) return;
        let k = -1, worst = 0.25;
        this.wheels.forEach((w, i) => { if (!w.gone && w.bent > worst) { worst = w.bent; k = i; } });
        if (k < 0 && Math.random() < 0.5) k = Math.floor(Math.random() * this.wheels.length);
        const w = this.wheels[k];
        if (!w || w.gone) return;
        this.group.updateMatrixWorld(true);
        // Its axle (the tyre's Z) on the body's disc axis (its Y).
        const piece = new THREE.Group();
        piece.name = 'pocabinet-debris-wheel';
        const inner = new THREE.Group();
        inner.rotation.x = -Math.PI / 2;
        inner.add(new THREE.Mesh(w.tyre.geometry, w.tyre.material), new THREE.Mesh(w.rim.geometry, w.rim.material));
        for (const m of inner.children) m.receiveShadow = true;
        piece.add(inner);
        w.pivot.getWorldPosition(piece.position);
        w.pivot.getWorldQuaternion(piece.quaternion).multiply(_q.setFromAxisAngle(X_AXIS, Math.PI / 2));
        const h = this.last?.h ?? 0, v = this.last?.v ?? 0;
        const fx = Math.cos(h), fz = Math.sin(h);
        const side = w.pivot.position.z > 0 ? 1 : -1;
        const rnd = Math.random;
        const out = 1.4 + rnd() * 2.2, keep = 0.8 + rnd() * 0.15;
        const thrown = throwPiece(parent, piece, {
            disc: [WHEEL_R, 0.14], e: 0.45, metal: false, owner: this, roll: true, floor: this.group.position.y,
            v: new THREE.Vector3(fx * (v * keep + 0.5) - fz * side * out, 1.6 + rnd() * 2.2, fz * (v * keep + 0.5) + fx * side * out),
            w: new THREE.Vector3((rnd() - 0.5) * 4, (rnd() - 0.5) * 4, (rnd() - 0.5) * 4),
        });
        if (!thrown) return;
        w.gone = true;
        w.pivot.visible = false;
        this.lost |= 1 << (PARTS + k);
        const zn = this.zones;
        if (w.front) zn.front = Math.max(zn.front, 2); else zn.rear = Math.max(zn.rear, 2);
        if (side > 0) zn.right = Math.max(zn.right, 2); else zn.left = Math.max(zn.left, 2);
    }

    /**
     * What the paint picks up (race.js, every rendered frame): `surface` is the sim's SURF_* under
     * the car. Dirt and the water on it build from that and the speed drawn; render only.
     */
    weather(dt, surface) {
        if (!this.disposed) this.livery?.tick(dt, surface, this.last?.v ?? 0);
    }

    /** World points where a hanging part is dragging on the road (sparks), into `out`. */
    dragging(out) {
        for (let id = 1; id <= PARTS; id++) {
            const p = this.parts[id];
            if (p.state !== 1 || (id !== PART.FRONT && id !== PART.REAR)) continue;
            const b = partBounds(this.style)[id];
            const free = this._v.set(p.hinge.x, 0.12, b.min.z + b.max.z - p.hinge.z);
            out.push(this.group.localToWorld(free).clone());
        }
        return out;
    }

    /**
     * Place the car. `snap` = { x, y, heading, speedKmh } (sim units), plus on a track with
     * height { h, pitch, roll }: the road's height (world units), slope and bank under it.
     * Called every rendered frame by race.js; the secondary motion is time-based.
     */
    update(snap) {
        if (this.disposed || !snap) return;
        const now = performance.now();
        const x = snap.x / WS, z = snap.y / WS;
        const speed = (Number(snap.speedKmh) || 0) / 2 / WS;     // world units/s
        this.group.position.set(x, Number(snap.h) || 0, z);
        // Yaw, then the road's slope about the car's own lateral axis, then its bank about
        // the car's length (+ roll = right side up; the car's right is local +Z).
        this.group.rotation.set(-(Number(snap.roll) || 0), -snap.heading, Number(snap.pitch) || 0, 'YZX');

        if (this.last) {
            const dt = Math.min(0.1, Math.max(1e-3, (now - this.last.t) / 1000));
            let dh = snap.heading - this.last.h;
            dh = Math.atan2(Math.sin(dh), Math.cos(dh));
            const yawRate = dh / dt;
            const accel = (speed - this.last.v) / dt;
            const k = 1 - Math.exp(-dt * 8);
            const steerTarget = Math.max(-0.45, Math.min(0.45, yawRate * 0.35 * (speed > 0.5 ? 1 : 0)));
            this.steer += (steerTarget - this.steer) * k;
            this.roll += (Math.max(-0.07, Math.min(0.07, -yawRate * speed * 0.004)) - this.roll) * k;
            this.pitch += (Math.max(-0.05, Math.min(0.05, accel * 0.0028)) - this.pitch) * k;
            const brake = accel < -3 ? 1 : 0;
            if (brake !== this.braking) { this.braking = brake; this.applyLights(); }
            this.spin -= speed * dt / WHEEL_R;
        }
        this.last = { t: now, h: snap.heading, v: speed };
        // A crushed corner sits low: the body sags onto whatever is bent under it (+ x roll
        // drops the right side, + z pitch lifts the nose).
        const zn = this.zones, sag = (v) => Math.min(1, v * 0.5);
        this.chassis.rotation.x = this.roll + 0.035 * (sag(zn.right) - sag(zn.left));
        this.chassis.rotation.z = this.pitch + 0.03 * (sag(zn.rear) - sag(zn.front));
        this.chassis.position.y = -0.04 * Math.max(sag(zn.front), sag(zn.rear), sag(zn.left), sag(zn.right));
        for (const w of this.wheels) {
            // The car's right is +Z: a bent wheel leans in at the top, points away from the car
            // and wobbles as it turns.
            const out = w.pivot.position.z > 0 ? -w.bent : w.bent;
            const wobble = Math.sin(this.spin) * w.bent * 0.07;
            w.pivot.rotation.x = out * 0.2 + wobble;
            w.pivot.rotation.y = (w.front ? this.steer : 0) + out * 0.12 + wobble;
            w.tyre.rotation.z = this.spin;
            w.rim.rotation.z = this.spin;
        }
        // Hanging parts flap off their hinges, the harder the faster the car is going.
        const t = now / 1000;
        for (let id = 1; id <= PARTS; id++) {
            const p = this.parts[id];
            if (p.state !== 1) continue;
            const flap = Math.sin(t * 17 + p.phase) * 0.05 * Math.min(1, speed / 6) + Math.sin(t * 5.3 + p.phase) * 0.03;
            const h = p.hinge;
            _m.makeTranslation(h.x, h.y, h.z)
                .multiply(_r.makeRotationX(p.angle + Math.sign(p.angle) * flap))
                .multiply(_r.makeTranslation(-h.x, -h.y, -h.z));
            this.dmg.parts.value[id - 1].copy(_m);
        }
    }

    applyLights() {
        // A smashed lamp stays dark (the shader draws the hole); the other one still brakes.
        this.tailMat.color.copy(TAIL).multiplyScalar(this.braking ? 3.1 : 1.2);
        const coneOp = this.braking ? 0.52 : 0.14;
        const coneScale = this.braking ? 1.15 : 0.7;
        for (let i = 0; i < this.cones.length; i++) {
            const c = this.cones[i];
            const broken = i === 0 ? this.lamps.tailL : this.lamps.tailR;
            c.visible = !broken;
            if (!broken) {
                c.material.opacity = coneOp;
                c.scale.set(coneScale, coneScale, 1);
            }
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.group.parent) this.group.parent.remove(this.group);
        for (const m of Object.values(this.mats)) m.dispose();
        for (const c of this.cones) c.material.dispose();
    }
}

/**
 * Build a car and add it to `parent`. Returns a handle with `update(snap)`, `addHit(...)`,
 * `addDamage(x, z, s)`, `setCondition(wrecked)` and `dispose()`.
 * @param {THREE.Object3D} parent
 * @param {{ id?: string, name: string, color?: string, style?: number }} opts  style: any
 *        integer, taken round the body styles (0 = the coupe)
 */
export function mountCar(parent, opts) {
    if (!parent) throw new Error('pocabinet/cars: parent object is required');
    if (!opts || !opts.name) throw new Error('pocabinet/cars: opts.name is required');
    const style = (((opts.style | 0) % STYLES.length) + STYLES.length) % STYLES.length;
    const g = geometry(style);
    const m = shared();

    // The car's damage uniforms, shared by all its chassis materials (damageable()).
    const dmg = {
        dentP: { value: Array.from({ length: MAX_DENTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
        dentD: { value: Array.from({ length: MAX_DENTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
        parts: { value: Array.from({ length: PARTS }, () => new THREE.Matrix4()) },
        crack: { value: 0 },
        scorch: { value: 0 },
    };
    const lamp = (mat) => { mat.userData.lamp = { value: new THREE.Vector2(0, 0) }; return mat; };
    const glass = m.glass.clone();
    const mats = {
        // Satin, not showroom: a thin clearcoat over a rough base, so a field of a hundred
        // reads as paint colours rather than as a hundred mirrors of the sky.
        paint: lamp(new THREE.MeshPhysicalMaterial({
            color: opts.color || '#888888', roughness: 0.58, metalness: 0.15,
            clearcoat: 0.25, clearcoatRoughness: 0.4,
        })),
        glass: lamp(glass),
        trim: lamp(m.trim.clone()),
        head: lamp(new THREE.MeshBasicMaterial({ color: HEAD_DAY.clone() })),
        tail: lamp(new THREE.MeshBasicMaterial({ color: TAIL.clone() })),
    };
    // Only the glass crazes: the others read a crack that stays 0.
    const noCrack = { value: 0 };
    // Living paint (paint.js) over the dents: dirt, rain, scars and flake on the body; dirt and
    // rain on the glass; dirt on the trim. The lamps stay as they are.
    const livery = new LivingPaint(paintSeed(opts.id || opts.name), dmg.dentP.value);
    for (const [key, mat] of Object.entries(mats)) {
        damageable(mat, key === 'glass' ? dmg : { ...dmg, crack: noCrack }, mat.userData.lamp);
        if (key === 'paint' || key === 'glass' || key === 'trim') livingPaint(mat, key, livery);
    }

    const group = new THREE.Group();
    group.name = `pocabinet-car-${opts.id || opts.name}`;
    const chassis = new THREE.Group();
    group.add(chassis);

    const add = (geom, mat, parentObj = chassis, cast = true) => {
        const mesh = new THREE.Mesh(geom, mat);
        mesh.castShadow = cast;
        mesh.receiveShadow = cast;
        parentObj.add(mesh);
        return mesh;
    };
    add(g.fine.paint, mats.paint);
    add(g.fine.glass, mats.glass);
    add(g.fine.trim, mats.trim);
    add(g.head, mats.head, chassis, false);
    add(g.tail, mats.tail, chassis, false);

    const wheels = [];
    for (const [x, z, front] of WHEELS) {
        const pivot = new THREE.Group();
        pivot.position.set(x, WHEEL_R, z);
        group.add(pivot);
        const tyre = add(g.tyre, m.tyre, pivot);
        const rim = add(g.rim, m.rim, pivot);
        wheels.push({ pivot, tyre, rim, front, bent: 0 });
    }

    const cones = [-0.56, 0.56].map((zOff) => {
        const mat = new THREE.MeshBasicMaterial({
            map: m.coneTex, color: 0xff2b16, transparent: true, opacity: 0.14,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        });
        const cone = new THREE.Mesh(m.coneGeom, mat);
        cone.rotation.x = -Math.PI * 0.44;
        cone.rotation.z = -Math.PI * 0.5;
        cone.position.set(-2.55, 0.34, zOff);
        cone.renderOrder = 3;
        chassis.add(cone);
        return cone;
    });

    const shadow = new THREE.Mesh(g.shadow, m.shadow);
    shadow.position.y = 0.03;
    shadow.renderOrder = 1;
    group.add(shadow);

    parent.add(group);
    const handle = new CarHandle(group, chassis, mats, dmg, wheels, style, cones);
    handle.livery = livery;
    return handle;
}

export function unmountCar(handle) {
    if (!handle) return;
    handle.dispose();
}

/**
 * Every car that is not drawn in full, as one instanced mesh per body style (for the
 * 100-car field). A full car is fourteen draw calls and as many again in the shadow
 * pass; a hundred of them would take a 29 fps frame to 3. A crowd mesh is the plain body, glass,
 * trim and tyres of its style merged into one geometry: the paint is the instance colour,
 * the rest is baked dark in vertex colour, and it casts its shadow in one call too. A torn-off
 * part or a shed wheel stays gone from a far car and a wreck stays sooted (per-instance aLost, aScorch). race.js
 * fills them each frame from the handles it is not showing (CarHandle.update has already
 * placed them).
 */
export class CarCrowd {
    constructor(parent, max) {
        const shaded = (geom, v) => {
            const c = geom.index ? geom.toNonIndexed() : geom.clone();
            c.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(c.attributes.position.count * 3).fill(v), 3));
            if (!c.attributes.aPart) c.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(c.attributes.position.count * 2), 2));
            return c;
        };
        this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 });
        // Per instance: the parts it has lost (bit id − 1) fold away, and a wreck is sooted.
        addHook(this.material, 'pocabinet-crowd', (shader) => {
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', `#include <common>
attribute vec2 aPart;
attribute float aLost;
attribute float aScorch;
varying float vScorch;`)
                .replace('#include <begin_vertex>', `#include <begin_vertex>
vScorch = aScorch;
float crowdPart = floor(aPart.x + 0.5);
if (crowdPart > 0.5 && mod(floor(aLost / exp2(crowdPart - 1.0)), 2.0) > 0.5) transformed = vec3(0.0);`);
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', `#include <common>
varying float vScorch;`)
                .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb *= 1.0 - 0.55 * vScorch;`);
        });
        this.max = max;
        this.meshes = STYLES.map((_, style) => {
            const g = geometry(style);
            const parts = [shaded(g.paint, 1), shaded(g.glass, 0.04), shaded(g.trim, 0.07)];
            // Each tyre is a part of its own (PARTS + 1 + k), so a wheel a wreck shed stays off.
            WHEELS.forEach(([x, z], k) => {
                const tyre = shaded(g.tyre, 0.05).translate(x, WHEEL_R, z);
                tyre.attributes.aPart.array.fill(PARTS + 1 + k);
                parts.push(tyre);
            });
            const merged = mergeGeometries(parts);
            merged.setAttribute('aLost', new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage));
            merged.setAttribute('aScorch', new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage));
            const mesh = new THREE.InstancedMesh(merged, this.material, max);
            for (const p of parts) p.dispose();
            mesh.name = `pocabinet-car-crowd-${style}`;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.frustumCulled = false;   // its bounds are wherever the field is
            mesh.count = 0;
            parent.add(mesh);
            return mesh;
        });
    }

    begin() { for (const m of this.meshes) m.count = 0; }

    /** Draw `handle`'s car here this frame (its own group should be hidden). */
    add(handle) {
        const mesh = this.meshes[handle.style];
        if (handle.disposed || mesh.count >= this.max) return;
        handle.group.updateMatrix();
        mesh.setMatrixAt(mesh.count, handle.group.matrix);
        mesh.setColorAt(mesh.count, handle.paint.color);
        mesh.geometry.attributes.aLost.array[mesh.count] = handle.lost;
        mesh.geometry.attributes.aScorch.array[mesh.count] = handle.scorch;
        mesh.count++;
    }

    end() {
        for (const m of this.meshes) {
            m.instanceMatrix.needsUpdate = true;
            if (m.instanceColor) m.instanceColor.needsUpdate = true;
            m.geometry.attributes.aLost.needsUpdate = true;
            m.geometry.attributes.aScorch.needsUpdate = true;
        }
    }

    dispose() {
        for (const m of this.meshes) {
            m.parent?.remove(m);
            m.geometry.dispose();
            m.dispose();
        }
        this.material.dispose();
    }
}
