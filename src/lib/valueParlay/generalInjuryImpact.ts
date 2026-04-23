/**
 * Generic injury-impact helpers for NBA and MLB — parallels nflInjuryImpact
 * but with sport-appropriate position weighting. The numeric delta returned
 * here is applied to BOTH:
 *
 *   - legScore            (existing, via ValueBetCandidate.injuryImpactAdj)
 *   - modelProbability    (new — feature-vector integration)
 *
 * So the InjuryImpactMeter signal users see in the UI actually moves the
 * underlying hit-probability, not just the leg ranking.
 */

import type { PlayerInjury } from "@/data/mockGames";

function isOut(i: PlayerInjury): boolean {
  return i.status === "OUT";
}

/**
 * NBA team-level injury delta.
 *
 * Any OUT with impactScore ≥ 8 counts as a star. Starter-level OUT counts
 * as a rotation piece (impactScore 5–7). The opponent's losses strengthen
 * the picked team by a smaller amount (you still have to score).
 *
 * Range: [-0.08, +0.08].
 */
export function computeNbaTeamInjuryAdj(
  ownInj: PlayerInjury[],
  oppInj: PlayerInjury[],
): number {
  if (!ownInj.length && !oppInj.length) return 0;

  const ownOut = ownInj.filter(isOut);
  const oppOut = oppInj.filter(isOut);

  const ownStar   = ownOut.filter((i) => i.impactScore >= 8).length;
  const ownRot    = ownOut.filter((i) => i.impactScore >= 5 && i.impactScore < 8).length;
  const oppStar   = oppOut.filter((i) => i.impactScore >= 8).length;
  const oppRot    = oppOut.filter((i) => i.impactScore >= 5 && i.impactScore < 8).length;

  let adj = 0;
  // Own losses hurt
  if (ownStar >= 2)  adj -= 0.07;
  else if (ownStar) adj -= 0.05;
  if (ownRot  >= 3)  adj -= 0.03;
  else if (ownRot  >= 1) adj -= 0.01;

  // Opponent losses help (at roughly 2/3 the magnitude)
  if (oppStar >= 2)  adj += 0.05;
  else if (oppStar) adj += 0.03;
  if (oppRot  >= 3)  adj += 0.02;
  else if (oppRot  >= 1) adj += 0.01;

  return Math.min(0.08, Math.max(-0.08, adj));
}

/**
 * MLB team-level injury delta.
 *
 * Bigger picture for MLB is the pitcher matchup (handled separately in the
 * prediction model). This captures position-player losses which shift
 * offense/defense. Range: [-0.06, +0.06] — tighter than NFL/NBA because
 * individual non-pitcher losses rarely swing moneyline by more than a few
 * percentage points.
 */
export function computeMlbTeamInjuryAdj(
  ownInj: PlayerInjury[],
  oppInj: PlayerInjury[],
): number {
  if (!ownInj.length && !oppInj.length) return 0;

  const ownOut = ownInj.filter(isOut);
  const oppOut = oppInj.filter(isOut);

  const ownImpactful = ownOut.filter((i) => i.impactScore >= 7).length;
  const ownMinor     = ownOut.filter((i) => i.impactScore >= 4 && i.impactScore < 7).length;
  const oppImpactful = oppOut.filter((i) => i.impactScore >= 7).length;
  const oppMinor     = oppOut.filter((i) => i.impactScore >= 4 && i.impactScore < 7).length;

  let adj = 0;
  if (ownImpactful >= 2) adj -= 0.05;
  else if (ownImpactful) adj -= 0.03;
  if (ownMinor     >= 2) adj -= 0.02;

  if (oppImpactful >= 2) adj += 0.04;
  else if (oppImpactful) adj += 0.02;
  if (oppMinor     >= 2) adj += 0.01;

  return Math.min(0.06, Math.max(-0.06, adj));
}
