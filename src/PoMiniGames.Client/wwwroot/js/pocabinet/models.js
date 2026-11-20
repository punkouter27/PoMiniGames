// pocabinet/models.js
//
// The scan the lap drives through: an outdoor basketball court (track.scan says where it stands;
// PoCabinetTrackGeometry lays the road across it). Two files draw it, both in the court's own
// frame (metres, floor on y = 0, x from one backboard to the other; scripts/blender/
// pocabinet-court.py and pocabinet-court-splat.py build them from the same reconstruction):
//
//   • court.ksplat, a Gaussian splat (400k splats, 9.6 MB; court-low.ksplat is its first 100k,
//     shown first), through gaussian-splats-3d's DropInViewer, which sorts in a worker;
//   • court.glb, the photogrammetry mesh: what the low graphics tier and the "Lite" setting
//     draw, and the fallback if the splat cannot be.
//
// Only the court and a few metres round it are drawn (track.scan.halfLength / halfWidth): the
// splat's shader drops everything outside that rectangle and fades the last stretch, the mesh
// is clipped to it. Inside it terrain.js steps the scene's own ground down out of the way, and
// a shadow catcher on the floor takes the cars' shadows (the scan is unlit: its colours are the
// court as the camera saw it). Every function takes the SceneHandle first; scene.js keeps thin
// methods that call them. Render-only.

import * as THREE from 'three';
import { WORLD_SCALE } from './util.js';
import { disposeObject } from './meshes.js';

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
};

export const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/gltf/';

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
        new THREE.ShadowMaterial({ opacity: 0.32, depthWrite: false }));
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
    const plan = roomPlan(sh.roomDetail || (sh.roomDetail = storedRoomDetail()));
    if (sh.quality !== 'low' && plan !== 'mesh' && await loadScanSplat(sh, group, plan === 'full')) return;
    if (sh.disposed || sh.trackGroup !== group) return;
    await loadScanMesh(sh, group, place);
}

/**
 * court.glb, placed and clipped to the drawn rectangle: unlit and single-sided as exported, it
 * neither casts nor takes the sun's shadows (the catcher does). Its textures are already the
 * court as the camera saw it, so they skip the filmic curve (which would grey them).
 * Non-fatal, and dropped if the track changed meanwhile.
 */
async function loadScanMesh(sh, group, place) {
    let draco = null;
    try {
        const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
            import('three/addons/loaders/GLTFLoader.js'),
            import('three/addons/loaders/DRACOLoader.js'),
        ]);
        draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
        const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync(COURT.url);
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
        draco?.dispose();
    }
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
    el.innerHTML = '<span>Loading court</span><span style="width:110px;height:5px;border-radius:3px;background:rgba(255,255,255,.18);overflow:hidden"><i style="display:block;height:100%;width:0;background:#9fd0ff;transition:width .2s"></i></span><b>0%</b>';
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

