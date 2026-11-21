// platform/3d/splats.js — Gaussian-splat backdrops on three r186 (WebGPURenderer / WebGL2 backend, TSL).
//
// WHY THIS EXISTS. PoCabinet drew its court scan through @mkkellogg/gaussian-splats-3d, which is
// pinned to three r165 + WebGLRenderer: its viewer owns raw GLSL ShaderMaterials patched by string
// replacement (pocabinet/models.js syncRoomSplat). None of that can render on a WebGPURenderer, so
// the splat was the thing blocking a r186 port. This module is the r186 replacement and is written
// for every game, not for the court: a game that wants a captured-scene backdrop calls loadSplat()
// and adds the returned object to its scene.
//
// WHAT IT DOES
//   • Parses .ksplat (the 0.1 format the court ships in, compression level 0/1/2, base colour only),
//     .splat (antimatter15, 32 B per splat) and .ply (3DGS: f_dc / opacity / scale_ / rot_).
//   • Bakes the placement matrix into the data once: centres to world, the 3D covariance
//     Sigma = A (R S S^T R^T) A^T as 6 floats. Nothing per frame touches the CPU copy of that.
//   • Three float data textures (position+opacity, covariance x2 with the colour packed into one float) read with textureLoad by a
//     per-instance index, so the same TSL graph runs on the WebGPU and the WebGL2 backend (no storage
//     buffers). One quad per splat, instanced; the material is ONE node graph, per-cloud values
//     (crop, fade, lift) are uniforms, so every cloud shares one compiled program.
//   • The vertex stage projects the covariance (Jacobian of the perspective map, the EWA splat of
//     Zwicker et al.), takes the 2x2 eigen axes, and the fragment evaluates exp(-d^2) on the quad.
//   • Back-to-front order comes from a Web Worker doing a 16-bit counting sort on view depth; the
//     sorted index list is the one instanced attribute. The worker is a Blob made from this file's
//     own function text (CSP allows blob workers, forbids eval) and re-sorts only when the view
//     direction/position moved enough, never more than one request in flight.
//   • Tier cap: `maxSplats` keeps an even stride of the file (a 400k scan becomes 100k on low) and
//     compensates the lost density by growing each kept gaussian a little.
//
// Alpha is NormalBlending, depthTest on, depthWrite off: the splat sits behind/among opaque meshes
// and blends correctly with the sorted order. Colours in the file are sRGB; `linear` (default on)
// converts to linear so the post/tone pass does not encode twice (the same fix models.js made).
//
// USAGE
//   import { loadSplat } from '../platform/3d/splats.js';
//   const cloud = await loadSplat(THREE, TSL, url, { matrix, maxSplats: 200000, crop, hide, onProgress });
//   scene.add(cloud.object); ... each frame: cloud.update(camera)   (optional: also auto-sorts in onBeforeRender)
//   cloud.dispose();
//
// `crop` = { x, z, hx, hz, fade }  drops splats outside the rectangle (world units) and fades the last
// `fade` units. `hide` = { floorY, scale, low, hoopAt, hoopReach, hoopHalf, cx, cz } drops everything
// higher than `low` metres over the floor except two hoop columns (PoCabinet's court). Both optional.

const TEX_W = 2048;

// ----------------------------------------------------------------------------------- parsing

