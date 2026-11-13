// pocabinet/models.js
//
// Tracks whose world is a loaded model rather than the scene's own terrain: the Playground
// marble run (playground.glb) and the two scans (SCANS): the Bedroom Floor GP (bedroom.glb as the
// collision model, the bedroom.ksplat Gaussian splat as what is drawn) and Center Court (court.glb /
// court.ksplat, an outdoor basketball court). MODEL_LOOKS is the one table scene.js asks
// "does this track bring its own world, and how is it loaded". Every function takes the
// SceneHandle first; scene.js keeps thin methods that call them. Render-only.

import * as THREE from 'three';
import { wallFace } from './terrain.js';
import { WORLD_SCALE, roadPlane } from './util.js';
import { disposeObject, hex, ribbon } from './meshes.js';

// Playground Marble Run: wwwroot/models/playground.glb (metres, +Y up) drawn at 50× around
// the world origin, so 1 model metre = 50 scene units = 500 sim units — the scale the track's
// knots in PoCabinetTrackGeometry were baked at, and the one at which the marble gutter's
// 26 cm floor is as wide as the physics corridor (road + run-off). The track is the marble
// run, without its walls (the gutter's sides would stand eight units
// tall around a one-unit car and hide the rest of the scene). So the model's gutter is hidden
// and, down to track.roadFrom, the scene lays an open chute in its place: the gutter's
// floor, same width, same bank, on the same supports, with two edge lines. From there on
// the gutter has ended at the drop well (marbles fall; cars get a ramp) and the scene builds
// a road: the ramp, down the slide, into the finish tray — tarmac and run-off deck. No
// barriers anywhere; the physics still stops a car at the edge. The well and the four
// marbles are hidden too. Render-only (neither physics copy knows the model exists). Loaded
// async after the track is built; if it fails the race runs on the chute over a plain lawn.
export const PLAYGROUND = {
    url: 'models/playground.glb',
    scale: 50,
    hidden: /^SM_Marble(Track|DropWell|_\d)/,
    chuteHex: '#2f86d6',
    // Outline (model metres, x/z) of everything it puts on the ground — pad, posts, slide,
    // marble-run supports and tray — kept free of grass blades.
    footprint: [
        6.9, 0.6, 7.49, 1.99, 7.22, 3.38, 6.52, 4.62, 5.26, 5.36, 3.58, 5.21, 2.3, 4.94, 1.32, 4.71,
        0.5, 5, -0.5, 5.63, -1.49, 5.4, -2.43, 4.98, -3.41, 4.51, -4.32, 3.82, -5.27, 2.99, -6.05, 1.9,
        -6.2, 0.6, -6.07, -0.71, -5.92, -2.06, -5.26, -3.25, -4.21, -4.11, -2.73, -4.24, -1.54, -4.32, -0.48, -4.34,
        0.5, -4.1, 1.26, -3.22, 2.03, -3.09, 3.1, -3.3, 3.96, -2.86, 4.81, -2.28, 5.51, -1.48, 5.86, -0.47,
    ],
};

export const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/gltf/';

// Bedroom Floor GP: wwwroot/models/bedroom.glb, a scanned bedroom that
// scripts/blender/pocabinet-bedroom.py stands up (floor on y = 0), cuts the ceiling off,
// decimates and checks the route against. It is in the scan's room units (~4.3 to the metre),
// drawn at 15x: 150 sim units per room unit, the scale the track's knots were printed at, so a
// car is a ~4 cm toy on the carpet. The scan is unlit (its textures carry the room's own light)
// and single-sided, so a camera outside a wall sees through it. The road is the toy track: orange
// plastic decked out to the rails and standing on stilts wherever it is off the carpet (the whole
// lap, ~4 ft up), and the scene's sun reaches the room only through a shadow catcher on the floor.
// Render-only; if the model fails the race runs on a plain carpet-coloured floor.
//
// The room is drawn as a Gaussian splat when it loads (wwwroot/models/bedroom.ksplat, a separate
// 3DGS capture of the same room that scripts/blender/pocabinet-bedroom-splat.py registers onto the
// mesh to under a centimetre, crops like it and trims to 400k splats), through
// gaussian-splats-3d's DropInViewer, which sorts in a worker. The mesh stays the collision model
// (the route is checked against it) and is drawn instead on the low graphics tier or if the
// splat cannot be.
export const ROOM = {
    url: 'models/bedroom.glb',
    splat: 'models/bedroom.ksplat',          // 400k splats, 9.6 MB
    splatLow: 'models/bedroom-low.ksplat',   // 100k, ~2.4 MB: shown first while the full one loads
    scale: 15,
    carpetHex: '#7b7166',
    lift: 1.0,            // the mesh's colours into the post pass (1 = as captured)
    splatLift: 0.78,      // the splat's, once linearized: it reads brighter than the mesh, so a touch down
    deckFrom: 8,         // sim height past which the road is off the carpet: decked, on stilts
    seam: 20,            // sim units between the toy track's moulded joints (= audio.js SEAM_SPACING)
    label: 'room',
    groundY: -0.2,       // scene units: the flat ground under the scan's floor
};

