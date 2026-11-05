// Headless stand-in for pomarblerace/audio.js: silence.
import { noopProxy } from './noop.mjs';

export function createAudio() {
  return noopProxy({});
}
