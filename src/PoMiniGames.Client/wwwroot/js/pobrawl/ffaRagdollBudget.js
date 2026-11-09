// ffaRagdollBudget.js — keep KO ragdolls visible while retiring settled physics work.
const DEFAULTS = Object.freeze({
  maxRagdolls: 16,
  maxFallSeconds: 4,
  settleSeconds: 0.5,
  linearSpeed: 0.3,
  angularSpeed: 0.6,
  minScale: 0.25,
  maxScale: 4,
});

function finitePositive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function speedSquared(vector) {
  return vector.x * vector.x + vector.y * vector.y + vector.z * vector.z;
}

function isSleeping(body) {
  return body.sleepState === body.constructor.SLEEPING;
}

export class FfaRagdollBudget {
  constructor(options = {}) {
    this.maxRagdolls = Math.max(1, Math.floor(finitePositive(options.maxRagdolls, DEFAULTS.maxRagdolls)));
    this.maxBodies = Math.max(1, Math.floor(finitePositive(options.maxBodies, this.maxRagdolls * 11)));
    this.maxFallSeconds = Math.min(4, finitePositive(options.maxFallSeconds, DEFAULTS.maxFallSeconds));
    this.settleSeconds = finitePositive(options.settleSeconds, DEFAULTS.settleSeconds);
    this.linearSpeed = finitePositive(options.linearSpeed, DEFAULTS.linearSpeed);
    this.angularSpeed = finitePositive(options.angularSpeed, DEFAULTS.angularSpeed);
    this.minScale = finitePositive(options.minScale, DEFAULTS.minScale);
    this.maxScale = Math.max(this.minScale, finitePositive(options.maxScale, DEFAULTS.maxScale));
    this.ragdolls = new Map();
    this.disposed = false;
  }

  get stats() {
    let bodies = 0;
    let sleepingBodies = 0;
    let constraints = 0;
    let settledRagdolls = 0;
    let retiredRagdolls = 0;
    for (const [ragdoll, record] of this.ragdolls) {
      bodies += Object.keys(ragdoll.bodies || {}).length;
      sleepingBodies += record.bodies.filter(isSleeping).length;
      constraints += ragdoll.constraints?.length || 0;
      if (record.settled) settledRagdolls++;
      if (record.retired) retiredRagdolls++;
    }
    return {
      trackedRagdolls: this.ragdolls.size,
      activeRagdolls: this.ragdolls.size - retiredRagdolls,
      settledRagdolls,
      retiredRagdolls,
      bodies,
      sleepingBodies,
      activeBodies: bodies - sleepingBodies,
      constraints,
      maxRagdolls: this.maxRagdolls,
      maxBodies: this.maxBodies,
      maxFallSeconds: this.maxFallSeconds,
    };
  }

  // Call instead of ragdoll.activate() in FFA. Capacity overflow freezes the
  // last driven pose in the existing rig, then removes only its physics bodies.
  activate(ragdoll, direction, options = {}) {
    if (this.disposed || !ragdoll) return false;
    this.ragdolls.delete(ragdoll);
    ragdoll.activate(direction, options);
    return this.track(ragdoll, { scale: options.scale });
  }

