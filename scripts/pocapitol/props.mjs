// Writes PoCapitol's loose props to wwwroot/models/pocapitol/props.glb: the things that end up on
// the ground and get thrown about (spent gas and smoke canisters, flash-bang bodies, water
// bottles, dropped placards and flags). debris.js drops them into a Rapier world and draws them.
//
//   npm ci --prefix scripts/pocapitol
//   node scripts/pocapitol/props.mjs
//
// The meshes are built here from three.js primitives, so the file is reproducible and there is
// no Blender step. Each prop is a metal-rough PBR material with small painted textures made from
// layers (base paint, a stencil band, chipped edges down to bare metal, grime), the way scanned
// material sets are put together, and the geometry is Draco-compressed (KHR_draco_mesh_compression):
// the app loads it through three's DRACOLoader with the decoder from the CDN. Textures stay PNG:
// they are 128 px and the browser decodes PNG for free.
//
// Node names are the contract with debris.js: canister, flashbang, bottle, placard, placard-face,
// placard-pole, flag-pole, flag-cloth. `placard-face` and `flag-cloth` are drawn with whatever
// the person was carrying (crowd.js flagTexture), so their own material is a plain stand-in.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

const out = new URL('../../src/PoMiniGames.Client/wwwroot/models/pocapitol/', import.meta.url);

// ---- Textures: RGBA pixels, layered, written as PNG ------------------------------------------

/** Seeded noise so every run writes the same bytes. */
function random(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function hash2(x, y, seed) {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) >>> 0;
    h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
    return (h ^ (h >>> 16)) / 4294967296;
}

/** Smooth value noise, tiling at `period` cells. */
function noise(x, y, period, seed) {
    const xi = Math.floor(x), yi = Math.floor(y), tx = x - xi, ty = y - yi;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const at = (a, b) => hash2(((a % period) + period) % period, ((b % period) + period) % period, seed);
    return (at(xi, yi) * (1 - sx) + at(xi + 1, yi) * sx) * (1 - sy) + (at(xi, yi + 1) * (1 - sx) + at(xi + 1, yi + 1) * sx) * sy;
}

function fbm(u, v, seed) {
    let sum = 0, amp = 0.5, freq = 4;
    for (let o = 0; o < 4; o++) { sum += amp * noise(u * freq, v * freq, freq, seed + o); amp *= 0.5; freq *= 2; }
    return sum;
}

function png(size, pixel) {
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0;
        for (let x = 0; x < size; x++) {
            const [r, g, b, a = 255] = pixel(x / size, y / size);
            const o = y * (size * 4 + 1) + 1 + x * 4;
            raw[o] = clamp8(r); raw[o + 1] = clamp8(g); raw[o + 2] = clamp8(b); raw[o + 3] = clamp8(a);
        }
    }
    const chunk = (type, data) => {
        const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
    header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
    ]);
}
const clamp8 = v => Math.max(0, Math.min(255, Math.round(v)));
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buffer) { let c = 0xffffffff; for (const b of buffer) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/**
 * A painted metal can: base paint, a band of colour round it, stencilled marks, chips worn
 * through to bright metal near the ends, and grime gathered low. Returns the colour map and the
 * glTF metal-rough map (G roughness, B metalness), which share the same chip mask so a chip is
 * both bright and shiny.
 */
function paintedMetal(seed, { paint, band, bandAt = [0.42, 0.58], stencil = true }) {
    const size = 128;
    const chip = (u, v) => {
        const edge = Math.min(v, 1 - v);
        const worn = fbm(u * 2, v * 2, seed + 11);
        return worn > 0.52 + edge * 1.6 ? 1 : 0;
    };
    const color = png(size, (u, v) => {
        const grime = fbm(u, v, seed + 3) * 0.35 + Math.max(0, v - 0.75) * 0.6;
        let c = paint;
        if (band && v > bandAt[0] && v < bandAt[1]) c = band;
        if (stencil && v > 0.2 && v < 0.34 && Math.floor(u * 24) % 3 !== 0 && (u * 4) % 1 < 0.6) c = [20, 20, 18];
        if (chip(u, v)) c = [168, 166, 158];
        const shade = 1 - grime * 0.45;
        return [c[0] * shade, c[1] * shade, c[2] * shade];
    });
    const orm = png(size, (u, v) => {
        const metal = chip(u, v);
        const rough = metal ? 0.32 : 0.55 + fbm(u, v, seed + 5) * 0.3;
        return [255, rough * 255, metal * 255];
    });
    return { color, orm };
}

function cardboard(seed) {
    const size = 128;
    const color = png(size, (u, v) => {
        const flute = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 22);
        const stain = fbm(u, v, seed) * 0.4;
        const k = 1 - flute * 0.06 - stain * 0.35;
        return [156 * k, 118 * k, 78 * k];
    });
    const orm = png(size, (u, v) => [255, (0.82 + fbm(u, v, seed + 1) * 0.15) * 255, 0]);
    return { color, orm };
}

function wood(seed) {
    const size = 64;
    const rnd = random(seed);
    const grain = Array.from({ length: 16 }, () => rnd());
    const color = png(size, (u, v) => {
        const ring = grain[Math.floor(u * 16)] * 0.25 + 0.5 + 0.5 * Math.sin((v * 30 + fbm(u, v, seed) * 6));
        const k = 0.75 + ring * 0.2;
        return [150 * k, 112 * k, 72 * k];
    });
    const orm = png(size, () => [255, 0.7 * 255, 0]);
    return { color, orm };
}