// Center Court: wwwroot/models/court.glb, an outdoor basketball court that
// scripts/blender/pocabinet-court.py levels into the court frame (metres, floor on y = 0, x from
// one backboard to the other), crops ~25 m round the court and checks the route against. Drawn at
// 10x: 100 sim units per metre, the scale the track's knots were printed at, so a car is a ~28 cm
// toy racing on the court floor, under hoops ten times its length. The splat
// (court.ksplat, scripts/blender/pocabinet-court-splat.py) is the same reconstruction as the mesh,
// so it needs no registration, only the same frame. Past the scan the flat ground is lawn.
export const COURT = {
    url: 'models/court.glb',
    splat: 'models/court.ksplat',            // 400k splats, 9.6 MB
    splatLow: 'models/court-low.ksplat',     // 100k, ~2.4 MB
    scale: 10,
    carpetHex: '#5d7a3a',
    lift: 1.0,
    splatLift: 0.82,
    deckFrom: 20,        // the road lies on the court at 13 sim (13 cm): past this it would stand on stilts
    seam: 20,
    label: 'court',
    // The splat's court is fuzz a few centimetres either side of the floor: the lawn under it
    // goes down out of its way (it only shows past the edge of the scan).
    groundY: -1.5,
};

/** The scanned tracks, by scene theme (terrain.js isScan). */
export const SCANS = { bedroom: ROOM, court: COURT };

/** The scan the handle's track is laid over (the bedroom's when unsure). */
export function scanOf(sh) {
    return SCANS[sh?.theme] || ROOM;
}

/** Sim-unit ring of the model's footprint, or null on tracks without a model. */
export function keepOutFor(trackId) {
    return trackId === 'playground' ? PLAYGROUND.footprint.map(v => v * PLAYGROUND.scale * WORLD_SCALE) : null;
}

/**
 * The bedroom's toy track off the carpet: where the road climbs (track.z past ROOM.deckFrom)
 * the run-off is decked in darker plastic out to the barrier and the deck stands on stilts
 * down to the floor (on the cushion they stand inside it). Plus a shadow catcher on the floor,
 * so the cars, road and rails throw shadows onto the unlit scan.
 */
/**
 * The toy road: moulded grey plastic under a light clearcoat, so the room's light (the sky dome's
 * IBL) slides along it as a soft sheen without the bloom the bright orange used to throw.
 */
export function toyRoadMaterial(atmosphere) {
    return new THREE.MeshPhysicalMaterial({
        color: hex(atmosphere.roadHex, '#56585e'), roughness: 0.58, metalness: 0,
        clearcoat: 0.55, clearcoatRoughness: 0.28, side: THREE.DoubleSide,
    });
}

let moulding = null;
/** Alpha texture across x road-width (0 = left edge, 1 = right) and along y one seam: darker
 *  toward both rails (the shading a moulded channel has) and a thin joint line at each seam. */
