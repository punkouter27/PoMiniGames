import { bootRace } from './harness.mjs';
import * as THREE from 'three';
const g = await bootRace(3, 1);
const v = new THREE.Vector3();
for (let s = 2840; s <= 3030; s += 10) { g.track.centerAt(s, v); console.log(s, [v.x, v.y, v.z].map(Math.round), 'hw', g.track.halfWidthAt ? g.track.halfWidthAt(s)?.toFixed?.(0) : ''); }
const names = new Set(); g.track.group.traverse((o) => { if (o.isMesh) names.add(o.name); }); console.log([...names].filter((n) => /Track|Bowl|Bump/.test(n)).join(' '));
process.exit(0);
