// The attempt on a real street map: where the crowd stood (the report's heat grid) and where
// each police line held, laid over OpenStreetMap tiles round the Capitol with MapLibre GL.
//
// Opt-in: nothing here loads, and no tile is asked for, until the player presses "Street map" on
// the report. MapLibre (BSD-3) comes from jsdelivr with an integrity hash (engineLoader.js); its
// stylesheet is fetched with the same check and inlined, since the CSP only allows our own
// sheets. Tiles are OpenStreetMap's standard layer (tile.openstreetmap.org), shown with the
// attribution its tile policy asks for.
//
// The scenario's route is invented and shorter than the real building; it is laid on the map at
// true scale with the Rotunda on the Rotunda and +z pointing west, so the lawn falls on the real
// West Front lawn and the rooms run east into the building. The export says so.
import { loadLibrary } from '../platform/engineLoader.js';
import { lineDefs, areas, milestones } from './world.js';

const MAPLIBRE = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js';
const MAPLIBRE_CSS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css';
const MAPLIBRE_CSS_SRI = 'sha384-MinO0mNliZ3vwppuPOUnGa+iq619pfMhLVUXfC4LHwSCvF9H+6P/KO4Q7qBOYV5V';

export const CAPITOL = { lat: 38.889939, lon: -77.009051 };
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 111320 * Math.cos(CAPITOL.lat * Math.PI / 180);
/** Where the Rotunda's centre is in the scene (world.js areas). */
const ROTUNDA_Z = -14;

/** A scene point (metres; +x south, +z west) as [longitude, latitude]. */
export function toLngLat(x, z) {
    return [
        Math.round((CAPITOL.lon - (z - ROTUNDA_Z) / M_PER_DEG_LON) * 1e7) / 1e7,
        Math.round((CAPITOL.lat - x / M_PER_DEG_LAT) * 1e7) / 1e7,
    ];
}

const box = (x, z, w, d) => [[
    toLngLat(x - w / 2, z - d / 2), toLngLat(x + w / 2, z - d / 2), toLngLat(x + w / 2, z + d / 2),
    toLngLat(x - w / 2, z + d / 2), toLngLat(x - w / 2, z - d / 2),
]];

/**
 * The attempt as GeoJSON: one point per occupied heat cell (`weight` 0..1, `seconds` of person
 * time), the rooms as polygons, each police line as a line string (`held` seconds, `fell` the
 * scenario second it went, or null), and the milestones. Plain data: also the export.
 */
export function attemptGeoJson({ heat, cols, rows, rect, series = [], lines = [], outcome = '', role = '' }) {
    const features = [];
    let top = 0;
    for (let i = 0; i < heat.length; i++) top = Math.max(top, heat[i]);
    if (top > 0) {
        const cw = rect.w / cols, cd = rect.d / rows;
        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                const value = heat[j * cols + i];
                if (value <= 0) continue;
                features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: toLngLat(rect.x0 + (i + 0.5) * cw, rect.z0 + (j + 0.5) * cd) },
                    properties: { kind: 'crowd', seconds: Math.round(value), weight: Math.round(value / top * 1000) / 1000 } });
            }
        }
    }
    for (const area of areas) {
        features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: box(area.x, area.z, area.w, area.d) },
            properties: { kind: 'room', name: area.name } });
    }
    const end = series.at(-1)?.at ?? 0;
    lineDefs.forEach((def, i) => {
        const fell = lines[i]?.brokenAt >= 0 ? Math.round(lines[i].brokenAt) : null;
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [toLngLat(def.x0, def.z), toLngLat(def.x1, def.z)] },
            properties: { kind: 'line', name: def.name, held: Math.round(fell ?? end), fell, withdrawn: lines[i]?.withdrawn === true } });
    });
    milestones.forEach((m, i) => features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: toLngLat(m.x, m.z) },
        properties: { kind: 'milestone', index: i + 1, name: m.label } }));
    return {
        type: 'FeatureCollection',
        properties: {
            title: 'PoCapitol attempt', outcome, role,
            note: 'Fictional scenario. The route is invented and laid at true scale from the Rotunda; it is not a plan of the building.',
            attribution: 'Basemap © OpenStreetMap contributors',
        },
        features,
    };
}