function mouldingTexture() {
    if (moulding) return moulding;
    const w = 64, h = 64;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
        const v = y / h;
        const joint = Math.max(0, 1 - Math.min(v, 1 - v) * h / 1.6);      // ~3 px line at v = 0
        for (let x = 0; x < w; x++) {
            const u = (x + 0.5) / w;
            const edge = Math.pow(Math.max(0, 1 - Math.min(u, 1 - u) / 0.16), 2);   // the outer 16%
            const a = Math.min(1, edge * 0.42 + joint * 0.5);
            const k = (y * w + x) * 4;
            img.data[k] = img.data[k + 1] = img.data[k + 2] = 0;
            img.data[k + 3] = Math.round(a * 255);
        }
    }
    g.putImageData(img, 0, 0);
    moulding = new THREE.CanvasTexture(c);
    moulding.wrapS = THREE.ClampToEdgeWrapping;
    moulding.wrapT = THREE.RepeatWrapping;
    moulding.anisotropy = 4;
    return moulding;
}

/** The moulding overlay: one strip over the road, u across its width, v one per seam. */
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
        const a0 = i * 2, a1 = a0 + 1, b0 = a0 + 2, b1 = a0 + 3;
        idx.push(a0, a1, b0, a1, b1, b0);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geom.setIndex(idx);
    return geom;
}

export function buildRoomTrack(sh, group, atmosphere) {
    const t = sh.track;
    const n = t.count;
    const scan = scanOf(sh);
    const overlay = new THREE.Mesh(mouldingStrip(t, scan.seam), new THREE.MeshBasicMaterial({
        color: 0x000000, map: mouldingTexture(), transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
    }));
    overlay.name = 'pocabinet-room-moulding';
    overlay.renderOrder = 1;
    group.add(overlay);
    const up = (i) => !!t.z && Math.min(t.z[i], t.z[(i + 1) % n]) > scan.deckFrom;
    const deckMat = new THREE.MeshStandardMaterial({
        color: hex(atmosphere.roadHex, '#d9581a').multiplyScalar(0.62), roughness: 0.6, metalness: 0, side: THREE.DoubleSide,
    });
    for (const [a, b] of [[(i) => -wallFace(t, i, -1), (i) => -t.hw[i]], [(i) => t.hw[i], (i) => wallFace(t, i, 1)]]) {
        const deck = new THREE.Mesh(ribbon(t, a, b, 0.015, 45, (i) => t.drawn(i) && up(i)), deckMat);
        deck.castShadow = true;
        deck.receiveShadow = true;
        group.add(deck);
    }
    sh.roadMesh.castShadow = true;

    // Stilts: a pair every few samples under the deck's edges, floor to deck; none where it would
    // stand in a lower part of the lap (the court's flyover passes over its own road).
    const spots = [];
    const onLowerRoad = (sx, sy, h, i) => {
        for (let k = 0; k < n; k++) {
            if (Math.abs(k - i) < 40 && Math.abs(k - i) < n - 40) continue;
            const dx = t.x[k] - sx, dy = t.y[k] - sy;
            if (t.z[k] < h - 20 && dx * dx + dy * dy < (wallFace(t, k, 1) + 4) ** 2) return true;
        }
        return false;
    };
    for (let i = 0; i < n; i += 4) {
        if (!up(i)) continue;
        for (const s of [-1, 1]) {
            const lat = s * (wallFace(t, i, s) - 3);
            const h = roadPlane(t, i, lat) / WORLD_SCALE;
            const sx = t.x[i] - t.ty[i] * lat, sy = t.y[i] + t.tx[i] * lat;
            if (onLowerRoad(sx, sy, h * WORLD_SCALE, i)) continue;
            spots.push([sx / WORLD_SCALE, h, sy / WORLD_SCALE]);
        }
    }
    if (spots.length) {
        const stilt = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.45, 0.6, 1, 10),
            new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.5, metalness: 0 }), spots.length);
        const m = new THREE.Matrix4();
        spots.forEach(([x, h, z], k) => stilt.setMatrixAt(k, m.compose(
            new THREE.Vector3(x, h / 2, z), new THREE.Quaternion(), new THREE.Vector3(1, h, 1))));
        stilt.castShadow = true;
        stilt.name = 'pocabinet-room-stilts';
        group.add(stilt);
    }

    const pad = 60;
    const xs = [], ys = [];
    for (let i = 0; i < n; i++) { xs.push(t.x[i]); ys.push(t.y[i]); }
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = (maxX - minX) / WORLD_SCALE + pad * 2, d = (maxY - minY) / WORLD_SCALE + pad * 2;
    // No depth: it is transparent like the splat, and three sorts the two by distance every frame.
    // Writing depth, whenever it drew first it hid the splat's floor just under it (half the
    // floor's fuzz) and the ground below showed through, so the floor flickered with the camera.
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
        new THREE.ShadowMaterial({ opacity: 0.32, depthWrite: false }));
    catcher.position.set((minX + maxX) / 2 / WORLD_SCALE, 0.09, (minY + maxY) / 2 / WORLD_SCALE);
    catcher.receiveShadow = true;
    catcher.name = 'pocabinet-room-shadows';
    group.add(catcher);
}

