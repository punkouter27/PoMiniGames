import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const root = new URL('../src/PoMiniGames.Client/wwwroot/js/pobrawl/', import.meta.url);
const source = (name) => readFile(new URL(name, root), 'utf8');

async function loadVisuals() {
  let releases = 0;
  class Vector {
    constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(p) { return this.set(p.x, p.y, p.z); }
  }
  class Geometry {
    constructor() { this.attributes = {}; }
    copy() { return this; }
    dispose() { releases++; }
    setAttribute(key, value) { this.attributes[key] = value; }
  }
  class Attribute {
    constructor(array, size) { this.array = array; this.size = size; }
    setUsage() {}
    setXYZ(index, x, y, z) { this.array.set([x, y, z], index * this.size); }
    setXYZW(index, x, y, z, w) { this.array.set([x, y, z, w], index * this.size); }
  }
  class Material {
    constructor(options) { Object.assign(this, options); }
    dispose() { releases++; }
  }
  class Mesh {
    constructor(geometry, material) {
      this.geometry = geometry; this.material = material; this.position = new Vector(); this.rotation = {};
    }
  }
  class Group {
    constructor() { this.children = []; this.visible = true; }
    add(mesh) { this.children.push(mesh); }
  }
  const THREE = {
    Vector3: Vector, PlaneGeometry: Geometry, InstancedBufferGeometry: Geometry,
    ConeGeometry: Geometry, InstancedBufferAttribute: Attribute, ShaderMaterial: Material, Mesh, Group,
  };
  const text = (await source('ffaVisuals.js')).replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ THREE, Math, Number, Float32Array, Map, Set });
  const exports = vm.runInContext(`${text}\n({createFfaVisuals,visualPolicy,hookSurface})`, context);
  return { ...exports, get releases() { return releases; } };
}

test('FFA quality bounds real AO, AA, bloom and GPU budgets', async () => {
  const { visualPolicy } = await loadVisuals();
  const high = visualPolicy('high'), medium = visualPolicy('medium'), low = visualPolicy('low');
  assert.deepEqual([high.particles, medium.particles, low.particles], [256, 144, 64]);
  assert.deepEqual([high.samples, medium.samples, low.samples], [4, 2, 0]);
  assert.equal(high.ao, true); assert.equal(medium.ao, false); assert.equal(low.bloom, false);
  const slow = visualPolicy('high', true);
  assert.equal(slow.particles, 64); assert.equal(slow.ao, false); assert.equal(slow.bloom, false);
});

test('FFA pools saturate, expire on GPU time, clear for calm/rounds and dispose idempotently', async () => {
  const api = await loadVisuals();
  const scene = { children: [], add(mesh) { this.children.push(mesh); }, remove(mesh) {
    this.children.splice(this.children.indexOf(mesh), 1);
  } };
  const visuals = api.createFfaVisuals(scene, null, api.visualPolicy('high'));
  const event = { position: { x: 1, y: 1.4, z: 0 }, power: 1 };
  for (let i = 0; i < 1000; i++) visuals.impact(event);
  assert.equal(visuals.state.activeParticles, 256);
  assert.equal(visuals.state.activeRings, 12);
  assert.ok(visuals.pulse <= 0.55);
  visuals.configure(api.visualPolicy('low'));
  assert.equal(visuals.state.particleBudget, 64);
  assert.equal(visuals.state.activeParticles, 64);
  visuals.setReducedMotion(true);
  assert.equal(visuals.state.activeParticles, 0);
  assert.equal(visuals.state.activeRings, 0);
  assert.equal(visuals.state.haze, false);
  visuals.impact(event); assert.equal(visuals.pulse, 0);
  visuals.setReducedMotion(false); visuals.impact(event);
  for (let i = 0; i < 6; i++) visuals.update(0.1);
  assert.equal(visuals.state.activeParticles, 0);
  assert.equal(visuals.state.activeRings, 0);
  visuals.impact(event); visuals.resetRound();
  assert.equal(visuals.state.activeParticles, 0);
  visuals.dispose();
  const releases = api.releases;
  visuals.dispose(); assert.equal(api.releases, releases);
  assert.equal(scene.children.length, 0);
  assert.ok(releases >= 6);
});

