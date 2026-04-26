/**
 * Auto-stake sizing — converts a current bankroll + risk tier into a
 * realistic, rounded suggested bet amount.
 *
 * Rules (per spec):
 *   low risk    → up to 5% of current bankroll
 *   medium risk → 2–3% of current bankroll
 *   high risk   → 1% of current bankroll
 *   single-bet hard cap → 5% of current bankroll
 *   minimum bet → $1 (anything below disables suggestion)
 *   round to a clean dollar figure ($1, $2, $5, $10, $25, $50, $100, $200…)
 */

import type { StakeRiskLevel } from "./types";

export const MIN_STAKE = 1;
export const MAX_STAKE_PCT = 0.05;

/** Risk-tier base allocation as a fraction of bankroll. */
const RISK_PCT: Record<StakeRiskLevel, number> = {
  low: 0.05,
  medium: 0.025,
  high: 0.01,
};

/** Standard sportsbook bet rungs — round suggestions to one of these. */
const BET_RUNGS = [1, 2, 3, 5, 10, 15, 20, 25, 50, 75, 100, 150, 200, 300, 500, 1000];

/** Round a raw stake to the nearest standard sportsbook rung at or below it. */
export function roundStake(raw: number): number {
  if (!Number.isFinite(raw) || raw < MIN_STAKE) return 0;
  // Prefer the highest rung at-or-below the raw value so suggestions
  // never exceed the requested allocation. For values above the
  // highest rung, snap to nearest $50.
  let chosen = BET_RUNGS[0];
  for (const r of BET_RUNGS) {
    if (r <= raw) chosen = r;
    else break;
  }
  if (raw > BET_RUNGS[BET_RUNGS.length - 1]) {
    chosen = Math.round(raw / 50) * 50;
  }
  return chosen;
}

/**
 * Suggested stake for a risk tier. Returns 0 when bankroll is too
 * small to support a $1 minimum at this tier. The 5% absolute cap is
 * enforced regardless of tier so a misclassified "low" prop still
 * can't size beyond bankroll-safe limits.
 */
export function suggestStakeForRisk(
  bankroll: number,
  risk: StakeRiskLevel,
): { stake: number; pctOfBankroll: number; capped: boolean } {
  if (!Number.isFinite(bankroll) || bankroll <= 0) {
    return { stake: 0, pctOfBankroll: 0, capped: false };
  }
  const targetPct = RISK_PCT[risk] ?? RISK_PCT.medium;
  const cap = bankroll * MAX_STAKE_PCT;
  const raw = Math.min(bankroll * targetPct, cap);
  const stake = roundStake(raw);
  const capped = stake >= Math.floor(cap);
  return {
    stake,
    pctOfBankroll: bankroll > 0 ? stake / bankroll : 0,
    capped,
  };
}

/** Helper for the UI — the three cards together. */
export function suggestAllStakes(bankroll: number) {
  return {
    low: suggestStakeForRisk(bankroll, "low"),
    medium: suggestStakeForRisk(bankroll, "medium"),
    high: suggestStakeForRisk(bankroll, "high"),
  };
}

/** True when an arbitrary stake exceeds the 5% single-bet cap. */
export function exceedsRecommendedCap(stake: number, bankroll: number): boolean {
  if (!Number.isFinite(bankroll) || bankroll <= 0) return false;
  return stake > bankroll * MAX_STAKE_PCT;
}