/**
 * Fetch a Draco GLB and place it in `group` at `scale`, after `prepare(mesh)` has had each
 * mesh; non-fatal, and dropped if the track changed meanwhile.
 */
export async function loadModel(sh, group, url, scale, name, prepare) {
    let draco = null;
    try {
        const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
            import('three/addons/loaders/GLTFLoader.js'),
            import('three/addons/loaders/DRACOLoader.js'),
        ]);
        draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
        const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync(url);
        const model = gltf.scene;
        const textures = new Set();
        model.traverse(o => {
            if (!o.isMesh) return;
            for (const m of [o.material].flat()) {
                for (const v of Object.values(m)) if (v && v.isTexture) textures.add(v);
            }
            prepare(o);
        });
        if (sh.disposed || sh.trackGroup !== group) {
            disposeObject(model);
            for (const t of textures) t.dispose();
            return;
        }
        model.name = name;
        model.scale.setScalar(scale);
        group.add(model);
        sh.ownedTextures.push(...textures);
    } catch (e) {
        console.warn(`pocabinet/scene: ${name} skipped`, e);
    } finally {
        draco?.dispose();
    }
}

/**
 * The bedroom scan: unlit and single-sided as exported; it neither casts nor takes the sun's
 * shadows (the catcher does). Its textures are already the room as the camera saw it, so they
 * skip the filmic curve (which would grey them) and get a little lift for the post grade.
 */
/** The "Room scans" values (PoCabinetUiSettings.RoomDetail); anything else reads as 'auto'. */
function roomDetailOf(v) {
    const d = String(v ?? '').toLowerCase();
    return d === 'mesh' || d === 'splat' ? d : 'auto';
}

/**
 * The player's "Room scans" setting (PoCabinetUiSettings.RoomDetail): 'auto' (the default),
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

/** What a "Room scans" value draws on this device: 'mesh', 'light' (the 100k scan) or 'full'. */
function roomPlan(detail) {
    if (detail === 'mesh') return 'mesh';
    if (detail === 'splat') return 'full';
    return lightDevice() ? 'light' : 'full';
}

export async function loadRoom(sh, group) {
    // The splat (400k, sorted every frame) costs ~a third of the frame rate: the low tier and the
    // "lite" setting keep the mesh. A tier change mid-race does not swap it; the setting does.
    const plan = roomPlan(sh.roomDetail || (sh.roomDetail = storedRoomDetail()));
    if (sh.quality !== 'low' && plan !== 'mesh' && await loadRoomSplat(sh, group, plan === 'full')) return;
    if (sh.disposed || sh.trackGroup !== group) return;
    const scan = scanOf(sh);
    await sh.loadModel(group, scan.url, scan.scale, 'pocabinet-room', (o) => {
        o.castShadow = false;
        o.receiveShadow = false;
        for (const m of [o.material].flat()) {
            m.toneMapped = false;
            m.color?.multiplyScalar(scan.lift);
        }
    });
}

/** Fetch and place playground.glb into `group`. */
export function loadPlayground(sh, group) {
    return sh.loadModel(group, PLAYGROUND.url, PLAYGROUND.scale, 'pocabinet-playground', (o) => {
        if (PLAYGROUND.hidden.test(o.name)) {
            o.visible = false;
        } else if (o.name.startsWith('SM_Ground')) {
            // The pad has ~0.36 m of relief and dips up to 0.13 m below y = 0, where the
            // scene's own lawn would cut holes in it: lift the dips to just above the lawn
            // (mounds keep their shape) and let it take shadows without casting them.
            const pos = o.geometry.attributes.position;
            for (let i = 0; i < pos.count; i++) if (pos.getY(i) < 0.006) pos.setY(i, 0.006);
            pos.needsUpdate = true;
            o.geometry.computeBoundingSphere();
            o.receiveShadow = true;
        } else {
            o.castShadow = true;
            o.receiveShadow = true;
        }
    });
}