test('FFA material hooks chain and restore without changing identities, geometry or KO visibility', async () => {
  const api = await loadVisuals();
  let chained = 0;
  const before = (shader) => { chained++; shader.uniforms.existing = { value: 7 }; };
  const material = { onBeforeCompile: before, customProgramCacheKey: () => 'existing',
    isMeshStandardMaterial: true, color: { identity: 'original' } };
  const originalColor = material.color;
  const uniforms = { ffaWear: { value: 0 }, ffaSweat: { value: 0 } };
  const restore = api.hookSurface(material, uniforms, 'skin');
  const shader = {
    uniforms: {}, vertexShader: 'void main() {\n#include <begin_vertex>\n}',
    fragmentShader: 'void main() {\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <opaque_fragment>\n}',
  };
  material.onBeforeCompile(shader);
  assert.equal(chained, 1); assert.equal(shader.uniforms.existing.value, 7);
  assert.equal(material.color, originalColor);
  assert.ok(shader.fragmentShader.includes('reflectedLight.directDiffuse'));
  assert.ok(shader.fragmentShader.includes('fwidth(vFfaLocal)'));
  assert.ok(shader.vertexShader.includes('vFfaLocal = position;'));
  assert.ok(!shader.vertexShader.includes('transformed +='));
  assert.ok(material.customProgramCacheKey().includes('existing|ffa'));
  restore(); assert.equal(material.onBeforeCompile, before);
  const scene = { add() {}, remove() {} };
  const visuals = api.createFfaVisuals(scene, null, api.visualPolicy());
  const rig = { root: { position: { x: 0, y: 0, z: 0 }, visible: true }, materials: { skinMat: material } };
  const fighter = { rig, alive: false };
  visuals.registerFighters([fighter, fighter]);
  assert.equal(visuals.state.registeredFighters, 1);
  visuals.impact({ position: { x: 0, y: 1, z: 0 }, target: fighter, power: 1 });
  visuals.update(0.1); visuals.resetRound();
  assert.equal(rig.root.visible, true);
  visuals.dispose(); assert.equal(material.onBeforeCompile, before);
});

test('FFA post uses resolved depth, eight AO taps, bounded half-res AO and a real bloom/FXAA stack', async () => {
  const post = await source('ffaPost.js');
  assert.match(post, /new THREE\.DepthTexture/);
  assert.match(post, /readBuffer\.depthTexture/);
  assert.match(post, /i < 8/);
  assert.match(post, /Math\.min\(0\.5, 640 \/ width, 360 \/ height\)/);
  assert.match(post, /new UnrealBloomPass/);
  assert.match(post, /new ShaderPass\(ffaFxaaShader\(\)\)/);
  assert.match(post, /samples === 0/);
  assert.match(post, /renderer\.capabilities\.maxSamples/);
  assert.doesNotMatch(post, /GTAOPass|SSAOPass|SSRPass|MeshNormalMaterial/);
});

test('FFA FXAA clamps ANGLE sample bias without mutating the shared Three shader', async () => {
  const post = await source('ffaPost.js');
  const functionSource = post.match(/export function ffaFxaaShader[\s\S]*?\n\}/)[0].replace('export ', '');
  const original = {
    fragmentShader: 'texture2D(tDiffuse, uv, -100.0); texture2D(tDiffuse, nextUV, -100.0);',
    vertexShader: 'unchanged', uniforms: { resolution: { value: 1 } },
  };
  const context = vm.createContext({ FXAAShader: original });
  const fixed = vm.runInContext(`${functionSource}\nffaFxaaShader()`, context);
  assert.equal(fixed.fragmentShader,
    'texture2D(tDiffuse, uv, -16.0); texture2D(tDiffuse, nextUV, -16.0);');
  assert.match(original.fragmentShader, /-100\.0/);
  assert.equal(fixed.vertexShader, original.vertexShader);
  assert.equal(fixed.uniforms, original.uniforms);
});
