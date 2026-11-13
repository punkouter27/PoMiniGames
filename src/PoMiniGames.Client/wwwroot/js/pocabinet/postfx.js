// pocabinet/postfx.js
//
// HDR post-processing for PoCabinet (WebGL2: three ≥ r163 has no WebGL1 path, so
// multisampled half-float targets are always available).
//
//   scene ─► MSAA half-float target (linear HDR) + a resolved float depth texture
//        ─► velocity (high): the cars drawn in full, again, as screen motion
//             (this frame's matrices against last frame's, wheels and all) into a
//             half-res target, then reduced to 16 px tiles and their 3×3 neighbourhood max
//        ─► GTAO (medium, high): ground-truth ambient occlusion from the depth buffer at half
//             res (2 slices × 6 steps a side, a 4×4 Bayer rotation the 4×4 blur removes)
//        ─► SSR (medium, high): screen-space reflections where the scene's alpha says the
//             surface is reflective (below), with raindrop ripples on the water; on a clear
//             day (high) the far road at grazing angles mirrors the sky like hot tarmac
//        ─► lighting: the scene × occlusion (depth-aware upsample) + reflections, blurred
//             vertically by how rough the wet surface is (puddles sharp, wet asphalt smeared)
//        ─► motion blur (high): per-pixel velocity (the car buffer where a car is in front,
//             else the camera's own motion reprojected through the depth) gathered along the
//             tile neighbourhood's dominant direction with McGuire's depth-aware weights, so
//             a passing car smears over the background and a spinning rim blurs round
//        ─► bright pass (soft knee) at half res
//        ─► dual-filter bloom: N downsamples, N upsamples added back up the chain
//        ─► composite:
//             • heat haze (off on every tier, see PASSES) — every full car's exhaust shimmers what is behind it
//               (depth-tested, so the car in front stays crisp), plus the far road on a clear
//               day and the slipstream between two cars (fx.haze, slipstream.js)
//             • speed — radial blur toward the vanishing point, chromatic fringing
//               at the edges, streaking speed lines (all masked off the centre)
//             • lens rain — refracting drops on the camera glass
//             • bloom + light shafts: the bloom texture blurred radially toward the
//               sun's screen position, plus a small glare/ghost when the sun is in view
//             • ACES filmic tone mapping with exposure, a light grade, vignette,
//               flash (flashbulbs, photo finish), slow-motion grade, grain
//             • linear → sRGB via three's <colorspace_fragment>
//
// Reflectivity rides in the scene target's alpha: every opaque material writes 1, and a
// surface that reflects writes 1 − reflectivity (materials.js reflective(): the road, 0.02
// dry so the mirage can find it, 0.55 wet). Puddles are decals that multiply the alpha
// under them down instead of blending it up (trackside.js), so standing water is a mirror.
// Ordinary transparent things (smoke, the rubbered line) blend it back toward 1.
//
// `fx` is SceneHandle.fx — the per-frame bag race.js writes and
// scene.js fills (sun position, exposure, rain). Reduced motion zeroes the speed effects, the
// motion blur and the haze. `fx.movers` is the list of car groups race.js draws in full.
// Quality 'low' | 'medium' | 'high' sets the bloom depth and which depth passes run; 'low'
// is the frame it always was.

import * as THREE from 'three';

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// Depth helpers shared by the depth passes. uProj = (P00, P11, near, far).
const DEPTH_GLSL = /* glsl */ `
uniform sampler2D tDepth;
uniform vec4 uProj;
uniform vec2 uDepthTexel;
float viewZOf(float d) { return (uProj.z * uProj.w) / ((uProj.w - uProj.z) * d - uProj.w); }
float viewZAt(vec2 uv) { return viewZOf(texture2D(tDepth, uv).x); }
vec3 viewPosAt(vec2 uv, float vz) {
    vec2 ndc = uv * 2.0 - 1.0;
    return vec3(ndc.x * -vz / uProj.x, ndc.y * -vz / uProj.y, vz);
}
// The smaller of the two one-sided differences each way, so an edge never bends a normal.
vec3 normalAt(vec2 uv, vec3 P) {
    vec2 tx = vec2(uDepthTexel.x, 0.0), ty = vec2(0.0, uDepthTexel.y);
    vec3 pr = viewPosAt(uv + tx, viewZAt(uv + tx)), pl = viewPosAt(uv - tx, viewZAt(uv - tx));
    vec3 pu = viewPosAt(uv + ty, viewZAt(uv + ty)), pd = viewPosAt(uv - ty, viewZAt(uv - ty));
    vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
    vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
    return normalize(cross(dx, dy));
}
float bayer4(vec2 p) {
    p = mod(floor(p), 4.0);
    int i = int(p.x) + int(p.y) * 4;
    const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
    return (m[i] + 0.5) / 16.0;
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

// ── GTAO (XeGTAO's integration, cosine-weighted, no bent normals) ──
const GTAO_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform float uRadius;
uniform vec2 uRes;
varying vec2 vUv;
#define PI 3.14159265
#define HALF_PI 1.5707963
#define SLICES 2
#define STEPS 6
void main() {
    float vz = viewZAt(vUv);
    if (-vz > uProj.w * 0.9) { gl_FragColor = vec4(1.0, -vz, 0.0, 1.0); return; }
    vec3 P = viewPosAt(vUv, vz);
    vec3 N = normalAt(vUv, P);
    vec3 V = normalize(-P);
    vec2 rUV = uProj.xy * 0.5 * uRadius / -vz;
    // A pixel right in front of the lens would search half the screen: cap it.
    float cap = min(1.0, 0.1 / max(rUV.y, 1e-5));
    rUV *= cap;
    float radius = uRadius * cap;
    if (rUV.y * uRes.y < 1.5) { gl_FragColor = vec4(1.0, -vz, 0.0, 1.0); return; }
    float falloffRange = 0.6 * radius;
    float falloffMul = -1.0 / falloffRange;
    float falloffAdd = (radius - falloffRange) / falloffRange + 1.0;
    float rot = bayer4(gl_FragCoord.xy);
    float jit = fract(bayer4(gl_FragCoord.yx + 1.0) + 0.37);
    float vis = 0.0;
    for (int s = 0; s < SLICES; s++) {
        float phi = (float(s) + rot) * PI / float(SLICES);
        vec2 omega = vec2(cos(phi), sin(phi));
        vec3 dirV = vec3(omega, 0.0);
        vec3 ortho = dirV - dot(dirV, V) * V;
        vec3 axis = normalize(cross(ortho, V));
        vec3 projN = N - axis * dot(N, axis);
        float projLen = length(projN);
        if (projLen < 1e-4) { vis += 1.0; continue; }
        float sgn = dot(ortho, projN) >= 0.0 ? 1.0 : -1.0;
        float cosN = clamp(dot(projN, V) / projLen, 0.0, 1.0);
        float n = sgn * acos(cosN);
        float low0 = cos(n + HALF_PI), low1 = cos(n - HALF_PI);
        float hc0 = low0, hc1 = low1;
        for (int k = 0; k < STEPS; k++) {
            float t = (float(k) + jit) / float(STEPS);
            t = max(t * t, 1.5 / (rUV.y * uRes.y));
            vec2 off = omega * rUV * t;
            vec2 uv0 = vUv + off, uv1 = vUv - off;
            vec3 d0 = viewPosAt(uv0, viewZAt(uv0)) - P;
            vec3 d1 = viewPosAt(uv1, viewZAt(uv1)) - P;
            float l0 = length(d0), l1 = length(d1);
            float w0 = clamp(l0 * falloffMul + falloffAdd, 0.0, 1.0);
            float w1 = clamp(l1 * falloffMul + falloffAdd, 0.0, 1.0);
            hc0 = max(hc0, mix(low0, dot(d0 / max(l0, 1e-4), V), w0));
            hc1 = max(hc1, mix(low1, dot(d1 / max(l1, 1e-4), V), w1));
        }
        float h0 = -acos(clamp(hc1, -1.0, 1.0));
        float h1 = acos(clamp(hc0, -1.0, 1.0));
        h0 = n + clamp(h0 - n, -HALF_PI, HALF_PI);
        h1 = n + clamp(h1 - n, -HALF_PI, HALF_PI);
        float sn = sin(n);
        float iarc0 = (cosN + 2.0 * h0 * sn - cos(2.0 * h0 - n)) * 0.25;
        float iarc1 = (cosN + 2.0 * h1 * sn - cos(2.0 * h1 - n)) * 0.25;
        vis += projLen * (iarc0 + iarc1);
    }
    vis /= float(SLICES);
    gl_FragColor = vec4(clamp(vis, 0.0, 1.0), -vz, 0.0, 1.0);
}`;

// 4×4 depth-aware box: exactly the Bayer tile the GTAO rotated by.
const AO_BLUR_FRAG = /* glsl */ `
uniform sampler2D tAO;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
    vec2 c = texture2D(tAO, vUv).xy;
    float sum = 0.0, wsum = 0.0;
    for (int y = -2; y < 2; y++) {
        for (int x = -2; x < 2; x++) {
            vec2 s = texture2D(tAO, vUv + (vec2(float(x), float(y)) + 0.5) * uTexel).xy;
            float w = max(0.0, 1.0 - abs(s.y - c.y) / (0.04 * c.y + 0.08));
            sum += s.x * w;
            wsum += w;
        }
    }
    gl_FragColor = vec4(wsum > 0.0 ? sum / wsum : c.x, c.y, 0.0, 1.0);
}`;

