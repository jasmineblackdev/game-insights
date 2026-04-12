/**
 * ML enrichment for Player Edge predictions.
 *
 * This is the integration point between the rules engine (ESPN / combat fetch pipeline)
 * and the new ML layer. It runs after the rules engine has fully scored each prediction.
 *
 * Contract:
 *  - Rules engine output is PRIMARY. ML adjustments are ADDITIVE, not replacement.
 *  - Alpha blend factor starts at 0.05 and grows with evidence — early on ML changes
 *    almost nothing; blended outputs converge toward rules engine outputs.
 *  - Each sport has its own trust level (sample_size) tracked independently.
 *  - Logging: surfaced predictions are written to `prediction_history` for future learning.
 *
 * What this module adds to each prediction:
 *  - ml_active          — whether ML has enough evidence to meaningfully contribute
 *  - ml_hit_probability — blended P(bet wins)
 *  - timing_urgency     — "now" | "monitor" | "wait" (from timing model)
 *  - best_time_to_bet   — human-readable timing label
 *  - volatility_flag    — true when stat variance is high (confidence model)
 *  - projection_ci_low  — 80% CI lower bound from propProjection model
 *  - projection_ci_high — 80% CI upper bound
 *  - ml_debug           — internal debug snapshot for logging / comparison
 *
 * What it UPDATES on existing fields (conservatively):
 *  - projected_value  — alpha-blended with ML projection
 *  - edge             — recomputed as blended_projection - line_value
 *  - confidence       — updated from blended confidence only when alpha >= 0.15
 */

import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import type { MLSport } from "@/lib/ml/types";
import type { RulesOutput } from "@/lib/ml/blending";
import { blendPropPredictionSync } from "@/lib/ml/blending";
import { extractMinimalPropFeatures } from "@/lib/ml/features/index";
import { computeConfidence } from "@/lib/ml/models/confidence";
import { computePropProjection } from "@/lib/ml/models/propProjection";
import { computeAlpha, getAdaptiveWeightsSync } from "@/lib/ml/weights";
import { supabase } from "@/lib/supabase";

// ── Sport mapping ─────────────────────────────────────────────────────────────

const SPORT_TO_ML: Record<PlayerEdgePrediction["sport"], MLSport> = {
  NBA:    "nba",
  NFL:    "nfl",
  MLB:    "mlb",
  Boxing: "boxing",
  MMA:    "mma",
};

// ── Rules engine proxy helpers ────────────────────────────────────────────────

/**
 * Derive a rules-based hit probability from edge magnitude and confidence tier.
 * This is the "rules engine's view" of P(bet wins), used as the rules input
 * to the blender.
 *
 * Formula: P = 0.5 + clamp(|edge| / sport_max_edge * 0.40, 0, 0.40)
 * Floors at 0.50 (never express negative edge in P), caps at 0.90.
 */
function rulesHitProbability(pred: PlayerEdgePrediction): number {
  const maxEdge: Record<string, number> = {
    NBA: 8, NFL: 30, MLB: 2, Boxing: 15, MMA: 15,
  };
  const max = maxEdge[pred.sport] ?? 8;
  const raw = 0.50 + Math.min(Math.abs(pred.edge) / max * 0.40, 0.40);
  return Math.max(0.50, Math.min(0.90, raw));
}

/**
 * Derive a market probability proxy when actual market odds are unavailable.
 * Uses confidence tier as a conservative estimate.
 */
function marketProbProxy(pred: PlayerEdgePrediction): number {
  if (pred.confidence === "HIGH") return 0.62;
  if (pred.confidence === "MED")  return 0.56;
  return 0.51;
}

// ── Timing label builder ──────────────────────────────────────────────────────

function buildTimingLabel(
  urgency: "now" | "wait" | "monitor",
  liveCheckpoint: string | null,
  context: "pregame" | "live",
): string {
  if (context === "live" && liveCheckpoint) return liveCheckpoint;
  if (urgency === "now")     return "Bet now";
  if (urgency === "wait")    return "Wait for more info";
  return "Monitor before game";
}

// ── Per-sport alpha lookup (sync, localStorage only) ─────────────────────────

function getAlphaForSport(sport: MLSport): number {
  const w = getAdaptiveWeightsSync(sport, "hit_probability", "pregame");
  return computeAlpha(w?.sample_size ?? 0);
}

// ── Core enrichment ───────────────────────────────────────────────────────────

