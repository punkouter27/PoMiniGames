// pocabinet/sky.js
//
// Sky dome for PoCabinet: a camera-following inverted sphere with a gradient, sun
// and drifting fbm clouds (greyed and thickened in rain). Daytime only: no
// stars, city glow or searchlights. Replaces the flat scene.background colour.
//
// The horizon colour is read from scene.fog every frame, so whatever the fog
// becomes (environment.js greys it in rain) the ground fades into the sky
// with no seam. Written at the far plane (z = w) and drawn first.

import * as THREE from './three.js';
import {
    uniform, varying, positionLocal, modelViewMatrix, cameraProjectionMatrix, vec2, vec3, vec4, float, fract, floor, dot, mix, pow,
    smoothstep, normalize, max, step, clamp,
} from 'three-eco/tsl';

// The circuit's look. Directions are world space (y up). The DirectionalLight in
// scene.js follows `sun`, clamped high enough to keep the road lit.
// Daytime: a low-sun dusk or a night makes the race hard to read.
const PRESET = {
    zenith: '#3a78c8', sun: [-0.45, 0.66, -0.6], sunColor: '#fff1d6', sunSize: 1.2,
    clouds: 0.3, cloudColor: '#ffffff',
};

// The dome as a TSL node material (r186). One node graph for every Sky: the values are the
// uniform nodes held in `material.uniforms` (same names and `.value` access the GLSL version had).
function skyMaterial(p, baseZenith) {
    const U = {
        uZenith: uniform(baseZenith.clone()), uHorizon: uniform(new THREE.Color('#14233f')),
        uSunDir: uniform(new THREE.Vector3(...p.sun).normalize()), uSunColor: uniform(new THREE.Color(p.sunColor)),
        uSunSize: uniform(p.sunSize), uCloud: uniform(p.clouds), uCloudColor: uniform(new THREE.Color(p.cloudColor)),
        uTime: uniform(0), uRain: uniform(0),
    };
    const hash12 = (p2) => {
        let p3 = fract(vec3(p2.x, p2.y, p2.x).mul(0.1031));
        p3 = p3.add(dot(p3, p3.yzx.add(33.33)));
        return fract(p3.x.add(p3.y).mul(p3.z));
    };
    const vnoise = (p2) => {
        const i = floor(p2), f = fract(p2);
        const u = f.mul(f).mul(float(3).sub(f.mul(2)));
        return mix(mix(hash12(i), hash12(i.add(vec2(1, 0))), u.x), mix(hash12(i.add(vec2(0, 1))), hash12(i.add(vec2(1, 1))), u.x), u.y);
    };
    const fbm = (p2) => {
        let s = float(0), a = 0.5, q = p2;
        for (let k = 0; k < 4; k++) { s = s.add(vnoise(q).mul(a)); q = q.mul(2.03).add(17.1); a *= 0.5; }
        return s;
    };
    const d = normalize(varying(positionLocal, 'vSkyDir'));
    const h = d.y;
    const up = pow(smoothstep(-0.02, 0.65, h), 0.65);
    const zen = mix(U.uZenith, vec3(dot(U.uZenith, vec3(0.33))).mul(1.4), U.uRain.mul(0.6));
    let col = mix(U.uHorizon, zen, up);
    const day = float(1).sub(U.uRain.mul(0.85));
    const s = max(dot(d, normalize(U.uSunDir)), 0);
    col = col.add(U.uSunColor.mul(pow(s, float(1400).div(max(U.uSunSize, 0.01))).mul(5).add(pow(s, 14).mul(0.3))).mul(day).mul(step(0.01, U.uSunSize)));
    col = col.add(U.uSunColor.mul(pow(s, 3)).mul(0.18).mul(float(1).sub(up)).mul(day));
    // Clouds: fbm on a plane overhead.
    const cp = d.xz.div(h.add(0.12)).mul(0.9).add(U.uTime.mul(vec2(0.011, 0.004)));
    const n = fbm(cp.mul(1.6));
    const cover = clamp(U.uCloud.add(U.uRain.mul(0.55)), 0, 0.95);
    const c = smoothstep(float(1).sub(cover), float(1).sub(cover).add(0.32), n).mul(smoothstep(0, 0.22, h)).mul(step(0, h));
    let lit = mix(U.uCloudColor.mul(0.55), U.uCloudColor.mul(1.1), smoothstep(0.3, 1, n));
    lit = lit.add(U.uSunColor.mul(pow(s, 6)).mul(0.4).mul(day));
    lit = mix(lit, vec3(0.28, 0.3, 0.33), U.uRain.mul(0.7));
    col = mix(col, lit, c.mul(0.88));
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    m.colorNode = col;                     // linear; the renderer's output transform encodes it (was <colorspace_fragment>)
    // Written at the far plane (z = w), like the GLSL's gl_Position = p.xyww.
    const clip = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(positionLocal, 1));
    m.vertexNode = vec4(clip.x, clip.y, clip.w, clip.w);
    m.uniforms = U;
    return m;
}

export class Sky {
    constructor() {
        const p = PRESET;
        this.preset = p;
        this.baseZenith = new THREE.Color(p.zenith);
        this.material = skyMaterial(p, this.baseZenith);
        this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), this.material);
        this.mesh.name = 'pocabinet-sky';
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = -1000;
    }

    /** World-space direction the DirectionalLight should shine from. */
    lightDirection() {
        const d = new THREE.Vector3(...this.preset.sun).normalize();
        d.y = Math.max(d.y, 0.6);
        return d.normalize();
    }

    setRain(rain) {
        this.material.uniforms.uRain.value = rain ? 1 : 0;
    }

    update(camera, fog, timeSeconds) {
        this.mesh.position.copy(camera.position);
        if (camera.parent && camera.parent.isObject3D && camera.parent.type !== 'Scene') {
            camera.getWorldPosition(this.mesh.position);
        }
        if (fog) this.material.uniforms.uHorizon.value.copy(fog.color);
        this.material.uniforms.uTime.value = timeSeconds % 10000;
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}