// ── Screen-space reflections (wet asphalt, puddles, and clearcoat car paint/glass #3) ──
const SSR_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D tScene;
uniform mat4 uProjM;
uniform mat4 uView;
uniform mat4 uInvView;
uniform float uWet;
uniform float uMirage;
uniform vec3 uSky;
uniform float uTime;
uniform vec2 uRes;
varying vec2 vUv;
#define STEPS 40

vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}
// Raindrop rings on standing water: two layers of cells, one expanding ring each.
vec2 ripples(vec2 p, float t) {
    vec2 g = vec2(0.0);
    for (int l = 0; l < 2; l++) {
        float sc = l == 0 ? 1.7 : 2.9;
        vec2 q = p * sc + float(l) * 7.31;
        vec2 id = floor(q);
        vec2 f = fract(q) - 0.5;
        vec2 h = hash22(id);
        float rate = 0.9 + h.y * 0.8;
        float cyc = t * rate + h.x * 9.0;
        float life = fract(cyc);
        vec2 c = (hash22(id + floor(cyc) * 1.37) - 0.5) * 0.36;
        vec2 d = f - c;
        float r = length(d);
        float ring = r - life * 0.42;
        float wave = sin(ring * 70.0) * exp(-ring * ring * 520.0) * (1.0 - life) * (1.0 - life);
        g += d / max(r, 1e-3) * wave;
    }
    return g * 0.32;
}

