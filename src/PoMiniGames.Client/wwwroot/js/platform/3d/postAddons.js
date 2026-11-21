// postAddons.js — the r186 screen-space addons the shared post stack (postStack.js) uses, imported
// in ONE place. platform/3d/postStack.js and shadows.js take THREE / TSL / these by argument so
// they stay loadable under node tests; this file is the browser-only side that actually pulls the
// modules from the 'three-eco/addons/' import-map entry (r186, WebGPU/TSL). A game imports
// `POST_ADDONS` from here and hands it to createPostStack / applySunShadows.
//
// Only what r186 ships is listed: there is no AnamorphicNode in this version (it was dropped
// before r186), so the anamorphic streak is written in postStack.js.
import * as THREE from 'three-eco/webgpu';
import * as TSL from 'three-eco/tsl';
import { traa } from 'three-eco/addons/tsl/display/TRAANode.js';
import { ssgi } from 'three-eco/addons/tsl/display/SSGINode.js';
import { ssr } from 'three-eco/addons/tsl/display/SSRNode.js';
import { lensflare } from 'three-eco/addons/tsl/display/LensflareNode.js';
import { CSMShadowNode } from 'three-eco/addons/csm/CSMShadowNode.js';

/** Everything postStack.js / shadows.js need, in the shape they take it. */
export const POST_LIB = Object.freeze({
    THREE,
    TSL,
    addons: Object.freeze({ traa, ssgi, ssr, lensflare }),
    CSMShadowNode,
});
