// pocabinet/models.js
//
// The scan a lap drives through (track.scan says which, and where it stands; SCANS below says how
// each is drawn). Two of them:
//
// THE HOUSE (the House Party track): a whole house, bedroom to living room, as one Gaussian splat
// in the house frame of scripts/pocabinet/house-frame.json (metres, floor on y = 0, x along the
// house), with the first band of its view-dependent colour (reflections and sheen that turn with
// the camera). house.ksplat is 2.8M splats, 92 MB; house-low.ksplat is 250k of them (8 MB), shown
// first, and all the low tier, the "Lite" setting and a phone ever draw. It is drawn whole, there
// is no mesh, and the road through it is a toy track (buildToyTrack): moulded plastic with a
// shoulder either side, standing on stilts wherever it is off the floor.
//
// THE COURT (the Grand Prix): an outdoor basketball court. Two files draw it, both in the court's own
// frame (metres, floor on y = 0, x from one backboard to the other; scripts/blender/
// pocabinet-court.py and pocabinet-court-splat.py build them from the same reconstruction):
//
//   • court.ksplat, a Gaussian splat (400k splats, 9.6 MB; court-low.ksplat is its first 100k,
//     shown first), through platform/3d/splats.js (r186 TSL splat renderer; its Web Worker sorts back to front);
//   • court.glb, the photogrammetry mesh: what the low graphics tier and the "Lite" setting
//     draw, and the fallback if the splat cannot be. Its three atlases are KTX2 (Basis ETC1S,
//     mips in the file) and its geometry Meshopt, packed by scripts/pocabinet/court-pack.mjs:
//     the textures stay compressed on the GPU (4 MB as ETC2 on a phone, 8 as BC7 on a desktop,
//     where the JPEGs decoded to 32), which matters on exactly the devices that draw the mesh.
//
// Only the court and a few metres round it are drawn (track.scan.halfLength / halfWidth): the
// splat's shader drops everything outside that rectangle and fades the last stretch, the mesh
// is clipped to it. Inside it terrain.js steps the scene's own ground down out of the way, and
// a shadow catcher on the floor takes the cars' shadows (the scan is unlit: its colours are the
// court as the camera saw it). Every function takes the SceneHandle first; scene.js keeps thin
// methods that call them. Render-only.

import * as THREE from './three.js';
import { WORLD_SCALE, roadPlane } from './util.js';
import { disposeObject, hex, ribbon } from './meshes.js';
import { wallFace } from './terrain.js';
import * as TSL from 'three-eco/tsl';
import { loadSplat } from '../platform/3d/splats.js';
import { getKtx2Loader } from '../platform/3d/textureLoader.js';
import { getGltfLoader } from '../platform/3d/gltfLoader.js';

export const COURT = {
    url: 'models/court.glb',
    splat: 'models/court.ksplat',            // 400k splats, 9.6 MB
    splatLow: 'models/court-low.ksplat',     // 100k, ~2.4 MB: shown first while the full one loads
    lift: 1.0,            // the mesh's colours into the post pass (1 = as captured)
    splatLift: 0.82,      // the splat's, once linearized: it reads brighter than the mesh, so a touch down
    label: 'court',
    fade: 1.6,            // world units over which the splat fades out at the edge of the rectangle
    // Above `low` metres only the two hoops are drawn: within `hoopReach` metres (along the
    // court) of a point `hoopAt` metres from the centre, and `hoopHalf` either side of the
    // court's axis. The trees round the court reach in over it, and without their trunks
    // (outside the rectangle) their branches would hang in the air.
    low: 0.6, hoopAt: 13.7, hoopReach: 1.9, hoopHalf: 1.5,
    crop: true,
    // How many splats each quality tier can sort and blend: the whole 400k scan on high, half on
    // medium, a quarter (the light file's size) on low. The loader strides the file down to the cap.
    cap: { high: 400000, medium: 200000, low: 100000 },
    shadow: 0.32,         // the floor's shadow catcher
};

