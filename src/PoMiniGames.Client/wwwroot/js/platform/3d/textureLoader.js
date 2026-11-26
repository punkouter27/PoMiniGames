// platform/3d/textureLoader.js — shared KTX2/Basis GPU-compressed texture & CC0 HDRI IBL loader.
// Uses the already-bundled /lib/basis/ transcoder so PBR maps and PMREM environments decode
// directly into GPU-native BC7/ASTC/ETC2 formats (4x-8x smaller VRAM & egress).
import * as THREE from 'three-eco/webgpu';
import { KTX2Loader } from 'three-eco/addons/loaders/KTX2Loader.js';
import { RGBELoader } from 'three-eco/addons/loaders/RGBELoader.js';

const BASIS_PATH = '/lib/basis/';
const _ktx2ByRenderer = new WeakMap();
const _texCache = new Map();
const _envCache = new Map();

/** Get or create a KTX2Loader configured for this renderer (cached per renderer). */
export async function getKtx2Loader(renderer) {
  if (!renderer) return null;
  let promise = _ktx2ByRenderer.get(renderer);
  if (!promise) {
    promise = (async () => {
      const loader = new KTX2Loader();
      loader.setTranscoderPath(BASIS_PATH);
      if (typeof loader.detectSupportAsync === 'function') {
        await loader.detectSupportAsync(renderer);
      } else if (typeof loader.detectSupport === 'function') {
        loader.detectSupport(renderer);
      }
      return loader;
    })();
    _ktx2ByRenderer.set(renderer, promise);
  }
  return promise;
}

/**
 * Load a KTX2 texture (with optional PNG/WebP fallback URL), cached by URL.
 * @param {object} renderer
 * @param {string} url
 * @param {{ srgb?: boolean, repeat?: [number, number], anisotropy?: number, fallbackUrl?: string }} [opts]
 */
export async function loadKtx2Texture(renderer, url, opts = {}) {
  const key = `${url}|${opts.srgb ? 's' : 'l'}`;
  if (_texCache.has(key)) return _texCache.get(key);
  const loader = await getKtx2Loader(renderer);
  let tex = null;
  try {
    if (loader && url.endsWith('.ktx2')) {
      tex = await loader.loadAsync(url);
    } else {
      tex = await new THREE.TextureLoader().loadAsync(url);
    }
  } catch (err) {
    if (opts.fallbackUrl) {
      tex = await new THREE.TextureLoader().loadAsync(opts.fallbackUrl);
    } else {
      throw err;
    }
  }
  if (opts.srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(opts.repeat[0], opts.repeat[1]);
  }
  if (opts.anisotropy) tex.anisotropy = opts.anisotropy;
  _texCache.set(key, tex);
  return tex;
}

/**
 * Load a Poly Haven CC0 HDRI (.hdr or equirectangular .ktx2) and bake a PMREM environment map.
 * Respects PoQuality tiers (skips on low tier unless forced).
 */
export async function loadEnvironmentHdri(renderer, url, { force = false } = {}) {
  const tier = (typeof window !== 'undefined' && window.PoQuality?.tier?.()) || 'high';
  if (!force && tier === 'low') return null;
  if (_envCache.has(url)) return _envCache.get(url);

  const raw = url.endsWith('.ktx2')
    ? await loadKtx2Texture(renderer, url)
    : await new RGBELoader().loadAsync(url);
  raw.mapping = THREE.EquirectangularReflectionMapping;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromEquirectangular(raw);
  raw.dispose();
  pmrem.dispose();

  _envCache.set(url, rt.texture);
  return rt.texture;
}

/** Dispose cached textures (e.g. on context loss). */
export function clearTextureCache() {
  for (const t of _texCache.values()) t.dispose?.();
  for (const t of _envCache.values()) t.dispose?.();
  _texCache.clear();
  _envCache.clear();
}
