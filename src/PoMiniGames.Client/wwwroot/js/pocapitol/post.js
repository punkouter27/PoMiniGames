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
            vec2 stepUv = (uLightDir.xz * vec2(1.0, -1.0) / uResolution) * (3.5 + (1.0 - depth) * 10.0);
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
        uniform float uCameraNear, uCameraFar, uBounceIntensity, uTime;
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
            float radius = (1.0 - depth * 0.65) * 26.0 / uResolution.y;

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

// Display-space grade: clean tone mapping, realistic saturation, subtle vignette with zero artificial grain noise.
const GradeShader = {
    uniforms: {
        tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.0 },
        uVignette: { value: 0.22 }, uSaturation: { value: 0.94 },
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uTime, uGrain, uVignette, uSaturation;
        varying vec2 vUv;
        void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
            c.rgb = mix(vec3(l), c.rgb, uSaturation);
            c.rgb += vec3(-0.012, 0.0, 0.022) * (1.0 - l) + vec3(0.018, 0.006, -0.014) * l;
            vec2 d = vUv - 0.5;
            c.rgb *= 1.0 - uVignette * dot(d, d) * 1.5;
            gl_FragColor = c;
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

    const focus = createRackFocus(scene, depthCamera, 1, 1);
    composer.addPass(focus.pass);

    composer.addPass(new OutputPass());
    const grade = new ShaderPass(GradeShader);
    composer.addPass(grade);

    let samples = 4, dofAllowed = true;
    /** 3: everything clean; 2: bloom only; 1: MSAA and grade only; 0: grade only. */
    function setLevel(level) {
        ao.enabled = level >= 3;
        sscsPass.enabled = false;
        ssgiPass.enabled = false;
        ssrPass.enabled = level >= 3;
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
    }
    function render(dt, time, calm) {
        grade.uniforms.uTime.value = time;
        grade.uniforms.uGrain.value = 0.0;
        focus.update(dt);
        composer.render(dt);
    }
    return {
        setLevel, setSize, render,
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