  // Also supports ragdolls activated directly before being handed to the budget.
  track(ragdoll, { scale } = {}) {
    if (this.disposed || !ragdoll?.active) return false;
    const previous = this.ragdolls.get(ragdoll);
    if (previous && !previous.retired) return true;
    if (previous) this.ragdolls.delete(ragdoll);
    const bodies = Object.values(ragdoll.bodies);
    const trackedBodies = [...this.ragdolls.keys()]
      .reduce((count, current) => count + Object.keys(current.bodies || {}).length, 0);
    if (this.ragdolls.size >= this.maxRagdolls || trackedBodies + bodies.length > this.maxBodies) {
      ragdoll.drive();
      ragdoll.dispose();
      return false;
    }

    const root = ragdoll.rig?.root;
    const scaleTarget = root?.scale?.clone?.();
    const rootScale = scale ?? (scaleTarget && root.getWorldScale
      ? root.getWorldScale(scaleTarget).x : root?.scale?.x) ?? 1;
    const safeScale = Math.min(this.maxScale, Math.max(this.minScale, finitePositive(rootScale, 1)));
    const linearLimit = this.linearSpeed * safeScale;
    for (const body of bodies) {
      body.allowSleep = true;
      body.sleepSpeedLimit = linearLimit;
      body.sleepTimeLimit = this.settleSeconds;
    }
    this.ragdolls.set(ragdoll, {
      bodies, linearLimit, settledFor: new Map(bodies.map((body) => [body, 0])),
      settled: false, retired: false, age: 0,
    });
    return true;
  }

  // Call after world.step() and the shouldDrive()/drive() loop.
  // Returns the number newly retired (settled or at the hard fall deadline).
  update(dt) {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) return 0;
    let newlySettled = 0;
    for (const [ragdoll, record] of this.ragdolls) {
      if (record.retired) continue;
      if (!ragdoll.active) {
        this.ragdolls.delete(ragdoll);
        continue;
      }
      record.age += dt;
      if (record.age + 1e-9 >= this.maxFallSeconds) {
        this.retire(ragdoll, 'timeout');
        newlySettled++;
        continue;
      }
      for (const body of record.bodies) {
        if (isSleeping(body)) continue;
        const still = speedSquared(body.velocity) <= record.linearLimit * record.linearLimit
          && speedSquared(body.angularVelocity) <= this.angularSpeed * this.angularSpeed;
        const settledFor = still ? record.settledFor.get(body) + dt : 0;
        record.settledFor.set(body, settledFor);
        if (settledFor >= this.settleSeconds) {
          body.sleep();
          record.settledFor.set(body, 0);
        }
      }
      if (record.bodies.every(isSleeping)) {
        this.retire(ragdoll, 'settled');
        newlySettled++;
        continue;
      }

    }
    return newlySettled;
  }

  // Check after world.step() and before update(); retired rigs keep their last pose.
  shouldDrive(ragdoll) {
    const record = this.ragdolls.get(ragdoll);
    if (!record || record.retired || !ragdoll.active) return false;
    return true;
  }

  // Rebuild retired physics from the retained pose, with no second KO launch.
  // Callers may provide a new direction/launch if an explicit re-launch is wanted.
  resume(ragdoll, direction = { x: 0, z: 0 }, options = {}) {
    const record = this.ragdolls.get(ragdoll);
    if (!record) return false;
    if (record.retired) {
      return this.activate(ragdoll, direction, {
        ...options,
        launch: { knockMul: 0, velMul: 0, upMul: 0, ...options.launch },
      });
    }
    for (const body of record.bodies) body.wakeUp();
    record.settled = false;
    for (const body of record.bodies) record.settledFor.set(body, 0);
    return true;
  }

  retire(ragdoll, reason = 'manual') {
    const record = this.ragdolls.get(ragdoll);
    if (!record || record.retired) return false;
    if (ragdoll.active) {
      ragdoll.drive();
      ragdoll.dispose();
    }
    record.bodies.length = 0;
    record.settledFor.clear();
    record.settled = reason === 'settled';
    record.retired = true;
    return true;
  }

  untrack(ragdoll, { dispose = false } = {}) {
    if (!this.ragdolls.has(ragdoll)) return false;
    this.ragdolls.delete(ragdoll);
    if (dispose && ragdoll.active) {
      ragdoll.drive();
      ragdoll.dispose();
    }
    return true;
  }

  // Clear a round while retaining the manager for the next one.
  reset() {
    for (const ragdoll of this.ragdolls.keys()) {
      if (!ragdoll.active) continue;
      ragdoll.drive();
      ragdoll.dispose();
    }
    this.ragdolls.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
  }
}
