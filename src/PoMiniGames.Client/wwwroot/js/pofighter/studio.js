// pofighter/studio.js — In-browser PoFighter Studio.
// Lazily loads MediaPipe Tasks Vision (Apache 2.0, WebAssembly) when the user opens
// the Studio to cut a real performer from webcam or uploaded video, packs a sprite
// sheet + manifest matching p1.json / sim.js, and persists custom fighters in IndexedDB.
// Falls back to background-difference silhouette cutout when offline.

const DB_NAME = 'pofighter-studio';
const STORE_NAME = 'fighters';
const DB_VERSION = 1;
const MEDIAPIPE_ESM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm';
const MEDIAPIPE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const SEGMENTER_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

export const STUDIO_MOVES = [
    { id: 'idle', label: 'Stance', loop: 'pingpong', fps: 7.5, hint: 'Stand in fighting guard' },
    { id: 'walkF', label: 'Walk', loop: 'loop', fps: 14, hint: 'Step forward & back' },
    { id: 'punchMid', label: 'Punch', loop: 'once', fps: 16, hint: 'Throw a straight punch' },
    { id: 'kick', label: 'Kick', loop: 'once', fps: 16, hint: 'Throw a front or side kick' },
    { id: 'jump', label: 'Jump', loop: 'once', fps: 16, hint: 'Hop in place' },
    { id: 'crouch', label: 'Crouch', loop: 'hold', fps: 14, hint: 'Duck low into guard' },
    { id: 'victory', label: 'Cheer', loop: 'pingpong', fps: 8, hint: 'Raise both arms!' },
    { id: 'ko', label: 'Fall', loop: 'hold', fps: 10, hint: 'Drop or lean down' },
];

let visionCache = null;

function openDb() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function listCustomFighters() {
    try {
        const db = await openDb();
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onsuccess = () => resolve((req.result || []).map(r => ({ id: r.id, name: r.name, createdAt: r.createdAt })));
            req.onerror = () => resolve([]);
        });
    } catch {
        return [];
    }
}

export async function getCustomFighter(id) {
    try {
        const db = await openDb();
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch {
        return null;
    }
}

export async function saveCustomFighter(record) {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

export async function deleteCustomFighter(id) {
    try {
        const db = await openDb();
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(id);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch {
        return false;
    }
}

/**
 * Lazily load MediaPipe Tasks Vision ImageSegmenter + PoseLandmarker.
 * Returns `{ segmenter, pose, mode: 'mediapipe' | 'chroma' }`.
 */
export async function ensureVision() {
    if (visionCache) return visionCache;
    try {
        const mp = await Promise.race([
            import(MEDIAPIPE_ESM),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
        ]);
        const fileset = await mp.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
        const segmenter = await mp.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: SEGMENTER_MODEL, delegate: 'CPU' },
            outputCategoryMask: false,
            outputConfidenceMasks: true,
            runningMode: 'IMAGE',
        });
        let pose = null;
        try {
            pose = await mp.PoseLandmarker.createFromOptions(fileset, {
                baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'CPU' },
                runningMode: 'IMAGE',
                numPoses: 1,
            });
        } catch { /* Pose classification optional; segmenter alone still cuts cleanly */ }
        visionCache = { segmenter, pose, mode: 'mediapipe' };
        return visionCache;
    } catch {
        visionCache = { segmenter: null, pose: null, mode: 'chroma' };
        return visionCache;
    }
}

/**
 * Segment one source canvas/video frame into a tight, transparent RGBA cutout canvas
 * plus anchor/reach metrics matching sim.js (`ax, ay, r`).
 */
