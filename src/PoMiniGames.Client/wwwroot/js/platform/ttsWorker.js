// platform/ttsWorker.js — Web Worker running Kokoro-82M ONNX TTS via kokoro-js (WebGPU/WASM).
// Keeps synthesis off the render thread and transfers raw Float32Array PCM back to localTts.js.
const KOKORO_CDN = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let tts = null;
let initPromise = null;

async function ensureTts() {
  initPromise ??= (async () => {
    const { KokoroTTS } = await import(/* @vite-ignore */ KOKORO_CDN);
    const hasGpu = Boolean(globalThis.navigator?.gpu && await globalThis.navigator.gpu.requestAdapter().catch(() => null));
    tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: hasGpu ? 'fp32' : 'q8',
      device: hasGpu ? 'webgpu' : 'wasm',
    });
    return tts;
  })().catch((err) => { initPromise = null; throw err; });
  return initPromise;
}

self.onmessage = async (e) => {
  const { id, text, voice = 'af_bella', speed = 1.0 } = e.data || {};
  try {
    const engine = await ensureTts();
    const audio = await engine.generate(String(text || ''), { voice, speed });
    const pcm = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
    self.postMessage({ id, ok: true, pcm, sampleRate: audio.sampling_rate || 24000 }, [pcm.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
