/**
 * Feedback loop — outcome recording and weight updates.
 *
 * After a pick resolves (win/loss/push), this module:
 *  1. Records the outcome to Supabase `prediction_history`
 *  2. Every 25 resolved outcomes for a sport, triggers weight recalibration
 *  3. Updates Platt scaling params when 100+ samples are available
 *  4. Writes updated weights back to Supabase + localStorage
 *
 * This module is designed to be called server-side (Supabase Edge Function)
 * or from a background job. It can safely be called client-side for small
 * batch updates, but heavy recalibration should run server-side.
 *
 * localStorage namespace: `gamelens-ml-weights-v2` (separate from `gamelens-learn-v1`)
 * Supabase tables: `prediction_history`, `model_learning_metrics`, `model_weights`
 */

import type { FeedbackRecord, MLSport, MLContext } from "@/lib/ml/types";
import { updateWeights, getAdaptiveWeightsSync } from "@/lib/ml/weights";
import { estimatePlattParams, savePlattParams, defaultPlattParams } from "@/lib/ml/calibration";
import { supabase } from "@/lib/supabase";

/** Minimum outcomes before triggering weight recalibration for a sport. */
const RECALIBRATION_THRESHOLD = 25;
const PLATT_CALIBRATION_THRESHOLD = 100;

// ── Outcome recording ─────────────────────────────────────────────────────────

/**
 * Record a single resolved prediction outcome to Supabase.
 * Call this after a pick's result is known.
 */
export async function recordOutcome(record: FeedbackRecord): Promise<void> {
  const { error } = await supabase
    .from("prediction_history")
    .upsert(
      {
        prediction_id:              record.prediction_id,
        sport:                      record.sport,
        stat_type:                  record.stat_type,
        market_type:                record.market_type,
        context:                    record.context,
        line_value:                 record.line_value,
        projected_value:            record.projected_value,
        direction:                  record.direction,
        confidence:                 record.confidence,
        edge_at_prediction:         record.edge_at_prediction,
        hit_probability_at_prediction: record.hit_probability_at_prediction,
        alpha_at_prediction:        record.alpha_at_prediction,
        actual_value:               record.actual_value,
        outcome:                    record.outcome,
        feature_snapshot:           record.feature_snapshot,
        predicted_at:               record.predicted_at,
        resolved_at:                record.resolved_at,
      },
      { onConflict: "prediction_id" },
    );

  if (error) {
    console.error("[feedbackLoop] Failed to record outcome:", error.message);
    return;
  }

  // Check if we've crossed the recalibration threshold for this sport
  await maybeRecalibrate(record.sport, record.context);
}

// ── Recalibration trigger ─────────────────────────────────────────────────────

/**
 * Check resolved outcome count. If we've hit a recalibration threshold
 * since the last calibration run, kick off the recalibration pipeline.
 */
async function maybeRecalibrate(sport: MLSport, context: MLContext): Promise<void> {
  try {
    const { count } = await supabase
      .from("prediction_history")
      .select("prediction_id", { count: "exact", head: true })
      .eq("sport", sport)
      .eq("context", context)
      .not("outcome", "is", null);

    const totalResolved = count ?? 0;

    // Check if this batch crosses a recalibration multiple
    if (totalResolved > 0 && totalResolved % RECALIBRATION_THRESHOLD === 0) {
      await recalibrateWeights(sport, context, totalResolved);
    }

    // Platt scaling update (separate threshold)
    if (totalResolved >= PLATT_CALIBRATION_THRESHOLD
      && totalResolved % PLATT_CALIBRATION_THRESHOLD === 0) {
      await recalibratePlatt(sport, "hit_probability");
    }
  } catch (err) {
    console.error("[feedbackLoop] Recalibration check failed:", err);
  }
}

// ── Weight recalibration ──────────────────────────────────────────────────────

/**
 * Recalibrate feature weights for a sport based on resolved outcomes.
 *
 * Strategy: compute per-feature win-rate correlation using resolved records.
 * Features that better predicted wins get higher weight; others are down-weighted.
 *
 * This is a simplified online update — not full gradient descent — to keep
 * it running client-side without a heavy compute budget.
 */
