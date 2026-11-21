// pocabinet/grass.js
//
// Camera-riding grass: a fixed field of blades (one BufferGeometry, positions
// baked in a TILE-sized square) that the vertex shader wraps around the camera,
// so the lawn is infinite and costs one draw call. Built on MeshStandardMaterial
// via onBeforeCompile, so blades take the same sun, IBL, shadows and fog as the
// ground they grow from; normals point up so the two blend.
//
// A top-down mask (the road plus kerb band, rasterised once per track from the
// centerline at each sample's own width, and out to the barrier where the run-off is gravel
// or tarmac) keeps blades off the tarmac and the traps; a noise lookup makes it patchy;
// blades shrink out toward the tile edge so the wrap never shows. On a track with a terrain
// (terrain.js) each blade grows from the ground's height, read from its height texture.

import * as THREE from './three.js';
import {
    uniform, attribute, varying, texture, positionGeometry, cameraViewMatrix, vec2, vec3, vec4, float, mod, length, smoothstep, mix, sin, cos,
    normalize, select,
} from 'three-eco/tsl';
import { clock, noise } from './materials.js';
import { runOffAt, KERB_OUTER } from './physics.js';
import { WORLD_SCALE as WS, addHook } from './util.js';

const TILE = 44;
let grassSerial = 0;

function roadMask(track, margin, keepOut) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, widest = track.halfWidth;
    for (let i = 0; i < track.count; i++) {
        minX = Math.min(minX, track.x[i]); maxX = Math.max(maxX, track.x[i]);
        minY = Math.min(minY, track.y[i]); maxY = Math.max(maxY, track.y[i]);
        widest = Math.max(widest, track.hw[i]);
    }
    const pad = widest + margin + 80;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const S = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);
    const sx = S / (maxX - minX), sy = S / (maxY - minY);
    // The road at its own width each sample, plus the run-off out to the barrier where that is
    // gravel or tarmac (one quad per segment, so the width can change).
    {
        const n = track.count;
        const edge = (i, side) => track.hw[i] + (track.runoffAt(i, side) === 0 ? margin : runOffAt(track, i, side) + 3);
        const at = (i, lat) => [(track.x[i] - track.ty[i] * lat - minX) * sx, (track.y[i] + track.tx[i] * lat - minY) * sy];
        g.fillStyle = '#fff';
        for (let i = 0; i < n; i++) {
            if (!track.drawn(i)) continue;
            const j = (i + 1) % n;
            const p = [at(i, -edge(i, -1)), at(i, edge(i, 1)), at(j, edge(j, 1)), at(j, -edge(j, -1))];
            g.beginPath();
            g.moveTo(p[0][0], p[0][1]);
            for (let k = 1; k < 4; k++) g.lineTo(p[k][0], p[k][1]);
            g.closePath();
            g.fill();
        }
    }
    // No blades where a scan is the ground (the court).
    if (keepOut) {
        g.fillStyle = '#fff';
        g.beginPath();
        for (let i = 0; i < keepOut.length; i += 2) g.lineTo((keepOut[i] - minX) * sx, (keepOut[i + 1] - minY) * sy);
        g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return { tex, rect: new THREE.Vector4(minX / WS, minY / WS, (maxX - minX) / WS, (maxY - minY) / WS) };
}

function bladeGeometry(count) {
    const pos = new Float32Array(count * 5 * 3);
    const nrm = new Float32Array(count * 5 * 3);
    const off = new Float32Array(count * 5 * 2);
    const rnd = new Float32Array(count * 5 * 4);
    const idx = new Uint32Array(count * 9);
    const shape = [[-1, 0], [1, 0], [-0.6, 0.5], [0.6, 0.5], [0, 1]];
    let s = 1234567;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let b = 0; b < count; b++) {
        const ox = r() * TILE, oz = r() * TILE;
        const rr = [r(), r(), r(), r()];
        for (let v = 0; v < 5; v++) {
            const i = b * 5 + v;
            pos[i * 3] = shape[v][0]; pos[i * 3 + 1] = shape[v][1]; pos[i * 3 + 2] = 0;
            nrm[i * 3 + 1] = 1;
            off[i * 2] = ox; off[i * 2 + 1] = oz;
            rnd[i * 4] = rr[0]; rnd[i * 4 + 1] = rr[1]; rnd[i * 4 + 2] = rr[2]; rnd[i * 4 + 3] = rr[3];
        }
        const v0 = b * 5;
        idx.set([v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2, v0 + 2, v0 + 3, v0 + 4], b * 9);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geom.setAttribute('aOffset', new THREE.BufferAttribute(off, 2));
    geom.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4));
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    return geom;
}

