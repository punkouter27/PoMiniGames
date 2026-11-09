// FFA's depth-only screen-space AO needs no second fighter/normal render.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const vertexShader = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export function ffaFxaaShader(shader = FXAAShader) {
  // Three r165 requests -100 LOD bias; ANGLE warns outside [-16,15.99].
  // Composer textures have no mipmaps, so valid -16 still samples the same level.
  return {
    ...shader,
    fragmentShader: shader.fragmentShader.replace(/-100\.0\b/g, '-16.0'),
  };
}

export const aoFragment = `
uniform sampler2D tDepth;
uniform mat4 inverseProjection;
uniform vec2 resolution;
varying vec2 vUv;
vec3 viewPoint(vec2 uv, float d) {
  vec4 p = inverseProjection * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
void main() {
  float depth = texture2D(tDepth, vUv).x;
  vec3 center = viewPoint(vUv, depth);
  vec3 dx = dFdx(center), dy = dFdy(center);
  vec3 normal = normalize(cross(dx, dy));
  if (normal.z < 0.0) normal = -normal;
  float occlusion = 0.0;
  // View-space radius, with a bounded pixel radius near the camera.
  float radius = clamp(0.35 * resolution.y / max(-center.z, 0.1), 2.0, 24.0);
  for (int i = 0; i < 8; i++) {
    float angle = float(i) * 2.399963;
    vec2 offset = vec2(cos(angle), sin(angle)) * radius * sqrt((float(i) + 0.5) / 8.0);
    vec2 uv = clamp(vUv + offset / resolution, vec2(0.001), vec2(0.999));
    vec3 delta = viewPoint(uv, texture2D(tDepth, uv).x) - center;
    float distanceToSample = length(delta);
    float horizon = max(dot(normal, delta / max(distanceToSample, 0.001)) - 0.12, 0.0);
    occlusion += horizon * (1.0 - smoothstep(0.08, 0.65, distanceToSample));
  }
  float ao = depth > 0.99999 ? 1.0 : 1.0 - clamp(occlusion * 0.12, 0.0, 0.3);
  gl_FragColor = vec4(ao, depth, 0.0, 1.0);
}`;

const compositeFragment = `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  float depth = texture2D(tDepth, vUv).x;
  float total = 0.0, weight = 0.0;
  for (int i = 0; i < 5; i++) {
    vec2 offset = i == 0 ? vec2(0.0) : i == 1 ? vec2(1.0,0.0) :
      i == 2 ? vec2(-1.0,0.0) : i == 3 ? vec2(0.0,1.0) : vec2(0.0,-1.0);
    vec2 a = texture2D(tAO, vUv + offset * texel).rg;
    float w = exp(-abs(a.g - depth) * 2500.0);
    total += a.r * w; weight += w;
  }
  vec4 color = texture2D(tDiffuse, vUv);
  gl_FragColor = vec4(color.rgb * (weight > 0.0001 ? total / weight : 1.0), color.a);
}`;

export const gradeFragment = `
uniform sampler2D tDiffuse;
uniform vec2 hitUV;
uniform vec2 texel;
uniform float hit;
uniform float aspect;
varying vec2 vUv;
void main() {
  vec2 radial = (vUv - hitUV) * vec2(aspect, 1.0);
  float local = exp(-dot(radial, radial) * 90.0) * hit;
  // A tiny local refractive RGB split: no whole-frame white flash.
  vec2 bend = normalize(radial + vec2(0.00001)) * texel * local * 1.8;
  vec3 color = texture2D(tDiffuse, vUv).rgb;
  color.r = texture2D(tDiffuse, clamp(vUv + bend, 0.0, 1.0)).r;
  color.b = texture2D(tDiffuse, clamp(vUv - bend, 0.0, 1.0)).b;
  float luma = dot(color, vec3(0.2126,0.7152,0.0722));
  color *= mix(vec3(0.985,1.0,1.018), vec3(1.018,1.004,0.985), smoothstep(0.05,1.2,luma));
  color += vec3(0.022,0.014,0.005) * local;
  vec2 edge = vUv - 0.5;
  color *= 1.0 - dot(edge, edge) * 0.09;
  gl_FragColor = vec4(color, 1.0);
}`;

