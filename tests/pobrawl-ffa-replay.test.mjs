import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

class Position {
  constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  toArray(a, i) { a[i] = this.x; a[i + 1] = this.y; a[i + 2] = this.z; }
  fromArray(a, i) { this.x = a[i]; this.y = a[i + 1]; this.z = a[i + 2]; }
}
class Quaternion {
  constructor() { this.values = [0, 0, 0, 1]; }
  toArray(a, i) { this.values.forEach((v, n) => { a[i + n] = v; }); }
  fromArray(a, i) { this.values = Array.from(a.slice(i, i + 4)); return this; }
  clone() { const q = new Quaternion(); q.values = [...this.values]; return q; }
  slerp() {}
}
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../src/PoMiniGames.Client/wwwroot/js/pobrawl/ffaReplay.js', import.meta.url), 'utf8')
  .replace('export class', 'class'), context);
const Replay = vm.runInContext('FfaReplay', context);
const node = () => ({ position: new Position(), quaternion: new Quaternion() });

test('replay is bounded, plays at half speed, interpolates and restores the actual final pose', () => {
  const root = node(), hips = node();
  const replay = new Replay([{ rig: { root, joints: { hips } } }]);
  assert.equal(replay.begin(), false);
  for (let i = 0; i < 300; i++) {
    root.position.x = i;
    hips.position.y = i / 10;
    replay.capture(1 / 30);
  }
  assert.equal(replay.frames.length, 90);
  root.position.x = 999;
  assert.equal(replay.begin(), true);
  const first = replay.frames[0].time;
  replay.update(1 / 30);
  assert.ok(Math.abs(replay.time - first - 1 / 60) < 1e-8);
  assert.ok(Math.abs(root.position.x - 210.5) < 1e-5);
  assert.ok(Math.abs(hips.position.y - 21.05) < 1e-4);
  let seconds = 1 / 30;
  while (replay.update(1 / 30)) seconds += 1 / 30;
  assert.ok(seconds > 5.8 && seconds < 6.1);
  replay.restore();
  assert.equal(root.position.x, 999);
  replay.reset();
  assert.equal(replay.frames.length, 0);
  replay.dispose();
  assert.equal(replay.nodes.length, 0);
});
