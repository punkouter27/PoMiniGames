// Canvas-only rolling highlights. No microphone or other audio track is captured.
export class AutomaticHighlights {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = options;
    this.MediaRecorderClass = options.MediaRecorderClass || globalThis.MediaRecorder;
    this.URLApi = options.URLApi || globalThis.URL;
    this.BlobClass = options.BlobClass || globalThis.Blob;
    this.now = options.now || (() => Date.now());
    this.setTimer = options.setTimer || globalThis.setTimeout?.bind(globalThis);
    this.clearTimer = options.clearTimer || globalThis.clearTimeout?.bind(globalThis);
    this.postRollMs = Math.max(0, options.postRollSeconds ?? 2) * 1000;
    this.timesliceMs = Math.max(250, options.timesliceMs ?? 1000);
    this.maxClips = Math.max(1, options.maxClips ?? 4);
    this.enabled = false;
    this.disposed = false;
    this.stream = null;
    this.recorder = null;
    this.pending = null;
    this.clips = [];
    this.nextId = 1;
    this.rotationMs = Math.max(1, options.rotationSeconds ?? options.preRollSeconds ?? 8) * 1000;
    this.rotationTimer = null;
    this.supported = !!(this.MediaRecorderClass && canvas?.captureStream
      && this.URLApi?.createObjectURL && this.BlobClass);
    this.status = this.supported ? 'Automatic highlights are off.' : 'Automatic highlights are not supported by this browser.';
    this.mimeType = '';
    this._publish();
    if (options.enabled !== false) this.setEnabled(true);
  }

  _publish() {
    const recording = {
      supported: this.supported,
      enabled: this.enabled,
      status: this.status,
      clips: this.clips.map(({ id, label, url, mimeType }) => ({
        id, label, url, mimeType: mimeType || this.mimeType || 'video/webm',
      })),
    };
    try { this.options.onPresentation?.({ recording }); } catch { /* parent UI is optional */ }
  }

  _status(state, message, extra = {}) {
    this.status = message;
    this.options.onStatus?.({ state, message, ...extra });
    this._publish();
  }

  _makeRecorder() {
    if (!this.supported) {
      this._status('unsupported', 'Automatic highlights are not supported by this browser.');
      return false;
    }
    try {
      this.segmentStartedAt = this.now();
      this.segmentChunks = [];
      const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      const mimeType = candidates.find((type) =>
        !this.MediaRecorderClass.isTypeSupported || this.MediaRecorderClass.isTypeSupported(type));
      this.recorderMimeType = mimeType || '';
      return this._startSegment();
    } catch (error) {
      this._stopTracks();
      this.recorder = null;
      this._status('error', `Could not start highlight recording: ${error?.message || 'recording unavailable'}`);
      return false;
    }
  }

  _startSegment() {
    if (!this.enabled || this.disposed) return false;
    try {
      if (!this.stream) this.stream = this.canvas.captureStream(30);
      const recorder = this.recorderMimeType
        ? new this.MediaRecorderClass(this.stream, { mimeType: this.recorderMimeType })
        : new this.MediaRecorderClass(this.stream);
      this.recorder = recorder;
      this.mimeType = recorder.mimeType || this.recorderMimeType || 'video/webm';
      this.segmentStartedAt = this.now();
      this.segmentChunks = [];
      recorder.ondataavailable = (event) => {
        if (this.recorder === recorder) this._onData(event.data);
      };
      recorder.onerror = () => {
        if (this.recorder !== recorder) return;
        this._clearRotation();
        this.pending?.timer && this.clearTimer?.(this.pending.timer);
        this.pending = null;
        this._status('error', 'The browser could not record this highlight.');
        try { recorder.stop(); } catch { /* recorder may already be inactive */ }
      };
      recorder.onstop = () => {
        if (this.recorder !== recorder) return;
        this._clearRotation();
        if (this.pending) this._finishPending();
        this.recorder = null;
        this._stopTracks();
        if (this.enabled && !this.disposed) this._startSegment();
        else if (!this.disposed) this._status('disabled', 'Automatic highlights are off.');
      };
      recorder.start(this.timesliceMs);
      this._scheduleRotation();
      this._status('ready', 'Automatic highlights are on.');
      return true;
    } catch (error) {
      this._clearRotation();
      this._status('error', `Could not start highlight recording: ${error?.message || 'recording unavailable'}`);
      this.enabled = false;
      this._stopTracks();
      this.recorder = null;
      return false;
    }
  }

  _scheduleRotation() {
    this._clearRotation();
    if (!this.enabled || this.disposed || this.pending || !this.recorder || !this.setTimer) return;
    this.rotationTimer = this.setTimer(() => {
      this.rotationTimer = null;
      if (this.pending) return;
      this._stopRecorder();
    }, this.rotationMs);
  }

  _clearRotation() {
    if (this.rotationTimer) this.clearTimer?.(this.rotationTimer);
    this.rotationTimer = null;
  }

  _stopRecorder() {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') return;
    try { recorder.stop(); } catch { /* already stopping or inactive */ }
  }

  setEnabled(enabled) {
    if (this.disposed) return false;
    const shouldEnable = !!enabled;
    if (shouldEnable === this.enabled) return this.enabled;
    this.enabled = shouldEnable;
    if (shouldEnable) {
      if (this.recorder) return true;
      if (!this.stream && !this._makeRecorder()) {
        this.enabled = false;
        this._publish();
        return false;
      }
      return this.recorder?.state === 'recording' || this._startSegment();
    }
    this._clearRotation();
    if (this.recorder && this.recorder.state !== 'inactive') {
      this._stopRecorder();
    } else {
      this._stopTracks();
    }
    if (!this.pending && !this.recorder) this._status('disabled', 'Automatic highlights are off.');
    else this._publish();
    return false;
  }

  _stopTracks() {
    for (const track of this.stream?.getTracks?.() || []) {
      try { track.stop(); } catch { /* a track may already have stopped */ }
    }
    this.stream = null;
  }

  _onData(blob) {
    if (!blob?.size || this.disposed) return;
    this.segmentChunks.push(blob);
  }

  mark(event = {}) {
    if (this.disposed || !this.enabled || !this.recorder || this.recorder.state !== 'recording') return false;
    const at = this.now();
    if (this.pending) {
      this.pending.until = Math.max(this.pending.until, at + this.postRollMs);
      this.pending.label = event.label || this.pending.label;
      this.pending.type = event.type || this.pending.type;
      if (this.pending.timer) this.clearTimer?.(this.pending.timer);
    } else {
      this.pending = {
        id: this.nextId++,
        label: event.label || event.type || 'FFA highlight',
        type: event.type || 'highlight',
        at,
        until: at + this.postRollMs,
      };
    }
    this._clearRotation();
    if (this.setTimer) {
      this.pending.timer = this.setTimer(() => {
        if (!this.pending) return;
        this._stopRecorder();
      }, Math.max(0, this.pending.until - at));
    }
    this._status('recording', 'Saving the recent fight and its finish.');
    return true;
  }

  _finishPending() {
    const pending = this.pending;
    if (!pending || this.disposed) return;
    this.pending = null;
    if (pending.timer) this.clearTimer?.(pending.timer);
    if (!this.segmentChunks.some((chunk) => chunk?.size)) {
      this._status('error', 'No video frames were available for that highlight.');
      return;
    }
    try {
      // Keep every timeslice from one recorder session. MediaRecorder only
      // guarantees playback when a session's ordered blobs are combined.
      const blob = new this.BlobClass(this.segmentChunks, { type: this.mimeType || 'video/webm' });
      const url = this.URLApi.createObjectURL(blob);
      const clip = {
        id: pending.id,
        label: pending.label,
        type: pending.type,
        url,
        mimeType: blob.type || this.mimeType,
        createdAt: this.now(),
        durationSeconds: Math.max(0, (this.now() - this.segmentStartedAt) / 1000),
      };
      this.clips.push(clip);
      while (this.clips.length > this.maxClips) {
        const removed = this.clips.shift();
        this.URLApi.revokeObjectURL(removed.url);
      }
      this.options.onClip?.({ ...clip });
      this._status('saved', `${clip.label} highlight is ready to download.`, { clip: { ...clip } });
      this.segmentChunks = [];
    } catch (error) {
      this._status('error', `Could not save highlight: ${error?.message || 'download unavailable'}`);
    }
  }

  download(id) {
    const clip = this.clips.find((item) => item.id === id);
    if (!clip || !globalThis.document?.createElement) return false;
    const link = document.createElement('a');
    link.href = clip.url;
    const extension = clip.mimeType?.includes('mp4') ? 'mp4' : 'webm';
    link.download = `pobrawl-ffa-${clip.type}-${clip.id}.${extension}`;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  }

  getClips() {
    return this.clips.map((clip) => ({ ...clip }));
  }

  dispose() {
    if (this.disposed) return;
    this.enabled = false;
    this.disposed = true;
    this._clearRotation();
    if (this.pending?.timer) this.clearTimer?.(this.pending.timer);
    this.pending = null;
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      try { this.recorder.stop(); } catch { /* shutdown continues */ }
    }
    this.recorder = null;
    this._stopTracks();
    for (const clip of this.clips) this.URLApi?.revokeObjectURL?.(clip.url);
    this.clips = [];
    this.segmentChunks = [];
    this._publish();
  }
}

export function createAutomaticHighlights(canvas, options) {
  return new AutomaticHighlights(canvas, options);
}