class DepthAO extends Pass {
  constructor() {
    super();
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.ao = new THREE.ShaderMaterial({
      vertexShader, fragmentShader: aoFragment, depthTest: false, depthWrite: false,
      uniforms: {
        tDepth: { value: null }, inverseProjection: { value: new THREE.Matrix4() },
        resolution: { value: new THREE.Vector2(1, 1) },
      },
    });
    this.composite = new THREE.ShaderMaterial({
      vertexShader, fragmentShader: compositeFragment, depthTest: false, depthWrite: false,
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null }, tAO: { value: this.target.texture },
        texel: { value: new THREE.Vector2(1, 1) },
      },
    });
    this.quad = new FullScreenQuad(this.ao);
  }
  setSize(width, height) {
    // At most 640x360-ish AO, irrespective of the canvas DPR.
    const scale = Math.min(0.5, 640 / width, 360 / height);
    const w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
    this.target.setSize(w, h);
    this.ao.uniforms.resolution.value.set(width, height);
    this.composite.uniforms.texel.value.set(1 / w, 1 / h);
  }
  render(renderer, writeBuffer, readBuffer) {
    this.ao.uniforms.tDepth.value = readBuffer.depthTexture;
    this.quad.material = this.ao;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    this.composite.uniforms.tDiffuse.value = readBuffer.texture;
    this.composite.uniforms.tDepth.value = readBuffer.depthTexture;
    this.quad.material = this.composite;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() {
    this.target.dispose(); this.ao.dispose(); this.composite.dispose(); this.quad.dispose();
  }
}

export function createFfaPost(scene, renderer, policy) {
  const sampleCount = (value) => Math.min(value, renderer.capabilities.maxSamples || 0);
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, samples: sampleCount(policy.samples), depthBuffer: true,
  });
  const composer = new EffectComposer(renderer, target);
  // RenderPass writes into either ping-pong buffer on successive frames.
  for (const buffer of [composer.renderTarget1, composer.renderTarget2]) {
    buffer.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  }
  const scenePass = new RenderPass(scene, null);
  const ao = new DepthAO();
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.4, 1.05);
  // UnrealBloomPass already uses half-resolution bright extraction plus mip blurs.
  const grade = new ShaderPass({
    vertexShader, fragmentShader: gradeFragment,
    uniforms: {
      tDiffuse: { value: null }, hitUV: { value: new THREE.Vector2(0.5, 0.5) },
      texel: { value: new THREE.Vector2(1, 1) }, aspect: { value: 1 }, hit: { value: 0 },
    },
  });
  const fxaa = new ShaderPass(ffaFxaaShader());
  composer.addPass(scenePass); composer.addPass(ao); composer.addPass(bloom);
  composer.addPass(grade); composer.addPass(new OutputPass()); composer.addPass(fxaa);
  let bloomScale = 1;
  const apply = (next) => {
    const samples = sampleCount(next.samples);
    for (const buffer of [composer.renderTarget1, composer.renderTarget2]) {
      if (buffer.samples !== samples) { buffer.samples = samples; buffer.dispose(); }
    }
    ao.enabled = next.ao; bloom.enabled = next.bloom;
    bloomScale = next.bloomScale;
    fxaa.enabled = samples === 0;
  };
  apply(policy);
  return {
    resize(width, height, dpr) {
      composer.setPixelRatio(dpr); composer.setSize(width, height);
      const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
      // Cap bloom independent of AO and the main backing store.
      bloom.setSize(Math.min(w, 960) * bloomScale, Math.min(h, 540) * bloomScale);
      grade.uniforms.texel.value.set(1 / w, 1 / h);
      grade.uniforms.aspect.value = width / height;
      fxaa.uniforms.resolution.value.set(1 / w, 1 / h);
    },
    configure: apply,
    render(camera, dt, pulse, point) {
      scenePass.camera = camera;
      ao.ao.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
      grade.uniforms.hit.value = pulse;
      if (point) {
        const p = point.clone().project(camera);
        grade.uniforms.hitUV.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
        if (p.z < -1 || p.z > 1) grade.uniforms.hit.value = 0;
      }
      composer.render(dt);
    },
    dispose() { for (const pass of composer.passes) pass.dispose?.(); composer.dispose(); },
    get state() {
      return { ao: ao.enabled, aoWidth: ao.target.width, aoHeight: ao.target.height,
        bloom: bloom.enabled, samples: composer.renderTarget1.samples, fxaa: fxaa.enabled };
    },
  };
}
