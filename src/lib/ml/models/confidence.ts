/**
 * Confidence/stability model for ML layer.
 *
 * Assesses prediction stability — how consistent is the signal?
 *  - LOW volatility + HIGH consistency → HIGH confidence
 *  - Consistency measured by comparing recent form to season average
 *  - Data quality gating: low-quality data cannot produce HIGH confidence
 *
 * Output feeds into BlendedPropOutput.confidence and the parlay leg scorer.
 */

import type { PropFeatureVector } from "@/lib/ml/types";
import type { ConfidenceOutput } from "@/lib/ml/types";

/**
 * Coefficient of variation proxy from feature vector averages.
 * Low CV → consistent performer → lower volatility.
 */
function computeVariability(fv: PropFeatureVector): number {
  const avg = (fv.avg_last5 + fv.avg_last10 + fv.season_avg) / 3;
  if (avg === 0) return 1; // No data — assume high volatility
  const spread = Math.max(fv.avg_last5, fv.avg_last10, fv.season_avg)
    - Math.min(fv.avg_last5, fv.avg_last10, fv.season_avg);
  // Normalize: spread relative to avg, capped at 1.0
  return Math.min(1.0, spread / avg);
}

/**
 * Recent form signal: how much is recent form deviating from season baseline?
 * Values close to 0 → stable; large deviations → recent volatility.
 */
function recentFormDrift(fv: PropFeatureVector): number {
  if (fv.season_avg === 0) return 0.5;
  const drift = Math.abs(fv.avg_last5 - fv.season_avg) / fv.season_avg;
  return Math.min(1.0, drift);
}

/**
 * Market stability signal from line movement.
 * Large line movement = uncertainty; stable lines = market agreement.
 */
function marketStability(lineMovement: number): number {
  // line_movement is in [-1, 1] for NFL/NBA/MLB
  return 1.0 - Math.abs(lineMovement);
}

/**
 * Injury flag dampens confidence — uncertainty about role/availability.
 */
function injuryDampener(hasInjuryFlag: boolean): number {
  return hasInjuryFlag ? 0.75 : 1.0;
}

/**
 * Compute a stability score from 0–1.
 * 1.0 = highly consistent / stable, 0.0 = highly volatile.
 */
function computeStabilityScore(fv: PropFeatureVector): number {
  const variability = computeVariability(fv);       // 0=stable, 1=volatile
  const drift = recentFormDrift(fv);                 // 0=on-trend, 1=diverging
  const stability = marketStability(fv.line_movement); // 0=moving, 1=stable

  // Weighted composite: lower variability and drift → higher score
  const rawScore = (
    (1 - variability) * 0.35 +
    (1 - drift)       * 0.30 +
    stability         * 0.20 +
    fv.data_quality   * 0.15
  );

  return Math.max(0, Math.min(1, rawScore)) * injuryDampener(fv.has_injury_flag);
}

/**
 * Volatility flag: fired when raw variability is high even if other factors
 * look OK (e.g., consistent but recent injury or wildly shifting lines).
 */
function computeVolatilityFlag(fv: PropFeatureVector, stabilityScore: number): boolean {
  const variability = computeVariability(fv);
  return variability > 0.40 || stabilityScore < 0.35 || fv.data_quality < 0.30;
}

/**
 * Map stability score → confidence tier.
 * Data quality gates the ceiling: poor data cannot produce HIGH.
 */
function scoreToConfidence(
  stabilityScore: number,
  dataQuality: number,
): "HIGH" | "MED" | "LOW" {
  // Data quality gate
  if (dataQuality < 0.40) return "LOW";
  if (dataQuality < 0.60 && stabilityScore >= 0.75) return "MED"; // Cap at MED

  if (stabilityScore >= 0.72) return "HIGH";
  if (stabilityScore >= 0.45) return "MED";
  return "LOW";
}

export function computeConfidence(fv: PropFeatureVector): ConfidenceOutput {
  const stabilityScore = computeStabilityScore(fv);
  const volatilityFlag = computeVolatilityFlag(fv, stabilityScore);
  const confidence = scoreToConfidence(stabilityScore, fv.data_quality);

  return {
    confidence,
    stability_score: stabilityScore,
    volatility_flag: volatilityFlag,
    source: "ml",
  };
}