export const HOUSE = {
    url: null,                               // no mesh: the light splat is the lite version
    splat: 'models/house.ksplat',            // 2.8M splats, 92 MB
    splatLow: 'models/house-low.ksplat',     // 250k, 8 MB: shown first, and the lite version
    splatLift: 1.0,
    label: 'house',
    crop: false,          // drawn whole
    // Every splat on a desktop, whatever its tier: thinning the file by a stride (and swelling the
    // survivors to cover) is what made the house blobby on medium.
    cap: { high: 3000000, medium: 3000000, low: 250000 },
    // What is drawn of it (platform/3d/splats.js culls to the view first): past `near` world units
    // (3 m) only the most important share of each `cell` (half a metre) of the house, down to a
    // third of it at the far end, and never more than `draw` at once (the nearest are kept).
    // Owner, 2026-11-27: the house should look like the scan, and fewer frames are accepted. The
    // budget is set by the tier the scan was loaded on and does not follow the live quality down.
    // On a Snapdragon X laptop, looking down a whole room: 400k drawn ran at 12 to 17 fps, 600k at
    // 6 to 7, 1M at 2 to 3 (the drop is steep), so the budget stops at the knee.
    lod: { near: 240, floor: 0.35, cell: 40 },
    draw: { high: 450000, medium: 380000, low: 250000 },
    indoor: true,         // no terrain, sky, scenery, grass or rain; the road is a toy track
    shadow: 0.2,
    // The chase camera rides higher and further back here (cameras.js): the scan was filmed from
    // standing height, and the closer the camera gets to the floor the more it sees what the
    // capture never did (smears and floaters).
    chase: { back: 10.5, up: 5.2, look: 1.4 },
    groundY: -110,        // world units: a dark floor under the house, below the stairwell's foot
    deckFrom: 40,         // sim units (5 cm): past this the road is off the floor, on stilts
    stiltEvery: 8,        // samples between pairs of stilts (~25 cm of road)
    seam: 200,            // sim units between the toy track's moulded joints (25 cm lengths)
};

/** The scans, by track.scan.id. */
export const SCANS = { court: COURT, house: HOUSE };

/** How the handle's (or a track's) scan is drawn: the court's when it has none or an unknown one. */
export function scanOf(sh) {
    return SCANS[(sh?.track ?? sh)?.scan?.id] || COURT;
}

/** True on a track that is all indoors (the house): the scan is the whole world. */
export function isIndoor(track) {
    return !!track?.scan && !!SCANS[track.scan.id]?.indoor;
}

/**
 * The Basis Universal transcoder KTX2Loader runs in its worker, served by this site
 * (wwwroot/lib/basis, built by scripts/pocabinet/basis-build.sh). Not three's copy on the CDN:
 * that one is the stock embind build, which makes functions from strings, and this site's
 * Content-Security-Policy has no 'unsafe-eval', so every texture failed to transcode with it
 * (r165 and r186 both). Ours is the same source built with DYNAMIC_EXECUTION=0.
 */
export const BASIS_PATH = 'lib/basis/';

/**
 * Where the scan stands in the scene (world units), from track.scan: its origin, the scale its
 * metres are drawn at, and the half extents of the rectangle that is drawn. Null without a scan.
 */
export function scanPlace(sh) {
    const s = sh?.track?.scan;
    if (!s) return null;
    return {
        x: s.x / WORLD_SCALE, y: s.floorZ / WORLD_SCALE, z: s.y / WORLD_SCALE, scale: s.scale / WORLD_SCALE,
        hx: s.halfLength * s.scale / WORLD_SCALE, hz: s.halfWidth * s.scale / WORLD_SCALE,
    };
}

/** The drawn rectangle as a sim-unit ring [x0, y0, …] (grass.js keeps it bare), or null. */
export function scanRing(track) {
    const s = track?.scan;
    if (!s) return null;
    const hx = s.halfLength * s.scale, hy = s.halfWidth * s.scale;
    return [s.x - hx, s.y - hy, s.x + hx, s.y - hy, s.x + hx, s.y + hy, s.x - hx, s.y + hy];
}