/** Dispose a DropInViewer: its dispose() is async (it terminates the sort worker), so a failure
 *  arrives as a rejection, not a throw. Never lets either escape. */
function disposeViewer(viewer) {
    if (!viewer) return;
    viewer.parent?.remove(viewer);
    try {
        Promise.resolve(viewer.dispose()).catch(e => console.warn('pocabinet/scene: splat dispose', e));
    } catch (e) {
        console.warn('pocabinet/scene: splat dispose', e);
    }
}

/** Drop the room's splat (if any): leaving the race, changing track, or switching to lite. */
export function disposeRoomSplat(sh) {
    disposeViewer(sh.roomSplat);
    sh.roomSplat = null;
    sh.roomProgress?.remove();
    sh.roomProgress = null;
}

/** A small "Loading room 42%" bar over the canvas while the splat downloads. */
function progressBar(sh) {
    const host = sh.canvas?.parentElement;
    if (!host) return { set() {}, remove() {} };
    const el = document.createElement('div');
    el.className = 'pocabinet-room-loading';
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:absolute;left:50%;bottom:14%;transform:translateX(-50%);z-index:5;'
        + 'padding:6px 12px;border-radius:999px;background:rgba(10,12,16,.62);color:#f1ede6;'
        + 'font:600 12px/1.2 system-ui,sans-serif;pointer-events:none;display:flex;gap:8px;align-items:center;';
    el.innerHTML = '<span>Loading room</span><span style="width:110px;height:5px;border-radius:3px;background:rgba(255,255,255,.18);overflow:hidden"><i style="display:block;height:100%;width:0;background:#9fd0ff;transition:width .2s"></i></span><b>0%</b>';
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

async function makeViewer(sh, group, GS, url, scale, onProgress) {
    const viewer = new GS.DropInViewer({
        gpuAcceleratedSort: false,
        sharedMemoryForWorkers: false,   // no cross-origin isolation on this site
        integerBasedSort: true,
        dynamicScene: false,
        sphericalHarmonicsDegree: 0,
        logLevel: GS.LogLevel.None,
    });
    try {
        const upright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
        await viewer.addSplatScene(url, {
            format: GS.SceneFormat.KSplat,
            showLoadingUI: false,
            progressiveLoad: false,
            position: [0, 0, 0],
            rotation: upright.toArray(),
            scale: [scale, scale, scale],
            onProgress: (percent) => onProgress?.(Number(percent) || 0),
        });
    } catch (e) {
        disposeViewer(viewer);
        throw e;
    }
    if (sh.disposed || sh.trackGroup !== group) {
        disposeViewer(viewer);
        return null;
    }
    return viewer;
}

/**
 * The bedroom as a Gaussian splat, in the room frame (z up) turned to three's y up and scaled
 * like the mesh, in two steps: the light splat (ROOM.splatLow, 100k, ~2.4 MB) goes in first so
 * the room appears within a second or two, then the full one (ROOM.splat, 400k) loads behind it
 * and replaces it, unless `full` is false (roomPlan: 'auto' on a phone or a slow link), where the
 * light one is the room. A bar over the canvas shows the downloads. True once a splat is in the
 * scene; false (and nothing added) if the library, the file or the GPU says no, or the track changed.
 */
export async function loadRoomSplat(sh, group, full = true) {
    const scan = scanOf(sh);
    const bar = progressBar(sh);
    sh.roomProgress = bar;
    try {
        const GS = await import('gaussian-splats-3d');
        if (sh.disposed || sh.trackGroup !== group) {
            bar.remove();
            if (sh.roomProgress === bar) sh.roomProgress = null;
            return false;
        }
        const low = await makeViewer(sh, group, GS, scan.splatLow, scan.scale, (p) => bar.set(p * (full ? 0.25 : 1), `Loading ${scan.label}`));
        if (!low) {
            bar.remove();
            if (sh.roomProgress === bar) sh.roomProgress = null;
            return false;
        }
        low.name = 'pocabinet-room-splat';
        group.add(low);
        sh.roomSplat = low;
        if (!full) {
            bar.remove();
            if (sh.roomProgress === bar) sh.roomProgress = null;
            return true;
        }
        // The sharp version, behind the light one; any failure just keeps the light one.
        makeViewer(sh, group, GS, scan.splat, scan.scale, (p) => bar.set(25 + p * 0.75, `Sharpening ${scan.label}`))
            .then((full) => {
                if (!full) return;
                if (sh.roomSplat !== low) { disposeViewer(full); return; }
                full.name = 'pocabinet-room-splat';
                group.add(full);
                sh.roomSplat = full;
                disposeViewer(low);
            })
            .catch((e) => console.warn('pocabinet/scene: full room splat skipped, keeping the light one', e))
            .finally(() => { bar.remove(); if (sh.roomProgress === bar) sh.roomProgress = null; });
        return true;
    } catch (e) {
        bar.remove();
        sh.roomProgress = null;
        console.warn('pocabinet/scene: room splat skipped, drawing the mesh', e);
        return false;
    }
}

/**
 * "Room scans: Auto / Full / Lite" changed: on a scanned track, swap what draws the room (the
 * full scan, the light one or the mesh) without rebuilding the track. Elsewhere just remembered
 * for the next room track. A change that draws the same thing here (Auto to Full on a desktop)
 * reloads nothing.
 */
export function setRoomDetail(sh, detail) {
    const next = roomDetailOf(detail);
    if (sh.roomDetail === next) return;
    const same = sh.roomDetail && roomPlan(sh.roomDetail) === roomPlan(next);
    sh.roomDetail = next;
    const group = sh.trackGroup;
    if (same || !sh.scan || !group) return;
    disposeRoomSplat(sh);
    const mesh = group.getObjectByName('pocabinet-room');
    if (mesh) {
        group.remove(mesh);
        disposeObject(mesh);
    }
    loadRoom(sh, group);
}

/**
 * Tracks whose world is a model, keyed by scene theme (terrain.js themeOf): the one place the
 * scene asks whether to skip its own terrain, trackside props and grass, and how to load the
 * model. The Playground also has its own staging in scene.js (isPlayground: chute, no walls).
 */
export const MODEL_LOOKS = {
    playground: { load: (sh, group) => sh.loadPlayground(group) },
    bedroom: { load: (sh, group) => sh.loadRoom(group) },
    court: { load: (sh, group) => sh.loadRoom(group) },
};

/**
 * gaussian-splats-3d's fragment shader writes its sRGB colour straight out. Drawn straight to
 * the canvas that is right; through postfx.js (a linear HDR target, then ACES and sRGB) it is
 * encoded twice and comes out washed white. So its material gets two uniforms: linearize (and
 * scale by ROOM.splatLift) while the post pass is on. Patched lazily: the viewer may swap its
 * mesh. Matches the pinned 0.4.7 shader; if the text ever differs it is left alone.
 */
export function syncRoomSplat(sh) {
    const mat = sh.roomSplat?.viewer?.splatMesh?.material;
    if (!mat) return;
    if (!mat.userData.pcPatched) {
        mat.userData.pcPatched = true;
        const out = 'gl_FragColor = vec4(color.rgb, opacity);';
        if (!mat.fragmentShader.includes(out)) return;
        mat.uniforms.pcLinear = { value: 1 };
        mat.uniforms.pcLift = { value: scanOf(sh).splatLift };
        mat.fragmentShader = mat.fragmentShader
            .replace('void main () {', 'uniform float pcLinear;\nuniform float pcLift;\nvoid main () {')
            .replace(out, 'color = mix(color, pow(max(color, vec3(0.0)), vec3(2.2)) * pcLift, pcLinear);\n' + out);
        mat.needsUpdate = true;
    }
    if (mat.uniforms.pcLinear) mat.uniforms.pcLinear.value = sh.post ? 1 : 0;
}
