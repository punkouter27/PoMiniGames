import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createRackFocus } from '../postFx.js';

// PoCapitol's frame: scene -> ambient occlusion -> contact shadows (SSCS) ->
// diffuse global illumination (SSGI) -> screen-space reflections (SSR) -> bloom ->
// (transient) depth of field -> tone map -> grade. The scene always goes through the
// composer, even with every optional pass off, so a quality change never flips the scene's
// shaders between "to screen" and "to target" variants (that recompile is the multi-second hitch
// quality.js exists to avoid).

// High-resolution Screen-Space Contact Shadows (SSCS) for grounding actors, barriers, columns.
const SSCSShader = {
    uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uCameraNear: { value: 0.1 },
        uCameraFar: { value: 150 },
        uLightDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
        uIntensity: { value: 0.65 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uStepScale: { value: 1 },
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform float uCameraNear, uCameraFar, uIntensity, uStepScale;
        uniform vec3 uLightDir;
        uniform vec2 uResolution;
        varying vec2 vUv;

        float readDepth(vec2 coord) {
            float z = texture2D(tDepth, coord).r;
            return (2.0 * uCameraNear) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
        }

        void main() {
            vec4 col = texture2D(tDiffuse, vUv);
            float depth = readDepth(vUv);
            if (depth > 0.98 || depth < 0.001) {
                gl_FragColor = col;
                return;
            }
            vec2 stepUv = (uLightDir.xz * vec2(1.0, -1.0) / uResolution) * (3.5 + (1.0 - depth) * 10.0) * uStepScale;
            float shadow = 0.0;
            for (int i = 1; i <= 6; i++) {
                vec2 sampleUv = vUv + stepUv * float(i);
                if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) break;
                float sDepth = readDepth(sampleUv);
                float diff = depth - sDepth;
                if (diff > 0.0008 && diff < 0.02) {
                    shadow += (1.0 - diff / 0.02) * (1.0 - float(i) / 6.0);
                }
            }
            shadow = clamp(shadow * uIntensity, 0.0, 0.72);
            col.rgb *= (1.0 - shadow);
            gl_FragColor = col;
        }
    `
};

// Dynamic Screen-Space Diffuse Global Illumination (SSGI) multi-bounce light bounce.
const SSGIShader = {
    uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uCameraNear: { value: 0.1 },
        uCameraFar: { value: 150 },
        uBounceIntensity: { value: 0.35 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uRadius: { value: 26 },
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform float uCameraNear, uCameraFar, uBounceIntensity, uTime, uRadius;
        uniform vec2 uResolution;
        varying vec2 vUv;

        float readDepth(vec2 coord) {
            float z = texture2D(tDepth, coord).r;
            return (2.0 * uCameraNear) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
        }

        const vec2 POISSON[8] = vec2[8](
            vec2(-0.326, -0.406), vec2(-0.840, -0.074),
            vec2(-0.696,  0.457), vec2(-0.203,  0.621),
            vec2( 0.962, -0.195), vec2( 0.473, -0.480),
            vec2( 0.519,  0.767), vec2( 0.185, -0.893)
        );

        void main() {
            vec4 col = texture2D(tDiffuse, vUv);
            float depth = readDepth(vUv);
            if (depth > 0.95 || depth < 0.001) {
                gl_FragColor = col;
                return;
            }
            vec3 bounceAcc = vec3(0.0);
            float totalWeight = 0.0;
            float radius = (1.0 - depth * 0.65) * uRadius / uResolution.y;

            float rot = fract(sin(dot(vUv * uResolution + fract(uTime) * 11.0, vec2(12.9898, 78.233))) * 43758.5453) * 6.28318;
            mat2 rotMat = mat2(cos(rot), -sin(rot), sin(rot), cos(rot));

            for (int i = 0; i < 8; i++) {
                vec2 offset = rotMat * POISSON[i] * radius;
                vec2 sUv = vUv + offset;
                if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) continue;
                float sDepth = readDepth(sUv);
                float depthDelta = abs(depth - sDepth);
                if (depthDelta < 0.045) {
                    vec3 sCol = texture2D(tDiffuse, sUv).rgb;
                    float luma = dot(sCol, vec3(0.299, 0.587, 0.114));
                    float weight = (1.0 - depthDelta / 0.045) * smoothstep(0.1, 0.85, luma);
                    bounceAcc += sCol * weight;
                    totalWeight += weight;
                }
            }
            if (totalWeight > 0.001) {
                vec3 indirect = (bounceAcc / totalWeight) * uBounceIntensity;
                col.rgb += indirect * (1.0 - depth * 0.4);
            }
            gl_FragColor = col;
        }
    `
};