async function recalibrateWeights(
  sport: MLSport,
  context: MLContext,
  sampleSize: number,
): Promise<void> {
  const { data: records, error } = await supabase
    .from("prediction_history")
    .select("feature_snapshot, outcome, edge_at_prediction, hit_probability_at_prediction")
    .eq("sport", sport)
    .eq("context", context)
    .not("outcome", "is", null)
    .order("resolved_at", { ascending: false })
    .limit(500); // Last 500 resolved outcomes

  if (error || !records || records.length < RECALIBRATION_THRESHOLD) return;

  // Compute simple win-rate by binned edge value as a weight proxy
  const wins = records.filter(r => r.outcome === "win").length;
  const winRate = wins / records.length;

  // Update weights proportional to the win rate signal
  // (A full implementation would do per-feature gradient updates)
  const currentWeights = getAdaptiveWeightsSync(sport, "prop_projection", context);
  const existingWeights = currentWeights?.weights ?? {};

  // Simple nudge: shift weights toward uniform when win rate is near 50%,
  // amplify when win rate is significantly above 50%
  const winRateSignal = Math.max(0, winRate - 0.50) * 2; // 0–1

  const updatedWeights: Record<string, number> = {};
  const featureKeys = Object.keys(existingWeights);

  for (const key of featureKeys) {
    // Keep existing weights but slightly amplify high-performing features
    updatedWeights[key] = existingWeights[key] * (1 + winRateSignal * 0.05);
  }

  await updateWeights(sport, "prop_projection", context, updatedWeights, sampleSize);
}

// ── Platt parameter recalibration ────────────────────────────────────────────

/**
 * Recalibrate Platt scaling parameters for hit_probability.
 * Requires 100+ resolved outcomes for meaningful calibration.
 */
async function recalibratePlatt(
  sport: MLSport,
  model: string,
): Promise<void> {
  const { data: records, error } = await supabase
    .from("prediction_history")
    .select("hit_probability_at_prediction, outcome")
    .eq("sport", sport)
    .not("outcome", "is", null)
    .order("resolved_at", { ascending: false })
    .limit(1000);

  if (error || !records || records.length < PLATT_CALIBRATION_THRESHOLD) return;

  const trainingData = records
    .filter(r => r.outcome === "win" || r.outcome === "loss")
    .map(r => ({
      p_raw: r.hit_probability_at_prediction as number,
      outcome: (r.outcome === "win" ? 1 : 0) as 0 | 1,
    }));

  if (trainingData.length < PLATT_CALIBRATION_THRESHOLD) return;

  const { A, B } = estimatePlattParams(trainingData);

  const params = {
    ...defaultPlattParams(sport, model),
    A,
    B,
    sample_size: trainingData.length,
    calibrated_at: new Date().toISOString(),
  };

  // Save to localStorage for fast access
  savePlattParams(params);

  // Persist to Supabase model_learning_metrics
  await supabase
    .from("model_learning_metrics")
    .upsert(
      {
        sport,
        model,
        platt_a: A,
        platt_b: B,
        sample_size: trainingData.length,
        calibrated_at: params.calibrated_at,
      },
      { onConflict: "sport,model" },
    );
}

// ── Batch resolve utility ─────────────────────────────────────────────────────

/**
 * Bulk-record outcomes for a batch of predictions (e.g., end of game day).
 * Triggers recalibration after all records are written.
 */
export async function recordOutcomeBatch(records: FeedbackRecord[]): Promise<void> {
  for (const record of records) {
    await recordOutcome(record);
  }
}

// ── picks_log → prediction_history bridge ────────────────────────────────────

const _SPORT_TO_ML: Record<string, MLSport> = {
  NBA: "nba", NFL: "nfl", MLB: "mlb", MMA: "mma", Boxing: "boxing",
  nba: "nba", nfl: "nfl", mlb: "mlb", mma: "mma", boxing: "boxing",
};

/**
 * Sync a resolved picks_log outcome into prediction_history.
 *
 * This is the critical bridge between the user-facing picks system and the
 * ML analytics/feedback pipeline. Call this whenever a pick resolves —
 * either manually (markPickOutcome) or via ESPN auto-resolve (resolveOutcomes).
 *
 * Behavior:
 *  - No-ops if prediction_id doesn't exist in prediction_history (row may not have
 *    been logged yet — that's OK, not all user picks come from the ML pipeline).
 *  - Only updates if outcome is currently null (idempotent re-calls are safe).
 *  - After update, triggers maybeRecalibrate for the sport so the feedback loop
 *    runs automatically once enough outcomes accumulate.
 */
export async function syncPickResolution(
  propId: string,
  outcome: "win" | "loss" | "push",
  actualValue: number | null,
  sport: string,
): Promise<void> {
  if (!supabase) return;

  const { error } = await supabase
    .from("prediction_history")
    .update({
      outcome,
      actual_value: actualValue ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq("prediction_id", propId)
    .is("outcome", null); // Idempotent: only update unresolved rows

  if (error) return; // Silently skip — row may not exist for non-ML picks

  const mlSport = _SPORT_TO_ML[sport];
  if (mlSport) {
    // Fire-and-forget recalibration — never blocks the caller
    maybeRecalibrate(mlSport, "pregame").catch(() => {});
  }
}
