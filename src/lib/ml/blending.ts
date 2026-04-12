/**
 * Blending layer — combines rules engine output with ML model adjustments.
 *
 * IMPORTANT: This runs AFTER the rules engine has fully scored the prediction
 * (including learningSignalAdjustments.ts). Never call this inside the signal
 * weight computation or confidence calibration buckets.
 *
 * Alpha blend factor:
 *   α = min(0.40, 0.05 + sampleSize / 2000)
 *   - Starts at 0.05 (5% ML influence) with no evidence
 *   - Reaches max 0.40 (40% ML influence) at 700+ samples
 *   - ML is only "active" (contributes) after 25 samples
 *
 * Final output = (1 - α) * rules_output + α * ml_output
 *
 * The blending is applied to:
 *  1. projected_value   (prop projection model)
 *  2. hit_probability   (logistic hit probability model)
 *  3. edge              (derived from hit_probability vs market)
 *  4. confidence        (stability model)
 *  5. timing            (timing model — not blended, directly from ML)
 */

import type { PropFeatureVector, BlendedPropOutput, MLSport } from "@/lib/ml/types";
import { computePropProjection } from "@/lib/ml/models/propProjection";
import { computeHitProbability } from "@/lib/ml/models/hitProbability";
import { computeConfidence } from "@/lib/ml/models/confidence";
import { computeTiming } from "@/lib/ml/models/timing";
import { computeAlpha, mlIsActive, getAdaptiveWeights, getAdaptiveWeightsSync } from "@/lib/ml/weights";
import { loadPlattParams } from "@/lib/ml/calibration";

/** Rules engine output passed into the blender. */
export interface RulesOutput {
  projected_value: number;
  hit_probability: number;    // 0–1
  edge: number;               // Percentage points
  confidence: "HIGH" | "MED" | "LOW";
}

/**
 * Blend a single prop prediction.
 *
 * @param fv           Feature vector for this prop
 * @param rulesOutput  What the rules engine produced for this prediction
 * @param sport        Sport key (used to look up sample size)
 */
export async function blendPropPrediction(
  fv: PropFeatureVector,
  rulesOutput: RulesOutput,
  sport: MLSport,
): Promise<BlendedPropOutput> {
  // Look up sample size to determine alpha
  const weights = await getAdaptiveWeights(sport, "hit_probability", fv.context);
  const sampleSize = weights?.sample_size ?? 0;
  const alpha = computeAlpha(sampleSize);
  const active = mlIsActive(sampleSize);

  // If ML hasn't accumulated enough data, return rules output unchanged
  if (!active) {
    return {
      projected_value: rulesOutput.projected_value,
      hit_probability: rulesOutput.hit_probability,
      confidence: rulesOutput.confidence,
      edge: rulesOutput.edge,
      timing: computeTiming(fv), // Timing is always from ML (no rules equivalent)
      alpha,
      ml_sample_size: sampleSize,
      ml_active: false,
    };
  }

  // Load Platt calibration params
  const platt = loadPlattParams(sport, "hit_probability");

  // Run ML models
  const mlProjection  = computePropProjection(fv);
  const mlHitProb     = computeHitProbability(fv, platt);
  const mlConfidence  = computeConfidence(fv);
  const timing        = computeTiming(fv);

  // Alpha-blend numerical outputs
  const blendedProjection = (1 - alpha) * rulesOutput.projected_value
    + alpha * mlProjection.projected_value;

  const blendedHitProb = (1 - alpha) * rulesOutput.hit_probability
    + alpha * mlHitProb.probability;

  const blendedEdge = (1 - alpha) * rulesOutput.edge
    + alpha * mlHitProb.edge;

  // Confidence: blend by taking the "lower" tier when ML disagrees significantly
  // to avoid false HIGH confidence from a model still learning
  const blendedConfidence = blendConfidence(
    rulesOutput.confidence,
    mlConfidence.confidence,
    alpha,
  );

  return {
    projected_value: Math.max(0, blendedProjection),
    hit_probability: Math.max(0.05, Math.min(0.95, blendedHitProb)),
    confidence: blendedConfidence,
    edge: blendedEdge,
    timing,
    alpha,
    ml_sample_size: sampleSize,
    ml_active: true,
  };
}

/**
 * Synchronous fast-path blend for hot renders.
 * Uses cached weights from localStorage only (no Supabase fetch).
 */
export function blendPropPredictionSync(
  fv: PropFeatureVector,
  rulesOutput: RulesOutput,
  sport: MLSport,
): BlendedPropOutput {
  const weights = getAdaptiveWeightsSync(sport, "hit_probability", fv.context);
  const sampleSize = weights?.sample_size ?? 0;
  const alpha = computeAlpha(sampleSize);
  const active = mlIsActive(sampleSize);

  const timing = computeTiming(fv);

  if (!active) {
    return {
      projected_value: rulesOutput.projected_value,
      hit_probability: rulesOutput.hit_probability,
      confidence: rulesOutput.confidence,
      edge: rulesOutput.edge,
      timing,
      alpha,
      ml_sample_size: sampleSize,
      ml_active: false,
    };
  }

  const platt = loadPlattParams(sport, "hit_probability");
  const mlProjection  = computePropProjection(fv);
  const mlHitProb     = computeHitProbability(fv, platt);
  const mlConf        = computeConfidence(fv);

  const blendedProjection = (1 - alpha) * rulesOutput.projected_value
    + alpha * mlProjection.projected_value;
  const blendedHitProb = (1 - alpha) * rulesOutput.hit_probability
    + alpha * mlHitProb.probability;
  const blendedEdge = (1 - alpha) * rulesOutput.edge + alpha * mlHitProb.edge;

  return {
    projected_value: Math.max(0, blendedProjection),
    hit_probability: Math.max(0.05, Math.min(0.95, blendedHitProb)),
    confidence: blendConfidence(rulesOutput.confidence, mlConf.confidence, alpha),
    edge: blendedEdge,
    timing,
    alpha,
    ml_sample_size: sampleSize,
    ml_active: true,
  };
}

/**
 * Confidence blending strategy:
 * - When both agree → use that tier
 * - When ML is lower than rules → conservative: use the lower tier if α > 0.15
 * - When ML is higher than rules → conservative: keep rules tier unless α > 0.30
 *
 * This prevents the ML from upgrading predictions to HIGH before it's reliable.
 */
function blendConfidence(
  rulesConf: "HIGH" | "MED" | "LOW",
  mlConf: "HIGH" | "MED" | "LOW",
  alpha: number,
): "HIGH" | "MED" | "LOW" {
  if (rulesConf === mlConf) return rulesConf;

  const rank: Record<"HIGH" | "MED" | "LOW", number> = { HIGH: 2, MED: 1, LOW: 0 };
  const rulesRank = rank[rulesConf];
  const mlRank = rank[mlConf];

  if (mlRank < rulesRank) {
    // ML says lower — apply if alpha is meaningful
    return alpha >= 0.15 ? mlConf : rulesConf;
  } else {
    // ML says higher — only apply when alpha is high (well-calibrated)
    return alpha >= 0.30 ? mlConf : rulesConf;
  }
}
