import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// PoCapitol's rigged figure: rig.js builds it, scripts/pocapitol-figure.mjs writes the glb.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const { BONES, REGIONS, buildFigure, toGlb } = await import(new URL('js/pocapitol/rig.js', client));
const figure = buildFigure();

test('committed figure.glb matches rig.js (run scripts/pocapitol-figure.mjs after editing the rig)', () => {
    const disk = readFileSync(new URL('models/pocapitol/figure.glb', client));
    assert.deepEqual(Buffer.from(toGlb(figure)), disk);
});

test('glb is a valid binary glTF with one skin over every bone and one material per region', () => {
    const glb = toGlb(figure), view = new DataView(glb.buffer);
    assert.equal(view.getUint32(0, true), 0x46546c67);
    assert.equal(view.getUint32(8, true), glb.length);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
    assert.equal(json.skins[0].joints.length, BONES.length);
    assert.deepEqual(json.materials.map(m => m.name), REGIONS);
    assert.equal(json.meshes[0].primitives.length, REGIONS.length);
    const bin = view.getUint32(20 + jsonLength, true);
    assert.equal(bin % 4, 0);
    assert.equal(json.buffers[0].byteLength, bin);
    for (const v of json.bufferViews) assert.ok(v.byteOffset + v.byteLength <= bin && v.byteOffset % 4 === 0);
});

test('skin weights are normalised, joints exist, and the figure stays low-poly', () => {
    let vertices = 0, triangles = 0;
    for (const r of figure.regions) {
        const count = r.positions.length / 3;
        vertices += count; triangles += r.indices.length / 3;
        for (let i = 0; i < count; i++) {
            const sum = r.weights[i * 4] + r.weights[i * 4 + 1] + r.weights[i * 4 + 2] + r.weights[i * 4 + 3];
            assert.ok(Math.abs(sum - 1) < 1e-5, `${r.name} vertex ${i} weights sum to ${sum}`);
            for (let k = 0; k < 4; k++) assert.ok(r.joints[i * 4 + k] < BONES.length);
        }
        for (const index of r.indices) assert.ok(index < count);
    }
    assert.ok(vertices < 1000 && triangles < 1800, `${vertices} vertices, ${triangles} triangles`);
    for (const bone of BONES) assert.ok(bone.parent === null || BONES.some(b => b.name === bone.parent));
});

test('surfaces face outward: coat from the spine, head from its centre', () => {
    const outward = (name, centre) => {
        const r = figure.regions.find(x => x.name === name);
        let good = 0, total = 0;
        for (let i = 0; i < r.positions.length / 3; i++) {
            const p = [r.positions[i * 3], r.positions[i * 3 + 1], r.positions[i * 3 + 2]], c = centre(p);
            const d = (p[0] - c[0]) * r.normals[i * 3] + (p[1] - c[1]) * r.normals[i * 3 + 1] + (p[2] - c[2]) * r.normals[i * 3 + 2];
            total++; if (d > 0) good++;
        }
        return good / total;
    };
    assert.ok(outward('coat', p => [0, p[1], 0]) > 0.9);
    assert.ok(outward('skin', p => p[1] > 1.6 ? [0, 1.83, 0] : [0, p[1], 0]) > 0.9);
    assert.ok(outward('pants', p => [Math.sign(p[0]) * 0.168, p[1], 0]) > 0.9);
});
