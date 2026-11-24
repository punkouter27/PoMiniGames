// pomarblerace/riskRollout.js — Physics-Aware 2-Second Risk/Reward Path & Boost Selector (#10).
// Evaluates 3 candidate lateral offsets x 8 forward steps over the upcoming course spline.
// Leaders choose low-variance safe center lines; trailing rivals gamble on high-speed edge/boost lines.
// CPU, 10 Hz per active rival (~0.18 ms total for 12 rivals).

const CANDIDATES = [-0.65, 0.0, 0.65]; // normalized lateral ratio of half-width

/**
 * Choose target lateral offset and boost intent for a rival marble.
 * @param {object} marble { lateral, speed, rank, totalRivals }
 * @param {Array<{ curvature: number, halfWidth: number, bankAngle: number, boostLane?: number }>} upcomingSegments (length >= 8)
 * @returns {{ targetLateral: number, useBoost: boolean, expectedGain: number }}
 */
export function selectMarbleLine(marble, upcomingSegments) {
  const rankRatio = marble.totalRivals > 1 ? (marble.rank - 1) / (marble.totalRivals - 1) : 0;
  // Trailing rivals tolerate higher fall risk for speed; leaders prioritize stability.
  const riskTolerance = 0.25 + 0.65 * rankRatio;
  const steps = Math.min(8, upcomingSegments.length);
  if (steps === 0) return { targetLateral: 0, useBoost: false, expectedGain: 0 };

  let bestLane = 0;
  let bestScore = -Infinity;
  let wantBoost = false;

  for (let c = 0; c < CANDIDATES.length; c++) {
    const ratio = CANDIDATES[c];
    let lat = marble.lateral ?? 0;
    let speed = marble.speed ?? 12;
    let score = 0;
    let hitBoost = false;

    for (let s = 0; s < steps; s++) {
      const seg = upcomingSegments[s];
      const hw = seg.halfWidth ?? 3.5;
      const targetLat = ratio * hw;
      lat += (targetLat - lat) * 0.35;

      // Centrifugal push on curves minus bank compensation
      const lateralForce = Math.abs(seg.curvature ?? 0) * speed * speed * 0.04 - Math.abs(seg.bankAngle ?? 0) * 1.4;
      const edgeMargin = hw - Math.abs(lat);
      const fallRisk = edgeMargin < 0.8 ? (0.8 - edgeMargin) * (1 + Math.max(0, lateralForce)) : 0;

      // Boost pad bonus
      if (seg.boostLane !== undefined && Math.abs(lat - seg.boostLane) < 0.9) {
        speed += 3.5;
        score += 4.2;
        hitBoost = true;
      }

      // Inside apex bonus on curved segments
      const apexSign = (seg.curvature ?? 0) >= 0 ? -1 : 1;
      const apexBonus = Math.sign(lat) === apexSign ? Math.abs(seg.curvature ?? 0) * 6 : 0;

      score += speed * 0.15 + apexBonus - fallRisk * (4.5 - 3.0 * riskTolerance);
    }

    if (score > bestScore) {
      bestScore = score;
      bestLane = ratio * (upcomingSegments[0].halfWidth ?? 3.5);
      wantBoost = hitBoost || (rankRatio > 0.45 && Math.abs(upcomingSegments[0].curvature ?? 0) < 0.08);
    }
  }

  return { targetLateral: bestLane, useBoost: wantBoost, expectedGain: bestScore };
}
