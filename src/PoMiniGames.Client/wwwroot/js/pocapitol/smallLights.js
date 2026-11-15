import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Hundreds of small lights for the price of one draw call.
//
// A real three.js light costs every lit pixel in the scene, which is why the scene has a dozen
// and one of them stands in for all four police cars. These do not work that way. Each light is
// a camera-facing quad just big enough to cover its own reach; the fragment shader rebuilds the
// world position and facing of whatever solid surface is under each pixel from the depth buffer,
// and adds the light that surface would receive. A light therefore costs only the pixels it can
// reach, and five hundred of them are one instanced draw.
//
// What uses it: a phone screen in front of everyone filming, phones held up across the far crowd
// once the light goes, each lamp post, each police light bar, and every round in flight.

const VERTEX_COPY = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const COPY = 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv); }';

const VERTEX = `
    attribute vec4 aAt;      // xyz, reach in metres
    attribute vec3 aColor;
    varying vec4 vAt;
    varying vec3 vColor;
    void main() {
        vAt = aAt; vColor = aColor;
        vec4 centre = viewMatrix * vec4(aAt.xyz, 1.0);
        // Pulled toward the lens by its own reach, so the quad still covers the light's sphere
        // when the camera is standing inside it.
        bool behind = centre.z - aAt.w > 0.0;
        centre.xy += position.xy * aAt.w * 2.0;
        centre.z = min(centre.z + aAt.w, -0.12);
        // A light wholly behind the lens reaches nothing on screen.
        gl_Position = behind ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * centre;
    }`;

const FRAGMENT = `
    uniform sampler2D tDepth, tScene;
    uniform mat4 uInvViewProjJ;
    uniform vec2 uSize;
    varying vec4 vAt;
    varying vec3 vColor;
    vec3 worldAt(vec2 uv) {
        vec4 p = uInvViewProjJ * vec4(uv * 2.0 - 1.0, texture2D(tDepth, uv).r * 2.0 - 1.0, 1.0);
        return p.xyz / p.w;
    }
    void main() {
        vec2 uv = gl_FragCoord.xy / uSize;
        vec3 p = worldAt(uv), to = vAt.xyz - p;
        float d2 = dot(to, to), reach = vAt.w;
        if (d2 > reach * reach) discard;
        // The surface's facing, from how its position changes across the pixel.
        vec3 n = normalize(cross(dFdx(p), dFdy(p)));
        float facing = clamp(dot(n, to * inversesqrt(max(d2, 1e-4))), 0.0, 1.0) * 0.8 + 0.2;
        float window = 1.0 - d2 / (reach * reach);
        // What the surface is: its own lit colour with the brightness taken out, near enough.
        vec3 scene = texture2D(tScene, uv).rgb;
        vec3 albedo = clamp(scene / (dot(scene, vec3(0.2126, 0.7152, 0.0722)) + 0.25), 0.0, 1.6);
        gl_FragColor = vec4(vColor * albedo * facing * window * window / (1.0 + d2 * 0.6), 0.0);
    }`;

class LightsPass extends Pass {
    constructor(mesh, camera) {
        super();
        this.mesh = mesh; this.camera = camera;
        this.scene = new THREE.Scene();
        this.scene.add(mesh);
        this.copy = new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null } }, vertexShader: VERTEX_COPY, fragmentShader: COPY, depthTest: false, depthWrite: false });
        this.quad = new FullScreenQuad(this.copy);
    }
    setSize(w, h) { this.mesh.material.uniforms.uSize.value.set(w, h); }
    render(renderer, writeBuffer, readBuffer) {
        this.copy.uniforms.tDiffuse.value = readBuffer.texture;
        this.mesh.material.uniforms.tScene.value = readBuffer.texture;
        const auto = renderer.autoClear;
        renderer.autoClear = false;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this.quad.render(renderer);
        renderer.render(this.scene, this.camera);
        renderer.autoClear = auto;
    }
    dispose() { this.copy.dispose(); this.quad.dispose(); }
}

export function createSmallLights(camera, depthTexture, invViewProj, capacity = 640) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const at = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    at.setUsage(THREE.DynamicDrawUsage); color.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aAt', at); geometry.setAttribute('aColor', color);
    const material = new THREE.ShaderMaterial({
        uniforms: {
            tDepth: { value: depthTexture }, tScene: { value: null }, uInvViewProjJ: { value: invViewProj },
            uSize: { value: new THREE.Vector2(1, 1) },
        },
        vertexShader: VERTEX, fragmentShader: FRAGMENT,
        transparent: true, depthTest: false, depthWrite: false,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.frustumCulled = false; mesh.count = 0;
    const pass = new LightsPass(mesh, camera);
    pass.enabled = false;
    let n = 0, allowed = true;
    return {
        pass, capacity,
        setAllowed(value) { allowed = value; if (!value) pass.enabled = false; },
        /** Start this frame's list. */
        begin() { n = 0; },
        /** One light: where, how far it reaches (metres), its colour and how bright. */
        add(x, y, z, reach, r, g, b, power = 1) {
            if (n >= capacity || power <= 0.01) return;
            at.array[n * 4] = x; at.array[n * 4 + 1] = y; at.array[n * 4 + 2] = z; at.array[n * 4 + 3] = reach;
            color.array[n * 3] = r * power; color.array[n * 3 + 1] = g * power; color.array[n * 3 + 2] = b * power;
            n++;
        },
        /** Upload the list. Returns how many lights are lit. */
        end() {
            mesh.count = n;
            if (n) { at.needsUpdate = true; color.needsUpdate = true; }
            pass.enabled = allowed && n > 0;
            return n;
        },
        dispose() { pass.dispose(); geometry.dispose(); material.dispose(); mesh.dispose(); },
    };
}