/** half float (uint16) to number, no THREE needed (the worker/test path stays dependency free). */
function halfToFloat(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/**
 * Decode a .ksplat into flat arrays in the file's own frame:
 *   { count, pos: Float32Array(3n), scale: Float32Array(3n), quat: Float32Array(4n) (x,y,z,w), rgba: Uint8Array(4n) }
 * Layout per compression level (mkkellogg SplatBuffer): L0 floats; L1/L2 uint16 centres (bucketed) and
 * half-float scale/rotation; colour is always 4 bytes at ColorOffsetBytes.
 */
export function parseKSplat(buffer) {
    const u8 = new Uint8Array(buffer, 0, 4096);
    const h32 = new Uint32Array(buffer, 0, 1024), h16 = new Uint16Array(buffer, 0, 2048);
    if (u8[0] !== 0 || u8[1] < 1) throw new Error('ksplat: unsupported version ' + u8[0] + '.' + u8[1]);
    const maxSections = h32[1], sectionCount = h32[2], total = h32[4], level = h16[10];
    const LV = [
        { c: 12, s: 12, r: 16, col: 4, so: 12, ro: 24, co: 40, shb: 4, range: 1, sh: [44, 80, 140] },
        { c: 6, s: 6, r: 8, col: 4, so: 6, ro: 12, co: 20, shb: 2, range: 32767, sh: [24, 42, 72] },
        { c: 6, s: 6, r: 8, col: 4, so: 6, ro: 12, co: 20, shb: 1, range: 32767, sh: [24, 33, 48] },
    ][level];
    if (!LV) throw new Error('ksplat: bad compression level ' + level);
    const pos = new Float32Array(total * 3), scale = new Float32Array(total * 3);
    const quat = new Float32Array(total * 4), rgba = new Uint8Array(total * 4);
    let sectionBase = 4096 + maxSections * 1024, out = 0;
    for (let si = 0; si < maxSections; si++) {
        const hb = 4096 + si * 1024;
        const sh32 = new Uint32Array(buffer, hb, 256), sh16 = new Uint16Array(buffer, hb, 512), sf = new Float32Array(buffer, hb, 256);
        const maxCount = sh32[1], bucketSize = sh32[2], bucketCount = sh32[3];
        const blockSize = sf[4], bucketStorage = sh16[10];
        const range = sh32[6] || LV.range, fullBuckets = sh32[8], partial = sh32[9], shDegree = sh16[20];
        const bytesPerSplat = LV.sh[shDegree] ?? LV.sh[0];
        const metaBytes = partial * 4, bucketsBytes = bucketStorage * bucketCount + metaBytes;
        const dataBase = sectionBase + bucketsBytes;
        const bucketsBase = sectionBase + metaBytes;
        const buckets = level >= 1 ? new Float32Array(buffer, bucketsBase, bucketCount * 3) : null;
        const partialLens = level >= 1 && partial ? new Uint32Array(buffer, sectionBase, partial) : null;
        const sfac = (blockSize / 2) / range;
        const dv = new DataView(buffer);
        // bucket index of the first splat in every partial bucket
        let bucketOf = null;
        if (level >= 1) {
            bucketOf = new Uint32Array(maxCount);
            let at = 0;
            for (let b = 0; b < fullBuckets; b++) for (let k = 0; k < bucketSize && at < maxCount; k++) bucketOf[at++] = b;
            for (let p = 0; p < partial; p++) for (let k = 0; k < partialLens[p] && at < maxCount; k++) bucketOf[at++] = fullBuckets + p;
        }
        for (let i = 0; i < maxCount; i++, out++) {
            const o = dataBase + i * bytesPerSplat;
            if (level === 0) {
                for (let k = 0; k < 3; k++) { pos[out * 3 + k] = dv.getFloat32(o + k * 4, true); scale[out * 3 + k] = dv.getFloat32(o + LV.so + k * 4, true); }
                quat[out * 4] = dv.getFloat32(o + LV.ro + 4, true); quat[out * 4 + 1] = dv.getFloat32(o + LV.ro + 8, true);
                quat[out * 4 + 2] = dv.getFloat32(o + LV.ro + 12, true); quat[out * 4 + 3] = dv.getFloat32(o + LV.ro, true);
            } else {
                const b = bucketOf[i] * 3;
                for (let k = 0; k < 3; k++) {
                    pos[out * 3 + k] = (dv.getUint16(o + k * 2, true) - range) * sfac + buckets[b + k];
                    scale[out * 3 + k] = halfToFloat(dv.getUint16(o + LV.so + k * 2, true));
                }
                quat[out * 4] = halfToFloat(dv.getUint16(o + LV.ro + 2, true)); quat[out * 4 + 1] = halfToFloat(dv.getUint16(o + LV.ro + 4, true));
                quat[out * 4 + 2] = halfToFloat(dv.getUint16(o + LV.ro + 6, true)); quat[out * 4 + 3] = halfToFloat(dv.getUint16(o + LV.ro, true));
            }
            rgba.set(new Uint8Array(buffer, o + LV.co, 4), out * 4);
        }
        sectionBase += bytesPerSplat * maxCount + bucketsBytes;
        if (si + 1 >= Math.max(sectionCount, 1) && out >= total) break;
    }
    return { count: total, pos, scale, quat, rgba };
}

/** antimatter15 .splat: 32 B = pos f32x3, scale f32x3, rgba u8x4, rot u8x4 (w,x,y,z, (v-128)/128). */
export function parseSplat(buffer) {
    const n = Math.floor(buffer.byteLength / 32);
    const f = new Float32Array(buffer, 0, n * 8), b = new Uint8Array(buffer);
    const pos = new Float32Array(n * 3), scale = new Float32Array(n * 3), quat = new Float32Array(n * 4), rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        pos.set(f.subarray(i * 8, i * 8 + 3), i * 3);
        scale.set(f.subarray(i * 8 + 3, i * 8 + 6), i * 3);
        rgba.set(b.subarray(i * 32 + 24, i * 32 + 28), i * 4);
        const q = [0, 1, 2, 3].map((k) => (b[i * 32 + 28 + k] - 128) / 128);
        const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
        quat[i * 4] = q[1] / l; quat[i * 4 + 1] = q[2] / l; quat[i * 4 + 2] = q[3] / l; quat[i * 4 + 3] = q[0] / l;
    }
    return { count: n, pos, scale, quat, rgba };
}

