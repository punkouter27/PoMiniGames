// shadows.js — two shadow maps for the sun on the high tier: a sharp one for what is in
// front of the camera, and the whole-island one the game always had for everything else.
//
// One 2048 map over the island is about twelve centimetres a texel: a rabbit's shadow is
// three texels wide and the edge of a hut is a smear. This is three's CSMShadowNode (cascaded
// shadow maps) cut down to what the island can afford and bent to what it needs:
//
//   NEAR   the camera's view out to NEAR_METRES, fitted every frame by CSMShadowNode itself.
//          Three and a half centimetres a texel and a narrower filter, so the shadows you
//          are standing next to have edges.
//   FAR    not a slice of the view at all. three would fit the last cascade to the view
//          frustum out to the far plane, which at this field of view is a box hundreds of
//          metres wide, mostly sea and sky, and four times COARSER than the single map was.
//          The island is 200 m across and never moves, so the far cascade is simply pinned
//          on it: the same camera, the same texel and the same bias as the single map.
//
// The result is never worse than the single map anywhere, sharper near the camera, and one
// extra shadow pass. (Measured on an integrated GPU at 1080p: the stock node with three
// cascades cost a tenth of the frame rate and with four a fifth, which the adaptive
// resolution then paid for in sharpness.)
//
// The two are blended over the last BLEND_METRES of the near map, so there is no line on the
// ground where the sharpness changes.
import { CSMShadowNode } from 'three-eco/addons/csm/CSMShadowNode.js';
import { Fn, If, positionView, smoothstep, vec4 } from 'three-eco/tsl';

const NEAR_METRES = 22;
const BLEND_METRES = 6;
const NEAR_RADIUS = 1.1;
const LIGHT_MARGIN = 200;   // how far back along the light the near map's camera sits: the island's width

class IslandShadowNode extends CSMShadowNode {
  constructor(light, cameraFar) {
    super(light, {
      cascades: 2, maxFar: cameraFar, mode: 'custom', lightMargin: LIGHT_MARGIN,
      customSplitsCallback: (count, near, far, breaks) => { breaks.push(NEAR_METRES / far, 1); },
    });
  }

  _init(builder) {
    // Captured before the clones are made: super._init copies light.shadow twice and scales
    // the second copy's bias, which is right for a wider slice and wrong for a map that is
    // the original one.
    const base = this.light.shadow;
    super._init(builder);
    const near = this.lights[0].shadow; const far = this.lights[1].shadow;
    // The near camera looks down the light from LIGHT_MARGIN behind its slice.
    near.camera.near = 1; near.camera.far = LIGHT_MARGIN + NEAR_METRES * 4;
    // The filter's width is radius x texel. The island map's radius, on texels a third the
    // size, would blur away most of what the near map resolves.
    near.radius = NEAR_RADIUS;
    near.camera.updateProjectionMatrix();
    // A constant bias is in units of the depth range, which just became a third shorter.
    near.bias = base.bias * (base.camera.far - base.camera.near) / (near.camera.far - near.camera.near);
    far.bias = base.bias;
    this._pinFar();
  }

  /** The far cascade is the sun's own shadow camera: the island, as lighting.js frames it. */
  _pinFar() {
    const from = this.light.shadow.camera; const to = this.lights[1]?.shadow.camera;
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

/** `?ecoCsm=off`: the high tier on the single shadow map, for comparing. */
function wanted() {
  try { return new URLSearchParams(window.location.search).get('ecoCsm') !== 'off'; } catch { return true; }
}

/**
 * Give `sun` the two-map shadow. Returns the node (its `updateFrustums()` must be called when
 * the camera's projection changes, its `islandChanged()` when the sun's own shadow camera is
 * reframed), or null when it is switched off or cannot be built: the sun then keeps its
 * single map.
 */
export function createIslandShadow(sun, cameraFar = 700) {
  if (!wanted()) return null;
  try {
    const node = new IslandShadowNode(sun, cameraFar);
    node.islandChanged = () => node._pinFar();
    sun.shadow.shadowNode = node;
    return node;
  } catch {
    return null;
  }
}
