/**
 * Prop projection model — weighted regression.
 *
 * Implements the spec formula:
 *   projection = baseline
 *              + recent_form_adjustment
 *              + matchup_adjustment
 *              + role_adjustment
 *              + pace_or_environment_adjustment
 *              - volatility_penalty
 *
 * Each adjustment is derived from the PropFeatureVector and adds/subtracts
 * from the baseline (season_avg). The model produces a point projection plus
 * an 80% confidence interval.
 *
 * Default weights are heuristic starting points — they converge via the
 * feedback loop as outcomes accumulate.
 */

import type { PropFeatureVector } from "@/lib/ml/types";
import type { PropProjectionOutput } from "@/lib/ml/types";

// Feature weights (sum ≈ 1.0 — normalized)
const PROJECTION_WEIGHTS = {
  recent_form:   0.32,   // avg_last5 deviation from season
  season_base:   0.25,   // Anchoring pull toward season average
  matchup:       0.18,   // Opponent rank signal
  role:          0.15,   // Usage/opportunity
  pace_env:      0.07,   // Pace/park/weather environment
  volatility:    0.03,   // Variance penalty (negative contributor)
};

/**
 * Recent form adjustment: how much is the last-5 trending above/below season.
 * Returns an absolute value delta from baseline.
 */
function recentFormAdjustment(fv: PropFeatureVector): number {
  if (fv.season_avg === 0) return 0;
  // Weighted blend: last5 more recent than last10
  const recentAvg = fv.avg_last5 * 0.65 + fv.avg_last10 * 0.35;
  const delta = recentAvg - fv.season_avg;
  // Dampen large swings: confidence decreases for extreme deviations
  const dampener = Math.max(0.5, 1 - Math.abs(delta / Math.max(fv.season_avg, 1)) * 0.3);
  return delta * dampener * PROJECTION_WEIGHTS.recent_form;
}

/**
 * Matchup adjustment: opponent rank (1=hardest, 30=easiest) → multiplier on baseline.
 * Rank 1 → -15% on baseline, Rank 30 → +15%.
 */
function matchupAdjustment(fv: PropFeatureVector): number {
  // Map rank to multiplier: 1→0.85, 30→1.15 (same as defRankToMultiplier in nba.ts)
  const maxRank = 32; // use 32 as ceiling to handle NFL (1-32)
  const mult = 0.85 + (fv.opponent_rank - 1) / (maxRank - 1) * 0.30;
  return fv.season_avg * (mult - 1.0) * PROJECTION_WEIGHTS.matchup;
}

/**
 * Role/opportunity adjustment: usage_rate above 0.5 is above-average opportunity.
 * Signed delta so high usage → positive contribution.
 */
function roleAdjustment(fv: PropFeatureVector): number {
  const usageDelta = fv.usage_rate - 0.5; // Center at neutral
  return fv.season_avg * usageDelta * 0.30 * PROJECTION_WEIGHTS.role;
}

/**
 * Pace/environment adjustment: uses pace_factor (already centered at 0).
 * High pace → more possessions → more opportunities.
 */
function paceEnvAdjustment(fv: PropFeatureVector): number {
  // pace_factor is already centered at 0 in all feature extractors
  return fv.season_avg * fv.pace_factor * 0.10 * PROJECTION_WEIGHTS.pace_env;
}

/**
 * Volatility penalty: stat variance reduces the projection toward baseline.
 * Measured by spread across the three rolling averages.
 */
function volatilityPenalty(fv: PropFeatureVector): number {
  if (fv.season_avg === 0) return 0;
  const spread = Math.max(fv.avg_last5, fv.avg_last10, fv.season_avg)
    - Math.min(fv.avg_last5, fv.avg_last10, fv.season_avg);
  const cv = spread / fv.season_avg;
  // Pull projected value back toward baseline when volatile
  return fv.season_avg * cv * 0.08 * PROJECTION_WEIGHTS.volatility;
}

/**
 * 80% confidence interval width based on data quality and volatility.
 * Better data + lower volatility → tighter interval.
 */
function computeCI(projection: number, fv: PropFeatureVector): { low: number; high: number } {
  if (projection === 0) return { low: 0, high: 0 };
  const spread = Math.max(fv.avg_last5, fv.avg_last10, fv.season_avg)
    - Math.min(fv.avg_last5, fv.avg_last10, fv.season_avg);
  const normalizedSpread = fv.season_avg > 0 ? spread / fv.season_avg : 0.3;

  // Base interval: ~15% of projection, scaled by volatility and data quality
  const qualityFactor = 2.0 - fv.data_quality; // 1.0 (perfect) to 2.0 (no data)
  const halfWidth = projection * 0.15 * (1 + normalizedSpread) * qualityFactor;

  return {
    low: Math.max(0, projection - halfWidth),
    high: projection + halfWidth,
  };
}

export function computePropProjection(fv: PropFeatureVector): PropProjectionOutput {
  // Guard: insufficient data → fall back to season_avg as baseline
  if (fv.data_quality < 0.20 || fv.season_avg === 0) {
    const fallback = fv.season_avg || fv.line_value;
    return {
      projected_value: fallback,
      projection_ci_low: fallback * 0.75,
      projection_ci_high: fallback * 1.25,
      source: "rules",
    };
  }

  const baseline = fv.season_avg;
  const projection = baseline
    + recentFormAdjustment(fv)
    + matchupAdjustment(fv)
    + roleAdjustment(fv)
    + paceEnvAdjustment(fv)
    - volatilityPenalty(fv);

  // Never project below 0
  const clamped = Math.max(0, projection);
  const { low, high } = computeCI(clamped, fv);

  return {
    projected_value: clamped,
    projection_ci_low: low,
    projection_ci_high: high,
    source: "ml",
  };
}