export function cutFrame(sourceCanvas, vision, bgImageData = null) {
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    const srcData = srcCtx.getImageData(0, 0, w, h);
    const px = srcData.data;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
    const outImg = outCtx.createImageData(w, h);
    const out = outImg.data;

    let mask = null;
    if (vision?.segmenter) {
        try {
            const res = vision.segmenter.segment(sourceCanvas);
            const conf = res?.confidenceMasks?.[0];
            if (conf) {
                mask = conf.getAsFloat32Array();
            }
            res?.close?.();
        } catch { mask = null; }
    }

    let minX = w, minY = h, maxX = -1, maxY = -1;
    const bgPx = bgImageData?.data || null;
    // Sample top-left corner if no explicit background plate was captured
    const refR = px[0], refG = px[1], refB = px[2];

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const p = i * 4;
            let alpha = 0;
            if (mask) {
                // Note: selfie_segmenter confidence mask marks person near 1.0 (or background near 1.0 depending on model);
                // check foreground confidence threshold cleanly:
                const m = mask[i];
                alpha = m > 0.48 ? Math.min(255, Math.round((m - 0.35) / 0.45 * 255)) : 0;
            } else if (bgPx) {
                const diff = Math.abs(px[p] - bgPx[p]) + Math.abs(px[p + 1] - bgPx[p + 1]) + Math.abs(px[p + 2] - bgPx[p + 2]);
                alpha = diff > 68 ? 255 : 0;
            } else {
                const diff = Math.abs(px[p] - refR) + Math.abs(px[p + 1] - refG) + Math.abs(px[p + 2] - refB);
                alpha = diff > 62 ? 255 : 0;
            }

            if (alpha > 16) {
                out[p] = px[p];
                out[p + 1] = px[p + 1];
                out[p + 2] = px[p + 2];
                out[p + 3] = alpha;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
    }

    if (maxX < minX || maxY < minY) return null;
    outCtx.putImageData(outImg, 0, 0);

    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    if (cw < 16 || ch < 32) return null;

    // Crop tightly onto a frame canvas scaled so standHeight (~373 world units * res 1.75 ≈ 650px) feels proportional
    const targetH = 380;
    const scale = targetH / Math.max(ch, 1);
    const fw = Math.max(16, Math.round(cw * scale));
    const fh = Math.max(16, Math.round(ch * scale));

    const crop = document.createElement('canvas');
    crop.width = fw;
    crop.height = fh;
    const cctx = crop.getContext('2d');
    cctx.drawImage(outCanvas, minX, minY, cw, ch, 0, 0, fw, fh);

    // Optional pose classification when scanning a video clip
    let poseClass = null;
    if (vision?.pose) {
        try {
            const pRes = vision.pose.detect(sourceCanvas);
            const lm = pRes?.landmarks?.[0];
            if (lm && lm.length >= 29) poseClass = classifyPose(lm);
        } catch { /* ignore */ }
    }

    return {
        canvas: crop,
        w: fw,
        h: fh,
        poseClass,
    };
}

/** Heuristic pose classifier from MediaPipe 33-point landmarks into PoFighter move ids. */
export function classifyPose(lm) {
    const nose = lm[0], lWrist = lm[15], rWrist = lm[16];
    const lShoulder = lm[11], rShoulder = lm[12];
    const lHip = lm[23], rHip = lm[24];
    const lAnkle = lm[27], rAnkle = lm[28];

    const hipY = (lHip.y + rHip.y) * 0.5;
    const ankleY = Math.max(lAnkle.y, rAnkle.y);
    const bodySpan = Math.max(0.1, ankleY - nose.y);

    // Both wrists high above nose => Cheer
    if (lWrist.y < nose.y - 0.04 && rWrist.y < nose.y - 0.04) return 'victory';
    // Body near floor / compressed => Crouch or KO
    if (bodySpan < 0.36) return 'ko';
    if (hipY > 0.68 && bodySpan < 0.55) return 'crouch';
    // One ankle lifted strongly => Kick
    if (Math.abs(lAnkle.y - rAnkle.y) > 0.14) return 'kick';
    // Wrist extended horizontally away from shoulder => Punch
    const shoulderX = (lShoulder.x + rShoulder.x) * 0.5;
    if (Math.abs(lWrist.x - shoulderX) > 0.22 || Math.abs(rWrist.x - shoulderX) > 0.22) return 'punchMid';
    // High hips & both feet elevated => Jump
    if (hipY < 0.42) return 'jump';
    // Stride separation => Walk
    if (Math.abs(lAnkle.x - rAnkle.x) > 0.14) return 'walkF';
    return 'idle';
}

/**
 * Pack `{ moveId: CutFrame[] }` into a single PNG sprite sheet data URL + `sim.js`-compatible manifest.
 */
