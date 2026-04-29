/**
 * Single-bet eligibility gate ("Would I bet this as a straight?").
 *
 * Implements Step 8 of the discipline checklist: a leg that doesn't
 * deserve a straight bet doesn't deserve a parlay slot either. Used
 * by SAFE / CASHOUT parlay modes as a hard filter; surfaced in the UI
 * as a per-leg badge so users learn which picks are parlay-safe.
 *
 * Thresholds intentionally conservative — false-negatives (missing a
 * fine pick) are cheaper than false-positives (parlaying a fragile leg).
 */

import type { ValueBetCandidate } from "./types";

/** Inclusive American-odds range a "straight bet" leg must price within. */
export const SINGLE_BET_PRICE_MIN = -300;
export const SINGLE_BET_PRICE_MAX = 110;

/** Probability/confidence floors. */
const MIN_MODEL_PROB        = 0.58;
const MIN_EDGE              = 0.02;
const MAX_VOLATILITY        = 60;
const MIN_RECENT_HIT_RATE   = 0.45;
const RECENT_HIT_MIN_SAMPLE = 3;

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

export function evaluateSingleBetEligibility(c: ValueBetCandidate): EligibilityResult {
  if (c.staleLineFlag)            return { eligible: false, reason: "Stale price" };
  if (c.lateChangeInvalidated)    return { eligible: false, reason: "Late lineup change" };
  if (c.confidence === "low")     return { eligible: false, reason: "Low confidence" };
  if ((c.edge ?? 0) <= MIN_EDGE)  return { eligible: false, reason: "Edge too thin for straight" };
  if ((c.modelProbability ?? 0) < MIN_MODEL_PROB) {
    return { eligible: false, reason: `Model prob < ${Math.round(MIN_MODEL_PROB * 100)}%` };
  }
  if ((c.volatilityScore ?? 0) >= MAX_VOLATILITY) {
    return { eligible: false, reason: "Too volatile for straight" };
  }
  if (c.americanOdds < SINGLE_BET_PRICE_MIN) {
    return { eligible: false, reason: "Too chalky (price < -300)" };
  }
  if (c.americanOdds > SINGLE_BET_PRICE_MAX) {
    return { eligible: false, reason: "Underdog price (> +110)" };
  }
  if (
    c.pickType === "player_prop"
    && c.recentHitRate != null
    && (c.recentHitRateSamples ?? 0) >= RECENT_HIT_MIN_SAMPLE
    && c.recentHitRate < MIN_RECENT_HIT_RATE
  ) {
    return { eligible: false, reason: "Missed line in last 5+" };
  }
  return { eligible: true };
}

/** Mutates `c` in place, attaching eligibleAsSingle + singleBetReason. */
export function attachSingleBetEligibility<T extends ValueBetCandidate>(c: T): T {
  const r = evaluateSingleBetEligibility(c);
  c.eligibleAsSingle = r.eligible;
  c.singleBetReason  = r.eligible ? undefined : r.reason;
  return c;
}