/**
 * A shadow catcher on the scan's floor, so the cars, the road's deck and the barriers throw
 * shadows onto the unlit scan. No depth: it is transparent like the splat, and three sorts the
 * two by distance every frame; writing depth, whenever it drew first it hid the splat's floor
 * just under it and the ground below showed through.
 */
export function buildScanFloor(sh, group) {
    const p = scanPlace(sh);
    if (!p) return;
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(p.hx * 2, p.hz * 2).rotateX(-Math.PI / 2),
        new THREE.ShadowMaterial({ opacity: scanOf(sh).shadow, depthWrite: false }));
    catcher.position.set(p.x, p.y + 0.09, p.z);
    catcher.receiveShadow = true;
    catcher.name = 'pocabinet-scan-shadows';
    group.add(catcher);
}

/** The "Court scan" values (PoCabinetUiSettings.RoomDetail); anything else reads as 'auto'. */
function roomDetailOf(v) {
    const d = String(v ?? '').toLowerCase();
    return d === 'mesh' || d === 'splat' ? d : 'auto';
}

/**
 * The player's "Court scan" setting (PoCabinetUiSettings.RoomDetail): 'auto' (the default),
 * 'splat' (full) or 'mesh' (lite). applySettings sets it on the handle; before the first
 * applySettings (the track is built inside mount) it is read from the stored settings so a lite
 * player never downloads the splat.
 */
export function storedRoomDetail() {
    try {
        const s = JSON.parse(localStorage.getItem('pominigames:pocabinet-settings-v1') || '{}');
        return roomDetailOf(s.roomDetail ?? s.RoomDetail);
    } catch {
        return 'auto';
    }
}

/**
 * A device or a connection the 9.6 MB scan is too much for: a phone (a touch screen under
 * tablet size), a browser asked to save data, a slow link, or little memory. 'auto' stops at
 * the light scan (2.4 MB, a quarter of the splats to sort) on these.
 */
function lightDevice() {
    try {
        const conn = navigator.connection;
        if (conn?.saveData || /(^|-)(2g|3g)$/.test(conn?.effectiveType || '')) return true;
        if ((navigator.deviceMemory || 8) <= 4) return true;
        return window.matchMedia('(pointer: coarse)').matches && Math.min(window.screen.width, window.screen.height) < 700;
    } catch {
        return false;
    }
}

/** What a "Court scan" value draws on this device: 'mesh', 'light' (the 100k scan) or 'full'. */
function roomPlan(detail) {
    if (detail === 'mesh') return 'mesh';
    if (detail === 'splat') return 'full';
    return lightDevice() ? 'light' : 'full';
}

/**
 * Draw the scan into `group`: the splat, or the mesh on the low tier, on "Lite" and when the
 * splat cannot load. The splat (sorted every frame) costs frame rate; a tier change mid-race
 * does not swap it, the setting does.
 */
export async function loadScan(sh, group) {
    const place = scanPlace(sh);
    if (!place) return;
    const scan = scanOf(sh);
    const plan = roomPlan(sh.roomDetail || (sh.roomDetail = storedRoomDetail()));
    const lite = sh.quality === 'low' || plan === 'mesh';
    // A scan with no mesh (the house) is always a splat: the light file is its lite version.
    if ((!lite || !scan.url) && await loadScanSplat(sh, group, plan === 'full' && !lite)) return;
    if (sh.disposed || sh.trackGroup !== group || !scan.url) return;
    await loadScanMesh(sh, group, place);
}

/**
 * court.glb (KTX2 atlases, Meshopt geometry), placed and clipped to the drawn rectangle: unlit as exported, it
 * neither casts nor takes the sun's shadows (the catcher does). Its textures are already the
 * court as the camera saw it, so they skip the filmic curve (which would grey them).
 * Non-fatal, and dropped if the track changed meanwhile.
 */
