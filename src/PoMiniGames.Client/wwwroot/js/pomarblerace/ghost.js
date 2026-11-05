// ghost.js — Game mixin: the faint replay of your fastest finish on an authored course.
// See the Ghost block in tuning.js. Mixed into Game.prototype by game.js.
import * as THREE from 'three';
import { encodeTrack, resample, sampleAt, loadGhost, saveGhost } from '../ghostTrack.js';
import {
  GHOST_HZ, GHOST_SCALES, GHOST_KEY,
} from './tuning.js';
import { update as updateSave } from './store.js';

export class GhostMixin {
  // A local race on an authored course: load the best run to race against and start recording this one.
  _armGhost() {
    this._dropGhost();
    if (this.demo || this.online || this.track.regenerate || this.chosen < 0) return;
    const best = loadGhost(GHOST_KEY + this.map.id);
    const me = this.marbleSet.marbles[this.chosen];
    let mesh = null;
    if (best) {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(me.radius, 20, 14),
        new THREE.MeshBasicMaterial({ color: 0xdff6ff, transparent: true, opacity: 0.32, depthWrite: false }));
      mesh.visible = false;
      this.scene.add(mesh);
    }
    this._ghost = { best, mesh, times: [], vals: [], next: 0 };
  }

  _dropGhost() {
    const g = this._ghost;
    this._ghost = null;
    if (!g || !g.mesh) return;
    this.scene.remove(g.mesh);
    g.mesh.geometry.dispose();
    g.mesh.material.dispose();
  }

  // Once per racing frame, after the step: sample your marble, and move the ghost to the same clock.
  _tickGhost() {
    const g = this._ghost;
    if (!g) return;
    const me = this.marbleSet.marbles[this.chosen];
    if (me && !me.finished && !me.eliminated && this.raceClock >= g.next) {
      const p = me.body.position;
      g.times.push(this.raceClock);
      g.vals.push(p.x, p.y, p.z);
      g.next = this.raceClock + 1 / GHOST_HZ;
    }
    if (!g.mesh) return;
    const at = this._ghostOn ? sampleAt(g.best.track, this.raceClock, [0, 0, 0]) : null;
    g.mesh.visible = !!at;
    if (at) g.mesh.position.set(at[0], at[1], at[2]);
  }

  // Your marble crossed the line: keep the run if it is this course's fastest.
  _keepGhost(time) {
    const g = this._ghost;
    if (!g || g.times.length < GHOST_HZ) return;
    g.times.push(time);
    const p = this.marbleSet.marbles[this.chosen].body.position;
    g.vals.push(p.x, p.y, p.z);
    saveGhost(GHOST_KEY + this.map.id, time,
      encodeTrack(resample(g.times, g.vals, 3, GHOST_HZ), 3, GHOST_HZ, GHOST_SCALES));
    g.times = [];
  }

  toggleGhost() {
    this._ghostOn = !this._ghostOn;
    updateSave((s) => { s.ghostOn = this._ghostOn; });
    if (this._ghost?.mesh && !this._ghostOn) this._ghost.mesh.visible = false;
  }
}
