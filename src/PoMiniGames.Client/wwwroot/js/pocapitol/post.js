import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createRackFocus } from '../postFx.js';

// PoCapitol's frame: scene -> ambient occlusion -> bloom -> (transient) depth of field ->
// tone map -> grade. The scene always goes through the composer, even with every optional
// pass off, so a quality change never flips the scene's shaders between "to screen" and
// "to target" variants (that recompile is the multi-second hitch quality.js exists to avoid).

// Display-space grade: a touch of desaturation, cool shadows and warm highlights (a winter
// news-camera look), a vignette and fine grain.
const GradeShader = {
    uniforms: {
        tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.035 },
        uVignette: { value: 0.32 }, uSaturation: { value: 0.88 },
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
            c.rgb *= 1.0 - uVignette * dot(d, d) * 1.8;
            float n = fract(sin(dot(vUv * 913.7 + fract(uTime) * 71.3, vec2(12.9898, 78.233))) * 43758.5453);
            c.rgb += (n - 0.5) * uGrain;
            gl_FragColor = c;
        }`,
};

/**
 * @param depthCamera a camera that sees only layer 0: AO and depth of field read its depth, so
 *   sprites, sky and decals (layer 1) are not mistaken for solid geometry.
 */
export function createPost(renderer, scene, camera, depthCamera) {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));

    const ao = new GTAOPass(scene, depthCamera, 1, 1);
    ao.blendIntensity = 0.85;
    ao.updateGtaoMaterial({ radius: 0.7, distanceExponent: 1.5, thickness: 1, scale: 1, samples: 12 });
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    composer.addPass(ao);

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
    /** 3: everything; 2: no AO or depth of field; 1: MSAA and grade only; 0: grade only. */
    function setLevel(level) {
        ao.enabled = level >= 3;
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
    }
    function render(dt, time, calm) {
        grade.uniforms.uTime.value = time;
        grade.uniforms.uGrain.value = calm ? 0 : 0.035;
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
