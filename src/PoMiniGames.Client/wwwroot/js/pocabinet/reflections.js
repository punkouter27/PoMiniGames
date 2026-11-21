// pocabinet/reflections.js
//
// Wet-road tail-light reflections for the frames without screen-space reflections: the 'low'
// quality tier (postfx.js runs no SSR there) and a scene with no post pass at all. On medium
// and high the SSR pass already mirrors the tail lights in the wet asphalt, so this stays
// hidden; it also hides whenever the road is dry. Both are read live each frame (the scene's
// tier steps down mid-race, the weather can change mid-race).
//
// What a camera sees on wet tarmac: each light smeared into a long streak running from under
// it toward the viewer, broken into shimmering bands by the rain. One instanced quad per light,
// aimed in the vertex shader (no per-frame matrix work): every car's tail lights, brighter
// under braking (the game is always day, so there are no lamp or headlight sources).
// Additive over the road, depth-tested so cars occlude it. Render-only: it reads the poses
// race.js already drew. Each streak lies on the road under its car (the car's own height:
// hills and banking), not at sea level.

import * as THREE from './three.js';
import {
    uniform, varying, instancedBufferAttribute, positionGeometry, cameraProjectionMatrix, cameraViewMatrix, vec2, vec4, float,
    length, max, min, clamp, smoothstep, exp, sin, select,
} from 'three-eco/tsl';

const MAX = 32;
const TAIL = new THREE.Color('#ff2a18');
const TAILS = [new THREE.Vector3(-1.9, 0.56, 0.56), new THREE.Vector3(-1.9, 0.56, -0.56)];

/**
 * The streak material as a TSL node material (r186). The per-light attributes are the instanced
 * buffers on the geometry (aLight: world x, z, height, intensity; aColor; aGround). One graph, so
 * one program; `uniforms` keeps the old names (`uCam`, `uTime`) as uniform nodes with `.value`.
 */
function streakMaterial(light, color, ground) {
    const U = { uCam: uniform(new THREE.Vector3()), uTime: uniform(0) };
    const aLight = instancedBufferAttribute(light), aColor = instancedBufferAttribute(color), aGround = instancedBufferAttribute(ground);
    const q = positionGeometry.xy;
    const foot = aLight.xy;
    const toCam = U.uCam.xz.sub(foot);
    const dist = length(toCam);
    const dir = toCam.div(max(dist, 1e-3));
    const side = vec2(dir.y.negate(), dir.x);
    // The mirror image sits under the light; roughness smears it toward the eye,
    // longer for a higher light and a longer view across the wet.
    const len = clamp(aLight.z.mul(2.4).add(dist.mul(0.14)), 1, max(1, min(dist.mul(0.85), 28)));
    const width = aLight.z.mul(0.05).add(0.16);
    const p = foot.add(side.mul(q.x).mul(width)).add(dir.mul(q.y).mul(len));
    const vQ = varying(q, 'vWQ'), vColor = varying(aColor, 'vWColor');
    const vI = varying(aLight.w.mul(float(1).sub(smoothstep(55, 120, dist))), 'vWI');
    const across = exp(vQ.x.mul(vQ.x).mul(-3.2));
    const along = smoothstep(0, 0.06, vQ.y).mul(float(1).sub(vQ.y)).mul(float(1).sub(vQ.y));
    const band = sin(vQ.y.mul(42).sub(U.uTime.mul(5)).add(vQ.x.mul(2.5)).add(vColor.r.mul(9))).mul(0.4).add(0.6);
    const a = across.mul(along).mul(band).mul(vI);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    m.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(p.x, aGround.add(0.06), p.y, 1));
    m.colorNode = vColor.mul(a);
    m.opacityNode = select(a.lessThan(0.003), float(0), float(1));
    m.uniforms = U;
    return m;
}

export class WetReflections {
    /** @param sceneHandle scene.js SceneHandle */
    constructor(sceneHandle) {
        this.sh = sceneHandle;
        const quad = new THREE.InstancedBufferGeometry();
        quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
        quad.setIndex([0, 1, 2, 1, 3, 2]);
        this.light = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
        this.color = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
        this.ground = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
        quad.setAttribute('aLight', this.light);
        quad.setAttribute('aColor', this.color);
        quad.setAttribute('aGround', this.ground);
        quad.instanceCount = 0;
        this.geom = quad;
        this.material = streakMaterial(this.light, this.color, this.ground);
        this.mesh = new THREE.Mesh(quad, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 3;
        sceneHandle.scene.add(this.mesh);
        this._v = new THREE.Vector3();
        this.disposed = false;
    }

    /**
     * @param timeSeconds  animation clock
     * @param cars         cars.js handles (group transform, braking flag)
     */
    update(timeSeconds, cars) {
        if (this.disposed) return;
        const sh = this.sh;
        const on = !!sh.raining && (sh.quality === 'low' || !sh.post);
        this.mesh.visible = on;
        if (!on) return;
        const L = this.light.array, C = this.color.array, G = this.ground.array;
        let n = 0;
        const put = (x, z, h, intensity, c, ground) => {
            if (n >= MAX || intensity <= 0.01) return;
            L[n * 4] = x; L[n * 4 + 1] = z; L[n * 4 + 2] = h; L[n * 4 + 3] = intensity;
            G[n] = ground;
            C[n * 3] = c.r; C[n * 3 + 1] = c.g; C[n * 3 + 2] = c.b;
            n++;
        };
        for (const car of cars) {
            if (!car || car.disposed || !car.group.visible) continue;
            car.group.updateMatrixWorld();
            const tail = car.braking ? 0.85 : 0.35;
            for (const p of TAILS) {
                const w = this._v.copy(p).applyMatrix4(car.group.matrixWorld);
                put(w.x, w.z, 0.56, tail, TAIL, car.group.position.y);
            }
        }
        this.geom.instanceCount = n;
        this.light.needsUpdate = true;
        this.color.needsUpdate = true;
        this.ground.needsUpdate = true;
        this.material.uniforms.uCam.value.copy(this.sh.camera.position);
        this.material.uniforms.uTime.value = timeSeconds % 1000;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.mesh.parent?.remove(this.mesh);
        this.geom.dispose();
        this.material.dispose();
    }
}