/** 3DGS .ply (binary little endian): scales are log, opacity logit, colour SH degree 0. */
export function parsePly(buffer) {
    const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096)));
    const end = head.indexOf('end_header');
    if (end < 0 || !/binary_little_endian/.test(head)) throw new Error('ply: need a binary little-endian 3DGS file');
    const lines = head.slice(0, end).split('\n');
    const n = Number(lines.find((l) => l.startsWith('element vertex'))?.split(/\s+/)[2]);
    const sizes = { float: 4, float32: 4, double: 8, uchar: 1, uint8: 1, int: 4, uint: 4, short: 2, ushort: 2, char: 1 };
    const props = []; let stride = 0;
    for (const l of lines) {
        const m = /^property\s+(\w+)\s+(\w+)/.exec(l);
        if (m) { props.push({ name: m[2], type: m[1], off: stride }); stride += sizes[m[1]] ?? 4; }
    }
    const at = Object.fromEntries(props.map((p) => [p.name, p]));
    for (const k of ['x', 'y', 'z', 'scale_0', 'rot_0', 'opacity', 'f_dc_0']) if (!at[k]) throw new Error('ply: missing ' + k);
    const dv = new DataView(buffer, head.indexOf('\n', end) + 1);
    const g = (i, k) => dv.getFloat32(i * stride + at[k].off, true);
    const pos = new Float32Array(n * 3), scale = new Float32Array(n * 3), quat = new Float32Array(n * 4), rgba = new Uint8Array(n * 4);
    const C0 = 0.28209479177387814, cl = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
    for (let i = 0; i < n; i++) {
        pos[i * 3] = g(i, 'x'); pos[i * 3 + 1] = g(i, 'y'); pos[i * 3 + 2] = g(i, 'z');
        for (let k = 0; k < 3; k++) scale[i * 3 + k] = Math.exp(g(i, 'scale_' + k));
        const q = [g(i, 'rot_0'), g(i, 'rot_1'), g(i, 'rot_2'), g(i, 'rot_3')];
        const l = Math.hypot(...q) || 1;
        quat[i * 4] = q[1] / l; quat[i * 4 + 1] = q[2] / l; quat[i * 4 + 2] = q[3] / l; quat[i * 4 + 3] = q[0] / l;
        for (let k = 0; k < 3; k++) rgba[i * 4 + k] = cl(0.5 + C0 * g(i, 'f_dc_' + k));
        rgba[i * 4 + 3] = cl(1 / (1 + Math.exp(-g(i, 'opacity'))));
    }
    return { count: n, pos, scale, quat, rgba };
}

