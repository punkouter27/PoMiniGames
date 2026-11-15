import * as THREE from 'three';

// A second, close shadow cascade for the sun, with edges that harden where things touch.
//
// One shadow map over the whole west front is about four centimetres a texel: fine for a
// building, soft mush for a hand, a baton or a boot. So there are two. The sun's own map still
// covers everything in the shot. A second map covers only the dozen metres round whoever the
// camera is on, at the same resolution, so its texels are about a centimetre; wherever a pixel
// falls inside it, its shadow comes from there instead, cross-faded at the edge of its reach.
//
// The close map is also read differently. A real shadow is sharp where the thing casting it
// touches the ground and soft further away, because the sun (and far more so an overcast sky) is
// not a point. For every pixel the shader first looks for what is casting on it and how far
// above the surface that is, then blurs the shadow in proportion: a boot's edge is crisp, the
// shadow of a flag two metres up is a soft patch.
//
// three.js r165 has no cascades of its own outside an add-on that rewrites the global shader
// chunks, which would leak into every other game on the page. This is confined to PoCapitol:
// the close map belongs to a second directional light of zero brightness (so anything that does
// not know about it is unaffected by it), and only this scene's own lit materials are taught,
// through their onBeforeCompile, to read its map for the sun.

const DISC = [[-0.326, -0.406], [-0.84, -0.074], [-0.696, 0.457], [-0.203, 0.621], [0.962, -0.195], [0.473, -0.48],
    [0.519, 0.767], [0.185, -0.893], [0.507, 0.064], [0.896, 0.412], [-0.322, -0.933], [-0.792, -0.598]];

/** Depth the close map spans along the sun's direction, metres: light at 110 m, 10 m near, 210 m far. */
const SPAN = 200;
/**
 * How fast the penumbra widens with the gap between what casts and what receives: the tangent of
 * the light's half-angle. The disc of the sun is 0.005; a January overcast is a soft box, far wider.
 */
export const PENUMBRA = 0.075;

/** Texels of blur per unit of normalised depth gap, for a map `size` texels across `reach` metres either side. */
export function penumbraScale(reach, size, spread = PENUMBRA) {
    return SPAN * spread / (2 * reach / size);
}

const soft = scale => `
#ifdef USE_SHADOWMAP
    const vec2 pcDisc[12] = vec2[12](${DISC.map(([x, y]) => `vec2(${x.toFixed(3)}, ${y.toFixed(3)})`).join(', ')});
    float pcNearShadow(sampler2D map, vec2 size, float bias, vec4 coord) {
        vec3 c = coord.xyz / coord.w;
        c.z += bias;
        vec2 texel = 1.0 / size;
        // A different turn of the sample disc at every pixel: noise instead of banding, and the
        // temporal resolve averages the noise away.
        float spin = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
        mat2 turn = mat2(cos(spin), -sin(spin), sin(spin), cos(spin));
        // What is casting on this point, and how far above it?
        float found = 0.0, above = 0.0;
        for (int k = 0; k < 12; k += 2) {
            float d = unpackRGBAToDepth(textureLod(map, c.xy + turn * pcDisc[k] * 6.0 * texel, 0.0));
            if (d < c.z) { above += d; found += 1.0; }
        }
        if (found < 0.5) return 1.0;
        // Touching: about a texel of blur. A metre up: several.
        float width = clamp((c.z - above / found) * ${scale.toFixed(1)}, 0.9, 8.0);
        float lit = 0.0;
        for (int k = 0; k < 12; k++) {
            lit += step(c.z, unpackRGBAToDepth(textureLod(map, c.xy + turn * pcDisc[k] * width * texel, 0.0)));
        }
        return lit / 12.0;
    }
#endif`;

const SUN_LINE = /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ i \][^;]*vDirectionalShadowCoord\[ i \] \) : 1\.0;/;

