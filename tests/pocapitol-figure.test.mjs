import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// PoCapitol's rigged figure: rig.js builds it, scripts/pocapitol-figure.mjs writes the glb.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const rig = await import(new URL('js/pocapitol/rig.js', client));
const { BONES, REGIONS, buildFigure, toGlb } = rig;
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

test('builds are morph targets over the same vertices, and each does what its name says', () => {
    const { SHAPES } = rig;
    assert.deepEqual(figure.shapes, SHAPES);
    const glb = toGlb(figure), view = new DataView(glb.buffer);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + view.getUint32(12, true))));
    assert.deepEqual(json.meshes[0].extras.targetNames, SHAPES);
    for (const primitive of json.meshes[0].primitives) assert.equal(primitive.targets.length, SHAPES.length);
    for (const r of figure.regions) {
        assert.equal(r.shapes.length, SHAPES.length);
        for (const delta of r.shapes) assert.equal(delta.length, r.positions.length);
    }
    const coat = figure.regions.find(r => r.name === 'coat');
    const lowest = offsets => {
        let y = Infinity;
        for (let i = 1; i < coat.positions.length; i += 3) y = Math.min(y, coat.positions[i] + (offsets ? offsets[i] : 0));
        return y;
    };
    const widest = offsets => {
        let x = 0;
        for (let i = 0; i < coat.positions.length; i += 3) x = Math.max(x, coat.positions[i] + (offsets ? offsets[i] : 0));
        return x;
    };
    const shape = name => coat.shapes[SHAPES.indexOf(name)];
    // A jacket ends at the hip where the long coat runs to mid-thigh.
    assert.ok(lowest() < 0.62 && lowest(shape('jacket')) > 0.78, `${lowest()} / ${lowest(shape('jacket'))}`);
    assert.ok(widest(shape('bulk')) > widest() && widest(shape('heavy')) > widest() && widest(shape('slim')) < widest());
    // A build changes clothes and flesh, never the face's features.
    for (const name of ['eyes', 'brow', 'mouth']) {
        for (const delta of figure.regions.find(r => r.name === name).shapes) assert.ok(delta.every(v => v === 0), name);
    }
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