async function loadScanMesh(sh, group, place) {
    let ktx2 = null;
    try {
        const [{ GLTFLoader }, { KTX2Loader }, { MeshoptDecoder }] = await Promise.all([
            import('three-eco/addons/loaders/GLTFLoader.js'),
            import('three-eco/addons/loaders/KTX2Loader.js'),
            import('three-eco/addons/libs/meshopt_decoder.module.js'),
        ]);
        // detectSupport picks the GPU's own compressed format (ASTC, ETC2 or BC), so the
        // atlases are never held as RGBA.
        ktx2 = new KTX2Loader().setTranscoderPath(new URL(BASIS_PATH, document.baseURI).href).detectSupport(sh.renderer);
        const gltf = await new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder).loadAsync(COURT.url);
        const model = gltf.scene;
        const planes = [
            new THREE.Plane(new THREE.Vector3(1, 0, 0), -(place.x - place.hx)),
            new THREE.Plane(new THREE.Vector3(-1, 0, 0), place.x + place.hx),
            new THREE.Plane(new THREE.Vector3(0, 0, 1), -(place.z - place.hz)),
            new THREE.Plane(new THREE.Vector3(0, 0, -1), place.z + place.hz),
        ];
        const textures = new Set();
        model.traverse(o => {
            if (!o.isMesh) return;
            o.castShadow = false;
            o.receiveShadow = false;
            for (const m of [o.material].flat()) {
                for (const v of Object.values(m)) if (v && v.isTexture) textures.add(v);
                m.toneMapped = false;
                m.color?.multiplyScalar(COURT.lift);
                m.clippingPlanes = planes;
            }
        });
        if (sh.disposed || sh.trackGroup !== group) {
            disposeObject(model);
            for (const t of textures) t.dispose();
            return;
        }
        sh.renderer.localClippingEnabled = true;
        model.name = 'pocabinet-scan';
        model.position.set(place.x, place.y, place.z);
        model.scale.setScalar(place.scale);
        group.add(model);
        sh.ownedTextures.push(...textures);
    } catch (e) {
        console.warn('pocabinet/scene: the court scan was skipped', e);
    } finally {
        ktx2?.dispose();
    }
}

/** Dispose a splat cloud's object (platform/3d/splats.js): ends its sort worker, frees its textures. */
function disposeViewer(viewer) {
    if (!viewer) return;
    viewer.parent?.remove(viewer);
    try {
        viewer.userData.cloud?.dispose();
    } catch (e) {
        console.warn('pocabinet/scene: splat dispose', e);
    }
}

/** Drop the scan's splat (if any): leaving the race, or switching to lite. */
export function disposeRoomSplat(sh) {
    disposeViewer(sh.roomSplat);
    sh.roomSplat = null;
    sh.roomProgress?.remove();
    sh.roomProgress = null;
}

/** A small "Loading court 42%" bar over the canvas while the splat downloads. */
function progressBar(sh) {
    const host = sh.canvas?.parentElement;
    if (!host) return { set() {}, remove() {} };
    const el = document.createElement('div');
    el.className = 'pocabinet-room-loading';
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:absolute;left:50%;bottom:14%;transform:translateX(-50%);z-index:5;'
        + 'padding:6px 12px;border-radius:999px;background:rgba(10,12,16,.62);color:#f1ede6;'
        + 'font:600 12px/1.2 system-ui,sans-serif;pointer-events:none;display:flex;gap:8px;align-items:center;';
    el.innerHTML = '<span>Loading scan</span><span style="width:110px;height:5px;border-radius:3px;background:rgba(255,255,255,.18);overflow:hidden"><i style="display:block;height:100%;width:0;background:#9fd0ff;transition:width .2s"></i></span><b>0%</b>';
    host.appendChild(el);
    const bar = el.querySelector('i'), pct = el.querySelector('b');
    return {
        el,
        set(p, label) {
            const v = Math.max(0, Math.min(100, Math.round(p)));
            bar.style.width = v + '%';
            pct.textContent = v + '%';
            if (label) el.firstChild.textContent = label;
        },
        remove() { el.remove(); },
    };
}

