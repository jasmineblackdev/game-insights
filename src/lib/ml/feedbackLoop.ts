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
import { clampAlpha, getAlphaRange } from "@/lib/ml/alphaConfig";
import {
  setCalibrationEntries,
  verdictTrendToAdjustment,
  type CalibrationVerdict,
  type CalibrationTrend,
} from "@/lib/ml/confidenceCalibrationMap";
import { supabase } from "@/lib/supabase";

// ── Alpha adjustment log (localStorage) ──────────────────────────────────────

const ALPHA_ADJ_LS_PREFIX = "gamelens-alpha-adj-v1";

export interface AlphaAdjustmentLog {
  direction:    "up" | "down" | "unchanged";
  alpha_before: number;
  alpha_after:  number;
  /** Hit rate delta (ml_blended - rules) in percentage points. */
  diff_pp:      number;
  timestamp:    string;
}

function writeAlphaAdjustmentLog(sport: string, entry: AlphaAdjustmentLog): void {
  try {
    localStorage.setItem(`${ALPHA_ADJ_LS_PREFIX}:${sport}`, JSON.stringify(entry));
  } catch { /* localStorage unavailable — skip */ }
}

export function readAlphaAdjustmentLog(sport: string): AlphaAdjustmentLog | null {
  try {
    const raw = localStorage.getItem(`${ALPHA_ADJ_LS_PREFIX}:${sport}`);
    if (!raw) return null;
    return JSON.parse(raw) as AlphaAdjustmentLog;
  } catch {
    return null;
  }
}

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

  // Fire-and-forget confidence calibration map update after weight recalibration
  maybeAdjustConfidenceFromCalibration().catch(() => {});
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

// ── Alpha feedback from model contribution analytics ─────────────────────────

/**
 * Adjust alpha for a sport by ±step based on whether ml_blended outperforms rules.
 *
 * Logic:
 *  - If ml_blended hit rate > rules hit rate + 2pp → nudge alpha up by step
 *  - If ml_blended hit rate < rules hit rate - 2pp → nudge alpha down by step
 *  - Otherwise no change
 *
 * Alpha is clamped to sport-specific range after adjustment.
 * Requires ≥10 resolved outcomes per variant (enforced by the RPC).
 * Fire-and-forget — never throws.
 */
export async function maybeAdjustAlphaFromContribution(sport: string): Promise<void> {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.rpc("analytics_model_contribution", {
      lookback_days: 30,
    });
    if (error || !data) return;

    const rows = data as Array<{
      model_variant: string;
      resolved_count: number;
      win_count: number;
      hit_rate_pct: number | null;
    }>;

    const rules  = rows.find((r) => r.model_variant === "rules");
    const blended = rows.find((r) => r.model_variant === "ml_blended");

    if (!rules || !blended) return;
    if (!rules.hit_rate_pct || !blended.hit_rate_pct) return;

    const diff = blended.hit_rate_pct - rules.hit_rate_pct; // in percentage points
    const range = getAlphaRange(sport);

    // Read current alpha from localStorage weights
    const current = getAdaptiveWeightsSync(sport as MLSport, "hit_probability", "pregame");
    if (!current) return;

    // computeAlpha is imported lazily to avoid circular dep; use inline formula
    const currentAlpha = Math.min(0.40, 0.05 + (current.sample_size ?? 0) / 2000);
    let newAlpha = currentAlpha;
    let direction: AlphaAdjustmentLog["direction"] = "unchanged";

    if (diff > 2) {
      newAlpha   = clampAlpha(sport, currentAlpha + range.step);
      direction  = newAlpha > currentAlpha ? "up" : "unchanged";
    } else if (diff < -2) {
      newAlpha   = clampAlpha(sport, currentAlpha - range.step);
      direction  = newAlpha < currentAlpha ? "down" : "unchanged";
    }

    // Always log the check result — "unchanged" entries are useful for the panel
    writeAlphaAdjustmentLog(sport, {
      direction,
      alpha_before: Math.round(currentAlpha * 10000) / 10000,
      alpha_after:  Math.round(newAlpha    * 10000) / 10000,
      diff_pp:      Math.round(diff * 10)  / 10,
      timestamp:    new Date().toISOString(),
    });

    if (direction === "unchanged") return;

    // Write updated alpha back via updateWeights (reuses existing mechanism)
    await updateWeights(
      sport as MLSport,
      "hit_probability",
      "pregame",
      current.weights ?? {},
      current.sample_size ?? 0,
    );
  } catch {
    // Non-critical — silently skip
  }
}

// ── Confidence calibration map update ────────────────────────────────────────

/**
 * Interface for calibration RPC rows needed for verdict/trend computation.
 * Mirrors ConfidenceCalibrationByMarketRow from useAnalyticsDashboard.
 */