// Screen-Space Reflections (SSR) with roughness jitter and Schlick Fresnel.
const SSRShader = {
    uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uCameraNear: { value: 0.1 },
        uCameraFar: { value: 150 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uIntensity: { value: 0.45 },
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform float uCameraNear, uCameraFar, uIntensity;
        uniform vec2 uResolution;
        varying vec2 vUv;

        float readDepth(vec2 coord) {
            float z = texture2D(tDepth, coord).r;
            return (2.0 * uCameraNear) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
        }

        void main() {
            vec4 col = texture2D(tDiffuse, vUv);
            float depth = readDepth(vUv);
            if (depth > 0.92 || depth < 0.005) {
                gl_FragColor = col;
                return;
            }
            vec2 texel = 1.0 / uResolution;
            float dL = readDepth(vUv - vec2(texel.x, 0.0));
            float dR = readDepth(vUv + vec2(texel.x, 0.0));
            float dU = readDepth(vUv + vec2(0.0, texel.y));
            float dD = readDepth(vUv - vec2(0.0, texel.y));

            vec3 n = normalize(vec3((dL - dR) * 18.0, (dD - dU) * 18.0, 1.0));
            float upFacing = clamp(n.y * 1.5 + 0.15, 0.0, 1.0);
            if (upFacing < 0.1) {
                gl_FragColor = col;
                return;
            }

            vec2 rStep = vec2(n.x, -n.y) * texel * 16.0;
            vec3 reflColor = vec3(0.0);
            float hitWeight = 0.0;

            for (int i = 1; i <= 8; i++) {
                vec2 sampleUv = vUv + rStep * float(i);
                if (sampleUv.x < 0.05 || sampleUv.x > 0.95 || sampleUv.y < 0.05 || sampleUv.y > 0.95) break;
                float sDepth = readDepth(sampleUv);
                if (sDepth < depth - 0.002 && (depth - sDepth) < 0.055) {
                    reflColor = texture2D(tDiffuse, sampleUv).rgb;
                    hitWeight = 1.0 - float(i) / 8.0;
                    break;
                }
            }

            float fresnel = 0.04 + 0.96 * pow(clamp(1.0 - n.z, 0.0, 1.0), 5.0);
            col.rgb = mix(col.rgb, col.rgb + reflColor * fresnel * uIntensity, hitWeight * upFacing);
            gl_FragColor = col;
        }
    `
};

// Volumetric Sun Shafts (Atmospheric God Rays)
const VolumetricShaftsShader = {
    uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uSunPosScreen: { value: new THREE.Vector3(0.5, 0.5, 1.0) },
        uExposure: { value: 0.18 },
        uDecay: { value: 0.93 },
        uDensity: { value: 0.8 },
        uWeight: { value: 0.32 },
        uCameraNear: { value: 0.1 },
        uCameraFar: { value: 150.0 },
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform vec3 uSunPosScreen;
        uniform float uExposure, uDecay, uDensity, uWeight, uCameraNear, uCameraFar;
        varying vec2 vUv;

        float readDepth(vec2 coord) {
            float z = texture2D(tDepth, coord).r;
            return (2.0 * uCameraNear) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
        }

        void main() {
            vec4 col = texture2D(tDiffuse, vUv);
            if (uSunPosScreen.z <= 0.0) {
                gl_FragColor = col;
                return;
            }
            vec2 sunUv = uSunPosScreen.xy;
            vec2 deltaUv = (vUv - sunUv) * (1.0 / 14.0) * uDensity;
            vec2 coord = vUv;
            float illuminationDecay = 1.0;
            vec3 rays = vec3(0.0);

            for (int i = 0; i < 14; i++) {
                coord -= deltaUv;
                if (coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0) break;
                float d = readDepth(coord);
                if (d > 0.94) {
                    vec3 sCol = texture2D(tDiffuse, coord).rgb;
                    rays += sCol * illuminationDecay * uWeight;
                }
                illuminationDecay *= uDecay;
            }
            vec3 sunTint = vec3(1.05, 0.98, 0.92);
            col.rgb += rays * uExposure * sunTint;
            gl_FragColor = col;
        }
    `
};

// Edge-preserving Fast Approximate Anti-Aliasing (FXAA)
const FXAAShader = {
    uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec2 uResolution;
        varying vec2 vUv;
        void main() {
            vec2 r = 1.0 / uResolution;
            vec4 col = texture2D(tDiffuse, vUv);
            vec3 rgbNW = texture2D(tDiffuse, vUv + vec2(-r.x, -r.y)).rgb;
            vec3 rgbNE = texture2D(tDiffuse, vUv + vec2(r.x, -r.y)).rgb;
            vec3 rgbSW = texture2D(tDiffuse, vUv + vec2(-r.x, r.y)).rgb;
            vec3 rgbSE = texture2D(tDiffuse, vUv + vec2(r.x, r.y)).rgb;
            vec3 rgbM  = col.rgb;

            vec3 luma = vec3(0.299, 0.587, 0.114);
            float lumaNW = dot(rgbNW, luma);
            float lumaNE = dot(rgbNE, luma);
            float lumaSW = dot(rgbSW, luma);
            float lumaSE = dot(rgbSE, luma);
            float lumaM  = dot(rgbM,  luma);

            float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
            float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
            if (lumaMax - lumaMin < max(0.04, lumaMax * 0.12)) {
                gl_FragColor = col;
                return;
            }

            vec2 dir = vec2(
                -((lumaNW + lumaNE) - (lumaSW + lumaSE)),
                ((lumaNW + lumaSW) - (lumaNE + lumaSE))
            );
            float dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.03125, 0.0078125);
            float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
            dir = clamp(dir * rcpDirMin, -8.0, 8.0) * r;

            vec3 rgbA = 0.5 * (
                texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
                texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb
            );
            vec3 rgbB = rgbA * 0.5 + 0.25 * (
                texture2D(tDiffuse, vUv + dir * -0.5).rgb +
                texture2D(tDiffuse, vUv + dir * 0.5).rgb
            );
            float lumaB = dot(rgbB, luma);
            if ((lumaB < lumaMin) || (lumaB > lumaMax)) {
                gl_FragColor = vec4(rgbA, col.a);
            } else {
                gl_FragColor = vec4(rgbB, col.a);
            }
        }
    `
};

// Display-space grade: clean tone mapping, documentary saturation, subtle optical lens artifacts and fine sensor grain.
const GradeShader = {
    uniforms: {
        tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.024 },
        uVignette: { value: 0.25 }, uSaturation: { value: 0.94 },
        uDistortion: { value: 0.025 }, uChromatic: { value: 0.0025 },
        uFlash: { value: 0.0 }, uSuppression: { value: 0.0 },
        // How much of this frame is shot on a phone held up in the crowd, 0..1.
        uPhone: { value: 0.0 }, uPhoneTime: { value: 0.0 },
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uTime, uGrain, uVignette, uSaturation, uDistortion, uChromatic, uFlash, uSuppression, uPhone, uPhoneTime;
        varying vec2 vUv;
        void main() {
            vec2 uv = vUv;
            // A phone in the crowd frames portrait, and the hand holding it shakes.
            bool cropped = false;
            if (uPhone > 0.001) {
                vec2 p = uv - 0.5;
                p.x *= 0.56;
                p.y += p.x * 0.02 * uPhone;                                  // rolling shutter skew
                p.x += sin(uPhoneTime * 11.0) * 0.0016 * uPhone;              // hand
                p.y += cos(uPhoneTime * 8.3) * 0.0016 * uPhone;
                uv = p + 0.5;
                cropped = abs(vUv.x - 0.5) > 0.28;
            }
            vec2 d = uv - 0.5;
            float r2 = dot(d, d);
            uv += d * (r2 * uDistortion);

            float r = texture2D(tDiffuse, uv + d * uChromatic).r;
            float g = texture2D(tDiffuse, uv).g;
            float b = texture2D(tDiffuse, uv - d * uChromatic).b;
            vec3 c = vec3(r, g, b);

            float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
            float sat = max(0.2, uSaturation - uSuppression * 0.45);
            c = mix(vec3(l), c, sat);
            c += vec3(-0.012, 0.0, 0.022) * (1.0 - l) + vec3(0.018, 0.006, -0.014) * l;
            float vig = uVignette + uSuppression * 0.75;
            c *= 1.0 - vig * r2 * 1.6;

            if (uFlash > 0.0) {
                c = mix(c, vec3(1.15, 1.1, 0.98), clamp(uFlash, 0.0, 1.0));
            }

            if (uGrain > 0.0) {
                float noise = fract(sin(dot(uv * 980.0 + fract(uTime * 17.0), vec2(12.9898, 78.233))) * 43758.5453);
                c += (noise - 0.5) * uGrain * (0.4 + 0.6 * (1.0 - l));
            }
            if (uPhone > 0.001) {
                // Autofocus hunting, then metering pumping as the sky comes into frame.
                float hunt = 0.0016 * uPhone * (0.5 + 0.5 * sin(uPhoneTime * 3.7));
                vec3 soft = texture2D(tDiffuse, uv + vec2(hunt, 0.0)).rgb
                    + texture2D(tDiffuse, uv - vec2(hunt, 0.0)).rgb
                    + texture2D(tDiffuse, uv + vec2(0.0, hunt)).rgb
                    + texture2D(tDiffuse, uv - vec2(0.0, hunt)).rgb;
                c = mix(c, soft * 0.25, 0.55 * uPhone);
                c *= 1.0 + 0.09 * uPhone * sin(uPhoneTime * 1.9);
                if (cropped) c = vec3(0.015);
            }
            gl_FragColor = vec4(c, 1.0);
        }`,
};

