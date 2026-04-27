/**
 * Stat-type bans for Primary / Auto Profit selections.
 *
 * High-variance stat types are explicitly excluded from the Primary
 * anchor pool and from any ticket the Auto Profit picker can select.
 * The user can still place these on their own from the parlay
 * builder; they just don't count for the disciplined daily-bet
 * surface.
 *
 * Why these specifically:
 *   - rbis / rbi: depends on prior runners + clutch pitching matchups,
 *     enormous game-script variance
 *   - runs: same problem, plus depends on lineup spot
 *   - home_runs: power props are coin flips even for elite hitters
 *     vs MLB pitching distributions
 *   - steals: contingent on team manager + game state, noisy
 *   - blocks: huge per-game variance, lineup-dependent
 *   - combat exact-method (ko_tko, submission, decision, draw): 50/50
 *     to 80/20 single-event outcomes, no variance reduction available
 */

import type { ValueBetCandidate } from "@/lib/valueParlay/types";

/** Set of stat_type strings (lowercase) that are banned for Primary/Auto Profit. */
export const BANNED_STAT_TYPES_FOR_PRIMARY = new Set([
  // MLB high-variance
  "rbi", "rbis", "runs", "home_runs", "homeruns", "hr",
  // NBA / NFL high-variance
  "steals", "blocks", "stl", "blk",
  // Combat exact-method props — single-event coin flips
  "ko_tko", "kotko", "submission", "decision", "draw",
]);

export function isBannedStatTypeForPrimary(c: ValueBetCandidate): boolean {
  const stat = String(c.statType ?? "").toLowerCase();
  return BANNED_STAT_TYPES_FOR_PRIMARY.has(stat);
}

/**
 * Quality gate for Auto Profit's "strong" classification — a leg
 * passes ONLY when implied probability sits in the modeled-edge band,
 * volatility is contained, and recent hit rate either supports the
 * pick or is missing entirely (we don't penalize for absent data,
 * but we DO penalize for present-and-bad data).
 */
const IMPLIED_LO_BAND = 0.30;  // < this is sharp/longshot territory
const IMPLIED_HI_BAND = 0.85;  // > this is heavy chalk; no edge to exploit
const VOLATILITY_HARD_CAP = 70; // 0-100 scale; > this fails
const RECENT_HIT_RATE_FLOOR = 0.45;

export function passesQualityGates(c: ValueBetCandidate): boolean {
  const impl = c.impliedProbability ?? 0.5;
  if (impl < IMPLIED_LO_BAND || impl > IMPLIED_HI_BAND) return false;

  if (typeof c.volatilityScore === "number" && c.volatilityScore > VOLATILITY_HARD_CAP) return false;

  // recent_hit_rate is only on player props; missing means "no penalty"
  // (we don't have data to fail on yet).
  if (typeof c.recentHitRate === "number" && c.recentHitRate < RECENT_HIT_RATE_FLOOR) return false;

  return true;
}

export const PRIMARY_QUALITY_THRESHOLDS = {
  IMPLIED_LO_BAND,
  IMPLIED_HI_BAND,
  VOLATILITY_HARD_CAP,
  RECENT_HIT_RATE_FLOOR,
};
