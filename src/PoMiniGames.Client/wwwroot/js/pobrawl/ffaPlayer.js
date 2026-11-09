import { KeyboardController, buildTouchControls, LAYOUTS, padCodes } from './input.js';
import { KeyBridge } from '../gamepadBus.js';

export class FfaPlayerInput {
  constructor(container, onPause) {
    this.keyboard = new KeyboardController(1, { ignoreEditable: true });
    this.pads = new KeyBridge([1], (pad) => padCodes(pad, LAYOUTS[1]));
    this.container = container;
    this.touch = buildTouchControls(container, false);
    const labels = ['Move forward', 'Move backward', 'Move left', 'Move right', 'Block (hold)', 'Punch', 'Kick'];
    this.touch.querySelectorAll('button').forEach((button, i) => {
      button.setAttribute('aria-label', labels[i]);
      button.title = labels[i];
      if (i < 2) button.textContent = i === 0 ? '\u25b2' : '\u25bc';
    });
    this.onKey = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || this.editable(event.target)) return;
      if (event.code === 'Escape' || event.code === 'KeyP') {
        event.preventDefault();
        onPause();
      }
    };
    this.onBlur = () => onPause(true);
    this.onVisibility = () => { if (document.hidden) onPause(true); };
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  editable(target) {
    return target?.matches?.('input,select,textarea,[contenteditable="true"]');
  }

  update() {
    if (this.editable(document.activeElement)) {
      this.release();
      return this.keyboard.update();
    }
    this.pads.poll();
    return this.keyboard.update({ towardX: 1 });
  }

  release() {
    this.pads.releaseAll();
    this.keyboard.releaseAll();
  }

  dispose() {
    this.release();
    this.pads.dispose();
    this.keyboard.dispose();
    this.touch.remove();
    this.container.classList.remove('pb-has-pad');
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
