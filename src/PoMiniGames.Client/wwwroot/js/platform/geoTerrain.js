// platform/geoTerrain.js — client helper for /api/geo/terrain (real-world elevation heightmaps).
// Fetches an 8x8 cached elevation sample and bilinearly upsamples it to any target resolution
// (e.g. 64x64 for PoEcosystem islands or spline elevation profiles for PoMarbleRace / PoCabinet).

export async function fetchGeoHeightmap(lat, lon, targetSize = 64) {
  const url = `/api/geo/terrain?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geoTerrain: ${res.status}`);
  const data = await res.json();
  const src = data.elevations || [];
  const n = data.size || 8;
  const out = new Float32Array(targetSize * targetSize);

  let minH = Infinity, maxH = -Infinity;
  for (const h of src) { if (h < minH) minH = h; if (h > maxH) maxH = h; }
  const span = Math.max(1, maxH - minH);

  for (let y = 0; y < targetSize; y++) {
    const fy = (y / Math.max(1, targetSize - 1)) * (n - 1);
    const y0 = Math.floor(fy), y1 = Math.min(n - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < targetSize; x++) {
      const fx = (x / Math.max(1, targetSize - 1)) * (n - 1);
      const x0 = Math.floor(fx), x1 = Math.min(n - 1, x0 + 1), tx = fx - x0;
      const h00 = src[y0 * n + x0] ?? minH;
      const h10 = src[y0 * n + x1] ?? minH;
      const h01 = src[y1 * n + x0] ?? minH;
      const h11 = src[y1 * n + x1] ?? minH;
      const h = (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
      out[y * targetSize + x] = (h - minH) / span;
    }
  }
  return { size: targetSize, source: data.source, minElevation: minH, maxElevation: maxH, heights: out };
}