/** Pick the parser from the URL (or a forced `format`). */
export function parseSplatBuffer(buffer, format) {
    if (format === 'ksplat') return parseKSplat(buffer);
    if (format === 'splat') return parseSplat(buffer);
    if (format === 'ply') return parsePly(buffer);
    throw new Error('splats: unknown format ' + format);
}

const formatOf = (url) => { const m = /\.(ksplat|splat|ply)(\?|#|$)/i.exec(url); return m ? m[1].toLowerCase() : 'ksplat'; };

// -------------------------------------------------------------------------- pack for the GPU

/**
 * Bake placement + build the four data textures' arrays. `m` is a 16-number column-major matrix
 * (THREE.Matrix4.elements) or null. Returns centres separately for the sorter.
 */
export function packSplats(data, { m = null, maxSplats = Infinity } = {}) {
    const stride = data.count > maxSplats ? Math.ceil(data.count / maxSplats) : 1;
    const n = Math.ceil(data.count / stride);
    const grow = Math.pow(stride, 1 / 3);               // fewer splats cover the same space: swell them
    const size = Math.ceil(n / TEX_W) * TEX_W * 4;
    const A = new Float32Array(size), B = new Float32Array(size), C = new Float32Array(size);
    const centers = new Float32Array(n * 3);
    const e = m ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    // 3x3 (row-major a[r][c] = e[c*4+r]) and translation
    const a = [[e[0], e[4], e[8]], [e[1], e[5], e[9]], [e[2], e[6], e[10]]];
    for (let j = 0; j < n; j++) {
        const i = j * stride;
        const x = data.pos[i * 3], y = data.pos[i * 3 + 1], z = data.pos[i * 3 + 2];
        const wx = a[0][0] * x + a[0][1] * y + a[0][2] * z + e[12];
        const wy = a[1][0] * x + a[1][1] * y + a[1][2] * z + e[13];
        const wz = a[2][0] * x + a[2][1] * y + a[2][2] * z + e[14];
        centers[j * 3] = wx; centers[j * 3 + 1] = wy; centers[j * 3 + 2] = wz;
        // R from the unit quaternion; M = A R S so Sigma' = M M^T
        const qx = data.quat[i * 4], qy = data.quat[i * 4 + 1], qz = data.quat[i * 4 + 2], qw = data.quat[i * 4 + 3];
        const R = [
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy)],
            [2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx)],
            [2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy)],
        ];
        const s = [data.scale[i * 3] * grow, data.scale[i * 3 + 1] * grow, data.scale[i * 3 + 2] * grow];
        const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
            M[r][c] = (a[r][0] * R[0][c] + a[r][1] * R[1][c] + a[r][2] * R[2][c]) * s[c];
        }
        const cv = (p, q) => M[p][0] * M[q][0] + M[p][1] * M[q][1] + M[p][2] * M[q][2];
        const o = j * 4;
        A[o] = wx; A[o + 1] = wy; A[o + 2] = wz; A[o + 3] = data.rgba[i * 4 + 3] / 255;
        B[o] = cv(0, 0); B[o + 1] = cv(0, 1); B[o + 2] = cv(0, 2); B[o + 3] = cv(1, 1);
        C[o] = cv(1, 2); C[o + 1] = cv(2, 2);
        C[o + 2] = data.rgba[i * 4] + data.rgba[i * 4 + 1] * 256 + data.rgba[i * 4 + 2] * 65536;   // 3 bytes in one exact float
    }
    return { n, A, B, C, centers, stride, rows: size / 4 / TEX_W };
}

// ------------------------------------------------------------------------------- sort worker

