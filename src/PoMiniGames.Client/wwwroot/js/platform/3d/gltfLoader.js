// platform/3d/gltfLoader.js — shared GLTF/GLB loader with MeshoptDecoder + KTX2Loader.
// Supports CC0 asset packs (Kenney, Quaternius, Poly Haven) hosted locally or in Blob Storage
// behind ModelsBaseUrl, with per-URL caching and automatic clone on reuse.
import { GLTFLoader } from 'three-eco/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three-eco/addons/libs/meshopt_decoder.module.js';
import { getKtx2Loader } from './textureLoader.js';

const _loaderByRenderer = new WeakMap();
const _gltfCache = new Map();

export async function getGltfLoader(renderer) {
  let promise = _loaderByRenderer.get(renderer);
  if (!promise) {
    promise = (async () => {
      const loader = new GLTFLoader();
      if (MeshoptDecoder) loader.setMeshoptDecoder(MeshoptDecoder);
      const ktx2 = await getKtx2Loader(renderer).catch(() => null);
      if (ktx2) loader.setKTX2Loader(ktx2);
      return loader;
    })();
    _loaderByRenderer.set(renderer, promise);
  }
  return promise;
}

/**
 * Load an optimized GLB (meshopt + KTX2) and return a fresh scene clone + animations.
 * @param {object} renderer
 * @param {string} url
 * @param {{ castShadow?: boolean, receiveShadow?: boolean, scale?: number }} [opts]
 */
export async function loadOptimizedGltf(renderer, url, opts = {}) {
  let entry = _gltfCache.get(url);
  if (!entry) {
    const loader = await getGltfLoader(renderer);
    entry = loader.loadAsync(url);
    _gltfCache.set(url, entry);
  }
  const gltf = await entry;
  const scene = gltf.scene.clone(true);
  if (opts.scale) scene.scale.setScalar(opts.scale);
  if (opts.castShadow || opts.receiveShadow) {
    scene.traverse((obj) => {
      if (obj.isMesh) {
        if (opts.castShadow) obj.castShadow = true;
        if (opts.receiveShadow) obj.receiveShadow = true;
      }
    });
  }
  return { scene, animations: gltf.animations || [] };
}

export function clearGltfCache() {
  _gltfCache.clear();
}
