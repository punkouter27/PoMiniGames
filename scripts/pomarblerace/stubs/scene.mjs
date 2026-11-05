// Headless stand-in for pomarblerace/scene.js: a real camera (the engine reads its position), the
// fields the engine reads, and no-ops for everything that draws.
import * as THREE from 'three';
import { noopProxy } from './noop.mjs';

export function createScene() {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.position.set(0, 50, -50);
  const root = new THREE.Scene();
  return noopProxy({
    camera,
    heavy: false,
    marbleEnv: null,
    renderer: { info: { render: { calls: 0, triangles: 0 }, memory: {} } },
    add: (o) => root.add(o),
    remove: (o) => root.remove(o),
    audioCue: () => null,
  });
}