/** Runs inside the worker (stringified), so it must not close over anything. */
function sortWorkerBody() {
    let centers = null, n = 0;
    self.onmessage = (ev) => {
        const m = ev.data;
        if (m.centers) { centers = new Float32Array(m.centers); n = centers.length / 3; return; }
        if (!centers) return;
        const { dir, cam, order } = m;                     // depth = dot(c - cam, dir) (view forward)
        const depth = new Float32Array(n);
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < n; i++) {
            const d = (centers[i * 3] - cam[0]) * dir[0] + (centers[i * 3 + 1] - cam[1]) * dir[1] + (centers[i * 3 + 2] - cam[2]) * dir[2];
            depth[i] = d; if (d < lo) lo = d; if (d > hi) hi = d;
        }
        const K = 65536, counts = new Uint32Array(K + 1), inv = (K - 1) / Math.max(hi - lo, 1e-6);
        const key = new Uint16Array(n);
        for (let i = 0; i < n; i++) { const k = ((depth[i] - lo) * inv) | 0; key[i] = k; counts[k + 1]++; }
        // back to front: the farthest (largest key) first
        for (let k = 0; k < K; k++) counts[k + 1] += counts[k];
        const out = new Float32Array(order);
        for (let i = 0; i < n; i++) out[n - 1 - counts[key[i]]++] = i;
        self.postMessage({ order: out.buffer }, [out.buffer]);
    };
}

// ----------------------------------------------------------------------------------- the cloud

/**
 * Build the cloud. THREE = the r186 webgpu namespace, TSL = 'three-eco/tsl'.
 * @returns {{ object: THREE.Mesh, count:number, uniforms:object, update(camera), setOpacity(v), dispose() }}
 */
