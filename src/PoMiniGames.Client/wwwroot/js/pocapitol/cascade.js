import { CSMShadowNode } from 'three-eco/addons/csm/CSMShadowNode.js';
import { Fn, If, positionView, smoothstep, vec4 } from 'three-eco/tsl';

// A second, close shadow cascade for the sun.
//
// One shadow map over the whole west front is about four centimetres a texel: fine for a
// building, soft mush for a hand, a baton or a boot. So there are two. The far map is still the
// sun's own, following whoever the camera is on. The near map is three's CSMShadowNode slice of
// the camera's view out to NEAR_METRES, refitted every frame by the node, so the shadows the
// player is standing next to have edges; the two cross-fade over the last BLEND_METRES.
//
// WHY IT CHANGED
// On r165 this file taught every lit material to read a second zero-brightness light's map by
// patching three's lighting chunk (onBeforeCompile), with a contact-hardening blur of its own.
// Node materials have no chunks to patch; the shadow of a light is a node (`light.shadow.shadowNode`),
// so the same idea is now a ShadowBaseNode, built the way PoEcosystem's island shadow is:
//   far   not a slice of the view: pinned to the sun's own shadow camera, so it is never worse
//         than the single map was and the existing reach/step logic in scene.js keeps driving it
//   near  CSM's own fit of the first NEAR_METRES of the view, with a narrower filter
// The contact-hardening penumbra (a sharper shadow where the caster touches the ground) is not
// carried over: the node's PCF filter has no blocker search. Edges are still about two to three
// times finer than the single map gave.

const NEAR_METRES = 24;
const BLEND_METRES = 6;
const NEAR_RADIUS = 1.1;
const LIGHT_MARGIN = 200;   // how far back along the light the near map's camera sits

class CapitolShadowNode extends CSMShadowNode {
    constructor(light, cameraFar) {
        super(light, {
            cascades: 2, maxFar: cameraFar, mode: 'custom', lightMargin: LIGHT_MARGIN,
            customSplitsCallback: (count, near, far, breaks) => { breaks.push(NEAR_METRES / far, 1); },
        });
    }

    _init(builder) {
        // Captured before the clones are made: super._init copies light.shadow twice and scales the
        // second copy's bias, which is right for a wider slice and wrong for a map that is the
        // original one.
        const base = this.light.shadow;
        super._init(builder);
        const near = this.lights[0].shadow, far = this.lights[1].shadow;
        near.camera.near = 1; near.camera.far = LIGHT_MARGIN + NEAR_METRES * 4;
        near.radius = NEAR_RADIUS;
        near.camera.updateProjectionMatrix();
        // A constant bias is in units of the depth range, which just became shorter.
        near.bias = base.bias * (base.camera.far - base.camera.near) / (near.camera.far - near.camera.near);
        far.bias = base.bias;
        this._pinFar();
    }

    /** The far cascade is the sun's own shadow camera. */
    _pinFar() {
        const from = this.light.shadow.camera, to = this.lights[1]?.shadow.camera;
        if (!to) return;
        to.left = from.left; to.right = from.right; to.top = from.top; to.bottom = from.bottom;
        to.near = from.near; to.far = from.far;
        to.updateProjectionMatrix();
    }

    _updateShadowBounds() {
        super._updateShadowBounds();
        this._pinFar();
    }

    updateBefore(frame) {
        super.updateBefore(frame);
        const far = this.lights[1];
        far.position.copy(this.light.position);
        far.target.position.copy(this.light.target.position);
        far.updateMatrixWorld();
        far.target.updateMatrixWorld();
        this._pinFar();
    }

    setup(builder) {
        if (this.camera === null) this._init(builder);
        const [near, far] = this._shadowNodes;
        return Fn((b) => {
            this.setupShadowPosition(b);
            const ret = vec4(1, 1, 1, 1).toVar('shadowValue');
            const dist = positionView.z.negate().toVar('shadowDist');
            const toFar = smoothstep(NEAR_METRES - BLEND_METRES, NEAR_METRES, dist).toVar('shadowToFar');
            // Each map is only read where it has something to say, as the stock node does.
            If(dist.lessThan(NEAR_METRES), () => { ret.subAssign(near.oneMinus().mul(toFar.oneMinus())); });
            If(dist.greaterThan(NEAR_METRES - BLEND_METRES), () => { ret.subAssign(far.oneMinus().mul(toFar)); });
            return ret;
        })();
    }
}

/**
 * @param sun    the scene's directional light: the far cascade
 * @param camera the scene camera (its far plane sizes the cascades)
 * @param enabled false on the low tier: the sun keeps its single map
 */
export function createNearCascade(scene, sun, { camera = null, enabled = true } = {}) {
    let node = null;
    if (enabled) {
        try {
            node = new CapitolShadowNode(sun, camera?.far ?? 420);
            sun.shadow.shadowNode = node;
        } catch (error) {
            console.warn('[PoCapitol] close shadow cascade unavailable:', error);
            node = null;
        }
    }
    return {
        node,
        /** Kept for the callers that taught r165 materials about the close map: nothing to teach now. */
        teachAll() {},
        teach() {},
        /** The close map is part of the sun's shadow node for good: changing it would recompile every lit shader. */
        setEnabled() {},
        enabled: () => node !== null,
        /** The camera's projection changed (fov, aspect): refit the near slice. */
        refit() { if (node?.camera) node.updateFrustums(); },
        /** Once a frame. The far map follows the sun's own camera, so there is nothing to place. */
        update() {},
        dispose() { if (node) { sun.shadow.shadowNode = null; node.dispose?.(); } },
    };
}
