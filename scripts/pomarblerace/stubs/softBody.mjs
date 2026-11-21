// Headless stand-in for platform/3d/softBody.js (the player's jelly shell is GPU compute, TSL and a
// WebGPU renderer, none of which the harness has). The shell is decoration: no physics reads it.
import { Object3D } from 'three';

export function createJellyShell() {
  return { mesh: new Object3D(), update() {}, dispose() {} };
}