export function packFighter(name, moveFramesMap) {
    const res = 1.0;
    const pad = 4;
    const maxRowW = 2048;

    const idleFrames = moveFramesMap.idle?.length ? moveFramesMap.idle : [];
    const fallback = idleFrames[0] || Object.values(moveFramesMap).flat()[0];
    if (!fallback) throw new Error('Capture at least one frame before saving.');

    const standHeight = fallback.h;
    const allPlaced = [];
    let curX = 0, curY = 0, rowH = 0, sheetW = 0;

    const movesOut = {};
    for (const spec of STUDIO_MOVES) {
        const list = moveFramesMap[spec.id]?.length ? moveFramesMap[spec.id] : (spec.id === 'idle' ? [fallback] : null);
        if (!list) continue;
        const framesMeta = [];
        for (let idx = 0; idx < list.length; idx++) {
            const f = list[idx];
            if (curX + f.w + pad > maxRowW) {
                curX = 0;
                curY += rowH + pad;
                rowH = 0;
            }
            allPlaced.push({ f, x: curX, y: curY });
            const ax = f.w * 0.35;
            const ay = f.h;
            const r = f.w - ax;
            framesMeta.push({
                src: idx,
                ax: Math.round(ax * 10) / 10,
                ay: Math.round(ay * 10) / 10,
                r: Math.round(r * 10) / 10,
                x: curX,
                y: curY,
                w: f.w,
                h: f.h,
            });
            curX += f.w + pad;
            if (curX > sheetW) sheetW = curX;
            if (f.h > rowH) rowH = f.h;
        }
        const entry = { loop: spec.loop, fps: spec.fps, frames: framesMeta };
        if (spec.id === 'walkF') entry.speed = 190;
        if (spec.id === 'punchMid') { entry.advance = 28; entry.hitMin = Math.round(standHeight * 0.36); }
        if (spec.id === 'kick') { entry.advance = 16; entry.hitMin = Math.round(standHeight * 0.42); }
        movesOut[spec.id] = entry;
    }

    // Mirror walkF backwards as walkB and reverse ko as getUp if missing
    if (!movesOut.walkB && movesOut.walkF) {
        movesOut.walkB = { ...movesOut.walkF, frames: [...movesOut.walkF.frames].reverse(), speed: -195 };
    }
    if (!movesOut.getUp && movesOut.ko) {
        movesOut.getUp = { loop: 'once', fps: 22, frames: [...movesOut.ko.frames].reverse() };
    }

    const sheetH = Math.max(16, curY + rowH);
    const sheetCanvas = document.createElement('canvas');
    sheetCanvas.width = Math.max(16, sheetW);
    sheetCanvas.height = sheetH;
    const sctx = sheetCanvas.getContext('2d');
    for (const item of allPlaced) {
        sctx.drawImage(item.f.canvas, item.x, item.y);
    }

    const id = 'custom-' + Date.now().toString(36);
    const sheetDataUrl = sheetCanvas.toDataURL('image/png');
    const manifest = {
        fighter: id,
        name: String(name || 'Custom Fighter').trim().slice(0, 24) || 'Custom Fighter',
        sheet: sheetDataUrl,
        standHeight,
        res,
        moves: movesOut,
    };

    return {
        id,
        name: manifest.name,
        data: manifest,
        sheetDataUrl,
        createdAt: Date.now(),
    };
}