let cssReady = null;
/** MapLibre's stylesheet, fetched with its hash checked and inlined (the CSP has no CDN in style-src). */
function ensureCss() {
    cssReady ??= fetch(MAPLIBRE_CSS, { integrity: MAPLIBRE_CSS_SRI, mode: 'cors' })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
        .then(text => {
            const style = document.createElement('style');
            style.dataset.engineDep = MAPLIBRE_CSS;
            style.textContent = text;
            document.head.append(style);
        })
        .catch(error => { cssReady = null; throw error; });
    return cssReady;
}

/** Colours for the map layers, read from the app's tokens so the map follows light and dark. */
function token(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

/**
 * Draws the attempt over OpenStreetMap in `container`. Resolves to `{ dispose }`, or throws if
 * the library or its stylesheet cannot load (the page then keeps its report as it was).
 */
export async function createStreetMap(container, data, { reducedMotion = false } = {}) {
    await Promise.all([loadLibrary(MAPLIBRE), ensureCss()]);
    const maplibregl = window.maplibregl;
    if (!maplibregl) throw new Error('MapLibre did not load.');
    const geo = attemptGeoJson(data);
    const accent = token('--po-danger', '#d93838'), line = token('--po-accent', '#3b6fd8'), ink = token('--po-text', '#1d1f24');
    const map = new maplibregl.Map({
        container,
        style: {
            version: 8,
            sources: {
                osm: {
                    type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19,
                    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
                },
            },
            layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.6, 'raster-opacity': 0.9 } }],
        },
        center: toLngLat(0, 30), zoom: 16.6, bearing: -90, pitch: 0,
        attributionControl: { compact: false },
        fadeDuration: reducedMotion ? 0 : 300,
        cooperativeGestures: true,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    await new Promise((resolve, reject) => {
        map.once('load', resolve);
        map.once('error', event => { if (!map.loaded()) reject(event?.error ?? new Error('Map failed to load.')); });
    });
    map.addSource('attempt', { type: 'geojson', data: geo });
    map.addLayer({ id: 'rooms', type: 'line', source: 'attempt', filter: ['==', ['get', 'kind'], 'room'],
        paint: { 'line-color': ink, 'line-width': 1.2, 'line-dasharray': [2, 2], 'line-opacity': 0.7 } });
    map.addLayer({ id: 'crowd', type: 'heatmap', source: 'attempt', filter: ['==', ['get', 'kind'], 'crowd'],
        paint: {
            'heatmap-weight': ['get', 'weight'],
            'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 15, 6, 19, 60],
            'heatmap-intensity': 1.1,
            'heatmap-opacity': 0.78,
            'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
                0, 'rgba(0,0,0,0)', 0.15, 'rgba(70,130,220,0.45)', 0.4, 'rgba(120,200,140,0.6)',
                0.65, 'rgba(245,190,60,0.75)', 0.9, 'rgba(230,80,50,0.85)', 1, 'rgba(200,30,120,0.9)'],
        } });
    map.addLayer({ id: 'lines', type: 'line', source: 'attempt', filter: ['==', ['get', 'kind'], 'line'],
        paint: { 'line-color': ['case', ['==', ['get', 'fell'], null], line, accent], 'line-width': 4,
            'line-dasharray': ['case', ['==', ['get', 'fell'], null], ['literal', [1, 0]], ['literal', [1.5, 1]]] } });
    map.addLayer({ id: 'milestones', type: 'circle', source: 'attempt', filter: ['==', ['get', 'kind'], 'milestone'],
        paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': ink, 'circle-stroke-width': 1.5 } });
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
    const describe = p => p.kind === 'line'
        ? `${p.name}: ${p.fell === null || p.fell === undefined ? `held ${p.held} min` : `${p.withdrawn ? 'withdrew' : 'fell'} at minute ${p.fell}`}`
        : `${p.index}. ${p.name}`;
    for (const layer of ['lines', 'milestones']) {
        map.on('mouseenter', layer, e => {
            map.getCanvas().style.cursor = 'pointer';
            const f = e.features?.[0];
            if (f) popup.setLngLat(e.lngLat).setText(describe(f.properties)).addTo(map);
        });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; popup.remove(); });
    }
    const all = geo.features.filter(f => f.properties.kind === 'room').flatMap(f => f.geometry.coordinates[0]);
    const lons = all.map(c => c[0]), lats = all.map(c => c[1]);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        { padding: 28, bearing: -90, duration: reducedMotion ? 0 : 600 });
    return {
        geojson: geo,
        dispose() { popup.remove(); map.remove(); },
    };
}