export function enrichPrediction(pred: PlayerEdgePrediction): PlayerEdgePrediction {
  const sport = SPORT_TO_ML[pred.sport];

  // 1. Build feature vector from minimal prediction data (lightweight path)
  const fv = extractMinimalPropFeatures({
    sport,
    stat_type: pred.stat_type,
    line_value: pred.line_value,
    projected_value: pred.projected_value,
    edge: pred.edge,
    confidence: pred.confidence,
    market_probability: marketProbProxy(pred),
  });

  // 2. Package rules engine output
  const rulesOutput: RulesOutput = {
    projected_value: pred.projected_value,
    hit_probability: rulesHitProbability(pred),
    edge: pred.edge,
    confidence: pred.confidence,
  };

  // 3. Blend (sync — safe for render-time calls)
  const blended = blendPropPredictionSync(fv, rulesOutput, sport);

  // 4. Additional models for CI and volatility (lightweight, pure functions)
  const mlProjection = computePropProjection(fv);
  const mlConfidence = computeConfidence(fv);

  // 5. Derive updated edge (absolute delta, same units as existing pred.edge)
  const blendedEdgeDelta = Math.round((blended.projected_value - pred.line_value) * 10) / 10;

  // 6. Confidence: only adopt ML's read when alpha is meaningful (>= 0.15)
  //    This prevents an uncalibrated ML from downgrading solid HIGH picks.
  const alpha = getAlphaForSport(sport);
  const finalConfidence = alpha >= 0.15 ? blended.confidence : pred.confidence;

  // 7. Timing label for UI display
  const timingLabel = buildTimingLabel(
    blended.timing.urgency,
    blended.timing.live_checkpoint,
    blended.timing.best_context,
  );

  // 8. Debug snapshot for internal logging
  const mlDebug: PlayerEdgePrediction["ml_debug"] = {
    rules_projection:     pred.projected_value,
    ml_projection:        mlProjection.projected_value,
    blended_projection:   blended.projected_value,
    implied_probability:  marketProbProxy(pred),
    edge_rules:           pred.edge,
    edge_blended:         blendedEdgeDelta,
    confidence_rules:     pred.confidence,
    confidence_blended:   blended.confidence,
    timing_urgency:       blended.timing.urgency,
    volatility_flag:      mlConfidence.volatility_flag,
    alpha:                blended.alpha,
    ml_sample_size:       blended.ml_sample_size,
    ml_active:            blended.ml_active,
    stability_score:      mlConfidence.stability_score,
  };

  return {
    ...pred,
    // Conservative field updates — nearly identical to rules output early on
    projected_value:    Math.round(blended.projected_value * 10) / 10,
    edge:               blendedEdgeDelta,
    confidence:         finalConfidence,
    // New ML fields
    ml_active:          blended.ml_active,
    ml_hit_probability: Math.round(blended.hit_probability * 1000) / 1000,
    timing_urgency:     blended.timing.urgency,
    best_time_to_bet:   timingLabel,
    volatility_flag:    mlConfidence.volatility_flag,
    projection_ci_low:  Math.round(mlProjection.projection_ci_low * 10) / 10,
    projection_ci_high: Math.round(mlProjection.projection_ci_high * 10) / 10,
    ml_debug:           mlDebug,
    // Update timing_note only if ML produced a checkpoint (pregame = keep existing)
    timing_note: blended.timing.best_context === "live" && blended.timing.live_checkpoint
      ? blended.timing.live_checkpoint
      : pred.timing_note,
  };
}

/**
 * Enrich an array of predictions in one pass.
 * Safe to call in the render pipeline — uses sync blending only.
 * Each prediction is enriched independently; failures are silently swallowed.
 */
export function enrichPredictions(preds: PlayerEdgePrediction[]): PlayerEdgePrediction[] {
  return preds.map((pred) => {
    try {
      return enrichPrediction(pred);
    } catch {
      // Never let ML enrichment break the UI — return original prediction
      return pred;
    }
  });
}

// ── Prediction logging for feedback loop ─────────────────────────────────────

const _loggedThisSession = new Set<string>();
const PREDICTION_LOG_BATCH_SIZE = 20;

/**
 * Log surfaced predictions to `prediction_history` for the ML feedback loop.
 * Uses sessionStorage to avoid duplicate logs within the same session.
 * Fire-and-forget — does not block the render pipeline.
 */
export async function logSurfacedPredictions(preds: PlayerEdgePrediction[]): Promise<void> {
  if (!supabase) return;

  // Only log predictions we haven't logged this session
  const toLog = preds.filter((p) => !_loggedThisSession.has(p.id));
  if (toLog.length === 0) return;

  // Mark as logged immediately to prevent duplicate calls
  toLog.forEach((p) => _loggedThisSession.add(p.id));

  // Process in small batches to avoid overwhelming Supabase
  for (let i = 0; i < toLog.length; i += PREDICTION_LOG_BATCH_SIZE) {
    const batch = toLog.slice(i, i + PREDICTION_LOG_BATCH_SIZE);
    const rows = batch.map((pred) => ({
      prediction_id:                    pred.id,
      sport:                            pred.sport.toLowerCase(),
      stat_type:                        pred.stat_type,
      market_type:                      "prop" as const,
      context:                          "pregame" as const,
      line_value:                       pred.line_value,
      projected_value:                  pred.projected_value,
      direction:                        pred.prediction_direction,
      confidence:                       pred.confidence,
      edge_at_prediction:               pred.edge,
      hit_probability_at_prediction:    pred.ml_hit_probability ?? rulesHitProbability(pred),
      alpha_at_prediction:              pred.ml_debug?.alpha ?? 0.05,
      actual_value:                     null,
      outcome:                          null,
      feature_snapshot: {
        line_value:          pred.line_value,
        projected_value:     pred.projected_value,
        edge:                pred.edge,
        confidence_score:    pred.confidence_score_0_100 ?? 0,
        ml_active:           pred.ml_active ? 1 : 0,
        ml_hit_probability:  pred.ml_hit_probability ?? 0,
        timing_urgency_now:  pred.timing_urgency === "now" ? 1 : 0,
        volatility_flag:     pred.volatility_flag ? 1 : 0,
      },
      predicted_at: new Date().toISOString(),
      resolved_at: null,
    }));

    try {
      await supabase
        .from("prediction_history")
        .upsert(rows, { onConflict: "prediction_id", ignoreDuplicates: true });
    } catch {
      // Non-critical — silently skip
    }
  }
}
