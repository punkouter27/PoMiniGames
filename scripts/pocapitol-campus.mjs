#!/usr/bin/env node
/**
 * Writes the OpenStreetMap footprint layer for PoCapitol's campus.
 *
 * The game ships a hand-built Capitol grounds and a stylized ring of landmarks. This script
 * adds the real building footprints of Capitol Hill around them, pulled once from the
 * Overpass API and committed as `wwwroot/data/pocapitol/campus-osm.json`, so nothing is
 * fetched at runtime and the file is precached by the service worker.
 *
 * Data © OpenStreetMap contributors, available under the Open Database Licence (ODbL).
 * Re-run after a map update, or when the bounding box changes:
 *
 *   node scripts/pocapitol-campus.mjs
 *
 * Nothing in the scenario rules depends on this file: if it is missing the hand-built campus
 * still renders exactly as it did before.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(HERE, '../src/PoMiniGames.Client/wwwroot/data/pocapitol/campus-osm.json');

const CAPITOL = { lat: 38.889939, lon: -77.009051 };
const METRES_PER_DEG_LAT = 111132;
const METRES_PER_DEG_LON = 111320 * Math.cos(CAPITOL.lat * Math.PI / 180);
// The scene squeezes a real mile into ~169 m (the Washington Monument sits at 238 m for
// 1.41 mi), so footprints use the same compression to land on the same bearings.
const SCENE_SCALE = 0.105;
const BBOX = { south: 38.8680, west: -77.0480, north: 38.9080, east: -76.9900 };
const MIN_AREA = 2;      // scene m², about 180 real m²: skip sheds and kiosks
const MAX_BUILDINGS = 700;
const NEAR_CLEAR = 150;  // inside this the hand-built grounds already own the ground
const FAR = 520;         // beyond this is outside the render distance
const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
];

const QUERY = `[out:json][timeout:120];
way["building"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
out geom;`;

const project = (lat, lon) => ({
    x: -(lat - CAPITOL.lat) * METRES_PER_DEG_LAT * SCENE_SCALE,
    z: -(lon - CAPITOL.lon) * METRES_PER_DEG_LON * SCENE_SCALE,
});

/** Longest-edge oriented box: a better fit than an axis-aligned one for the row houses. */
function orientedBox(points) {
    let longest = 0, angle = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length > longest) { longest = length; angle = Math.atan2(b.z - a.z, b.x - a.x); }
    }
    const cos = Math.cos(-angle), sin = Math.sin(-angle);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of points) {
        const u = p.x * cos - p.z * sin;
        const v = p.x * sin + p.z * cos;
        minU = Math.min(minU, u); maxU = Math.max(maxU, u);
        minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
    return {
        x: cu * cos + cv * sin,
        z: -cu * sin + cv * cos,
        w: Math.max(1, maxU - minU),
        d: Math.max(1, maxV - minV),
        rot: angle,
    };
}

async function fetchOverpass() {
    let lastError = null;
    for (const endpoint of ENDPOINTS) {
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'PoMiniGames-campus-builder/1.0 (Capitol Hill footprint cache)',
                },
                body: new URLSearchParams({ data: QUERY }),
            });
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
            return await response.json();
        } catch (error) {
            lastError = error;
            console.warn(`Overpass endpoint failed: ${endpoint} — ${error.message}`);
        }
    }
    throw lastError ?? new Error('No Overpass endpoint answered.');
}

const data = await fetchOverpass();
const buildings = [];
for (const way of data.elements ?? []) {
    if (way.type !== 'way' || !Array.isArray(way.geometry) || way.geometry.length < 4) continue;
    const tags = way.tags ?? {};
    if (tags.building === 'no' || tags.building === 'roof') continue;
    const points = way.geometry.map(node => project(node.lat, node.lon));
    const box = orientedBox(points);
    const distance = Math.hypot(box.x, box.z);
    if (distance < NEAR_CLEAR || Math.abs(box.x) > FAR || Math.abs(box.z) > FAR) continue;
    if (box.w * box.d < MIN_AREA) continue;
    const levels = Number.parseFloat(tags['building:levels']);
    const height = Number.parseFloat(tags.height);
    const h = Math.max(1.4, Math.min(9,
        Number.isFinite(height) ? height * SCENE_SCALE * 6 : Number.isFinite(levels) ? levels * 1.5 : 4.5));
    buildings.push({
        x: Math.round(box.x * 10) / 10,
        z: Math.round(box.z * 10) / 10,
        w: Math.round(box.w * 10) / 10,
        d: Math.round(box.d * 10) / 10,
        h: Math.round(h * 10) / 10,
        rot: Math.round(box.rot * 1000) / 1000,
        name: tags.name ?? '',
        distance,
    });
}

buildings.sort((a, b) => a.distance - b.distance);
const kept = buildings.slice(0, MAX_BUILDINGS)
    .sort((a, b) => a.x - b.x || a.z - b.z)
    .map(({ distance, ...rest }) => rest);

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, JSON.stringify({
    source: 'OpenStreetMap via Overpass API',
    attribution: '© OpenStreetMap contributors (ODbL)',
    generated: new Date().toISOString().slice(0, 10),
    sceneScale: SCENE_SCALE,
    bbox: BBOX,
    buildings: kept,
}, null, 0) + '\n');

console.log(`Wrote ${kept.length} footprints to ${OUTPUT}`);