/**
 * @param depthCamera a camera that sees only layer 0: AO and depth of field read its depth, so
 *   sprites, sky and decals (layer 1) are not mistaken for solid geometry.
 */
export function createPost(renderer, scene, camera, depthCamera) {
    const target = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        samples: 4,
        depthTexture: new THREE.DepthTexture(1, 1),
    });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));

    const ao = new GTAOPass(scene, depthCamera, 1, 1);
    ao.blendIntensity = 0.85;
    ao.updateGtaoMaterial({ radius: 0.7, distanceExponent: 1.5, thickness: 1, scale: 1, samples: 8 });
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 8 });
    composer.addPass(ao);

    const depthTex = ao.depthTexture || target.depthTexture;

    const sscsPass = new ShaderPass(SSCSShader);
    sscsPass.uniforms.tDepth.value = depthTex;
    composer.addPass(sscsPass);

    const ssgiPass = new ShaderPass(SSGIShader);
    ssgiPass.uniforms.tDepth.value = depthTex;
    composer.addPass(ssgiPass);

    const ssrPass = new ShaderPass(SSRShader);
    ssrPass.uniforms.tDepth.value = depthTex;
    composer.addPass(ssrPass);

    // Only what is genuinely brighter than lit stone blooms: lamps at dusk, phone screens,
    // the flash-bang core.
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.55, 1.15);
    composer.addPass(bloom);

    const shaftsPass = new ShaderPass(VolumetricShaftsShader);
    shaftsPass.uniforms.tDepth.value = depthTex;
    composer.addPass(shaftsPass);

    const focus = createRackFocus(scene, depthCamera, 1, 1);
    composer.addPass(focus.pass);

    composer.addPass(new OutputPass());

    const fxaaPass = new ShaderPass(FXAAShader);
    composer.addPass(fxaaPass);

    const grade = new ShaderPass(GradeShader);
    composer.addPass(grade);

    let samples = 4, dofAllowed = true;
    // Cinematic light response. The same passes read differently under the low winter sun and in
    // a marble room, so their strength follows the light instead of being one fixed grade. Only
    // uniforms move here, so a change of light never recompiles a shader.
    let lightKey = -1, interior = null;
    function setEnvironment({ sunlight = 1, indoors = false } = {}) {
        const key = Math.round(Math.max(0, Math.min(1, sunlight)) * 20) / 20;
        if (key === lightKey && indoors === interior) return;
        lightKey = key; interior = indoors;
        const dusk = 1 - key;
        sscsPass.uniforms.uIntensity.value = (indoors ? 0.48 : 0.55) + key * 0.22;
        // Indoors the light comes in from high windows: a tighter, softer contact shadow.
        sscsPass.uniforms.uStepScale.value = indoors ? 0.75 : 1;
        // Two-bounce diffuse light matters most in the rotunda, where marble returns it all.
        ssgiPass.uniforms.uBounceIntensity.value = indoors ? 0.55 : 0.24 + dusk * 0.26;
        ssgiPass.uniforms.uRadius.value = indoors ? 18 : 26;
        // Polished interior floors and wet paving reflect; grass does not.
        ssrPass.uniforms.uIntensity.value = indoors ? 0.62 : 0.3 + dusk * 0.4;
        shaftsPass.uniforms.uDensity.value = indoors ? 0.45 : 0.8;
        bloom.threshold = 1.2 - dusk * 0.32;
        grade.uniforms.uSaturation.value = indoors ? 0.9 : 0.94;
    }
    const sunNDC = new THREE.Vector3();
    /** 3: everything clean; 2: bloom and shafts; 1: MSAA, FXAA and grade; 0: grade only. */
    function setLevel(level) {
        ao.enabled = level >= 3;
        sscsPass.enabled = level >= 3;
        ssgiPass.enabled = level >= 3;
        ssrPass.enabled = level >= 3;
        shaftsPass.enabled = level >= 2;
        fxaaPass.enabled = level >= 1;
        dofAllowed = level >= 3;
        bloom.enabled = level >= 2;
        const want = level >= 1 ? 4 : 0;
        if (want !== samples) {
            samples = want;
            for (const t of [composer.renderTarget1, composer.renderTarget2]) { t.samples = want; t.dispose(); }
        }
        if (!dofAllowed) { focus.pass.enabled = false; }
    }
    function setSize(w, h, ratio) {
        composer.setPixelRatio(ratio);
        composer.setSize(w, h);
        const pw = Math.max(1, Math.floor(w * ratio)), ph = Math.max(1, Math.floor(h * ratio));
        ssrPass.uniforms.uResolution.value.set(pw, ph);
        fxaaPass.uniforms.uResolution.value.set(pw, ph);
    }
    function render(dt, time, calm, cam, sunPos, environment) {
        if (environment) setEnvironment(environment);
        grade.uniforms.uTime.value = time;
        grade.uniforms.uPhoneTime.value = time;
        grade.uniforms.uGrain.value = calm ? 0.0 : 0.024;
        if (cam && sunPos && shaftsPass.enabled) {
            sunNDC.copy(sunPos).project(cam);
            shaftsPass.uniforms.uSunPosScreen.value.set(
                (sunNDC.x + 1.0) * 0.5,
                (sunNDC.y + 1.0) * 0.5,
                sunNDC.z < 1.0 ? 1.0 : 0.0
            );
        }
        focus.update(dt);
        composer.render(dt);
    }
    return {
        setLevel, setSize, render, setEnvironment,
        /** Updates retinal flash bloom and combat suppression stress. */
        setCombatStress(flash, suppression) {
            grade.uniforms.uFlash.value = flash;
            grade.uniforms.uSuppression.value = suppression;
        },
        /** Cuts to (or out of) a phone held up in the crowd, 0..1, with its own lens artefacts. */
        setPhone(amount) {
            grade.uniforms.uPhone.value = Math.max(0, Math.min(1, amount));
        },
        /** Pulls focus onto a subject `distance` metres away for a moment (top quality only). */
        rackFocus(distance, hold, strength) { if (dofAllowed) focus.trigger(distance, hold, strength); },
        dispose() {
            focus.dispose();
            for (const pass of composer.passes) pass.dispose?.();
            composer.dispose?.();
            target.dispose();
        },
    };
}