async function makeViewer(sh, group, url, place, onProgress) {
    const scan = scanOf(sh);
    // The splat's frame is z up: turned to three's y up, scaled and stood where the scan stands.
    const upright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(place.x, place.y, place.z), upright,
        new THREE.Vector3(place.scale, place.scale, place.scale));
    const cloud = await loadSplat(THREE, TSL, url, {
        matrix,
        maxSplats: scan.cap[sh.quality] ?? scan.cap.high,
        lod: scan.lod,
        maxDraw: scan.draw ? (scan.draw[sh.quality] ?? scan.draw.high) : 0,
        lift: scan.splatLift,
        name: 'pocabinet-scan-splat',
        // The court: only it and a few metres round it, softly ending in the lawn; above `low`
        // metres only the two hoops (the trees round the court would otherwise hang in the air).
        // The house is drawn whole.
        crop: scan.crop ? { x: place.x, z: place.z, hx: place.hx, hz: place.hz, fade: scan.fade } : undefined,
        hide: scan.crop ? { floorY: place.y, scale: place.scale, low: scan.low, hoopAt: scan.hoopAt, hoopReach: scan.hoopReach, hoopHalf: scan.hoopHalf, cx: place.x, cz: place.z } : undefined,
        onProgress: (p) => onProgress?.(Number(p) || 0),
    });
    if (sh.disposed || sh.trackGroup !== group) {
        cloud.dispose();
        return null;
    }
    cloud.object.userData.cloud = cloud;
    if (sh.camera) cloud.warmSort?.(sh.camera);
    if (sh.renderer) { getKtx2Loader(sh.renderer).catch(() => {}); getGltfLoader(sh.renderer).catch(() => {}); }
    return cloud.object;
}

/**
 * The court as a Gaussian splat, in two steps: the light splat (COURT.splatLow, 100k, ~2.4 MB)
 * goes in first so the court appears within a second or two, then the full one (COURT.splat,
 * 400k) loads behind it and replaces it, unless `full` is false (roomPlan: 'auto' on a phone or
 * a slow link), where the light one is the court. A bar over the canvas shows the downloads.
 * True once a splat is in the scene; false (and nothing added) if the library, the file or the
 * GPU says no, or the track changed.
 */
export async function loadScanSplat(sh, group, full = true) {
    const place = scanPlace(sh);
    if (!place) return false;
    const scan = scanOf(sh);
    const bar = progressBar(sh);
    sh.roomProgress = bar;
    const done = () => { bar.remove(); if (sh.roomProgress === bar) sh.roomProgress = null; };
    try {
        const low = await makeViewer(sh, group, scan.splatLow, place, (p) => bar.set(p * (full ? 0.25 : 1), `Loading ${scan.label}`));
        if (!low) { done(); return false; }
        low.name = 'pocabinet-scan-splat';
        group.add(low);
        sh.roomSplat = low;
        if (!full) { done(); return true; }
        // The sharp version, behind the light one; any failure just keeps the light one.
        makeViewer(sh, group, scan.splat, place, (p) => bar.set(25 + p * 0.75, `Sharpening ${scan.label}`))
            .then((sharp) => {
                if (!sharp) return;
                if (sh.roomSplat !== low) { disposeViewer(sharp); return; }
                sharp.name = 'pocabinet-scan-splat';
                group.add(sharp);
                sh.roomSplat = sharp;
                disposeViewer(low);
            })
            .catch((e) => console.warn(`pocabinet/scene: the full ${scan.label} splat was skipped, keeping the light one`, e))
            .finally(done);
        return true;
    } catch (e) {
        done();
        console.warn(`pocabinet/scene: the ${scan.label} splat was skipped`, e);
        return false;
    }
}

/**
 * "Court scan: Auto / Full / Lite" changed: swap what draws the court (the full scan, the light
 * one or the mesh) without rebuilding the track. A change that draws the same thing here (Auto
 * to Full on a desktop) reloads nothing.
 */
export function setRoomDetail(sh, detail) {
    const next = roomDetailOf(detail);
    if (sh.roomDetail === next) return;
    const same = sh.roomDetail && roomPlan(sh.roomDetail) === roomPlan(next);
    sh.roomDetail = next;
    const group = sh.trackGroup;
    if (same || !sh.track?.scan || !group) return;
    disposeRoomSplat(sh);
    const mesh = group.getObjectByName('pocabinet-scan');
    if (mesh) {
        group.remove(mesh);
        disposeObject(mesh);
    }
    loadScan(sh, group);
}

