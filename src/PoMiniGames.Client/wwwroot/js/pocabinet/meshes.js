// pocabinet/meshes.js
//
// The track's own geometry, built from track.js samples: the road and run-off ribbons (on the
// road's plane, banked), the barrier walls exactly where physics.js stops a car, the flat ground,
// the chequered start line, and their small helpers. Split out of scene.js; render-only.

import * as THREE from 'three';
import { WORLD_SCALE, roadPlane, canvasTexture } from './util.js';

export function hex(value, fallback) {
    try { return new THREE.Color(value || fallback); } catch { return new THREE.Color(fallback); }
}

/** Free every geometry and material under `root` (textures are the caller's). */
export function disposeObject(root) {
    root.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        for (const m of [o.material].flat()) m?.dispose();
    });
}

export function scaleUv(geom, su, sv) {
    const uv = geom.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    uv.needsUpdate = true;
}

/**
 * The road surface's normal at sample `k` (world space): tilted back by the grade and
 * across by the bank. Straight up on a flat track.
 */
export function roadNormal(track, k, out) {
    const n = track.count;
    const p = (k - 1 + n) % n, q = (k + 1) % n;
    const span = track.segLen[p] + track.segLen[k];
    const g = track.z && span > 1e-9 ? (track.z[q] - track.z[p]) / span : 0;
    const b = track.bank ? track.bank[k] : 0;
    const tx = track.tx[k], ty = track.ty[k];
    // (lateral, bank) x (forward, grade), lateral = (-ty, tx).
    return out.set(b * ty - tx * g, 1, -ty * g - b * tx).normalize();
}

/**
 * A strip between two lateral offsets (sim units; numbers, or functions of the sample for a
 * road whose width changes), following the road's height and bank; uv = (lateral, distance)
 * / tile (sim units), or world xz / opts.worldTile (world units) for a surface that has to
 * meet the terrain's mapping. `pick(i)` chooses the segments to lay (default: everything
 * but the return link). Normals follow the road's slope, or point straight up (opts.flat).
 */
