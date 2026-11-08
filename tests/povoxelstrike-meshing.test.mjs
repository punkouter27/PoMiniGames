import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../src/PoMiniGames.Client/wwwroot/js/povoxelstrike/greedymesh.js', import.meta.url), 'utf8');
const { greedyMesh } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('cached meshing preserves exact geometry, colours, stress tint and LOD while reducing reads', () => {
  const fixtures = [
    [1, '19df68cabf0a11b483421c1aca086b7022f85847aaed4af23b3272463414d623', 254430],
    [2, '719afcfecd8c7f26d5602aa32d937bbda906b97109826bf273f43399cd280072', 125292],
    [4, '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b', 18478],
  ];
  for (const [step, hash, previousReads] of fixtures) {
    let reads = 0;
    const mesh = greedyMesh({
      min: [3, 2, 1], max: [35, 34, 33], step,
      palette: [220, 170, 100, 255, 80, 150, 200, 255],
      offset: [19, 0, 17],
      tint: (x, y, z) => ((x + y + z) % 13) / 8,
      get: (x, y, z) => {
        reads++;
        if (x < 0 || y < 0 || z < 0 || x >= 40 || y >= 38 || z >= 37) return 0;
        return ((x * 13 + y * 7 + z * 3) % 17) < 12 ? 0 : 1 + ((x + y + z) % 2);
      },
    });
    assert.equal(createHash('sha256').update(JSON.stringify(mesh)).digest('hex'), hash);
    assert.ok(reads < previousReads / 3, `${step}: ${reads} reads exceeds the reduction target`);
  }
});

test('sampling cache is rebuilt after edits and respects empty regions and chunk neighbours', () => {
  let solid = true;
  const options = {
    min: [0, 0, 0], max: [1, 1, 1], palette: [255, 255, 255, 255],
    get: (x, y, z) => solid && x === 0 && y === 0 && z === 0 ? 1 : 0,
  };
  assert.equal(greedyMesh(options).positions.length, 6 * 6 * 3);
  solid = false;
  assert.equal(greedyMesh(options), null);
  options.get = () => 1;
  assert.equal(greedyMesh(options), null, 'neighbours hide every face, including chunk boundaries');
  assert.equal(greedyMesh({ ...options, max: [0, 1, 1] }), null);
});
