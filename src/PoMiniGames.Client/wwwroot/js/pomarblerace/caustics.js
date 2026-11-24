// caustics.js — glass-marble caustics (#13): the light a glass ball focuses onto the floor.
//
// A glass sphere is a ball lens. Under a low sun it throws a small, hot focal spot with a ring of
// split colour round it (glass bends blue more than red, so the ring fringes), plus filaments
// where the marble's inner swirl breaks the light up. That is drawn here as ONE instanced quad per
// marble with an additive TSL material: no extra lights, no render target, one draw call for all.
// director.js decides where each lands (down the key light's ray through the marble), how big and
// how bright; this only draws what it is handed.
//
// Per-instance data: the matrix (position on the floor, facing the floor's normal, spun with the
// marble's roll, scaled with the gap underneath) and the instance colour, which carries the tint
// and the brightness together (additive blending, so colour × strength is the light added).
import * as THREE from 'three-eco/webgpu';
import * as TSL from 'three-eco/tsl';

const Z = new THREE.Vector3(0, 0, 1);

export function createCaustics(scene, max = 4) {
  const { uv, vec3, float, length, atan, sin, exp, smoothstep, pow, max: tmax } = TSL;
  const p = uv().sub(0.5).mul(2);
  const r = length(p);
  const ang = atan(p.y, p.x);
  // Squared by multiplication: WGSL's pow() is undefined for a negative base.
  const gauss = (x) => exp(x.mul(x).negate());
  const ring = (radius, width) => gauss(r.sub(radius).div(width));
  // The chromatic ring: red outermost, blue innermost.
  const fringe = vec3(ring(0.62, 0.075), ring(0.57, 0.07), ring(0.52, 0.065)).mul(1.15);
  // The focal spot.
  const core = gauss(r.div(0.16)).mul(2.4);
  // Filaments: a few bright spokes inside the ring, which turn because the quad itself is spun.
  const spokes = pow(tmax(sin(ang.mul(7).add(r.mul(13))), float(0)), float(5)).mul(smoothstep(0.15, 0.6, r).oneMinus()).mul(0.55);
  const edge = smoothstep(0.72, 1.0, r).oneMinus();   // nothing reaches the quad's corners (edges ascending: reversed ones are undefined)
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  // The instance colour multiplies this (tint × strength), per marble.
  material.colorNode = vec3(core).add(fringe).add(vec3(spokes)).mul(edge);
  material.fog = false;
  material.toneMapped = true;

  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, max);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.count = 0;
  mesh.name = 'mr-caustics';
  scene.add(mesh);

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), spin = new THREE.Quaternion();
  const s3 = new THREE.Vector3(), col = new THREE.Color(), white = new THREE.Color(0xffffff);

  return {
    /** list: [{ pos, up, size, strength, color (hex), spin (rad) }], at most `max`. */
    update(list) {
      const n = Math.min(max, list.length);
      for (let i = 0; i < n; i++) {
        const e = list[i];
        q.setFromUnitVectors(Z, e.up);
        spin.setFromAxisAngle(Z, e.spin || 0);
        q.multiply(spin);
        s3.set(e.size, e.size, 1);
        m4.compose(e.pos, q, s3);
        mesh.setMatrixAt(i, m4);
        // Light through tinted glass keeps most of its white; the tint colours the fringe.
        col.setHex(e.color).lerp(white, 0.45).multiplyScalar(Math.max(0, e.strength) * 0.9);
        mesh.setColorAt(i, col);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    },
    dispose() {
      scene.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