void main() {
    vec4 sc = texture2D(tScene, vUv);
    float refl = clamp(1.0 - sc.a, 0.0, 1.0);
    if (refl < 0.012) { gl_FragColor = vec4(0.0); return; }
    float vz = viewZAt(vUv);
    if (-vz > uProj.w * 0.9) { gl_FragColor = vec4(0.0); return; }
    vec3 P = viewPosAt(vUv, vz);
    vec3 up = normalize((uView * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vec3 Nd = normalAt(vUv, P);
    bool isClearcoat = dot(Nd, up) < 0.35 && refl > 0.14;
    if (!isClearcoat && dot(Nd, up) < 0.3) { gl_FragColor = vec4(0.0); return; }
    // Ground leans heavily on world-up; car bodies/glass trace along true geometry normal (#3).
    vec3 N = isClearcoat ? Nd : normalize(mix(Nd, up, 0.85));
    if (uWet > 0.01 && !isClearcoat) {
        vec3 W = (uInvView * vec4(P, 1.0)).xyz;
        vec2 g = ripples(W.xz, uTime) * (refl > 0.7 ? 1.0 : 0.1) * uWet;
        N = normalize(N + (uView * vec4(g.x, 0.0, g.y, 0.0)).xyz);
    }
    vec3 V = normalize(P);
    vec3 R = reflect(V, N);
    float cosV = clamp(dot(-V, N), 0.0, 1.0);
    float F = 0.03 + 0.97 * pow(1.0 - cosV, 5.0);
    float coatW = isClearcoat ? min(0.75, refl * (F * 1.4 + 0.18)) : 0.0;
    float wetW = (!isClearcoat && uWet > 0.01 && refl > 0.05) ? min(1.0, refl * (F * 1.6 + 0.12)) : 0.0;
    float mirW = (!isClearcoat) ? uMirage * (1.0 - uWet) * smoothstep(45.0, 150.0, -vz) * pow(1.0 - cosV, 10.0) * 0.8 : 0.0;
    if (coatW + wetW + mirW < 0.004 || R.z > 0.15) { gl_FragColor = vec4(0.0); return; }

    // March the reflected ray in screen space, perspective-correct in depth.
    float L = isClearcoat ? 75.0 : 140.0;
    if (P.z + R.z * L > -uProj.z) L = (-uProj.z * 1.5 - P.z) / R.z;
    vec3 E = P + R * L;
    vec4 H0 = uProjM * vec4(P, 1.0), H1 = uProjM * vec4(E, 1.0);
    float k0 = 1.0 / H0.w, k1 = 1.0 / H1.w;
    vec2 S0 = H0.xy * k0 * 0.5 + 0.5, S1 = H1.xy * k1 * 0.5 + 0.5;
    float z0 = P.z * k0, z1 = E.z * k1;
    float spanPx = length((S1 - S0) * uRes);
    float t0 = min(0.5, 2.0 / max(spanPx, 1.0));
    float jit = bayer4(gl_FragCoord.xy);
    float tPrev = t0, tHit = -1.0;
    for (int i = 1; i <= STEPS; i++) {
        float t = t0 + (1.0 - t0) * pow((float(i) - 1.0 + jit) / float(STEPS), 1.6);
        vec2 uv = mix(S0, S1, t);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
        float rz = mix(z0, z1, t) / mix(k0, k1, t);
        float dz = viewZAt(uv) - rz;
        if (dz > 0.0 && dz < 0.35 + abs(rz) * 0.035) { tHit = t; break; }
        tPrev = t;
    }
    vec3 col = uSky;
    float conf = 0.0;
    if (tHit > 0.0) {
        float a = tPrev, b = tHit;
        for (int j = 0; j < 5; j++) {
            float m = 0.5 * (a + b);
            vec2 uv = mix(S0, S1, m);
            float rz = mix(z0, z1, m) / mix(k0, k1, m);
            if (viewZAt(uv) - rz > 0.0) b = m; else a = m;
        }
        vec2 uv = mix(S0, S1, b);
        col = min(texture2D(tScene, uv).rgb, vec3(8.0));
        vec2 e = smoothstep(vec2(0.0), vec2(0.07), uv) * smoothstep(vec2(0.0), vec2(0.07), 1.0 - uv);
        conf = e.x * e.y * (1.0 - b * b) * smoothstep(0.15, -0.15, R.z);
    }
    float w = (wetW + coatW) * conf + coatW * (tHit < 0.0 ? 0.28 : 0.0) + mirW * (tHit > 0.0 ? conf : 1.0);
    gl_FragColor = vec4(col, clamp(w, 0.0, 1.0));
}`;

const MAX_DYN_LIGHTS = 12;
// ── Lighting: occlusion, contact shadows, 1-bounce SSGI, 12 dynamic lights & SSR ──
const LIGHT_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D tScene;
uniform sampler2D tAO;
uniform sampler2D tSSR;
uniform mat4 uProjM;
uniform vec3 uSunDir;
uniform vec2 uHalfTexel;
uniform float uAO;
uniform float uSSR;
uniform float uContact;
uniform float uGI;
uniform vec2 uRes;
uniform int uLightCount;
uniform vec4 uLightPos[${MAX_DYN_LIGHTS}];
uniform vec4 uLightCol[${MAX_DYN_LIGHTS}];
uniform vec3 uLightDir[${MAX_DYN_LIGHTS}];
varying vec2 vUv;
void main() {
    vec4 sc = texture2D(tScene, vUv);
    vec3 col = sc.rgb;
    if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
    float z = -viewZAt(vUv);
    vec3 P = viewPosAt(vUv, -z);
    vec3 Nd = (uLightCount > 0 && z < 95.0) ? normalAt(vUv, P) : vec3(0.0, 1.0, 0.0);
    if (uAO > 0.0) {
        // Depth-aware upsample of the half-res occlusion.
        vec2 base = vUv / uHalfTexel - 0.5;
        vec2 f = fract(base);
        vec2 b0 = (floor(base) + 0.5) * uHalfTexel;
        float sum = 0.0, wsum = 0.0;
        for (int j = 0; j < 2; j++) {
            for (int i = 0; i < 2; i++) {
                vec2 s = texture2D(tAO, b0 + vec2(float(i), float(j)) * uHalfTexel).xy;
                float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
                float dw = 1.0 / (1e-3 + abs(s.y - z) / (0.02 * z + 0.05));
                float w = bw * dw + 1e-5;
                sum += s.x * w;
                wsum += w;
            }
        }
        float ao = pow(sum / wsum, 1.8);
        ao = mix(1.0, ao, uAO * (1.0 - smoothstep(35.0, 90.0, z)));
        float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
        ao = mix(ao, 1.0, 0.35 * smoothstep(0.8, 3.0, luma));
        col *= ao;

        // Screen-space contact shadow short raymarch along view-space sun vector (#4).
        if (uContact > 0.0 && z < 55.0) {
            float occ = 0.0;
            float jit = bayer4(gl_FragCoord.xy);
            for (int s = 1; s <= 6; s++) {
                float dist = (float(s) - 0.5 + jit) * 0.14;
                vec3 samplePos = P + uSunDir * dist;
                vec4 clip = uProjM * vec4(samplePos, 1.0);
                vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
                if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
                float hitZ = -viewZAt(suv);
                float rayZ = -samplePos.z;
                float diff = rayZ - hitZ;
                if (diff > 0.03 && diff < 0.42) {
                    occ = max(occ, 1.0 - smoothstep(0.22, 0.42, diff));
                }
            }
            float fade = 1.0 - smoothstep(32.0, 55.0, z);
            col *= 1.0 - occ * 0.42 * uContact * fade;
        }

        // 1-bounce Screen-Space Global Illumination (#4)
        if (uGI > 0.0 && z < 75.0) {
            vec3 gi = vec3(0.0);
            float wgi = 0.0;
            float phi0 = bayer4(gl_FragCoord.xy) * 6.28318;
            vec2 px = 1.0 / max(uRes, vec2(1.0));
            for (int t = 0; t < 8; t++) {
                float ft = (float(t) + 0.5) / 8.0;
                float ang = phi0 + float(t) * 2.399963;
                float rad = mix(8.0, 38.0, ft);
                vec2 suv = vUv + vec2(cos(ang), sin(ang)) * rad * px;
                if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
                float sz = -viewZAt(suv);
                float dw = 1.0 / (1.0 + abs(sz - z) * 0.65);
                vec3 scTap = max(vec3(0.0), texture2D(tScene, suv).rgb);
                float tapLum = dot(scTap, vec3(0.2126, 0.7152, 0.0722));
                float boost = smoothstep(0.35, 1.8, tapLum);
                gi += scTap * (0.28 + boost * 0.9) * dw;
                wgi += dw;
            }
            if (wgi > 1e-4) {
                vec3 bounce = min(gi / wgi, vec3(1.6));
                col += bounce * (0.14 * uGI * (1.0 - smoothstep(45.0, 75.0, z)));
            }
        }
    }
    // Clustered 12 dynamic point/spot lights: impact spark flashes, brake glow, headlights (#10).
    if (uLightCount > 0 && z < 95.0) {
        float refl = clamp(1.0 - sc.a, 0.0, 1.0);
        vec3 V = normalize(-P);
        vec3 dyn = vec3(0.0);
        float shininess = mix(16.0, 64.0, refl);
        for (int i = 0; i < ${MAX_DYN_LIGHTS}; i++) {
            if (i >= uLightCount) break;
            vec4 lp = uLightPos[i];
            vec4 lc = uLightCol[i];
            vec3 toL = lp.xyz - P;
            float dist = length(toL);
            if (dist >= lp.w || dist < 0.01) continue;
            vec3 L = toL / dist;
            float att = 1.0 - dist / lp.w;
            att = att * att;
            if (lc.w > 0.01) {
                float spotCos = dot(-L, uLightDir[i]);
                att *= smoothstep(lc.w, min(0.99, lc.w + 0.25), spotCos);
            }
            float ndl = max(dot(Nd, L), 0.14);
            vec3 H = normalize(L + V);
            float spec = pow(max(dot(Nd, H), 0.0), shininess) * (0.08 + refl * 0.55);
            dyn += lc.rgb * att * (ndl * 0.35 + spec);
        }
        col += dyn;
    }
    if (uSSR > 0.0) {
        float refl = clamp(1.0 - sc.a, 0.0, 1.0);
        float spread = (1.0 - smoothstep(0.6, 0.9, refl)) * 7.0;
        vec4 acc = vec4(0.0);
        for (int j = -1; j <= 1; j++) {
            for (int i = -2; i <= 2; i++) {
                float k = float(i);
                vec2 o = vec2(float(j) * 1.5 * uHalfTexel.x, uHalfTexel.y * (spread + 1.5) * k * 1.1);
                vec4 s = texture2D(tSSR, vUv + o);
                float tw = (i == 0 ? 0.28 : (abs(i) == 1 ? 0.22 : 0.14)) * (j == 0 ? 0.4 : 0.3);
                acc += vec4(s.rgb * s.a, s.a) * tw;
            }
        }
        float w = clamp(acc.a * uSSR, 0.0, 1.0);
        vec3 rc = acc.a > 1e-4 ? acc.rgb / acc.a : vec3(0.0);
        col = col * (1.0 - w * 0.55) + rc * w;
    }
    gl_FragColor = vec4(col, sc.a);
}`;

// ── Velocity of the cars in full (supports single meshes + InstancedMesh CarCrowd #14) ──
const VEL_VERT = /* glsl */ `
attribute vec4 aPrevCol0;
attribute vec4 aPrevCol1;
attribute vec4 aPrevCol2;
attribute vec4 aPrevCol3;
uniform mat4 uPrevModel;
uniform mat4 uPrevViewProj;
uniform float uIsInstanced;
varying vec4 vCur;
varying vec4 vPrev;
varying float vDepth;
void main() {
    mat4 curM = modelMatrix;
    mat4 prevM = uPrevModel;
    if (uIsInstanced > 0.5) {
        #ifdef USE_INSTANCING
        curM = modelMatrix * instanceMatrix;
        prevM = modelMatrix * mat4(aPrevCol0, aPrevCol1, aPrevCol2, aPrevCol3);
        #endif
    }
    vec4 vp = viewMatrix * curM * vec4(position, 1.0);
    gl_Position = projectionMatrix * vp;
    vCur = gl_Position;
    vPrev = uPrevViewProj * (prevM * vec4(position, 1.0));
    vDepth = -vp.z;
}`;
const VEL_FRAG = /* glsl */ `
varying vec4 vCur;
varying vec4 vPrev;
varying float vDepth;
void main() {
    vec2 a = vCur.xy / vCur.w, b = vPrev.xy / vPrev.w;
    gl_FragColor = vec4((a - b) * 0.5, vDepth, 1.0);
}`;

// Largest car velocity in each 16 px tile (sampled every other half-res texel).
const TILE_FRAG = /* glsl */ `
uniform sampler2D tVel;
uniform vec2 uVelTexel;
uniform vec2 uTileUV;
varying vec2 vUv;
void main() {
    vec2 corner = vUv - uTileUV * 0.5 + uVelTexel;
    vec2 best = vec2(0.0);
    float bl = 0.0;
    for (int j = 0; j < 4; j++) {
        for (int i = 0; i < 4; i++) {
            vec4 v = texture2D(tVel, corner + vec2(float(i), float(j)) * uVelTexel * 2.0);
            float l = dot(v.xy, v.xy) * step(0.5, v.w);
            if (l > bl) { bl = l; best = v.xy; }
        }
    }
    gl_FragColor = vec4(best, 0.0, 1.0);
}`;
const NEIGHBOR_FRAG = /* glsl */ `
uniform sampler2D tTile;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
    vec2 best = vec2(0.0);
    float bl = 0.0;
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            vec2 v = texture2D(tTile, vUv + vec2(float(i), float(j)) * uTexel).xy;
            float l = dot(v, v);
            if (l > bl) { bl = l; best = v; }
        }
    }
    gl_FragColor = vec4(best, 0.0, 1.0);
}`;

const MOTION_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D tColor;
uniform sampler2D tVel;
uniform sampler2D tNeighbor;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform float uScale;
uniform float uMaxPx;
uniform vec2 uRes;
varying vec2 vUv;
#define TAPS 12

vec2 camVel(vec2 uv, float d) {
    vec4 w = uInvViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    w /= w.w;
    vec4 p = uPrevViewProj * w;
    return (uv - (p.xy / p.w * 0.5 + 0.5));
}
vec2 velAt(vec2 uv, float d, float z) {
    vec4 c = texture2D(tVel, uv);
    vec2 v = (c.w > 0.5 && abs(c.z - z) < 0.4 + z * 0.03) ? c.xy : camVel(uv, d);
    v *= uScale;
    float l = length(v * uRes);
    return l > uMaxPx ? v * (uMaxPx / l) : v;
}
float cone(float dist, float len) { return clamp(1.0 - dist / len, 0.0, 1.0); }
float cylinder(float dist, float len) { return 1.0 - smoothstep(0.95 * len, 1.05 * len, dist); }
float softDepth(float za, float zb, float soft) { return clamp(1.0 - (za - zb) / soft, 0.0, 1.0); }

void main() {
    float d = texture2D(tDepth, vUv).x;
    float z = -viewZOf(d);
    vec2 vX = velAt(vUv, d, z);
    vec2 vN = texture2D(tNeighbor, vUv).xy * uScale;
    float ln = length(vN * uRes);
    if (ln > uMaxPx) vN *= uMaxPx / ln;
    vec2 vDom = dot(vN * uRes, vN * uRes) > dot(vX * uRes, vX * uRes) ? vN : vX;
    float lenPx = length(vDom * uRes);
    vec3 c0 = texture2D(tColor, vUv).rgb;
    if (lenPx < 1.0) { gl_FragColor = vec4(c0, 1.0); return; }
    float lenX = max(length(vX * uRes), 0.5);
    float soft = 0.5 + z * 0.02;
    vec3 sum = c0 / lenX;
    float wsum = 1.0 / lenX;
    float jit = ign(gl_FragCoord.xy) - 0.5;
    for (int i = 0; i < TAPS; i++) {
        float t = mix(-0.5, 0.5, (float(i) + 0.5 + jit) / float(TAPS));
        vec2 uvY = clamp(vUv + vDom * t, vec2(0.001), vec2(0.999));
        float dY = texture2D(tDepth, uvY).x;
        float zY = -viewZOf(dY);
        float lenY = max(length(velAt(uvY, dY, zY) * uRes), 0.5);
        float dist = abs(t) * lenPx;
        float f = softDepth(zY, z, soft);
        float b = softDepth(z, zY, soft);
        float w = f * cone(dist, lenY) + b * cone(dist, lenX) + cylinder(dist, lenY) * cylinder(dist, lenX) * 2.0;
        sum += texture2D(tColor, uvY).rgb * w;
        wsum += w;
    }
    gl_FragColor = vec4(sum / wsum, 1.0);
}`;

const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
void main() {
    // 4-tap box on the way down (the target is half size).
    vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb;
    c *= 0.25;
    // One bad pixel (NaN/Inf from a degenerate triangle) would otherwise bloom into a blob.
    if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
    c = min(c, vec3(60.0));
    float br = max(c.r, max(c.g, c.b));
    float knee = uThreshold * 0.5;
    float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    float w = max(soft, br - uThreshold) / max(br, 1e-4);
    gl_FragColor = vec4(c * w, 1.0);
}`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
    vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
    s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    gl_FragColor = vec4(s / 8.0, 1.0);
}`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;     // the smaller, already-accumulated level
uniform sampler2D tBase;    // this level's downsample
uniform vec2 uTexel;        // texel of tSrc
varying vec2 vUv;
void main() {
    vec3 s = texture2D(tSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb * 2.0;
    s += texture2D(tSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb * 2.0;
    s += texture2D(tSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb * 2.0;
    s += texture2D(tSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb * 2.0;
    s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    gl_FragColor = vec4(texture2D(tBase, vUv).rgb + s / 12.0, 1.0);
}`;

const MAX_HAZE = 14;

const TONE_GLSL = /* glsl */ `
vec3 RRTAndODTFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
}
vec3 acesFilmic(vec3 c) {
    const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
    const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
    return clamp(outM * RRTAndODTFit(inM * c), 0.0, 1.0);
}`;

// The picture-in-picture inset: its HDR frame tone-mapped like the main one, straight onto the canvas.
const INSET_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform float uExposure;
varying vec2 vUv;
${TONE_GLSL}
void main() {
    vec3 c = texture2D(tSrc, vUv).rgb;
    if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
    gl_FragColor = vec4(acesFilmic(c * uExposure / 0.6), 1.0);
    #include <colorspace_fragment>
}`;

// ── Quarter-res depth-occluded crepuscular light shafts (#17) ──
const VOL_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform vec3 uSun;
uniform vec2 uRes;
varying vec2 vUv;
void main() {
    if (uSun.z <= 0.002) { gl_FragColor = vec4(0.0); return; }
    vec2 sp = uSun.xy;
    vec2 delta = (sp - vUv) / 16.0;
    vec2 p = vUv + delta * bayer4(gl_FragCoord.xy);
    float occ = 0.0, decay = 1.0;
    for (int i = 0; i < 16; i++) {
        if (p.x >= 0.0 && p.x <= 1.0 && p.y >= 0.0 && p.y <= 1.0) {
            float z = -viewZAt(p);
            float skyMask = smoothstep(55.0, 140.0, z);
            occ += skyMask * decay;
        }
        p += delta;
        decay *= 0.91;
    }
    vec2 d = (vUv - sp) * vec2(uRes.x / max(uRes.y, 1.0), 1.0);
    float mie = exp(-length(d) * 2.2) * 0.7 + 0.3;
    gl_FragColor = vec4(vec3(occ / 16.0 * mie), 1.0);
}`;

// ── Temporal Anti-Aliasing with YCoCg 3x3 variance clipping (#1) ──
const TAA_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D tCur;
uniform sampler2D tHist;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec2 uTexel;
uniform vec2 uJitterUV;
uniform float uBlend;
varying vec2 vUv;
vec3 toYCoCg(vec3 c) {
    return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
vec3 toRGB(vec3 y) {
    float t = y.x - y.z;
    return max(vec3(0.0), vec3(t + y.y, y.x + y.z, t - y.y));
}
void main() {
    vec2 uv = vUv - uJitterUV;
    vec3 cur = texture2D(tCur, uv).rgb;
    if (any(isnan(cur)) || any(isinf(cur))) cur = vec3(0.0);
    if (uBlend <= 0.01) { gl_FragColor = vec4(cur, 1.0); return; }
    float d = texture2D(tDepth, vUv).x;
    vec4 w = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    w /= w.w;
    vec4 p = uPrevViewProj * w;
    vec2 prevUv = p.xy / p.w * 0.5 + 0.5;
    if (prevUv.x < 0.002 || prevUv.x > 0.998 || prevUv.y < 0.002 || prevUv.y > 0.998) {
        gl_FragColor = vec4(cur, 1.0); return;
    }
    vec3 m1 = vec3(0.0), m2 = vec3(0.0);
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec3 tap = toYCoCg(max(vec3(0.0), texture2D(tCur, uv + vec2(float(x), float(y)) * uTexel).rgb));
            m1 += tap;
            m2 += tap * tap;
        }
    }
    m1 /= 9.0;
    vec3 sig = sqrt(max(vec3(0.0), m2 / 9.0 - m1 * m1));
    vec3 lo = m1 - sig * 1.15, hi = m1 + sig * 1.15;
    vec3 hist = toYCoCg(max(vec3(0.0), texture2D(tHist, prevUv).rgb));
    hist = clamp(hist, lo, hi);
    vec3 res = mix(cur, toRGB(hist), uBlend);
    gl_FragColor = vec4(res, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tDepth;
uniform sampler2D tVol;
uniform float uHasVol;
uniform vec4 uProj;
uniform vec2 uRes;
uniform float uTime;
uniform float uSpeed;
uniform float uRadial;
uniform float uMotion;
uniform float uRain;
uniform float uFlash;
uniform float uSlow;
uniform float uBloom;
uniform float uExposure;
uniform vec3 uSun;          // xy = screen uv, z = visibility
uniform vec3 uSunColor;
uniform int uHazeCount;
uniform vec4 uHaze[${MAX_HAZE}];     // xy = screen uv, z = radius (uv height), w = strength
uniform vec3 uHazeShape[${MAX_HAZE}]; // x = linear depth, yz = plume direction on screen (uv)
uniform float uMirage;
varying vec2 vUv;

#define PI 3.14159265

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
float linearDepth(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    return -(uProj.z * uProj.w) / ((uProj.w - uProj.z) * d - uProj.w);
}

// Hot air: a rising, wobbling refraction behind each exhaust (only over what is further
// away than the pipe) and, on a clear day, over the far road.
vec2 haze(vec2 uv, vec2 asp) {
    if (uHazeCount == 0 && uMirage <= 0.0) return vec2(0.0);
    float z = linearDepth(uv);
    vec2 off = vec2(0.0);
    for (int i = 0; i < ${MAX_HAZE}; i++) {
        if (i >= uHazeCount) break;
        vec4 h = uHaze[i];
        vec3 s = uHazeShape[i];
        if (z < s.x - 0.15) continue;
        vec2 d = (uv - h.xy) * asp;
        vec2 dir = normalize(s.yz * asp + vec2(1e-5));
        float along = dot(d, dir);
        float across = dot(d, vec2(-dir.y, dir.x));
        float len = length(s.yz * asp);
        float r = h.z;
        float m = smoothstep(-r * 0.4, r * 0.3, along) * (1.0 - smoothstep(len * 0.5, len + r, along));
        m *= exp(-across * across / (r * r * (0.35 + 1.2 * clamp(along / max(len, 1e-4), 0.0, 1.0))));
        if (m < 0.002) continue;
        vec2 q = vec2(across, along) / r * 3.0;
        vec2 n = vec2(vnoise(q * 1.7 + vec2(0.0, -uTime * 4.0)), vnoise(q * 2.3 + vec2(5.2, -uTime * 5.5))) - 0.5;
        off += n * m * h.w * r * 0.032;
    }
    if (uMirage > 0.0) {
        float far = smoothstep(55.0, 140.0, z) * (1.0 - smoothstep(380.0, 700.0, z));
        float roadLike = 1.0 - smoothstep(0.985, 0.999, texture2D(tScene, uv).a);
        float m = far * roadLike * uMirage;
        if (m > 0.0) {
            vec2 q = uv * vec2(150.0, 360.0);
            off.y += (vnoise(q + vec2(0.0, -uTime * 9.0)) - 0.5) * m * 0.0022;
            off.x += (vnoise(q * 0.7 + vec2(3.1, -uTime * 7.0)) - 0.5) * m * 0.0012;
        }
    }
    return off;
}

// One layer of drops on the lens: xy = refraction direction, z = coverage.
vec3 drops(vec2 q, float scale, float density) {
    vec2 g = q * scale;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 r = hash22(id);
    if (hash12(id + 17.31) > density) return vec3(0.0);
    // Each drop lives a few seconds, then a new one forms elsewhere in the cell.
    float life = fract(uTime * (0.08 + r.y * 0.1) + r.x);
    vec2 c = (hash22(id + floor(uTime * (0.08 + r.y * 0.1) + r.x)) - 0.5) * 0.45;
    c.y -= life * 0.25 * (0.3 + uSpeed);
    float rad = (0.1 + r.y * 0.13) * smoothstep(0.0, 0.1, life) * (1.0 - smoothstep(0.8, 1.0, life));
    vec2 dv = f - c;
    dv.x *= 1.0 + uSpeed * 0.6;
    float dist = length(dv);
    float m = smoothstep(rad, rad * 0.55, dist);
    return vec3(dv / max(rad, 1e-3) * m, m);
}

${TONE_GLSL}

void main() {
    vec2 asp = vec2(uRes.x / uRes.y, 1.0);
    vec2 uv = vUv;
    if (uMotion > 0.0) uv = clamp(uv + haze(vUv, asp), vec2(0.0), vec2(1.0));
    vec2 center = vec2(0.5, 0.5);
    vec2 toC = uv - center;

    // ── Speed: radial blur + fringing ──
    float bmask = smoothstep(0.18, 0.66, length(toC * asp));
    float amt = uSpeed * uSpeed * 0.032 * uMotion * bmask * uRadial;
    vec3 col = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        float t = float(i) / 7.0;
        col += texture2D(tScene, uv - toC * amt * t).rgb;
    }
    col /= 8.0;
    if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
    float ca = (0.0004 + uSpeed * 0.0018) * uMotion * bmask;
    col.r = mix(col.r, texture2D(tScene, uv + toC * ca).r, 0.7);
    col.b = mix(col.b, texture2D(tScene, uv - toC * ca).b, 0.7);

    // ── Lens rain ──
    if (uRain > 0.001) {
        vec2 q = (uv - vec2(0.5, 0.0)) * asp;
        vec3 d1 = drops(q, 7.0, 0.3 * uRain);
        vec3 d2 = drops(q + vec2(0.371, 0.113), 16.0, 0.25 * uRain);
        float m = max(d1.z, d2.z);
        vec2 n = d1.xy * 0.035 + d2.xy * 0.018;
        vec3 dropCol = texture2D(tScene, uv - n * 1.6).rgb * 1.05;
        col = mix(col, dropCol, m) * (1.0 - m * (1.0 - m) * 1.0);
    }

    // ── Bloom + depth-occluded volumetric light shafts toward the sun ──
    vec3 bloom = texture2D(tBloom, uv).rgb;
    col += bloom * uBloom;
    if (uSun.z > 0.001) {
        vec2 sp = uSun.xy;
        if (uHasVol > 0.5) {
            float volShaft = texture2D(tVol, uv).r;
            col += uSunColor * volShaft * uSun.z * 0.62;
        } else {
            vec2 dlt = (sp - uv) / 28.0;
            vec2 p = uv;
            vec3 shafts = vec3(0.0);
            float decay = 1.0;
            for (int i = 0; i < 28; i++) {
                p += dlt;
                vec3 b = texture2D(tBloom, p).rgb;
                shafts += b * decay;
                decay *= 0.95;
            }
            col += shafts / 28.0 * uSunColor * uSun.z * 0.9;
        }
        vec2 ds = (uv - sp) * asp;
        float glare = exp(-length(ds) * 7.0) * 0.35 + exp(-abs(ds.y) * 90.0) * exp(-abs(ds.x) * 3.0) * 0.12;
        // A few ghosts along the line through the centre.
        vec2 axis = (center - sp);
        float ghosts = 0.0;
        for (int g = 1; g <= 3; g++) {
            vec2 gp = sp + axis * (0.6 + float(g) * 0.45);
            ghosts += smoothstep(0.05 + float(g) * 0.02, 0.0, length((uv - gp) * asp)) * 0.05;
        }
        col += uSunColor * (glare + ghosts) * uSun.z;
    }

    // ── Speed lines (added after bloom so they stay crisp) ──
    vec2 dir = toC * asp;
    float len = length(dir);
    float ang = atan(dir.y, dir.x);
    float laneF = ang * 180.0 / PI;
    float lane = floor(laneF);
    float lr = hash12(vec2(lane, 3.1));
    float streak = step(0.94, lr) * smoothstep(0.42, 0.9, len);
    float travel = fract(len * 1.1 - uTime * (1.6 + lr * 2.0) + lr * 7.0);
    streak *= smoothstep(0.0, 0.05, travel) * smoothstep(0.32, 0.08, travel);
    streak *= smoothstep(0.22, 0.05, abs(fract(laneF) - 0.5));
    col += vec3(0.9, 0.95, 1.0) * streak * pow(uSpeed, 3.0) * 0.12 * uMotion;

    // ── Tone map + grade ──
    col = acesFilmic(col * uExposure / 0.6);
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(luma), col, 1.08);                       // a touch of saturation
    col = mix(col, vec3(luma) * vec3(0.9, 0.97, 1.08), uSlow * 0.55);
    float vig = smoothstep(0.5, 1.2, length(toC * asp * vec2(0.9, 1.0)));
    col *= 1.0 - vig * (0.35 + uSpeed * 0.15 * uMotion + uSlow * 0.35);
    col = mix(col, vec3(1.0, 0.98, 0.95), clamp(uFlash, 0.0, 1.0));
    col += (hash12(uv * uRes + fract(uTime * 7.3) * 91.0) - 0.5) * 0.004;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    #include <colorspace_fragment>
}`;

const LEVELS = { low: 3, medium: 4, high: 5 };
// Which depth passes each tier runs (low is the frame as it always was). Heat haze and the road
// mirage are off on every tier: the wavy refraction read as a smeared, hazy picture (2026-11-04).
// The shader paths stay; flip haze/mirage back on here to restore them.
const PASSES = {
    low: { ao: false, ssr: false, haze: false, blur: false, mirage: false, contact: false, ssgi: false, taa: false, vol: false },
    medium: { ao: true, ssr: true, haze: false, blur: false, mirage: false, contact: true, ssgi: false, taa: false, vol: true },
    high: { ao: true, ssr: true, haze: true, blur: true, mirage: false, contact: true, ssgi: true, taa: true, vol: true },
};
const HALTON8 = [
    [0.5, 0.333333], [0.25, 0.666667], [0.75, 0.111111], [0.125, 0.444444],
    [0.625, 0.777778], [0.375, 0.222222], [0.875, 0.555556], [0.0625, 0.888889],
];
const AO_RADIUS = 1.6;        // world units (a car is 3.9 long)
const AO_STRENGTH = 0.9;
const SHUTTER = 1 / 60;       // seconds of motion each frame smears (a 180° shutter at 30 fps)
const MAX_BLUR_PX = 32;
const TILE = 16;
const EXHAUST = new THREE.Vector3(-2.02, 0.3, 0.32);   // car-local (+X forward), cars.js

function target(w, h, samples = 0, depth = false) {
    return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
        type: THREE.HalfFloatType, samples, depthBuffer: samples > 0 || depth,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
}

function nearestTarget(w, h) {
    const t = target(w, h);
    t.texture.minFilter = THREE.NearestFilter;
    t.texture.magFilter = THREE.NearestFilter;
    return t;
}

export class PostFx {
    constructor(renderer) {
        this.renderer = renderer;
        this.size = new THREE.Vector2();
        this.quality = 'high';
        renderer.getDrawingBufferSize(this.size);
        this.sceneTarget = target(this.size.x, this.size.y, 4);
        // The depth the scene pass leaves behind, resolved out of the MSAA buffer every frame
        // (three blits depth with colour when a target has a depth texture).
        this.sceneTarget.depthTexture = new THREE.DepthTexture(this.size.x, this.size.y, THREE.FloatType);
        this.down = [];
        this.up = [];
        this.depthTargets = [];
        this.depthOk = true;

        const mat = (frag, uniforms, vert = QUAD_VERT) => new THREE.ShaderMaterial({
            vertexShader: vert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
        });
        const depthUniforms = () => ({
            tDepth: { value: this.sceneTarget.depthTexture },
            uProj: { value: new THREE.Vector4() },
            uDepthTexel: { value: new THREE.Vector2() },
        });
        this.brightMat = mat(BRIGHT_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.0 } });
        this.downMat = mat(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
        this.upMat = mat(UP_FRAG, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() } });
        this.aoMat = mat(GTAO_FRAG, { ...depthUniforms(), uRadius: { value: AO_RADIUS }, uRes: { value: new THREE.Vector2() } });
        this.aoBlurMat = mat(AO_BLUR_FRAG, { tAO: { value: null }, uTexel: { value: new THREE.Vector2() } });
        this.ssrMat = mat(SSR_FRAG, {
            ...depthUniforms(), tScene: { value: this.sceneTarget.texture },
            uProjM: { value: new THREE.Matrix4() }, uView: { value: new THREE.Matrix4() }, uInvView: { value: new THREE.Matrix4() },
            uWet: { value: 0 }, uMirage: { value: 0 }, uSky: { value: new THREE.Color() }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2() },
        });
        this.lightMat = mat(LIGHT_FRAG, {
            ...depthUniforms(), tScene: { value: this.sceneTarget.texture }, tAO: { value: null }, tSSR: { value: null },
            uProjM: { value: new THREE.Matrix4() }, uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.44).normalize() },
            uHalfTexel: { value: new THREE.Vector2() }, uAO: { value: 0 }, uSSR: { value: 0 },
            uContact: { value: 0 }, uGI: { value: 0 }, uRes: { value: new THREE.Vector2() },
            uLightCount: { value: 0 },
            uLightPos: { value: Array.from({ length: MAX_DYN_LIGHTS }, () => new THREE.Vector4()) },
            uLightCol: { value: Array.from({ length: MAX_DYN_LIGHTS }, () => new THREE.Vector4()) },
            uLightDir: { value: Array.from({ length: MAX_DYN_LIGHTS }, () => new THREE.Vector3()) },
        });
        this.volMat = mat(VOL_FRAG, {
            ...depthUniforms(), uSun: { value: new THREE.Vector3() }, uRes: { value: new THREE.Vector2() },
        });
        this.taaMat = mat(TAA_FRAG, {
            ...depthUniforms(), tCur: { value: null }, tHist: { value: null },
            uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
            uTexel: { value: new THREE.Vector2() }, uJitterUV: { value: new THREE.Vector2() }, uBlend: { value: 0.84 },
        });
        this.tileMat = mat(TILE_FRAG, { tVel: { value: null }, uVelTexel: { value: new THREE.Vector2() }, uTileUV: { value: new THREE.Vector2() } });
        this.neighborMat = mat(NEIGHBOR_FRAG, { tTile: { value: null }, uTexel: { value: new THREE.Vector2() } });
        this.motionMat = mat(MOTION_FRAG, {
            ...depthUniforms(), tColor: { value: null }, tVel: { value: null }, tNeighbor: { value: null },
            uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
            uScale: { value: 1 }, uMaxPx: { value: MAX_BLUR_PX }, uRes: { value: new THREE.Vector2() },
        });
        this.material = mat(COMPOSITE_FRAG, {
            tScene: { value: this.sceneTarget.texture },
            tBloom: { value: null },
            tDepth: { value: this.sceneTarget.depthTexture },
            tVol: { value: null },
            uHasVol: { value: 0 },
            uProj: { value: new THREE.Vector4() },
            uRes: { value: new THREE.Vector2(this.size.x, this.size.y) },
            uTime: { value: 0 },
            uSpeed: { value: 0 },
            uRadial: { value: 1 },
            uMotion: { value: 1 },
            uRain: { value: 0 },
            uFlash: { value: 0 },
            uSlow: { value: 0 },
            uBloom: { value: 0.7 },
            uExposure: { value: 1 },
            uSun: { value: new THREE.Vector3() },
            uSunColor: { value: new THREE.Color(1, 0.9, 0.75) },
            uHazeCount: { value: 0 },
            uHaze: { value: Array.from({ length: MAX_HAZE }, () => new THREE.Vector4()) },
            uHazeShape: { value: Array.from({ length: MAX_HAZE }, () => new THREE.Vector3()) },
            uMirage: { value: 0 },
        });
        this.insetMat = mat(INSET_FRAG, { tSrc: { value: null }, uExposure: { value: 1 } });
        this.insetTarget = null;
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.quad.frustumCulled = false;
        this.quadScene = new THREE.Scene();
        this.quadScene.add(this.quad);
        this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        // Velocity: a proxy per car mesh (sharing its geometry) in a scene of its own, each
        // with its own copy of the material so its last-frame matrix rides in its uniforms.
        this.velMat = new THREE.ShaderMaterial({
            vertexShader: VEL_VERT, fragmentShader: VEL_FRAG, side: THREE.DoubleSide,
            uniforms: {
                uPrevModel: { value: new THREE.Matrix4() },
                uPrevViewProj: { value: new THREE.Matrix4() },
                uIsInstanced: { value: 0 },
            },
        });
        this.velScene = new THREE.Scene();
        this.velScene.matrixWorldAutoUpdate = false;
        this.proxies = new WeakMap();
        this.proxyList = [];
        this.frame = 0;
        this.viewProj = new THREE.Matrix4();
        this.prevViewProj = new THREE.Matrix4();
        this.prevCamPos = new THREE.Vector3();
        this.prevCamDir = new THREE.Vector3();
        this.hasPrev = false;
        this.taaTargets = [];
        this.taaIdx = 0;
        this.taaValid = false;
        this.volTarget = null;
        this.jitterUV = new THREE.Vector2();
        this.lastTime = null;
        this.allProxies = new Set();
        this._v = new THREE.Vector3();
        this._w = new THREE.Vector3();
        this._a = new THREE.Vector3();
        this._b = new THREE.Vector3();
        this._clear = new THREE.Color();

        this.buildChain();
    }

    get passes() { return PASSES[this.quality] || PASSES.low; }

    setQuality(q) {
        if (!LEVELS[q] || q === this.quality) return;
        this.quality = q;
        this.buildChain();
    }

    buildChain() {
        for (const t of [...this.down, ...this.up, ...this.depthTargets]) t.dispose();
        this.down = [];
        this.up = [];
        this.depthTargets = [];
        let w = Math.max(1, this.size.x >> 1), h = Math.max(1, this.size.y >> 1);
        for (let i = 0; i < LEVELS[this.quality]; i++) {
            this.down.push(target(w, h));
            this.up.push(target(w, h));
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
        }
        const p = this.passes;
        const fw = this.size.x, fh = this.size.y;
        const hw = Math.max(1, fw >> 1), hh = Math.max(1, fh >> 1);
        const keep = (t) => { this.depthTargets.push(t); return t; };
        this.aoTarget = p.ao ? keep(nearestTarget(hw, hh)) : null;
        this.aoBlurTarget = p.ao ? keep(nearestTarget(hw, hh)) : null;
        this.ssrTarget = p.ssr ? keep(target(hw, hh)) : null;
        this.litTarget = p.ao || p.ssr ? keep(target(fw, fh)) : null;
        this.volTarget = p.vol ? keep(target(Math.max(1, fw >> 2), Math.max(1, fh >> 2))) : null;
        this.taaTargets = p.taa ? [keep(target(fw, fh)), keep(target(fw, fh))] : [];
        this.taaValid = false;
        this.taaIdx = 0;
        if (p.blur) {
            this.velTarget = keep(nearestTarget(hw, hh));
            this.velTarget.depthBuffer = true;
            this.tileTarget = keep(nearestTarget(Math.ceil(fw / TILE), Math.ceil(fh / TILE)));
            this.neighborTarget = keep(nearestTarget(Math.ceil(fw / TILE), Math.ceil(fh / TILE)));
            this.motionTarget = keep(target(fw, fh));
        } else {
            this.velTarget = this.tileTarget = this.neighborTarget = this.motionTarget = null;
        }
        this.hasPrev = false;
    }

    setSize() {
        this.renderer.getDrawingBufferSize(this.size);
        const w = Math.max(1, this.size.x), h = Math.max(1, this.size.y);
        if (this.sceneTarget.width !== w || this.sceneTarget.height !== h) {
            this.sceneTarget.setSize(w, h);
            this.buildChain();
        }
        this.material.uniforms.uRes.value.set(w, h);
    }

    pass(material, out) {
        this.quad.material = material;
        this.renderer.setRenderTarget(out);
        this.renderer.render(this.quadScene, this.quadCamera);
    }

    /** The per-frame camera uniforms every depth pass shares. */
    setDepthUniforms(camera) {
        const e = camera.projectionMatrix.elements;
        const w = this.sceneTarget.width, h = this.sceneTarget.height;
        for (const m of [this.aoMat, this.ssrMat, this.lightMat, this.motionMat, this.volMat, this.taaMat, this.material]) {
            const u = m.uniforms;
            u.uProj.value.set(e[0], e[5], camera.near, camera.far);
            u.uDepthTexel?.value.set(1 / w, 1 / h);
        }
    }

    render(scene, camera, fx, timeSeconds) {
        const r = this.renderer;
        const dt = this.lastTime === null ? 1 / 60 : Math.min(0.1, Math.max(1 / 240, timeSeconds - this.lastTime));
        this.lastTime = timeSeconds;
        this.frame++;
        const p = this.passes;
        const motion = !fx.reduced;
        const useTaa = this.depthOk && p.taa && motion && this.taaTargets.length === 2;
        const pe = camera.projectionMatrix.elements;
        const p8 = pe[8], p9 = pe[9];
        if (useTaa) {
            const h = HALTON8[this.frame & 7];
            const jx = h[0] - 0.5, jy = h[1] - 0.5;
            const fw = this.sceneTarget.width, fh = this.sceneTarget.height;
            pe[8] = p8 + (2 * jx) / fw;
            pe[9] = p9 + (2 * jy) / fh;
            this.jitterUV.set(jx / fw, jy / fh);
        } else {
            this.jitterUV.set(0, 0);
        }
        r.setRenderTarget(this.sceneTarget);
        try {
            r.render(scene, camera);
        } finally {
            pe[8] = p8;
            pe[9] = p9;
        }

        const deep = this.depthOk && (p.ao || p.ssr || p.haze || p.blur || p.vol || p.taa);
        let src = this.sceneTarget;
        let hasVol = false;
        if (deep) {
            try {
                camera.updateMatrixWorld();
                this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
                this.setDepthUniforms(camera);
                const cut = this.cameraCut(camera);
                if (p.ao || p.ssr) src = this.lighting(camera, fx, timeSeconds) || src;
                if (p.blur && motion) src = this.motionBlur(camera, fx, src, dt, cut) || src;
                else this.forgetMovers();
                if (useTaa) {
                    const readIdx = this.taaIdx, writeIdx = readIdx ^ 1;
                    const t = this.taaMat.uniforms;
                    t.tCur.value = src.texture;
                    t.tHist.value = this.taaTargets[readIdx].texture;
                    t.uInvViewProj.value.copy(this.viewProj).invert();
                    t.uPrevViewProj.value.copy(cut ? this.viewProj : this.prevViewProj);
                    t.uTexel.value.set(1 / src.width, 1 / src.height);
                    t.uJitterUV.value.copy(this.jitterUV);
                    t.uBlend.value = cut || !this.taaValid ? 0 : 0.84;
                    this.pass(this.taaMat, this.taaTargets[writeIdx]);
                    src = this.taaTargets[writeIdx];
                    this.taaIdx = writeIdx;
                    this.taaValid = true;
                } else {
                    this.taaValid = false;
                }
                if (p.vol && this.volTarget && fx.sun?.v > 0.002) {
                    const v = this.volMat.uniforms;
                    v.uSun.value.set(fx.sun.x, fx.sun.y, fx.sun.v);
                    v.uRes.value.set(this.volTarget.width, this.volTarget.height);
                    this.pass(this.volMat, this.volTarget);
                    hasVol = true;
                }
                this.prevViewProj.copy(this.viewProj);
                this.prevCamPos.copy(camera.position);
                camera.getWorldDirection(this.prevCamDir);
                this.hasPrev = true;
            } catch (e) {
                // A driver that cannot sample the resolved depth: drop back to the plain frame for good.
                this.depthOk = false;
                this.taaValid = false;
                src = this.sceneTarget;
                console.warn('pocabinet/postfx: depth passes off', e);
            }
        }

        // Bloom chain.
        const b = this.brightMat.uniforms;
        b.tSrc.value = src.texture;
        b.uTexel.value.set(1 / src.width, 1 / src.height);
        b.uThreshold.value = fx.bloomThreshold || 1.0;
        this.pass(this.brightMat, this.down[0]);
        for (let i = 1; i < this.down.length; i++) {
            const s = this.down[i - 1];
            this.downMat.uniforms.tSrc.value = s.texture;
            this.downMat.uniforms.uTexel.value.set(1 / s.width, 1 / s.height);
            this.pass(this.downMat, this.down[i]);
        }
        const last = this.down.length - 1;
        let acc = this.down[last];
        for (let i = last - 1; i >= 0; i--) {
            this.upMat.uniforms.tSrc.value = acc.texture;
            this.upMat.uniforms.tBase.value = this.down[i].texture;
            this.upMat.uniforms.uTexel.value.set(1 / acc.width, 1 / acc.height);
            this.pass(this.upMat, this.up[i]);
            acc = this.up[i];
        }

        const u = this.material.uniforms;
        u.tScene.value = src.texture;
        u.tBloom.value = acc.texture;
        u.tVol.value = hasVol ? this.volTarget.texture : null;
        u.uHasVol.value = hasVol ? 1 : 0;
        u.uTime.value = timeSeconds % 1000;
        u.uSpeed.value = Math.min(1, Math.max(0, fx.speed || 0));
        u.uMotion.value = motion ? 1 : 0;
        // With real motion blur the radial streak only has to add the stylised rush.
        u.uRadial.value = src === this.motionTarget || (useTaa && p.blur) ? 0.55 : 1;
        u.uRain.value = fx.rain || 0;
        u.uFlash.value = fx.flash || 0;
        u.uSlow.value = fx.slow || 0;
        u.uBloom.value = fx.bloom ?? 0.7;
        u.uExposure.value = fx.exposure || 1;
        if (fx.sun) u.uSun.value.set(fx.sun.x, fx.sun.y, fx.sun.v);
        else u.uSun.value.set(0, 0, 0);
        if (fx.sunColor) u.uSunColor.value.copy(fx.sunColor);
        if (deep && p.haze && motion) this.hazeUniforms(camera, fx, dt);
        else { u.uHazeCount.value = 0; u.uMirage.value = 0; }
        this.pass(this.material, null);
        this.quad.material = this.material;
    }

    /**
     * A second view (scene.js's picture-in-picture) into the canvas rectangle x, y, w, h (CSS px,
     * y from the bottom): rendered into a lightweight 0.75x non-MSAA linear HDR target reusing shadows (#19).
     */
    drawInset(scene, camera, x, y, w, h, exposure) {
        const r = this.renderer;
        const pr = r.getPixelRatio();
        const tw = Math.max(1, Math.round(w * pr * 0.75)), th = Math.max(1, Math.round(h * pr * 0.75));
        if (!this.insetTarget) this.insetTarget = target(tw, th, 0);
        else if (this.insetTarget.width !== tw || this.insetTarget.height !== th) this.insetTarget.setSize(tw, th);
        const prevShadow = r.shadowMap.autoUpdate;
        r.shadowMap.autoUpdate = false;
        r.setRenderTarget(this.insetTarget);
        try {
            r.render(scene, camera);
        } finally {
            r.shadowMap.autoUpdate = prevShadow;
        }
        this.insetMat.uniforms.tSrc.value = this.insetTarget.texture;
        this.insetMat.uniforms.uExposure.value = exposure;
        const full = r.getSize(this._full || (this._full = new THREE.Vector2()));
        this.quad.material = this.insetMat;
        r.setRenderTarget(null);
        r.setScissorTest(true);
        r.setScissor(x, y, w, h);
        r.setViewport(x, y, w, h);
        try {
            r.render(this.quadScene, this.quadCamera);
        } finally {
            r.setScissorTest(false);
            r.setViewport(0, 0, full.x, full.y);
            this.quad.material = this.material;
        }
    }

    /** True when the camera jumped (a cut, a snap): no motion this frame, it would smear the screen. */
    cameraCut(camera) {
        if (!this.hasPrev) return true;
        const moved = camera.position.distanceTo(this.prevCamPos);
        const dir = camera.getWorldDirection(this._v);
        return moved > 6 || dir.dot(this.prevCamDir) < 0.94;
    }

    /** GTAO + SSR + clustered dynamic lights onto the scene colour; returns the lit target, or null when inactive. */
    lighting(camera, fx, timeSeconds) {
        const p = this.passes;
        const ao = p.ao && this.aoTarget;
        const wet = Math.min(1, Math.max(0, fx.rain || 0));
        const mirage = p.mirage && !wet ? Math.max(0, Math.min(1, fx.mirage ?? 0)) : 0;
        const ssr = p.ssr && this.ssrTarget && (wet > 0.01 || mirage > 0.01 || this.quality === 'high');
        if (!ao && !ssr) return null;
        if (ao) {
            const a = this.aoMat.uniforms;
            a.uRes.value.set(this.aoTarget.width, this.aoTarget.height);
            this.pass(this.aoMat, this.aoTarget);
            this.aoBlurMat.uniforms.tAO.value = this.aoTarget.texture;
            this.aoBlurMat.uniforms.uTexel.value.set(1 / this.aoTarget.width, 1 / this.aoTarget.height);
            this.pass(this.aoBlurMat, this.aoBlurTarget);
        }
        if (ssr) {
            const s = this.ssrMat.uniforms;
            s.uProjM.value.copy(camera.projectionMatrix);
            s.uView.value.copy(camera.matrixWorldInverse);
            s.uInvView.value.copy(camera.matrixWorld);
            s.uWet.value = wet;
            s.uMirage.value = mirage;
            if (fx.skyColor) s.uSky.value.copy(fx.skyColor);
            s.uTime.value = timeSeconds % 1000;
            s.uRes.value.set(this.ssrTarget.width, this.ssrTarget.height);
            this.pass(this.ssrMat, this.ssrTarget);
        }
        const l = this.lightMat.uniforms;
        l.tAO.value = ao ? this.aoBlurTarget.texture : null;
        l.tSSR.value = ssr ? this.ssrTarget.texture : null;
        l.uProjM.value.copy(camera.projectionMatrix);
        const sunW = fx.sunDir || this._v.set(0.42, 0.80, 0.42);
        this._w.copy(sunW).normalize().transformDirection(camera.matrixWorldInverse);
        l.uSunDir.value.copy(this._w);
        l.uAO.value = ao ? AO_STRENGTH : 0;
        l.uSSR.value = ssr ? 1 : 0;
        l.uContact.value = p.contact && ao ? 1 : 0;
        l.uGI.value = p.ssgi && ao ? 1 : 0;
        l.uRes.value.set(this.litTarget.width, this.litTarget.height);
        const half = this.aoTarget || this.ssrTarget;
        l.uHalfTexel.value.set(1 / half.width, 1 / half.height);

        // Clustered 12 dynamic lights (view space) (#10).
        const lights = fx.lights;
        const nL = Array.isArray(lights) ? Math.min(MAX_DYN_LIGHTS, lights.length) : 0;
        l.uLightCount.value = nL;
        for (let i = 0; i < nL; i++) {
            const lt = lights[i];
            this._v.set(lt.x, lt.y, lt.z).applyMatrix4(camera.matrixWorldInverse);
            l.uLightPos.value[i].set(this._v.x, this._v.y, this._v.z, lt.radius || 8);
            l.uLightCol.value[i].set(lt.r || 1, lt.g || 1, lt.b || 1, lt.spot || 0);
            if (lt.spot > 0.01) {
                this._w.set(lt.dx || 0, lt.dy || 0, lt.dz || -1).normalize().transformDirection(camera.matrixWorldInverse);
                l.uLightDir.value[i].copy(this._w);
            }
        }
        this.pass(this.lightMat, this.litTarget);
        return this.litTarget;
    }

    /** The cars' velocity buffer, its tiles, then the gather; returns the blurred target. */
    motionBlur(camera, fx, src, dt, cut) {
        const r = this.renderer;
        this.updateProxies(fx.movers, cut);
        const vt = this.velTarget;
        const clear = r.getClearColor(this._clear).getHex(), alpha = r.getClearAlpha();
        r.setClearColor(0x000000, 0);
        r.setRenderTarget(vt);
        r.clear(true, true, false);
        if (this.velScene.children.length) r.render(this.velScene, camera);
        r.setClearColor(clear, alpha);
        this.storeProxies();

        const t = this.tileMat.uniforms;
        t.tVel.value = vt.texture;
        t.uVelTexel.value.set(1 / vt.width, 1 / vt.height);
        t.uTileUV.value.set(1 / this.tileTarget.width, 1 / this.tileTarget.height);
        this.pass(this.tileMat, this.tileTarget);
        this.neighborMat.uniforms.tTile.value = this.tileTarget.texture;
        this.neighborMat.uniforms.uTexel.value.set(1 / this.tileTarget.width, 1 / this.tileTarget.height);
        this.pass(this.neighborMat, this.neighborTarget);

        const m = this.motionMat.uniforms;
        m.tColor.value = src.texture;
        m.tVel.value = vt.texture;
        m.tNeighbor.value = this.neighborTarget.texture;
        m.uInvViewProj.value.copy(this.viewProj).invert();
        m.uPrevViewProj.value.copy(cut ? this.viewProj : this.prevViewProj);
        m.uScale.value = cut ? 0 : SHUTTER / dt;
        m.uRes.value.set(this.motionTarget.width, this.motionTarget.height);
        this.pass(this.motionMat, this.motionTarget);
        return this.motionTarget;
    }

    /** Point the velocity scene at this frame's visible car meshes (including CarCrowd instanced meshes #14). */
    updateProxies(movers, cut) {
        const list = this.proxyList;
        list.length = 0;
        const prevVP = cut || !this.hasPrev ? this.viewProj : this.prevViewProj;
        if (Array.isArray(movers)) {
            for (const g of movers) {
                if (!g || !g.visible) continue;
                g.traverseVisible((o) => {
                    if (!o.isMesh || o.isSkinnedMesh) return;
                    const m = o.material;
                    if (!m || (Array.isArray(m) ? m[0]?.depthWrite === false : m.depthWrite === false)) return;
                    if (o.isInstancedMesh) {
                        if (!o.count || !o.userData?.prevInstanceMatrix) return;
                        let p = this.proxies.get(o);
                        if (!p) {
                            const maxInst = o.instanceMatrix.count;
                            const pGeom = o.geometry.clone();
                            const prevArr = new Float32Array(maxInst * 16);
                            const ibuf = new THREE.InstancedInterleavedBuffer(prevArr, 16, 1).setUsage(THREE.DynamicDrawUsage);
                            pGeom.setAttribute('aPrevCol0', new THREE.InterleavedBufferAttribute(ibuf, 4, 0));
                            pGeom.setAttribute('aPrevCol1', new THREE.InterleavedBufferAttribute(ibuf, 4, 4));
                            pGeom.setAttribute('aPrevCol2', new THREE.InterleavedBufferAttribute(ibuf, 4, 8));
                            pGeom.setAttribute('aPrevCol3', new THREE.InterleavedBufferAttribute(ibuf, 4, 12));
                            const mat = this.velMat.clone();
                            mat.uniforms.uIsInstanced.value = 1;
                            p = new THREE.InstancedMesh(pGeom, mat, maxInst);
                            p.matrixAutoUpdate = false;
                            p.matrixWorldAutoUpdate = false;
                            p.parent = this.velScene;
                            p.prevInstArr = prevArr;
                            p.prevIBuf = ibuf;
                            p.seen = -1;
                            this.proxies.set(o, p);
                            this.allProxies.add(p);
                        }
                        p.count = Math.min(p.instanceMatrix.count, o.count);
                        p.frustumCulled = o.frustumCulled;
                        p.matrixWorld.copy(o.matrixWorld);
                        p.instanceMatrix.array.set(o.instanceMatrix.array);
                        p.instanceMatrix.needsUpdate = true;
                        const srcPrev = (cut || p.seen !== this.frame - 1) ? o.instanceMatrix.array : o.userData.prevInstanceMatrix;
                        p.prevInstArr.set(srcPrev.subarray(0, p.prevInstArr.length));
                        p.prevIBuf.needsUpdate = true;
                        const u = p.material.uniforms;
                        u.uIsInstanced.value = 1;
                        u.uPrevViewProj.value.copy(prevVP);
                        p.material.uniformsNeedUpdate = true;
                        list.push(p);
                        return;
                    }
                    let p = this.proxies.get(o);
                    if (!p) {
                        const mat = this.velMat.clone();
                        p = new THREE.Mesh(o.geometry, mat);
                        p.matrixAutoUpdate = false;
                        p.matrixWorldAutoUpdate = false;
                        p.parent = this.velScene;
                        p.prev = new THREE.Matrix4();
                        p.seen = -1;
                        this.proxies.set(o, p);
                        this.allProxies.add(p);
                    }
                    p.geometry = o.geometry;
                    p.frustumCulled = o.frustumCulled;
                    p.matrixWorld.copy(o.matrixWorld);
                    const u = p.material.uniforms;
                    u.uIsInstanced.value = 0;
                    // A mesh not drawn last frame has no motion yet.
                    u.uPrevModel.value.copy(cut || p.seen !== this.frame - 1 ? o.matrixWorld : p.prev);
                    u.uPrevViewProj.value.copy(prevVP);
                    p.material.uniformsNeedUpdate = true;
                    list.push(p);
                });
            }
        }
        this.velScene.children = list;
    }

    storeProxies() {
        for (const p of this.proxyList) {
            if (p.prev) p.prev.copy(p.matrixWorld);
            p.seen = this.frame;
        }
    }

    forgetMovers() {
        this.proxyList.length = 0;
        this.velScene.children = this.proxyList;
    }

    /**
     * Heat sources for the composite: each full car's exhaust (stronger idling, stretched back
     * at speed) plus anything fx.haze adds (the slipstream), projected to the screen.
     */
    hazeUniforms(camera, fx, dt) {
        const u = this.material.uniforms;
        const hz = u.uHaze.value, shape = u.uHazeShape.value;
        let n = 0;
        const add = (wx, wy, wz, tx, ty, tz, radius, strength) => {
            if (n >= MAX_HAZE || strength <= 0.01) return;
            const v = this._v.set(wx, wy, wz).applyMatrix4(camera.matrixWorldInverse);
            const depth = -v.z;
            if (depth < 0.5 || depth > 70) return;
            const s = this._v.set(wx, wy, wz).project(camera);
            const e = this._w.set(tx, ty, tz).project(camera);
            if (Math.abs(s.x) > 1.3 || Math.abs(s.y) > 1.3 || s.z > 1) return;
            const rUV = radius * camera.projectionMatrix.elements[5] * 0.5 / depth;
            hz[n].set(s.x * 0.5 + 0.5, s.y * 0.5 + 0.5, Math.min(0.25, rUV), strength * (1 - depth / 70));
            shape[n].set(depth, (e.x - s.x) * 0.5, (e.y - s.y) * 0.5);
            n++;
        };
        if (Array.isArray(fx.movers)) {
            for (const g of fx.movers) {
                if (n >= MAX_HAZE - 2) break;
                if (!g || !g.visible) continue;
                const mw = g.matrixWorld;
                // Speed from the car's own movement (world units/s), eased.
                const pos = this._a.setFromMatrixPosition(mw);
                const last = g.userData.hazeLast || (g.userData.hazeLast = pos.clone());
                const v = Math.min(40, pos.distanceTo(last) / dt);
                last.copy(pos);
                const speed = g.userData.hazeSpeed = (g.userData.hazeSpeed ?? v) * 0.85 + v * 0.15;
                // Moving cars trail their heat back; a car at rest sends it straight up.
                const a = this._a.copy(EXHAUST).applyMatrix4(mw);
                const tail = this._b.set(EXHAUST.x - 0.8 - Math.min(3, speed * 0.25), EXHAUST.y + 1.1 - Math.min(0.8, speed * 0.06), EXHAUST.z).applyMatrix4(mw);
                add(a.x, a.y, a.z, tail.x, tail.y, tail.z, 0.42, 1.0 - Math.min(0.5, speed * 0.03));
            }
        }
        if (Array.isArray(fx.haze)) {
            for (const h of fx.haze) {
                add(h.x, h.y, h.z, h.tx, h.ty, h.tz, h.radius || 1, h.strength || 0);
            }
        }
        u.uHazeCount.value = n;
        u.uMirage.value = this.passes.mirage && !(fx.rain > 0) ? Math.max(0, Math.min(1, fx.mirage ?? 0)) : 0;
    }

    dispose() {
        this.sceneTarget.depthTexture?.dispose();
        this.sceneTarget.dispose();
        this.insetTarget?.dispose();
        this.insetMat.dispose();
        for (const t of [...this.down, ...this.up, ...this.depthTargets]) t.dispose();
        for (const m of [this.brightMat, this.downMat, this.upMat, this.material, this.aoMat, this.aoBlurMat,
            this.ssrMat, this.lightMat, this.volMat, this.taaMat, this.tileMat, this.neighborMat, this.motionMat, this.velMat]) m.dispose();
        for (const p of this.allProxies) {
            p.material.dispose();
            if (p.isInstancedMesh) p.geometry.dispose();
        }
        this.allProxies.clear();
        this.quad.geometry.dispose();
    }
}
