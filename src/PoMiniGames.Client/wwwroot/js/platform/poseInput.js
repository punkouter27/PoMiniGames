// platform/poseInput.js — live MediaPipe PoseLandmarker webcam controller for PoFighter & PoBrawl.
// Reuses the exact @mediapipe/tasks-vision@0.10.18 + pose_landmarker_lite.task already pinned in
// pofighter/studio.js. Maps real-time body gestures to combat inputs (local 1P/Training only).
const MEDIAPIPE_ESM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm';
const MEDIAPIPE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

let _landmarkerPromise = null;

async function getLandmarker() {
  _landmarkerPromise ??= (async () => {
    const vision = await import(/* @vite-ignore */ MEDIAPIPE_ESM);
    const fileset = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
    return vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
  })().catch((err) => { _landmarkerPromise = null; throw err; });
  return _landmarkerPromise;
}

/**
 * Start a webcam pose-to-combat controller.
 * @param {(action: 'punch'|'kick'|'guard'|'crouch'|'jump', held: boolean) => void} onAction
 */
export async function startPoseController(onAction) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera unavailable');
  const [landmarker, stream] = await Promise.all([
    getLandmarker(),
    navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' }, audio: false }),
  ]);

  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();

  let raf = 0, stopped = false;
  let prevLW = null, prevRW = null, lastPunchAt = 0, lastKickAt = 0;
  let baseHipY = null;

  function loop(now) {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2) return;
    const res = landmarker.detectForVideo(video, now);
    const lm = res?.landmarks?.[0];
    if (!lm) return;

    // Landmarks: 11/12 shoulders, 15/16 wrists, 23/24 hips, 27/28 ankles
    const ls = lm[11], rs = lm[12], lw = lm[15], rw = lm[16], lh = lm[23], rh = lm[24], la = lm[27], ra = lm[28];
    const hipY = (lh.y + rh.y) * 0.5;
    baseHipY = baseHipY == null ? hipY : baseHipY * 0.98 + hipY * 0.02;

    // Guard: both wrists near shoulder height & close together
    const guard = Math.hypot(lw.x - rw.x, lw.y - rw.y) < 0.18 && lw.y < hipY && rw.y < hipY;
    onAction('guard', guard);

    // Crouch / Jump relative to smoothed standing hip height
    onAction('crouch', hipY - baseHipY > 0.08);
    if (baseHipY - hipY > 0.07) onAction('jump', true);

    // Punch: rapid wrist extension (velocity spike)
    if (prevLW && prevRW && now - lastPunchAt > 180) {
      const vL = Math.hypot(lw.x - prevLW.x, lw.y - prevLW.y);
      const vR = Math.hypot(rw.x - prevRW.x, rw.y - prevRW.y);
      if (Math.max(vL, vR) > 0.085 && !guard) {
        lastPunchAt = now;
        onAction('punch', true);
      }
    }
    prevLW = { x: lw.x, y: lw.y };
    prevRW = { x: rw.x, y: rw.y };

    // Kick: ankle lifted near hip height
    if (now - lastKickAt > 260 && (la.y < hipY + 0.14 || ra.y < hipY + 0.14)) {
      lastKickAt = now;
      onAction('kick', true);
    }
    void ls; void rs;
  }
  raf = requestAnimationFrame(loop);

  return {
    video,
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