// ---- Geometry ---------------------------------------------------------------------------------

/** A can with a domed lid and a fuse cap on top, centred on its middle, standing on y. */
function can(radius, height, cap) {
    const body = new THREE.CylinderGeometry(radius, radius, height, 20, 1, false);
    const lid = new THREE.CylinderGeometry(radius * 0.82, radius, height * 0.08, 20, 1, false);
    lid.translate(0, height / 2 + height * 0.04, 0);
    const fuse = new THREE.CylinderGeometry(cap, cap, height * 0.16, 10, 1, false);
    fuse.translate(0, height / 2 + height * 0.16, 0);
    // The fuse lever: a thin strap down one side.
    const lever = new THREE.BoxGeometry(radius * 0.35, height * 0.75, radius * 0.12);
    lever.translate(0, height * 0.1, radius + radius * 0.06);
    return mergeGeometries([body, lid, fuse, lever].map(g => g.toNonIndexed()));
}

function bottle() {
    const profile = [[0, -0.105], [0.031, -0.105], [0.033, -0.095], [0.033, 0.035], [0.028, 0.06],
        [0.014, 0.08], [0.013, 0.095], [0.014, 0.1], [0.014, 0.105], [0, 0.105]]
        .map(([x, y]) => new THREE.Vector2(x, y));
    return new THREE.LatheGeometry(profile, 18);
}

/** A cloth that has fallen in a heap: a sheet with folds pushed into it. */
function crumpledSheet(w, h, seed) {
    const g = new THREE.PlaneGeometry(w, h, 14, 10);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i);
        const fold = Math.sin(x * 11 + seed) * 0.025 + Math.sin(y * 9 - x * 4) * 0.02 + (fbm(x / w + 0.5, y / h + 0.5, seed) - 0.5) * 0.05;
        p.setZ(i, fold);
    }
    g.computeVertexNormals();
    return g;
}

// ---- Document -----------------------------------------------------------------------------------

const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('props');

function texture(name, bytes) {
    return doc.createTexture(name).setMimeType('image/png').setImage(new Uint8Array(bytes));
}

function material(name, { color = [1, 1, 1, 1], metal = 0, rough = 1, maps = null, alpha = null }) {
    const m = doc.createMaterial(name).setBaseColorFactor(color).setMetallicFactor(metal).setRoughnessFactor(rough);
    if (maps) {
        m.setBaseColorTexture(texture(`${name}-color`, maps.color));
        m.setMetallicRoughnessTexture(texture(`${name}-orm`, maps.orm));
    }
    if (alpha !== null) m.setAlphaMode('BLEND');
    return m;
}

function mesh(name, geometry, mat) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    g.computeVertexNormals();
    const accessor = (attr, type) => doc.createAccessor().setType(type).setArray(new Float32Array(attr.array)).setBuffer(buffer);
    const prim = doc.createPrimitive()
        .setAttribute('POSITION', accessor(g.attributes.position, 'VEC3'))
        .setAttribute('NORMAL', accessor(g.attributes.normal, 'VEC3'))
        .setMaterial(mat);
    if (g.attributes.uv) prim.setAttribute('TEXCOORD_0', accessor(g.attributes.uv, 'VEC2'));
    const m = doc.createMesh(name).addPrimitive(prim);
    scene.addChild(doc.createNode(name).setMesh(m));
}

const gasPaint = paintedMetal(1, { paint: [74, 82, 58], band: [196, 162, 40] });
const bangPaint = paintedMetal(2, { paint: [34, 35, 38], band: [200, 200, 196], bandAt: [0.7, 0.76], stencil: false });

mesh('canister', can(0.032, 0.15, 0.011), material('canister', { metal: 1, rough: 1, maps: gasPaint }));
mesh('flashbang', can(0.024, 0.11, 0.009), material('flashbang', { metal: 1, rough: 1, maps: bangPaint }));
mesh('bottle', bottle(), material('bottle', { color: [0.62, 0.78, 0.86, 0.55], rough: 0.08, alpha: true }));

const board = new THREE.BoxGeometry(0.6, 0.42, 0.008);
mesh('placard', board, material('placard', { maps: cardboard(4) }));
const face = new THREE.PlaneGeometry(0.58, 0.4);
face.translate(0, 0, 0.0045);
mesh('placard-face', face, material('placard-face', { color: [0.93, 0.92, 0.88, 1], rough: 0.85 }));
const stick = new THREE.BoxGeometry(0.022, 0.75, 0.022);
stick.translate(0, -0.48, -0.016);
const woodMaps = wood(5);
mesh('placard-pole', stick, material('placard-pole', { maps: woodMaps }));
const pole = new THREE.CylinderGeometry(0.012, 0.012, 1.6, 8);
pole.rotateZ(Math.PI / 2);
mesh('flag-pole', pole, material('flag-pole', { maps: woodMaps }));
const cloth = crumpledSheet(0.9, 0.6, 6);
cloth.rotateX(-Math.PI / 2);
cloth.translate(0.45, 0.02, 0.2);
mesh('flag-cloth', cloth, material('flag-cloth', { color: [0.9, 0.9, 0.9, 1], rough: 0.9 }));

const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.encoder': await draco3d.createEncoderModule() });
await doc.transform(draco({ method: 'edgebreaker', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
mkdirSync(out, { recursive: true });
const glb = await io.writeBinary(doc);
writeFileSync(new URL('props.glb', out), glb);
console.log(`props.glb: ${(glb.byteLength / 1024).toFixed(1)} KB, ${scene.listChildren().length} props, Draco-compressed`);
