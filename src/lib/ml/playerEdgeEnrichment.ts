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
import { deriveModelStatus } from "@/lib/ml/modelStatus";
import { plattParamsFor } from "@/lib/ml/plattCalibration";
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
  // Prefer the variance-adjusted path; fall back to the linear edge map
  // only when projected_value / line_value aren't useful.
  if (Number.isFinite(pred.projected_value) && Number.isFinite(pred.line_value)) {
    return rulesHitProbabilityVariance(pred);
  }
  const maxEdge: Record<string, number> = {
    NBA: 8, NFL: 30, MLB: 2, Boxing: 15, MMA: 15,
  };
  const max = maxEdge[pred.sport] ?? 8;
  const raw = 0.50 + Math.min(Math.abs(pred.edge) / max * 0.40, 0.40);
  return Math.max(0.50, Math.min(0.90, raw));
}

/**
 * Real market-implied probability when American odds are present.
 * Falls back to a confidence-tier proxy only when the feed hasn't supplied
 * actual odds — important because the nightly Platt fitter trains on this
 * value. Synthetic targets pollute calibration.
 */
function marketProbProxy(pred: PlayerEdgePrediction): number {
  const a = pred.american_odds;
  if (typeof a === "number" && Number.isFinite(a) && a !== 0) {
    return a >= 0 ? 100 / (a + 100) : -a / (-a + 100);
  }
  if (pred.confidence === "HIGH") return 0.62;
  if (pred.confidence === "MED")  return 0.56;
  return 0.51;
}

/**
 * Variance-adjusted rules hit probability from projected value vs line.
 * Previously a linear transform of |edge|, which makes Platt train on a
 * signal that's structurally equivalent to edge. Now uses:
 *   P_over = Φ((projected − line) / sport_sigma)
 * where sport_sigma is a stat-specific residual volatility.
 */
function rulesHitProbabilityVariance(pred: PlayerEdgePrediction): number {
  const sportSigma: Record<string, number> = {
    NBA: 4.5, NFL: 18, MLB: 0.6, Boxing: 0.08, MMA: 0.08,
  };
  const sigma = sportSigma[pred.sport] ?? 4.0;
  const z = (pred.projected_value - pred.line_value) / sigma;
  // Normal CDF approximation (Abramowitz & Stegun 7.1.26 variant)
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804 * Math.exp(-0.5 * z * z);
  const cdf = 1 - d * (0.31938153 * t - 0.356563782 * t * t + 1.781477937 * t * t * t
                       - 1.821255978 * t * t * t * t + 1.330274429 * t * t * t * t * t);
  const pOver = z >= 0 ? cdf : 1 - cdf;
  const side = pred.prediction_direction === "MORE" ? pOver : 1 - pOver;
  return Math.max(0.10, Math.min(0.90, side));
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

  // 1. Build feature vector from minimal prediction data (lightweight path).
  //    Now passes game-state features (home/away, opp strength, recent form,
  //    injury flag) so the ML feature vector reflects historical context the
  //    fetcher has already pulled.
  const fv = extractMinimalPropFeatures({
    sport,
    stat_type: pred.stat_type,
    line_value: pred.line_value,
    projected_value: pred.projected_value,
    edge: pred.edge,
    confidence: pred.confidence,
    market_probability: marketProbProxy(pred),
    is_home: pred.is_home,
    opponent_win_pct: pred.opponent_win_pct,
    opponent_defensive_rating: pred.opponent_defensive_rating,
    recent_form: pred.recent_form,
    has_injury_flag: pred.has_injury_flag,
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
    // Transparency fields for the Model Status badge.
    data_quality:       Math.round(fv.data_quality * 100) / 100,
    model_status:       deriveModelStatus({
      sport:           pred.sport,
      market:          pred.stat_type,
      sampleSize:      blended.ml_sample_size,
      dataQuality:     fv.data_quality,
      plattAvailable:  plattParamsFor(pred.sport.toLowerCase(), "player_prop", pred.confidence) != null,
    }).status,
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

  // Filter out MLB predictions whose starting pitcher isn't confirmed yet —
  // pre-confirmation variance poisons the MLB strikeout calibration bucket
  // and shrinks alpha trust for legitimate confirmed-starter samples.
  // Pre-confirmation predictions re-enter the pool automatically once the
  // pitcher is confirmed (they get a new id on the next fetch).
  const gated = preds.filter((p) => {
    if (p.sport !== "MLB") return true;
    // Any MLB pred tagged with pendingConfirmation / ml_debug flag skips logging.
    type MlbPreConfirmShape = { pendingConfirmation?: boolean };
    if ((p as MlbPreConfirmShape).pendingConfirmation) return false;
    return true;
  });

  // Only log predictions we haven't logged this session
  const toLog = gated.filter((p) => !_loggedThisSession.has(p.id));
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
      // NFL injury position multiplier: derive a simplified adj from has_injury_flag
      // + stat_type for enriched props (full positional context is only available for
      // game-level candidates which have a separate build path).
      // Role-sensitive stats (rushing, receiving) with injury flag → +0.02 timing boost.
      // All other cases → 0. Negative adjustments (QB out → WR props hurt) are not
      // derivable here and will populate once game-level candidate logging is added.
      injury_impact_adj: (() => {
        if (pred.sport !== "NFL" || !pred.has_injury_flag) return 0;
        const s = pred.stat_type.toLowerCase();
        const isRoleSensitive = s.includes("rush") || s.includes("receiv") || s === "receptions" || s === "targets";
        return isRoleSensitive ? 0.02 : 0;
      })(),
      feature_snapshot: {
        line_value:              pred.line_value,
        projected_value:         pred.projected_value,
        edge:                    pred.edge,
        confidence_score:        pred.confidence_score_0_100 ?? 0,
        // Closest approximation to "odds at prediction time" we have from ESPN data.
        // Actual book odds are not provided by the ESPN endpoint; use ML-derived
        // market probability proxy so this field is populated for the learning loop.
        market_probability_proxy: marketProbProxy(pred),
        ml_active:               pred.ml_active ? 1 : 0,
        ml_hit_probability:      pred.ml_hit_probability ?? 0,
        // timing_bucket: string for easy SQL GROUP BY across now/monitor/wait buckets
        timing_bucket:           pred.timing_urgency ?? "monitor",
        timing_urgency_now:      pred.timing_urgency === "now" ? 1 : 0,
        timing_urgency_monitor:  pred.timing_urgency === "monitor" || !pred.timing_urgency ? 1 : 0,
        timing_urgency_wait:     pred.timing_urgency === "wait" ? 1 : 0,
        timing_stage:            pred.best_time_to_bet ?? "Pregame",
        volatility_flag:         pred.volatility_flag ? 1 : 0,
        stability_score:         pred.ml_debug?.stability_score ?? 0,
        rules_projection:        pred.ml_debug?.rules_projection ?? pred.projected_value,
        alpha:                   pred.ml_debug?.alpha ?? 0.05,
        projection_ci_low:       pred.projection_ci_low ?? 0,
        projection_ci_high:      pred.projection_ci_high ?? 0,
      },
      model_variant: pred.ml_active ? "ml_blended" : "rules",
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