/**
 * Per frame: nothing the splat needs from the scene any more. The old viewer's GLSL had to be
 * patched with a linearize switch (post pass on or off) and the crop; platform/3d/splats.js takes
 * both as options and the r186 pipeline is always linear, so this stays as the scene's hook only.
 */
export function syncRoomSplat(sh) {
    const cloud = sh.roomSplat?.userData?.cloud;
    if (!cloud) return;
    cloud.uniforms.lift.value = scanOf(sh).splatLift;
    const flash = sh.fx?.lightningFlash || 0;
    cloud.setLighting?.({ flash });
}

// ── The toy track (indoor scans) ─────────────────────────────────────────────────────────────

/**
 * The toy road: moulded grey plastic under a light clearcoat, so the room's light slides along it
 * as a soft sheen. Smooth, where the Grand Prix's tarmac is rough.
 */
export function toyRoadMaterial(atmosphere) {
    return new THREE.MeshPhysicalMaterial({
        color: hex(atmosphere.roadHex, '#4a4d55'), roughness: 0.58, metalness: 0,
        clearcoat: 0.55, clearcoatRoughness: 0.28, side: THREE.DoubleSide,
    });
}

/** The shoulder either side of the toy road (the run-off): the same plastic in the track's accent colour. */
export function toyShoulderMaterial(atmosphere) {
    return new THREE.MeshStandardMaterial({
        color: hex(atmosphere.accentHex, '#e07a3f').multiplyScalar(0.8), roughness: 0.72, metalness: 0, side: THREE.DoubleSide,
    });
}

let moulding = null;
/** Alpha across the road's width (u) and one moulded length (v): darker toward both rails, the
 *  shading a moulded channel has, and a thin joint line where two lengths meet. */
function mouldingTexture() {
    if (moulding) return moulding;
    const w = 64, h = 64;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
        const v = y / h;
        const joint = Math.max(0, 1 - Math.min(v, 1 - v) * h / 1.6);
        for (let x = 0; x < w; x++) {
            const u = (x + 0.5) / w;
            const edge = Math.pow(Math.max(0, 1 - Math.min(u, 1 - u) / 0.16), 2);
            img.data[(y * w + x) * 4 + 3] = Math.round(Math.min(1, edge * 0.42 + joint * 0.5) * 255);
        }
    }
    g.putImageData(img, 0, 0);
    moulding = new THREE.CanvasTexture(c);
    moulding.wrapS = THREE.ClampToEdgeWrapping;
    moulding.wrapT = THREE.RepeatWrapping;
    moulding.anisotropy = 4;
    return moulding;
}

/** One strip over the road, u across its width, v one per moulded length. */
function mouldingStrip(t, seam) {
    const n = t.count;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= n; i++) {
        const k = i % n;
        const nx = -t.ty[k], ny = t.tx[k];
        const v = (i === n ? t.length : t.cum[k]) / seam;
        for (const [lat, u] of [[-t.hw[k], 0], [t.hw[k], 1]]) {
            pos.push((t.x[k] + nx * lat) / WORLD_SCALE, 0.035 + roadPlane(t, k, lat) / WORLD_SCALE, (t.y[k] + ny * lat) / WORLD_SCALE);
            uv.push(u, v);
        }
    }
    for (let i = 0; i < n; i++) {
        if (!t.drawn(i)) continue;
        const a0 = i * 2;
        idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geom.setIndex(idx);
    return geom;
}

/**
 * What makes the road through an indoor scan a toy track, on top of the road, shoulders and
 * barriers the scene lays for every track:
 *   - the moulding: channel shading and a joint every `seam` units, as an overlay on the road;
 *   - a slab under the road and both shoulders, a few millimetres thick, so the track has an
 *     underside and an edge when a camera looks up at it from the floor;
 *   - stilts: a pair under the slab's edges every `stiltEvery` samples wherever the road is more
 *     than `deckFrom` over the floor, down to the floor (through whatever furniture the scan has
 *     under it: the scan draws over them there), none where one would stand in another stretch
 *     of the road's own corridor (the hall's two lanes).
 */
