/**
 * Risk-mix derivation for paper-bet legs.
 *
 * Paper bets are typed in manually so they don't carry a stability
 * label or model probability. We derive a coarse Low/Med/High risk
 * tier from the American odds alone — implied probability is the
 * single best signal we have for "how likely is this leg to hit?"
 *
 * Low   — implied ≥ 60% (favorite-side bets)
 * Med   — implied 40–60%
 * High  — implied < 40% (longshot)
 *
 * Used by the slip-summary card's risk-mix bar and (later) per-leg
 * risk badges in the slip drawer.
 */
import type { PaperLeg } from "./types";

export type RiskTier = "low" | "med" | "high";

export function americanToImpliedProb(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 0.5;
  return american > 0
    ? 100 / (american + 100)
    : -american / (-american + 100);
}

export function legRiskTier(americanOdds: number): RiskTier {
  const p = americanToImpliedProb(americanOdds);
  if (p >= 0.60) return "low";
  if (p >= 0.40) return "med";
  return "high";
}

export interface RiskMix {
  low: number;
  med: number;
  high: number;
  /** Total leg count — denominator for the percentages. */
  total: number;
}

export function computeRiskMix(legs: Pick<PaperLeg, "americanOdds">[]): RiskMix {
  const out: RiskMix = { low: 0, med: 0, high: 0, total: legs.length };
  for (const l of legs) {
    const t = legRiskTier(l.americanOdds);
    out[t] += 1;
  }
  return out;
}

export function riskMixPct(mix: RiskMix): { low: number; med: number; high: number } {
  if (mix.total === 0) return { low: 0, med: 0, high: 0 };
  return {
    low:  Math.round((mix.low  / mix.total) * 100),
    med:  Math.round((mix.med  / mix.total) * 100),
    high: Math.round((mix.high / mix.total) * 100),
  };
}