export class Grass {
    /**
     * @param track  runtime track
     * @param color  base colour (the ground's)
     * @param count  blades in the tile (quality tier)
     * @param opts   { keepOut: optional sim ring [x0, y0, …] kept bare, like the road;
     *                 terrain: terrain.js (blades grow from its height) }
     */
    constructor(track, color, count, opts = {}) {
        const mask = roadMask(track, KERB_OUTER + 6, opts.keepOut);
        this.mask = mask.tex;
        const height = opts.terrain ? opts.terrain.heightTexture() : null;
        this.flatTex = height ? null : flatHeight();
        this.center = new THREE.Vector3();
        this.material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(color).multiplyScalar(1.15), roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
        });
        // One node graph for this lawn (r186): the old GLSL hook, as TSL. The blades' own tile-wrapped
        // placement, height, sway and culling run in the vertex stage (positionNode); the colour ramp
        // along the blade is the fragment's. Unique key: the uniforms below belong to THIS Grass.
        const U = {
            uCenter: uniform(this.center),
            uMaskRect: uniform(mask.rect),
            uHeightRect: uniform(height ? height.rect : new THREE.Vector4(0, 0, 1, 1)),
        };
        const maskTex = mask.tex, heightTex = height ? height.tex : this.flatTex, noiseTex = noise();
        addHook(this.material, 'pocabinet-grass:' + (grassSerial++), () => {
            const aOffset = attribute('aOffset', 'vec2'), aRand = attribute('aRand', 'vec4');
            const yaw = aRand.z.mul(6.2831853);
            const bdir = vec2(cos(yaw), sin(yaw));
            const T = float(TILE);
            const rel = mod(aOffset.sub(U.uCenter.xz).add(T.mul(0.5)), T).sub(T.mul(0.5));
            const root = U.uCenter.xz.add(rel);
            const fade = smoothstep(T.mul(0.3), T.mul(0.48), length(rel)).oneMinus();
            const road = texture(maskTex, root.sub(U.uMaskRect.xy).div(U.uMaskRect.zw), 0).r;
            const ground = texture(heightTex, root.sub(U.uHeightRect.xy).div(U.uHeightRect.zw), 0).r;
            const patchy = texture(noiseTex, root.mul(0.015), 0).r.add(aRand.y.mul(0.35));
            const h = float(0.28).add(aRand.x.mul(0.55)).mul(fade).mul(smoothstep(0.1, 0.6, road).oneMinus()).mul(smoothstep(0.42, 0.62, patchy));
            const t = positionGeometry.y;
            const gust = texture(noiseTex, root.mul(0.02).add(vec2(clock.mul(0.05), clock.mul(0.03))), 0).g;
            const sway = sin(clock.mul(1.9).add(root.x.mul(0.45)).add(root.y.mul(0.3))).mul(0.25).add(gust.sub(0.5).mul(0.9));
            const xz = root.add(bdir.mul(positionGeometry.x.mul(0.045).mul(float(1).sub(t.mul(0.85)))))
                .add(vec2(0.8, 0.45).mul(sway).add(vec2(bdir.y.negate(), bdir.x).mul(aRand.w.sub(0.5).mul(0.6))).mul(t.mul(t).mul(h).mul(0.55)));
            const pos = vec3(xz.x, ground.add(t.mul(h)), xz.y);
            // A culled blade (road, patch gap, tile edge) collapses to one point underground:
            // left at full width it lies flat as a sliver that shades into HDR fireflies.
            const culled = h.lessThan(0.03);
            const vBlade = varying(t, 'vGrassBlade');
            return {
                position: () => select(culled, vec3(root.x, ground.sub(1), root.y), pos),
                normal: () => normalize(cameraViewMatrix.transformDirection(vec3(bdir.y.mul(0.35), 1, bdir.x.mul(-0.35)))),
                color: (c) => {
                    let rgb = c.rgb.mul(mix(0.35, 1.25, vBlade));
                    rgb = mix(rgb, rgb.mul(vec3(1.15, 1.1, 0.7)), vBlade.mul(vBlade).mul(0.5));
                    return vec4(rgb, c.a);
                },
            };
        });
        this.mesh = new THREE.Mesh(bladeGeometry(count), this.material);
        this.mesh.name = 'pocabinet-grass';
        this.mesh.frustumCulled = false;
        this.mesh.receiveShadow = true;
    }

    /** Follow the camera (the wrap happens in the shader). */
    update(camera) {
        this.center.copy(camera.position);
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.dispose();
        this.mask.dispose();
        this.flatTex?.dispose();
    }
}

/** A 1 x 1 zero height: the flat lawn (the terrain's texture belongs to terrain.js). */
function flatHeight() {
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    t.needsUpdate = true;
    return t;
}