export function buildToyTrack(sh, group, atmosphere) {
    const t = sh.track;
    const scan = scanOf(sh);
    const n = t.count;
    const floor = (t.scan?.floorZ || 0);
    const overlay = new THREE.Mesh(mouldingStrip(t, scan.seam), new THREE.MeshBasicMaterial({
        color: 0x000000, map: mouldingTexture(), transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
    }));
    overlay.name = 'pocabinet-toy-moulding';
    overlay.renderOrder = 1;
    group.add(overlay);

    const slabMat = new THREE.MeshStandardMaterial({
        color: hex(atmosphere.roadHex, '#4a4d55').multiplyScalar(0.55), roughness: 0.7, metalness: 0, side: THREE.DoubleSide,
    });
    const THICK = 0.55;    // world units: ~7 mm of plastic at this scale
    const left = (i) => -(wallFace(t, i, -1) + 2.5), right = (i) => wallFace(t, i, 1) + 2.5;
    const under = new THREE.Mesh(ribbon(t, left, right, -THICK, 45), slabMat);
    under.name = 'pocabinet-toy-slab';
    under.castShadow = true;
    group.add(under);
    // The slab's two edges: a skirt from the shoulder's level down to the underside.
    for (const lat of [left, right]) {
        const pos = [], idx = [];
        for (let i = 0; i <= n; i++) {
            const k = i % n, a = lat(k);
            const x = (t.x[k] - t.ty[k] * a) / WORLD_SCALE, z = (t.y[k] + t.tx[k] * a) / WORLD_SCALE;
            const y = roadPlane(t, k, a) / WORLD_SCALE;
            pos.push(x, y + 0.012, z, x, y - THICK, z);
        }
        for (let i = 0; i < n; i++) {
            if (!t.drawn(i)) continue;
            const a0 = i * 2;
            idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
        const skirt = new THREE.Mesh(g, slabMat);
        skirt.name = 'pocabinet-toy-skirt';
        group.add(skirt);
    }

    const up = (i) => !!t.z && t.z[i] - floor > scan.deckFrom;
    const inOtherStretch = (sx, sy, i) => {
        for (let k = 0; k < n; k += 2) {
            const gap = Math.abs(k - i);
            if (Math.min(gap, n - gap) < 60) continue;
            const dx = t.x[k] - sx, dy = t.y[k] - sy;
            if (dx * dx + dy * dy < (wallFace(t, k, 1) + 6) ** 2) return true;
        }
        return false;
    };
    const spots = [];
    for (let i = 0; i < n; i += scan.stiltEvery) {
        if (!up(i) || !t.drawn(i)) continue;
        for (const s of [-1, 1]) {
            const lat = s * (wallFace(t, i, s) - 2);
            const sx = t.x[i] - t.ty[i] * lat, sy = t.y[i] + t.tx[i] * lat;
            if (inOtherStretch(sx, sy, i)) continue;
            spots.push([sx / WORLD_SCALE, (roadPlane(t, i, lat) - floor) / WORLD_SCALE - THICK, sy / WORLD_SCALE]);
        }
    }
    if (spots.length) {
        const stilts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.42, 0.55, 1, 10),
            new THREE.MeshStandardMaterial({ color: '#ece8df', roughness: 0.5, metalness: 0 }), spots.length);
        const m = new THREE.Matrix4(), q = new THREE.Quaternion();
        const y0 = floor / WORLD_SCALE;
        spots.forEach(([x, h, z], k) => stilts.setMatrixAt(k, m.compose(new THREE.Vector3(x, y0 + h / 2, z), q, new THREE.Vector3(1, h, 1))));
        stilts.castShadow = true;
        stilts.name = 'pocabinet-toy-stilts';
        group.add(stilts);
    }
}
