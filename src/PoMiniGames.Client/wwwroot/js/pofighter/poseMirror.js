// pofighter/poseMirror.js — Client-Side Pose / Gesture Input & Adaptive Cadence Mirror (#20).
// Decouples MediaPipe Pose Landmarker Lite (WebGPU delegate, free jsDelivr CDN) from the 60 Hz
// fighter sim: processes a downscaled 256x144 offscreen canvas at 15-20 Hz and writes debounced
// action intents + physical tempo cadence into a lock-free buffer. Zero video upload; keyboard/gamepad
// remain primary with zero overhead when the camera is off.

const LANDMARKER_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export class PoseSparringMirror {
  constructor() {
    this.landmarker = null;
    this.running = false;
    this.latestIntent = 'idle'; // 'idle' | 'guard' | 'jab' | 'dodge_left' | 'dodge_right'
    this.lastActionAt = 0;
    this.actionIntervals = [];
    this._canvas = null;
    this._ctx = null;
    this._lastSampleMs = 0;
  }

  async init() {
    if (this.landmarker) return true;
    try {
      const vision = await import(/* @vite-ignore */ `${LANDMARKER_CDN}/vision_bundle.mjs`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${LANDMARKER_CDN}/wasm`);
      const delegate = (typeof navigator !== 'undefined' && navigator.gpu) ? 'GPU' : 'CPU';
      this.landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Attach to PoFighter's existing <video> camera element; polls at <= 20 Hz via rVFC/rAF. */
  start(videoEl) {
    if (!videoEl || this.running) return;
    this.running = true;
    this._canvas = document.createElement('canvas');
    this._canvas.width = 256;
    this._canvas.height = 144;
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });

    const step = (now) => {
      if (!this.running) return;
      if (this.landmarker && videoEl.readyState >= 2 && now - this._lastSampleMs >= 50) {
        this._lastSampleMs = now;
        this._ctx.drawImage(videoEl, 0, 0, 256, 144);
        const res = this.landmarker.detectForVideo(this._canvas, now);
        const lm = res?.landmarks?.[0];
        if (lm && lm.length >= 17) this._classify(lm, now);
      }
      if (typeof videoEl.requestVideoFrameCallback === 'function') {
        videoEl.requestVideoFrameCallback(() => step(performance.now()));
      } else {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }

  stop() {
    this.running = false;
    this.latestIntent = 'idle';
  }

  /** Classify upper-body pose landmarks into fighter intents + track physical strike cadence. */
  _classify(lm, nowMs) {
    const nose = lm[0];
    const lShoulder = lm[11];
    const rShoulder = lm[12];
    const lWrist = lm[15];
    const rWrist = lm[16];
    const shoulderMidX = (lShoulder.x + rShoulder.x) * 0.5;

    let intent = 'idle';
    if (lWrist.y < nose.y + 0.06 && rWrist.y < nose.y + 0.06) {
      intent = 'guard';
    } else if (Math.abs(lWrist.x - lShoulder.x) > 0.22 || Math.abs(rWrist.x - rShoulder.x) > 0.22) {
      intent = 'jab';
    } else if (nose.x < shoulderMidX - 0.08) {
      intent = 'dodge_left';
    } else if (nose.x > shoulderMidX + 0.08) {
      intent = 'dodge_right';
    }

    if (intent !== this.latestIntent && intent === 'jab') {
      if (this.lastActionAt > 0) {
        this.actionIntervals.push(nowMs - this.lastActionAt);
        if (this.actionIntervals.length > 8) this.actionIntervals.shift();
      }
      this.lastActionAt = nowMs;
    }
    this.latestIntent = intent;
  }

  /** Lock-free read for the 60 Hz sim + CPU tempo adaptation (returns average strike cadence ms). */
  readState() {
    const n = this.actionIntervals.length;
    const avgCadenceMs = n > 0 ? this.actionIntervals.reduce((a, b) => a + b, 0) / n : 0;
    return { intent: this.latestIntent, avgCadenceMs, active: this.running };
  }
}