async function makeViewer(sh, group, GS, url, place, onProgress) {
    const viewer = new GS.DropInViewer({
        gpuAcceleratedSort: false,
        sharedMemoryForWorkers: false,   // no cross-origin isolation on this site
        integerBasedSort: true,
        dynamicScene: false,
        sphericalHarmonicsDegree: 0,
        logLevel: GS.LogLevel.None,
    });
    try {
        // The splat's frame is z up: turned to three's y up, scaled and stood where the scan stands.
        const upright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
        await viewer.addSplatScene(url, {
            format: GS.SceneFormat.KSplat,
            showLoadingUI: false,
            progressiveLoad: false,
            position: [place.x, place.y, place.z],
            rotation: upright.toArray(),
            scale: [place.scale, place.scale, place.scale],
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
    const bar = progressBar(sh);
    sh.roomProgress = bar;
    const done = () => { bar.remove(); if (sh.roomProgress === bar) sh.roomProgress = null; };
    try {
        const GS = await import('gaussian-splats-3d');
        if (sh.disposed || sh.trackGroup !== group) { done(); return false; }
        const low = await makeViewer(sh, group, GS, COURT.splatLow, place, (p) => bar.set(p * (full ? 0.25 : 1), `Loading ${COURT.label}`));
        if (!low) { done(); return false; }
        low.name = 'pocabinet-scan-splat';
        group.add(low);
        sh.roomSplat = low;
        if (!full) { done(); return true; }
        // The sharp version, behind the light one; any failure just keeps the light one.
        makeViewer(sh, group, GS, COURT.splat, place, (p) => bar.set(25 + p * 0.75, `Sharpening ${COURT.label}`))
            .then((sharp) => {
                if (!sharp) return;
                if (sh.roomSplat !== low) { disposeViewer(sharp); return; }
                sharp.name = 'pocabinet-scan-splat';
                group.add(sharp);
                sh.roomSplat = sharp;
                disposeViewer(low);
            })
            .catch((e) => console.warn('pocabinet/scene: the full court splat was skipped, keeping the light one', e))
            .finally(done);
        return true;
    } catch (e) {
        done();
        console.warn('pocabinet/scene: the court splat was skipped, drawing the mesh', e);
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
 * gaussian-splats-3d's shaders, patched for this scene (lazily: the viewer may swap its mesh).
 * They match the pinned 0.4.7 text; a shader whose text ever differs is left alone.
 *
 *   • Fragment: it writes its sRGB colour straight out. Drawn straight to the canvas that is
 *     right; through postfx.js (a linear HDR target, then ACES and sRGB) it is encoded twice and
 *     comes out washed white. So: linearize (and scale by COURT.splatLift) while the post pass is on.
 *   • Vertex: a splat whose centre is outside the drawn rectangle (pcCrop: centre x, z and half
 *     extents, world units; the centres are already in the scene's frame, the viewer bakes the
 *     placement in) is dropped, and the last COURT.fade before the edge fades out, so the scan
 *     ends in a soft edge on the lawn instead of a wall of grass and tree fuzz. So is one more
 *     than COURT.low metres over the floor that is not part of a hoop (pcScan: the floor's
 *     height and the scale; pcHoop: COURT.low, hoopAt, hoopReach, hoopHalf).
 */
export function syncRoomSplat(sh) {
    const mat = sh.roomSplat?.viewer?.splatMesh?.material;
    if (!mat) return;
    if (!mat.userData.pcPatched) {
        mat.userData.pcPatched = true;
        const out = 'gl_FragColor = vec4(color.rgb, opacity);';
        if (mat.fragmentShader.includes(out)) {
            mat.uniforms.pcLinear = { value: 1 };
            mat.uniforms.pcLift = { value: COURT.splatLift };
            mat.fragmentShader = mat.fragmentShader
                .replace('void main () {', 'uniform float pcLinear;\nuniform float pcLift;\nvoid main () {')
                .replace(out, 'color = mix(color, pow(max(color, vec3(0.0)), vec3(2.2)) * pcLift, pcLinear);\n' + out);
        }
        const centre = 'vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));';
        const colour = 'vColor = uintToRGBAVec(sampledCenterColor.r);';
        const place = scanPlace(sh);
        if (place && mat.vertexShader.includes(centre) && mat.vertexShader.includes(colour)) {
            mat.uniforms.pcCrop = { value: new THREE.Vector4(place.x, place.z, place.hx, place.hz) };
            mat.uniforms.pcFade = { value: COURT.fade };
            mat.uniforms.pcScan = { value: new THREE.Vector2(place.y, place.scale) };
            mat.uniforms.pcHoop = { value: new THREE.Vector4(COURT.low, COURT.hoopAt, COURT.hoopReach, COURT.hoopHalf) };
            mat.vertexShader = mat.vertexShader
                .replace('void main () {', 'uniform vec4 pcCrop;\nuniform float pcFade;\nuniform vec2 pcScan;\nuniform vec4 pcHoop;\nvoid main () {')
                .replace(centre, centre + `
                    vec2 pcIn = pcCrop.zw - abs(splatCenter.xz - pcCrop.xy);
                    float pcEdge = min(pcIn.x, pcIn.y);
                    vec3 pcM = vec3(splatCenter.x - pcCrop.x, splatCenter.y - pcScan.x, splatCenter.z - pcCrop.y) / pcScan.y;
                    bool pcHigh = pcM.y > pcHoop.x && !(abs(abs(pcM.x) - pcHoop.y) < pcHoop.z && abs(pcM.z) < pcHoop.w);
                    if (pcEdge < 0.0 || pcHigh) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }`)
                .replace(colour, colour + '\nvColor.a *= smoothstep(0.0, pcFade, pcEdge);');
        }
        mat.needsUpdate = true;
    }
    if (mat.uniforms.pcLinear) mat.uniforms.pcLinear.value = sh.post ? 1 : 0;
}
