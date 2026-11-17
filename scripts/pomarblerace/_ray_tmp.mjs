import { bootRace } from './harness.mjs';
import * as CANNON from 'cannon-es';
const g = await bootRace(3, 1);
const ray = new CANNON.RaycastResult();
for (const [y, z] of [[-714.5, 237], [-716, 237], [-718, 237], [-714.5, 240], [-714.5, 235.5]]) {
  ray.reset();
  g.world.raycastClosest(new CANNON.Vec3(-80, y, z), new CANNON.Vec3(-110, y, z), { skipBackfaces: false, collisionFilterMask: -1 }, ray);
  console.log(y, z, ray.hasHit ? [ray.hitPointWorld.x.toFixed(2), 'n', ray.hitNormalWorld.x.toFixed(2), ray.hitNormalWorld.y.toFixed(2), ray.hitNormalWorld.z.toFixed(2), 'body', ray.body.id, ray.body.shapes[0].type, ray.body.material?.name] : 'none');
}
process.exit(0);