export function ribbon(track, fromLat, toLat, height, tile, pick = (i) => track.drawn(i), opts = {}) {
    const from = typeof fromLat === 'function' ? fromLat : () => fromLat;
    const to = typeof toLat === 'function' ? toLat : () => toLat;
    const positions = [], uvs = [], normals = [];
    const n = track.count;
    const nrm = new THREE.Vector3();
    for (let i = 0; i <= n; i++) {
        const k = i % n;
        const nx = -track.ty[k], ny = track.tx[k];
        const x = track.x[k], y = track.y[k];
        const a = from(k), b = to(k);
        const ax = (x + nx * a) / WORLD_SCALE, az = (y + ny * a) / WORLD_SCALE;
        const bx = (x + nx * b) / WORLD_SCALE, bz = (y + ny * b) / WORLD_SCALE;
        positions.push(ax, height + roadPlane(track, k, a) / WORLD_SCALE, az, bx, height + roadPlane(track, k, b) / WORLD_SCALE, bz);
        if (opts.worldTile) {
            uvs.push(ax / opts.worldTile, az / opts.worldTile, bx / opts.worldTile, bz / opts.worldTile);
        } else {
            const v = (i === n ? track.length : track.cum[k]) / tile;
            uvs.push(a / tile, v, b / tile, v);
        }
        if (opts.flat) nrm.set(0, 1, 0);
        else roadNormal(track, k, nrm);
        normals.push(nrm.x, nrm.y, nrm.z, nrm.x, nrm.y, nrm.z);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    const indices = [];
    for (let i = 0; i < n; i++) {
        if (!pick(i)) continue;
        const a0 = i * 2, a1 = i * 2 + 1, b0 = (i + 1) * 2, b1 = (i + 1) * 2 + 1;
        indices.push(a0, a1, b0, a1, b1, b0);
    }
    geom.setIndex(indices);
    return geom;
}

/** The Playground's lawn (and the fallback if the terrain fails): one flat plane past the fog. */
export function flatGround(world, material, reach, tile) {
    const minX = Number(world.minX) || 0, maxX = Number(world.maxX) || 0;
    const minY = Number(world.minY) || 0, maxY = Number(world.maxY) || 0;
    const w = (maxX - minX) / WORLD_SCALE + reach * 2, d = (maxY - minY) / WORLD_SCALE + reach * 2;
    const geom = new THREE.PlaneGeometry(w, d);
    geom.rotateX(-Math.PI / 2);
    scaleUv(geom, w / tile, d / tile);
    const ground = new THREE.Mesh(geom, material);
    ground.position.set((minX + maxX) / 2 / WORLD_SCALE, 0, (minY + maxY) / 2 / WORLD_SCALE);
    ground.receiveShadow = true;
    return ground;
}

/**
 * Barrier wall: inner face at `lateral` (a number, or a function of the sample), a top, and
 * an outer face `thick` sim units further out (on side `s`), standing on the road's plane
 * (height and bank) with its foot sunk below it so no slope of the ground opens a gap.
 * uv.x runs along the lap for the striped texture.
 *
 * Where the face would stand on another part of the road (the inside of a corner tighter than
 * the wall's offset, or a stretch whose run-off reaches a neighbouring one), that piece is not
 * drawn: the physics measures its wall from the nearest point of the road, so there is no wall
 * there, and cars used to drive straight through one standing across the track.
 */
export function barrier(track, lateral, s, height, thick) {
    const lat = typeof lateral === 'function' ? lateral : () => lateral;
    const positions = [], uvs = [];
    const n = track.count;
    const onRoad = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
        const face = lat(k);
        const pr = track.project(track.x[k] - track.ty[k] * face, track.y[k] + track.tx[k] * face, -1);
        if (Math.abs(pr.lateral) < track.hwAt(pr.index) + 1) onRoad[k] = 1;
    }
    const rows = [[0, -0.3], [0, height], [s * thick, height], [s * thick, -1.2]];
    const vs = [0, 0.8, 0.9, 1];
    for (let i = 0; i <= n; i++) {
        const k = i % n;
        const nx = -track.ty[k], ny = track.tx[k];
        const u = (i === n ? track.length : track.cum[k]) / 80;
        const face = lat(k);
        // The top follows the plane at the face, so the wall stands level across its thickness.
        const base = roadPlane(track, k, face) / WORLD_SCALE;
        rows.forEach(([dl, h], r) => {
            const l = face + dl;
            positions.push((track.x[k] + nx * l) / WORLD_SCALE, base + h, (track.y[k] + ny * l) / WORLD_SCALE);
            uvs.push(u, vs[r]);
        });
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    const idx = [];
    for (let i = 0; i < n; i++) {
        if (onRoad[i] || onRoad[(i + 1) % n]) continue;
        for (let r = 0; r < 3; r++) {
            const a0 = i * 4 + r, a1 = i * 4 + r + 1, b0 = (i + 1) * 4 + r, b1 = (i + 1) * 4 + r + 1;
            idx.push(a0, a1, b0, a1, b1, b0);
        }
    }
    geom.setIndex(idx);
    geom.computeVertexNormals();
    return geom;
}

export const barrierTextures = new Map();

export function barrierTexture(accentHex) {
    const key = accentHex || '#c6a35a';
    if (barrierTextures.has(key)) return barrierTextures.get(key);
    const tex = canvasTexture(256, 64, (g) => {
        for (let i = 0; i < 4; i++) {
            g.fillStyle = i % 2 ? '#e9e6df' : key;
            g.fillRect(i * 64, 0, 64, 52);
        }
        g.fillStyle = '#3a3c40';
        g.fillRect(0, 52, 256, 12);
        g.fillStyle = 'rgba(0,0,0,0.18)';
        g.fillRect(0, 0, 256, 4);
    }, { repeat: 's', anisotropy: 8 });
    barrierTextures.set(key, tex);
    return tex;
}

/** Chequered strip across the road where a lap ends: distance 0 on a circuit, the finish of a point-to-point run. */
export function startLine(track) {
    const group = new THREE.Group();
    const p = track.pointAt(track.lapLength);
    const y0 = 0.035 + track.heightAt(track.lapLength) / WORLD_SCALE;
    const bank = track.bankAt(track.lapLength);
    const cols = 12, rows = 2, hw = track.hw[track.indexAt(track.lapLength)];
    const cell = (hw * 2) / cols;
    const geom = new THREE.PlaneGeometry(cell / WORLD_SCALE, cell / WORLD_SCALE);
    geom.rotateX(-Math.PI / 2);
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.55 });
    const black = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const lat = -hw + cell * (c + 0.5);
            const fwd = (r - 0.5) * cell;
            const m = new THREE.Mesh(geom, (r + c) % 2 === 0 ? white : black);
            m.position.set(
                (p.x + -p.ty * lat + p.tx * fwd) / WORLD_SCALE,
                y0 + bank * lat / WORLD_SCALE,
                (p.y + p.tx * lat + p.ty * fwd) / WORLD_SCALE);
            m.rotation.y = -Math.atan2(p.ty, p.tx);
            m.receiveShadow = true;
            group.add(m);
        }
    }
    return group;
}