/** The directional-light loop of three's lighting chunk, taught about the close map. Null if three's text has changed. */
function patchedLights() {
    const chunk = THREE.ShaderChunk.lights_fragment_begin;
    const start = chunk.indexOf('#if ( NUM_DIR_LIGHTS > 0 )'), end = chunk.indexOf('#if ( NUM_RECT_AREA_LIGHTS');
    if (start < 0 || end < start) return null;
    let sun = chunk.slice(start, end);
    const line = sun.match(SUN_LINE);
    if (!line) return null;
    sun = sun.replace(SUN_LINE, `{
            #if NUM_DIR_LIGHT_SHADOWS > 1 && UNROLLED_LOOP_INDEX == 1
            // The close cascade's own light has no brightness: nothing to shadow.
            float pcShade = 1.0;
            #else
            float pcShade = ${line[0].slice(line[0].indexOf('getShadow'), line[0].lastIndexOf(' : 1.0;'))};
            #endif
            #if NUM_DIR_LIGHT_SHADOWS > 1 && UNROLLED_LOOP_INDEX == 0
            vec4 pcCoord = vDirectionalShadowCoord[ 1 ];
            vec3 pcAt = pcCoord.xyz / pcCoord.w;
            vec2 pcEdge = min(pcAt.xy, 1.0 - pcAt.xy);
            // Inside the close map, and not within its last few percent, where it hands back to the far one.
            float pcIn = smoothstep(0.0, 0.07, min(pcEdge.x, pcEdge.y)) * step(0.0, pcAt.z) * step(pcAt.z, 1.0);
            if (pcIn > 0.0) {
                pcShade = mix(pcShade, pcNearShadow(directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowBias, pcCoord), pcIn);
            }
            #endif
            directLight.color *= ( directLight.visible && receiveShadow ) ? pcShade : 1.0;
        }`);
    // And the zero-brightness light is not shaded at all: it would cost every lit pixel a BRDF.
    sun = sun.replace(/(RE_Direct\( directLight,[^;]*;)/, '#if !( NUM_DIR_LIGHT_SHADOWS > 1 && UNROLLED_LOOP_INDEX == 1 )\n\t\t$1\n\t\t#endif');
    return chunk.slice(0, start) + sun + chunk.slice(end);
}

/**
 * @param sun   the scene's directional light: the far cascade, unchanged
 * @param reach half-width of the close map, metres
 * @param size  its resolution
 */
export function createNearCascade(scene, sun, { reach = 13, size = 2048 } = {}) {
    const light = new THREE.DirectionalLight('#ffffff', 0);
    light.castShadow = true;
    light.shadow.mapSize.set(size, size);
    light.shadow.bias = -0.00035;
    light.shadow.normalBias = 0.012;
    // Driven by hand each frame, so it can be parked without three recompiling anything.
    light.shadow.autoUpdate = false;
    scene.add(light.target); scene.add(light);
    const lights = patchedLights();
    const pars = soft(penumbraScale(reach, size));
    let warned = false, on = false;
    const right = new THREE.Vector3(), up = new THREE.Vector3(), centre = new THREE.Vector3(), world = new THREE.Vector3(0, 1, 0);

    function patch(shader) {
        if (!lights || !shader.fragmentShader.includes('#include <lights_fragment_begin>')
            || !shader.fragmentShader.includes('#include <shadowmap_pars_fragment>')) return;
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <shadowmap_pars_fragment>', `#include <shadowmap_pars_fragment>\n${pars}`)
            .replace('#include <lights_fragment_begin>', lights);
    }
    /** Teaches one lit material to read the close map. Its own onBeforeCompile still runs first. */
    function teach(material) {
        if (!material || material.userData.pcCascade || !(material.isMeshStandardMaterial || material.isMeshLambertMaterial || material.isMeshPhongMaterial)) return;
        if (!lights) {
            if (!warned) { warned = true; console.warn('[PoCapitol] three.js lighting chunk has changed: the close shadow cascade is off.'); }
            return;
        }
        material.userData.pcCascade = true;
        const before = material.onBeforeCompile, key = material.customProgramCacheKey;
        // The default key is the hook's own source. Wrapped, every hook would read the same, and
        // two materials with different hooks would be handed one program: keep the original text.
        const own = key === THREE.Material.prototype.customProgramCacheKey ? before.toString() : null;
        material.onBeforeCompile = (shader, renderer) => { before.call(material, shader, renderer); patch(shader); };
        material.customProgramCacheKey = () => `${own ?? key.call(material)}|pc-cascade`;
    }
    function park() {
        Object.assign(light.shadow.camera, { left: -1, right: 1, top: 1, bottom: -1, near: 0.01, far: 0.02 });
        light.shadow.camera.updateProjectionMatrix();
        // One last render with nothing in range leaves an empty map, and it is never drawn again.
        light.shadow.needsUpdate = true;
    }
    park();

    return {
        light,
        /** Every lit material under `root` (call once the scene is built, before the first frame). */
        teachAll(root) {
            root.traverse(object => {
                if (!object.material) return;
                for (const material of Array.isArray(object.material) ? object.material : [object.material]) teach(material);
            });
        },
        teach,
        /** On at the top quality rung only. Off, the map is emptied once and costs nothing. */
        setEnabled(value) {
            if (value === on) return;
            on = value;
            if (on) {
                Object.assign(light.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 10, far: 10 + SPAN });
                light.shadow.camera.updateProjectionMatrix();
            } else park();
        },
        enabled: () => on,
        /**
         * Once a frame: centre the close map on `focus`, looking along the sun.
         * The centre moves in whole texels of the map, or every shadow edge would crawl as the
         * camera's subject walks.
         */
        update(focus, sunDir) {
            if (!on) return;
            right.crossVectors(world, sunDir).normalize();
            up.crossVectors(sunDir, right).normalize();
            const texel = 2 * reach / size;
            const dx = focus.x * right.x + focus.z * right.z, dy = focus.x * up.x + focus.z * up.z;
            centre.set(focus.x, 0, focus.z)
                .addScaledVector(right, Math.round(dx / texel) * texel - dx)
                .addScaledVector(up, Math.round(dy / texel) * texel - dy);
            light.target.position.copy(centre);
            light.position.copy(centre).addScaledVector(sunDir, 110);
            light.shadow.needsUpdate = true;
        },
        dispose() { scene.remove(light); scene.remove(light.target); light.shadow.map?.dispose(); light.dispose(); },
    };
}
