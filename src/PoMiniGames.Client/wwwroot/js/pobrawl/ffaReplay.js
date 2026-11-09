// A bounded transform-only replay: no resimulation, scoring or audio side effects.
export class FfaReplay {
  constructor(fighters) {
    this.nodes = fighters.flatMap((f) => [f.rig.root, ...Object.values(f.rig.joints)]);
    this.frames = [];
    this.time = 0;
    this.sampleIn = 0;
    this.duration = 0;
    this.saved = null;
  }

  snapshot() {
    const data = new Float32Array(this.nodes.length * 7);
    this.nodes.forEach((node, i) => {
      node.position.toArray(data, i * 7);
      node.quaternion.toArray(data, i * 7 + 3);
    });
    return data;
  }

  capture(dt) {
    this.time += dt;
    this.sampleIn -= dt;
    if (this.sampleIn > 0) return;
    this.sampleIn = 1 / 30;
    this.frames.push({ time: this.time, data: this.snapshot() });
    if (this.frames.length > 90) this.frames.shift();
  }

  begin() {
    if (this.frames.length < 2) return false;
    this.saved = this.snapshot();
    this.time = this.frames[0].time;
    this.duration = this.frames.at(-1).time;
    return true;
  }

  apply(data) {
    this.nodes.forEach((node, i) => {
      node.position.fromArray(data, i * 7);
      node.quaternion.fromArray(data, i * 7 + 3);
    });
  }

  update(dt) {
    this.time = Math.min(this.duration, this.time + dt * 0.5);
    let index = this.frames.findIndex((f) => f.time >= this.time);
    if (index < 0) index = this.frames.length - 1;
    const right = this.frames[index];
    const left = this.frames[Math.max(0, index - 1)];
    const t = right.time === left.time ? 1 : (this.time - left.time) / (right.time - left.time);
    this.apply(left.data);
    this.nodes.forEach((node, i) => {
      const offset = i * 7;
      node.position.x += (right.data[offset] - node.position.x) * t;
      node.position.y += (right.data[offset + 1] - node.position.y) * t;
      node.position.z += (right.data[offset + 2] - node.position.z) * t;
      const q = node.quaternion.clone().fromArray(right.data, offset + 3);
      node.quaternion.slerp(q, t);
    });
    return this.time < this.duration;
  }

  restore() {
    if (this.saved) this.apply(this.saved);
    this.saved = null;
  }

  reset() {
    this.restore();
    this.frames.length = 0;
    this.time = 0;
    this.sampleIn = 0;
    this.duration = 0;
  }

  dispose() {
    this.reset();
    this.nodes.length = 0;
  }
}
