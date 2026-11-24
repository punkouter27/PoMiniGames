// platform/ai/squadBlackboard.js — Shared Squad Blackboard & Coordinated Pincer Memory (#4).
// Used by PoBrawl FFA (grudge decay + leader dogpile) and PoVoxelStrike (angular engagement-slot
// reservations so max 2 melee units engage frontally while others flank). CPU, 10 Hz, ~0.15 ms.

const MAX_FACTS = 32;

export class SquadBlackboard {
  constructor(maxAgents = 16, slotCount = 8, maxFrontalSlots = 2) {
    this.maxAgents = maxAgents;
    this.slotCount = slotCount;
    this.maxFrontalSlots = maxFrontalSlots;
    this.grudge = new Float32Array(maxAgents * maxAgents);
    this.slots = new Int16Array(slotCount).fill(-1);
    this.facts = new Array(MAX_FACTS);
    this.factHead = 0;
    this.factCount = 0;
    this.lastTargetX = 0;
    this.lastTargetZ = 0;
    this.lastTargetVx = 0;
    this.lastTargetVz = 0;
    this.lastTargetSeenAt = -Infinity;
    this.targetExhaustedUntil = -Infinity;
  }

  recordTargetSighting(x, z, vx, vz, nowSec, staminaRatio = 1) {
    this.lastTargetX = x;
    this.lastTargetZ = z;
    this.lastTargetVx = vx;
    this.lastTargetVz = vz;
    this.lastTargetSeenAt = nowSec;
    if (staminaRatio < 0.25) {
      this.targetExhaustedUntil = Math.max(this.targetExhaustedUntil, nowSec + 2.5);
    }
    this.pushFact({ type: 'sighting', x, z, t: nowSec });
  }

  pushFact(fact) {
    this.facts[this.factHead] = fact;
    this.factHead = (this.factHead + 1) % MAX_FACTS;
    if (this.factCount < MAX_FACTS) this.factCount++;
  }

  recordDamage(victimIdx, attackerIdx, amount) {
    if (victimIdx < 0 || attackerIdx < 0 || victimIdx >= this.maxAgents || attackerIdx >= this.maxAgents) return;
    this.grudge[victimIdx * this.maxAgents + attackerIdx] += amount;
  }

  decayGrudges(factor = 0.92) {
    for (let i = 0; i < this.grudge.length; i++) {
      this.grudge[i] *= factor;
    }
  }

  /**
   * Pick the highest-priority FFA target for `agentIdx`, combining grudge decay with
   * opportunistic dogpiling on a low-stamina leader.
   */
  pickFfaTarget(agentIdx, agents) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    let leaderIdx = -1;
    let maxScore = -Infinity;
    for (let i = 0; i < agents.length; i++) {
      if (agents[i].alive && (agents[i].score ?? 0) > maxScore) {
        maxScore = agents[i].score ?? 0;
        leaderIdx = i;
      }
    }
    const rowOff = agentIdx * this.maxAgents;
    for (let i = 0; i < agents.length; i++) {
      if (i === agentIdx || !agents[i].alive) continue;
      let score = this.grudge[rowOff + i] * 1.5;
      if (i === leaderIdx && (agents[i].stamina ?? 1) < 0.3) score += 35;
      score += (1 - (agents[i].hpRatio ?? 1)) * 20;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  /** Clear and re-assign angular attack slots around the target to force pincer flanking. */
  resetSlots() {
    this.slots.fill(-1);
  }

  /**
   * Reserve the best available angular slot around (targetX, targetZ) given target's facing angle.
   * Slots 0 and slotCount-1 are frontal; once `maxFrontalSlots` are claimed, later agents get flank/rear slots.
   * @returns {{ slot: number, angle: number, isFlank: boolean }}
   */
  reserveSlot(agentId, agentX, agentZ, targetX, targetZ, targetFacingRad) {
    let frontalUsed = 0;
    for (let s = 0; s < this.slotCount; s++) {
      if (this.slots[s] === agentId) {
        const ang = targetFacingRad + (s / this.slotCount) * Math.PI * 2;
        return { slot: s, angle: ang, isFlank: s >= 2 && s <= this.slotCount - 2 };
      }
      if (this.slots[s] !== -1 && (s === 0 || s === 1 || s === this.slotCount - 1)) frontalUsed++;
    }

    const desiredAngle = Math.atan2(agentZ - targetZ, agentX - targetX);
    let bestSlot = -1;
    let bestDist = Infinity;
    for (let s = 0; s < this.slotCount; s++) {
      if (this.slots[s] !== -1) continue;
      const isFrontal = s === 0 || s === 1 || s === this.slotCount - 1;
      if (isFrontal && frontalUsed >= this.maxFrontalSlots) continue;
      const slotAngle = targetFacingRad + (s / this.slotCount) * Math.PI * 2;
      let diff = Math.abs(Math.atan2(Math.sin(slotAngle - desiredAngle), Math.cos(slotAngle - desiredAngle)));
      if (!isFrontal && frontalUsed >= this.maxFrontalSlots) diff *= 0.85;
      if (diff < bestDist) {
        bestDist = diff;
        bestSlot = s;
      }
    }
    if (bestSlot < 0) bestSlot = Math.abs(agentId) % this.slotCount;
    this.slots[bestSlot] = agentId;
    const angle = targetFacingRad + (bestSlot / this.slotCount) * Math.PI * 2;
    return { slot: bestSlot, angle, isFlank: bestSlot >= 2 && bestSlot <= this.slotCount - 2 };
  }
}