export function createSplatCloud(THREE, TSL, packed, opts = {}) {
    const { float, vec2, vec3, vec4, int, ivec2, uniform, textureLoad, instancedBufferAttribute, positionGeometry,
        modelViewMatrix, cameraProjectionMatrix, screenSize, varying, exp, sqrt, max, min, dot, normalize, smoothstep,
        abs, pow, mix, select, mod } = TSL;
    const n = packed.n;
    const mk = (arr, type, fmt) => {
        const t = new THREE.DataTexture(arr, TEX_W, packed.rows, fmt ?? THREE.RGBAFormat, type ?? THREE.FloatType);
        t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
        return t;
    };
    const tA = mk(packed.A), tB = mk(packed.B), tC = mk(packed.C);
    const order = new Float32Array(n); for (let i = 0; i < n; i++) order[i] = i;
    const orderAttr = new THREE.InstancedBufferAttribute(order, 1);
    orderAttr.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.instanceCount = n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);   // never frustum-culled by bounds

    const U = {
        lift: uniform(opts.lift ?? 1), linear: uniform(opts.linear === false ? 0 : 1), opacity: uniform(opts.opacity ?? 1),
        crop: uniform(new THREE.Vector4(0, 0, 1e9, 1e9)), fade: uniform(opts.crop?.fade ?? 1), cropOn: uniform(opts.crop ? 1 : 0),
        scan: uniform(new THREE.Vector2(opts.hide?.floorY ?? 0, opts.hide?.scale ?? 1)),
        hoop: uniform(new THREE.Vector4(opts.hide?.low ?? 1e9, opts.hide?.hoopAt ?? 0, opts.hide?.hoopReach ?? 0, opts.hide?.hoopHalf ?? 0)),
        hoopC: uniform(new THREE.Vector2(opts.hide?.cx ?? 0, opts.hide?.cz ?? 0)),
        hideOn: uniform(opts.hide ? 1 : 0), size: uniform(1),
    };
    if (opts.crop) U.crop.value.set(opts.crop.x, opts.crop.z, opts.crop.hx, opts.crop.hz);

    const idx = instancedBufferAttribute(orderAttr).toInt();
    const tex = (t) => textureLoad(t, ivec2(mod(idx, int(TEX_W)), idx.div(int(TEX_W))), int(0));

    // Plain JS node building (no Fn): the graph is the same for every cloud, per-cloud values are uniforms.
    const a = tex(tA), b = tex(tB), c = tex(tC);
    const center = a.xyz;
    const view = modelViewMatrix.mul(vec4(center, 1));
    const clip = cameraProjectionMatrix.mul(view);
    // covariance in view space: V = W Sigma W^T (W = upper 3x3 of the model-view matrix)
    const W = TSL.mat3(modelViewMatrix[0].xyz, modelViewMatrix[1].xyz, modelViewMatrix[2].xyz);
    const S = TSL.mat3(vec3(b.x, b.y, b.z), vec3(b.y, b.w, c.x), vec3(b.z, c.x, c.y));
    const V = W.mul(S).mul(W.transpose());
    // Jacobian of the perspective map at the centre, in pixels: sx = fx X / d, d = -Z (the view looks down -z)
    const fx = cameraProjectionMatrix[0].x.mul(screenSize.x).mul(0.5), fy = cameraProjectionMatrix[1].y.mul(screenSize.y).mul(0.5);
    const d = view.z.negate().max(0.001), dd = d.mul(d);
    const j00 = fx.div(d), j02 = fx.mul(view.x).div(dd), j11 = fy.div(d), j12 = fy.mul(view.y).div(dd);
    const v00 = V[0].x, v01 = V[1].x, v02 = V[2].x, v11 = V[1].y, v12 = V[2].y, v22 = V[2].z;
    const c00 = j00.mul(j00).mul(v00).add(j00.mul(j02).mul(v02).mul(2)).add(j02.mul(j02).mul(v22)).add(0.3);
    const c01 = j00.mul(j11).mul(v01).add(j00.mul(j12).mul(v02)).add(j02.mul(j11).mul(v12)).add(j02.mul(j12).mul(v22));
    const c11 = j11.mul(j11).mul(v11).add(j11.mul(j12).mul(v12).mul(2)).add(j12.mul(j12).mul(v22)).add(0.3);
    const mid = c00.add(c11).mul(0.5), rad = sqrt(max(c00.sub(c11).mul(0.5).pow(2).add(c01.mul(c01)), 0.0001));
    const l1 = mid.add(rad), l2 = max(mid.sub(rad), 0.1);
    const dv = normalize(vec2(c01, l1.sub(c00)));
    const major = dv.mul(min(sqrt(l1.mul(2)), 1024)), minor = vec2(dv.y, dv.x.negate()).mul(min(sqrt(l2.mul(2)), 1024));
    const q = positionGeometry.xy;
    const ndc = clip.xy.div(clip.w);
    const off = major.mul(q.x).add(minor.mul(q.y)).mul(2).mul(U.size).div(screenSize);
    // crop / hoop masks (world units, as pocabinet/models.js did inside the old viewer's shader)
    const edge = min(U.crop.z.sub(abs(center.x.sub(U.crop.x))), U.crop.w.sub(abs(center.z.sub(U.crop.y))));
    const mm = vec3(center.x.sub(U.hoopC.x), center.y.sub(U.scan.x), center.z.sub(U.hoopC.y)).div(U.scan.y);
    const nearHoop = abs(abs(mm.x).sub(U.hoop.y)).lessThan(U.hoop.z).and(abs(mm.z).lessThan(U.hoop.w));
    const high = mm.y.greaterThan(U.hoop.x).and(nearHoop.not());
    // cull what cannot be seen: near-transparent splats and ones under ~a third of a pixel (overdraw is the cost)
    const tiny = a.w.lessThan(0.012).or(l1.lessThan(0.12));
    const drop = tiny.or(clip.w.lessThanEqual(0.01)).or(abs(ndc.x).greaterThan(1.4)).or(abs(ndc.y).greaterThan(1.4))
        .or(U.cropOn.greaterThan(0.5).and(edge.lessThan(0)))
        .or(U.hideOn.greaterThan(0.5).and(high));
    const fade = select(U.cropOn.greaterThan(0.5), smoothstep(0, U.fade, edge), float(1));
    const pk = c.z, cb = pk.div(65536).floor(), cg = pk.sub(cb.mul(65536)).div(256).floor(), cr = pk.sub(cb.mul(65536)).sub(cg.mul(256));
    const rgb = vec3(cr, cg, cb).div(255);
    const lin = mix(rgb, pow(max(rgb, 0), vec3(2.2)).mul(U.lift), U.linear);
    const vColor = varying(lin, 'vSplatColor'), vAlpha = varying(a.w.mul(fade).mul(U.opacity), 'vSplatAlpha'), vQuad = varying(q, 'vSplatQuad');

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide });
    material.vertexNode = select(drop, vec4(0, 0, 2, 1), vec4(ndc.add(off), clip.z.div(clip.w), 1));
    const gA = dot(vQuad, vQuad).negate();
    // colorNode/opacityNode, NOT fragmentNode: r186 builds a material with a fragmentNode as ONE output
    // and never merges the renderer's MRT into it, so inside a post stack's multi-attachment scene pass
    // ("Color target has no corresponding fragment stage output") the pipeline fails to compile.
    material.colorNode = vColor;
    material.opacityNode = select(gA.lessThan(-4), float(0), exp(gA).mul(vAlpha));
    material.blending = THREE.NormalBlending;
    material.toneMapped = opts.toneMapped ?? true;

    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = opts.renderOrder ?? 0;
    mesh.name = opts.name ?? 'splat-cloud';

    // ---- sorting
    let worker = null, busy = false, url = null;
    const last = { dir: new THREE.Vector3(), cam: new THREE.Vector3(), has: false };
    const dir = new THREE.Vector3(), cam = new THREE.Vector3(), inv = new THREE.Matrix4();
    let spare = null;
    try {
        url = URL.createObjectURL(new Blob([`(${sortWorkerBody.toString()})()`], { type: 'text/javascript' }));
        worker = new Worker(url);
        const c = packed.centers.slice();
        worker.postMessage({ centers: c.buffer }, [c.buffer]);
        worker.onmessage = (ev) => {
            const o = new Float32Array(ev.data.order);
            orderAttr.array.set(o); orderAttr.needsUpdate = true; spare = o; busy = false;
        };
        worker.onerror = (e) => { console.warn('splats: sort worker failed', e.message); busy = false; };
    } catch (e) {
        console.warn('splats: no sort worker, drawing unsorted', e);
    }

    /** Ask for a re-sort when the camera moved or turned enough; cheap when nothing changed. */
    function update(camera) {
        if (!worker || busy) return;
        mesh.updateWorldMatrix(true, false);
        inv.copy(mesh.matrixWorld).invert();                       // sorter works in the baked (object) frame
        cam.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
        camera.getWorldDirection(dir).transformDirection(inv);
        if (last.has && last.dir.dot(dir) > 0.9995 && last.cam.distanceToSquared(cam) < 0.0025) return;
        last.dir.copy(dir); last.cam.copy(cam); last.has = true;
        busy = true;
        const buf = (spare && spare.buffer.byteLength) ? spare.buffer : new Float32Array(n).buffer;
        spare = null;
        worker.postMessage({ dir: [dir.x, dir.y, dir.z], cam: [cam.x, cam.y, cam.z], order: buf }, [buf]);
    }
    mesh.onBeforeRender = (renderer, scene, camera) => update(camera);

    return {
        object: mesh, count: n, uniforms: U, update,
        setOpacity(v) { U.opacity.value = v; },
        dispose() {
            worker?.terminate(); if (url) URL.revokeObjectURL(url);
            geo.dispose(); material.dispose(); tA.dispose(); tB.dispose(); tC.dispose();
            mesh.parent?.remove(mesh);
        },
    };
}

/**
 * Fetch + parse + pack + build. `opts.matrix` is a THREE.Matrix4 (or 16-array) baked into the data;
 * `opts.maxSplats` caps the count (tier); `opts.onProgress(0..100)`; the rest goes to createSplatCloud.
 */
export async function loadSplat(THREE, TSL, url, opts = {}) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`splats: ${url} -> ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    let buffer;
    if (res.body && total) {
        const out = new Uint8Array(total); let got = 0;
        const rd = res.body.getReader();
        for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            out.set(value, got); got += value.length; opts.onProgress?.(Math.min(100, got / total * 100));
        }
        buffer = out.buffer;
    } else buffer = await res.arrayBuffer();
    const data = parseSplatBuffer(buffer, opts.format ?? formatOf(url));
    const m = opts.matrix ? (opts.matrix.elements ?? opts.matrix) : null;
    const packed = packSplats(data, { m, maxSplats: opts.maxSplats });
    opts.onProgress?.(100);
    return createSplatCloud(THREE, TSL, packed, opts);
}