/** Scan an uploaded video File/Blob and auto-slice pose-classified frames into moves. */
export async function extractFromVideoFile(file, onProgress = null) {
    const vision = await ensureVision();
    const url = URL.createObjectURL(file);
    try {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.src = url;
        await new Promise((resolve, reject) => {
            video.onloadedmetadata = resolve;
            video.onerror = () => reject(new Error('Could not read video file'));
        });

        const dur = Math.min(20, Math.max(0.5, video.duration || 5));
        const samples = Math.min(36, Math.max(8, Math.floor(dur * 3)));
        const work = document.createElement('canvas');
        const scale = Math.min(1, 480 / Math.max(1, video.videoWidth || 480));
        work.width = Math.max(64, Math.round((video.videoWidth || 480) * scale));
        work.height = Math.max(64, Math.round((video.videoHeight || 360) * scale));
        const wctx = work.getContext('2d', { willReadFrequently: true });

        const buckets = Object.fromEntries(STUDIO_MOVES.map(m => [m.id, []]));
        for (let i = 0; i < samples; i++) {
            const t = (i / Math.max(1, samples - 1)) * (dur - 0.05);
            video.currentTime = t;
            await new Promise(res => { video.onseeked = res; });
            wctx.drawImage(video, 0, 0, work.width, work.height);
            const cut = cutFrame(work, vision);
            if (cut) {
                const moveId = cut.poseClass && buckets[cut.poseClass] ? cut.poseClass : 'idle';
                if (buckets[moveId].length < 10) buckets[moveId].push(cut);
            }
            onProgress?.(Math.round(((i + 1) / samples) * 100), vision.mode);
        }
        return { buckets, mode: vision.mode };
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * Interactive Studio controller wired by PoFighterPage.razor.
 * Drives webcam preview, background-plate capture, per-move recording, video import,
 * and sprite-sheet packing -> IndexedDB save.
 */
export function createStudioController(videoEl, previewCanvas, statusEl, dotnetRef) {
    let stream = null;
    let vision = null;
    let bgImageData = null;
    let raf = 0;
    let buckets = Object.fromEntries(STUDIO_MOVES.map(m => [m.id, []]));
    const work = document.createElement('canvas');
    work.width = 320;
    work.height = 240;
    const wctx = work.getContext('2d', { willReadFrequently: true });

    const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };

    const notifyCounts = () => {
        const counts = {};
        for (const m of STUDIO_MOVES) counts[m.id] = buckets[m.id].length;
        dotnetRef?.invokeMethodAsync?.('OnStudioCounts', JSON.stringify(counts)).catch(() => {});
    };

    const drawLoop = () => {
        if (!stream || !videoEl || !previewCanvas) return;
        raf = requestAnimationFrame(drawLoop);
        if (videoEl.readyState < 2) return;
        wctx.drawImage(videoEl, 0, 0, work.width, work.height);
        const pctx = previewCanvas.getContext('2d');
        pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        const cut = cutFrame(work, vision, bgImageData);
        if (cut) {
            const scale = Math.min(previewCanvas.width / cut.w, previewCanvas.height / cut.h);
            const dw = cut.w * scale;
            const dh = cut.h * scale;
            pctx.drawImage(cut.canvas, (previewCanvas.width - dw) / 2, previewCanvas.height - dh, dw, dh);
        }
    };

    return {
        async startWebcam() {
            setStatus('Loading MediaPipe vision…');
            vision = await ensureVision();
            try {
                stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
                videoEl.srcObject = stream;
                await videoEl.play();
                setStatus(vision.mode === 'mediapipe'
                    ? 'Webcam + MediaPipe AI cutout ready! Pick a move and hold Capture.'
                    : 'Webcam ready (offline silhouette mode — step out & click Capture BG first).');
                drawLoop();
                return true;
            } catch {
                setStatus('Camera unavailable — upload a short video clip instead.');
                return false;
            }
        },
        captureBackground() {
            if (!videoEl || videoEl.readyState < 2) return false;
            wctx.drawImage(videoEl, 0, 0, work.width, work.height);
            bgImageData = wctx.getImageData(0, 0, work.width, work.height);
            setStatus('Background plate captured.');
            return true;
        },
        async captureMove(moveId) {
            if (!stream || !videoEl || videoEl.readyState < 2) return 0;
            vision = vision || await ensureVision();
            buckets[moveId] = [];
            setStatus(`Recording ${moveId}…`);
            for (let i = 0; i < 8; i++) {
                wctx.drawImage(videoEl, 0, 0, work.width, work.height);
                const cut = cutFrame(work, vision, bgImageData);
                if (cut) buckets[moveId].push(cut);
                await new Promise(r => setTimeout(r, 110));
            }
            notifyCounts();
            setStatus(`Captured ${buckets[moveId].length} frames for ${moveId}.`);
            return buckets[moveId].length;
        },
        async importVideo(inputEl) {
            const file = inputEl?.files?.[0];
            if (!file) return false;
            setStatus('Scanning video with MediaPipe Pose + Segmentation…');
            try {
                const res = await extractFromVideoFile(file, (pct, mode) => {
                    setStatus(`Extracting moves (${mode}): ${pct}%`);
                });
                buckets = res.buckets;
                notifyCounts();
                const total = Object.values(buckets).reduce((a, b) => a + b.length, 0);
                setStatus(total > 0
                    ? `Extracted ${total} frames (${res.mode}). Click Save & Fight!`
                    : 'No performer detected — try better lighting or contrast.');
                return total > 0;
            } catch (err) {
                setStatus(`Video error: ${err?.message ?? err}`);
                return false;
            }
        },
        async save(name) {
            const record = packFighter(name, buckets);
            await saveCustomFighter(record);
            setStatus(`Saved "${record.name}"!`);
            return record.id;
        },
        dispose() {
            cancelAnimationFrame(raf);
            if (stream) {
                for (const t of stream.getTracks()) t.stop();
                stream = null;
            }
            if (videoEl) videoEl.srcObject = null;
        },
    };
}