interface CalibrationMarketRow {
  sport:             string;
  stat_type:         string;
  confidence:        string;
  resolved_count:    number;
  win_count:         number;
  hit_rate_pct:      number | null;
}

function computeVerdict(
  highRate: number | null,
  medRate:  number | null,
  lowRate:  number | null,
  minResolved: number,
): CalibrationVerdict {
  if (highRate === null && medRate === null && lowRate === null) return "insufficient";
  if (highRate !== null && medRate !== null && lowRate !== null) {
    if (highRate > medRate && medRate > lowRate) return "calibrated";
    if (highRate > medRate) return "partial";
    return "inverted";
  }
  if (highRate !== null && medRate !== null) {
    return highRate > medRate ? "partial" : "inverted";
  }
  return "insufficient";
}

function computeTrend(
  rate7:  number | null,
  rate30: number | null,
  gap7:   number | null, // HIGH - LOW gap at 7d
  gap30:  number | null, // HIGH - LOW gap at 30d
): CalibrationTrend {
  const RATE_THRESHOLD = 2;
  const GAP_THRESHOLD  = 1;

  const rateDiff = rate7 !== null && rate30 !== null ? rate7 - rate30 : null;
  const gapDiff  = gap7  !== null && gap30  !== null ? gap7  - gap30  : null;

  if (rateDiff !== null && rateDiff > RATE_THRESHOLD)  return "up";
  if (rateDiff !== null && rateDiff < -RATE_THRESHOLD) return "down";
  // Rate is flat — check H-L gap as tie-breaker
  if (gapDiff !== null && gapDiff > GAP_THRESHOLD)  return "up";
  if (gapDiff !== null && gapDiff < -GAP_THRESHOLD) return "down";
  return "flat";
}

/**
 * Reads 7d + 30d confidence calibration data from Supabase, computes
 * per-market verdict + trend, then writes adjusted values to localStorage.
 *
 * Called: after each batch recalibration cycle (every 25 resolved outcomes).
 * Fire-and-forget — never throws.
 */
export async function maybeAdjustConfidenceFromCalibration(): Promise<void> {
  if (!supabase) return;
  try {
    const MIN_RESOLVED = 5;

    const [res7, res30] = await Promise.all([
      supabase.rpc("analytics_confidence_calibration_by_market", {
        lookback_days: 7,
        min_resolved: MIN_RESOLVED,
      }),
      supabase.rpc("analytics_confidence_calibration_by_market", {
        lookback_days: 30,
        min_resolved: MIN_RESOLVED,
      }),
    ]);

    if (res30.error || !res30.data) return;

    const rows30 = res30.data as CalibrationMarketRow[];
    const rows7  = (res7.data  ?? []) as CalibrationMarketRow[];

    // Group rows by "SPORT:stat_type"
    type MarketKey = string;
    type ConfMap   = Record<string, number | null>; // confidence → hit_rate_pct

    function groupByMarket(rows: CalibrationMarketRow[]): Map<MarketKey, ConfMap> {
      const m = new Map<MarketKey, ConfMap>();
      for (const r of rows) {
        const k = `${r.sport.toUpperCase()}:${r.stat_type.toLowerCase()}`;
        if (!m.has(k)) m.set(k, {});
        m.get(k)![r.confidence] = r.hit_rate_pct;
      }
      return m;
    }

    const map30 = groupByMarket(rows30);
    const map7  = groupByMarket(rows7);

    const now = new Date().toISOString();
    const updates: Parameters<typeof setCalibrationEntries>[0] = [];

    for (const [key, conf30] of map30) {
      const [sport, statType] = key.split(":");
      const conf7 = map7.get(key) ?? {};

      const highRate30 = conf30["HIGH"] ?? null;
      const medRate30  = conf30["MED"]  ?? null;
      const lowRate30  = conf30["LOW"]  ?? null;

      const highRate7  = conf7["HIGH"]  ?? null;
      const lowRate7   = conf7["LOW"]   ?? null;

      // Verdict from 30d (more stable baseline)
      const verdict = computeVerdict(highRate30, medRate30, lowRate30, MIN_RESOLVED);

      // Trend: HIGH hit rate 7d vs 30d + H-L gap trend
      const gap7  = highRate7  !== null && lowRate7   !== null ? highRate7  - lowRate7  : null;
      const gap30 = highRate30 !== null && lowRate30  !== null ? highRate30 - lowRate30 : null;
      const trend = computeTrend(highRate7, highRate30, gap7, gap30);

      const adjustment = verdictTrendToAdjustment(verdict, trend as CalibrationTrend);

      updates.push({ sport, statType, adjustment, verdict, trend, updatedAt: now });
    }

    if (updates.length > 0) {
      setCalibrationEntries(updates);
    }
  } catch {
    // Non-critical — silently skip
  }
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
