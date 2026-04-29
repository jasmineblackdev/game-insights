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
import { stageMaxStakePctFor } from "@/lib/bankroll/scalingLadder";

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
  // Scaling Ladder — stage-aware cap. Smaller stages get a tighter
  // cap to protect the roll; Pro stage tightens too (defend > grow).
  const stagePct = stageMaxStakePctFor(bankroll);
  const cap = bankroll * Math.min(MAX_STAKE_PCT, stagePct);
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

// ── Fractional Kelly ──────────────────────────────────────────────
// Risk-tier-flat staking treats every bet at a tier the same. Kelly
// criterion sizes by edge × odds: bigger when the edge is fat at +200,
// smaller at heavy chalk where the same edge buys less expected value.
// Full Kelly is too volatile in practice — fractional Kelly (0.25× is
// the sharp standard) cuts variance ~94% while keeping ~60% of the
// long-run growth. Net effect: better growth, lower drawdowns.

/** Convert American odds → decimal price (the "1 + b" form). */
function americanToDecimal(o: number): number {
  if (!Number.isFinite(o) || o === 0) return 1;
  return o >= 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
}

/**
 * Kelly criterion fraction (full Kelly). f* = (b·p − q) / b
 * where b = decimal − 1, p = win prob, q = 1 − p.
 *
 * Returns 0 when there's no edge (negative or zero f*) — never bet
 * negative-EV propositions.
 */
export function kellyFraction(modelProb: number, americanOdds: number): number {
  if (modelProb <= 0 || modelProb >= 1) return 0;
  if (!Number.isFinite(americanOdds) || americanOdds === 0) return 0;
  const decimal = americanToDecimal(americanOdds);
  const b = decimal - 1;
  if (b <= 0) return 0;
  const fStar = (b * modelProb - (1 - modelProb)) / b;
  return Math.max(0, fStar);
}

/**
 * Suggested stake from a fractional Kelly fit, clamped to the same
 * 5% per-bet cap as the risk-tier sizer. fractionScale defaults to
 * 0.25 (quarter-Kelly) — matches the "sharps' rule of thumb".
 *
 * Returns null when modelProb / odds aren't usable so the caller can
 * fall through to the risk-tier sizer. Never negative.
 */
export function suggestKellyStake(args: {
  bankroll: number;
  modelProb: number;
  americanOdds: number;
  fractionScale?: number;
}): { stake: number; pctOfBankroll: number; kellyFraction: number; capped: boolean } | null {
  const { bankroll, modelProb, americanOdds, fractionScale = 0.25 } = args;
  if (!Number.isFinite(bankroll) || bankroll <= 0) return null;
  const f = kellyFraction(modelProb, americanOdds);
  if (f <= 0) return null; // no edge → Kelly says don't bet
  const cap = bankroll * MAX_STAKE_PCT;
  const raw = Math.min(bankroll * f * fractionScale, cap);
  if (raw < MIN_STAKE) return { stake: 0, pctOfBankroll: 0, kellyFraction: f, capped: false };
  const stake = roundStake(raw);
  return {
    stake,
    pctOfBankroll: bankroll > 0 ? stake / bankroll : 0,
    kellyFraction: f,
    capped: stake >= Math.floor(cap),
  };
}

/**
 * Smart stake — uses fractional Kelly when modelProb + odds are
 * available, falls back to the risk-tier flat allocation when not.
 * Risk tier still bounds the result: low→Kelly with 5% cap, medium→
 * Kelly with 2.5% cap, high→Kelly with 1% cap. So Kelly never
 * pushes a high-risk bet past 1% of bankroll.
 */
export function suggestSmartStake(args: {
  bankroll: number;
  risk: StakeRiskLevel;
  /** Raw model probability — used only when calibratedProb missing. */
  modelProb?: number;
  /**
   * Empirically-calibrated probability (Platt / isotonic). Preferred
   * input for Kelly so we size off realized hit rate, not raw model
   * output. When present, takes precedence over modelProb.
   */
  calibratedProb?: number;
  americanOdds?: number;
}): { stake: number; pctOfBankroll: number; capped: boolean; method: "kelly" | "flat" | "no-edge" } {
  const { bankroll, risk, modelProb, calibratedProb, americanOdds } = args;
  // Prefer calibrated over raw — calibrated reflects realized hit rate.
  const probForKelly = calibratedProb ?? modelProb;
  if (probForKelly != null && americanOdds != null) {
    const tierCapPct = RISK_PCT[risk] ?? RISK_PCT.medium;
    const k = suggestKellyStake({ bankroll, modelProb: probForKelly, americanOdds });
    // No edge → do not flat-fall back. A negative-EV bet should size to 0.
    if (k === null) {
      return { stake: 0, pctOfBankroll: 0, capped: false, method: "no-edge" };
    }
    if (k.stake > 0) {
      // Apply the tier ceiling (so high-risk Kelly can't exceed 1%).
      const tierCap = bankroll * tierCapPct;
      if (k.stake <= tierCap) {
        return { stake: k.stake, pctOfBankroll: k.pctOfBankroll, capped: k.capped, method: "kelly" };
      }
      const cappedStake = roundStake(tierCap);
      return {
        stake: cappedStake,
        pctOfBankroll: bankroll > 0 ? cappedStake / bankroll : 0,
        capped: true,
        method: "kelly",
      };
    }
  }
  const flat = suggestStakeForRisk(bankroll, risk);
  return { ...flat, method: "flat" };
}
