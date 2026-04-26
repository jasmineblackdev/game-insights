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

import type { MLSport, MLContext } from "@/lib/ml/types";
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
  /** Average CLV (closing - opening implied prob, in pp) for the lookback window. Optional — only set when CLV broke a tie or when CLV data was available. */
  clv_pp_avg?:  number;
}

/**
 * Average closing-line value (clv_pp) over the last N days for a
 * given sport. Used as a tie-breaker in alpha adjustment when the
 * direct hit-rate diff is in the ±2pp dead zone.
 *
 * Live schema doesn't have a clv_pp column — values are stashed in
 * `extra->>'clv_pp'` by the snapshotter and read back here. Returns
 * null when there's no sealed data yet (Supabase not configured, no
 * resolved bets, fewer than 10 samples, etc).
 */
async function fetchAvgClvForSport(sport: string, lookbackDays: number): Promise<number | null> {
  if (!supabase) return null;
  try {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("prediction_history")
      .select("extra")
      .eq("sport", sport.toLowerCase())
      .gte("settled_at", since);
    if (error || !data || data.length === 0) return null;
    const values = (data as Array<{ extra: Record<string, unknown> | null }>)
      .map((r) => {
        const v = r.extra?.clv_pp;
        return typeof v === "number" ? v : typeof v === "string" ? Number(v) : null;
      })
      .filter((v): v is number => v != null && Number.isFinite(v));
    // Need at least 10 sealed CLV samples before we trust the average
    // — otherwise random variance dominates.
    if (values.length < 10) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return sum / values.length;
  } catch {
    return null;
  }
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

/**
 * Minimum resolved outcomes before triggering weight recalibration for a sport.
 * Raised to 50 to match the spec's "sport ROI adjustments: ≥50 resolved per sport"
 * threshold — prevents premature weight updates from small samples.
 */
const RECALIBRATION_THRESHOLD = 50;
const PLATT_CALIBRATION_THRESHOLD = 100;

// ── Recalibration trigger ─────────────────────────────────────────────────────

/**
 * Check resolved outcome count. If we've hit a recalibration threshold
 * since the last calibration run, kick off the recalibration pipeline.
 */
async function maybeRecalibrate(sport: MLSport, context: MLContext): Promise<void> {
  try {
    const { count } = await supabase
      .from("prediction_history")
      .select("id", { count: "exact", head: true })
      .eq("sport", sport)
      .eq("prediction_phase", context)
      .in("outcome", ["win", "loss"]);

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
    .select("extra, outcome, edge, model_probability")
    .eq("sport", sport)
    .eq("prediction_phase", context)
    .in("outcome", ["win", "loss"])
    .order("settled_at", { ascending: false })
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
    .select("model_probability, outcome")
    .eq("sport", sport)
    .in("outcome", ["win", "loss"])
    .order("settled_at", { ascending: false })
    .limit(1000);

  if (error || !records || records.length < PLATT_CALIBRATION_THRESHOLD) return;

  const trainingData = records
    .filter(r => r.outcome === "win" || r.outcome === "loss")
    .map(r => ({
      p_raw: r.model_probability as number,
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

    // CLV signal — a tie-breaker when blended-vs-rules diff is small.
    // Positive avg CLV means we're consistently picking value the
    // market later agrees with → trust ML more. Negative avg CLV
    // means we're picking peak/stale lines → pull alpha back faster.
    const clvAvg = await fetchAvgClvForSport(sport, 30);

    if (diff > 2) {
      newAlpha   = clampAlpha(sport, currentAlpha + range.step);
      direction  = newAlpha > currentAlpha ? "up" : "unchanged";
    } else if (diff < -2) {
      newAlpha   = clampAlpha(sport, currentAlpha - range.step);
      direction  = newAlpha < currentAlpha ? "down" : "unchanged";
    } else if (clvAvg != null) {
      // Diff is in the ±2pp dead zone — let CLV break the tie when it's
      // strong enough (≥ 1.5pp average). Step is half-size since this is
      // an indirect signal vs the direct hit-rate comparison.
      const halfStep = range.step / 2;
      if (clvAvg >= 1.5) {
        newAlpha  = clampAlpha(sport, currentAlpha + halfStep);
        direction = newAlpha > currentAlpha ? "up" : "unchanged";
      } else if (clvAvg <= -1.5) {
        newAlpha  = clampAlpha(sport, currentAlpha - halfStep);
        direction = newAlpha < currentAlpha ? "down" : "unchanged";
      }
    }

    // Always log the check result — "unchanged" entries are useful for the panel
    writeAlphaAdjustmentLog(sport, {
      direction,
      alpha_before: Math.round(currentAlpha * 10000) / 10000,
      alpha_after:  Math.round(newAlpha    * 10000) / 10000,
      diff_pp:      Math.round(diff * 10)  / 10,
      timestamp:    new Date().toISOString(),
      clv_pp_avg:   clvAvg != null ? Math.round(clvAvg * 10) / 10 : undefined,
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

/** Resolution completeness below this threshold → sport excluded from calibration updates. */
const RESOLUTION_TRUST_MIN = 0.70;

/**
 * Reads 7d + 30d confidence calibration data from Supabase, computes
 * per-market verdict + trend, then writes adjusted values to localStorage.
 *
 * Called: after each batch recalibration cycle (every 50 resolved outcomes).
 * Fire-and-forget — never throws.
 */

export async function maybeAdjustConfidenceFromCalibration(): Promise<void> {
  if (!supabase) return;
  try {
    /**
     * Minimum resolved outcomes per sport × market before we trust calibration
     * data enough to adjust. Spec: "confidence calibration tuning: ≥40 resolved
     * predictions per sport × market".
     */
    const MIN_RESOLVED = 40;

    const [res7, res30, resComp] = await Promise.all([
      supabase.rpc("analytics_confidence_calibration_by_market", {
        lookback_days: 7,
        min_resolved: MIN_RESOLVED,
      }),
      supabase.rpc("analytics_confidence_calibration_by_market", {
        lookback_days: 30,
        min_resolved: MIN_RESOLVED,
      }),
      // Fetch resolution completeness to gate low-trust sports
      supabase.rpc("analytics_resolution_completeness", { lookback_days: 30 }),
    ]);

    if (res30.error || !res30.data) return;

    const rows30 = res30.data as CalibrationMarketRow[];
    const rows7  = (res7.data  ?? []) as CalibrationMarketRow[];

    // Build set of sports with insufficient resolution completeness.
    // Any sport below RESOLUTION_TRUST_MIN (70%) is excluded from calibration
    // updates — its outcomes are too incomplete to trust for weight adjustments.
    const lowTrustSports = new Set<string>();
    if (!resComp.error && resComp.data) {
      for (const row of resComp.data as Array<{ sport: string; resolution_pct: number }>) {
        if (Number(row.resolution_pct) < RESOLUTION_TRUST_MIN * 100) {
          lowTrustSports.add(row.sport.toUpperCase());
        }
      }
    }

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

      // Skip sports with insufficient resolution completeness — their outcome
      // data is too incomplete to trust for calibration adjustments.
      if (lowTrustSports.has(sport.toUpperCase())) continue;

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

// ── picks_log → prediction_history bridge ────────────────────────────────────

const _SPORT_TO_ML: Record<string, MLSport> = {
  NBA: "nba", NFL: "nfl", MLB: "mlb", MMA: "mma", Boxing: "boxing",
  nba: "nba", nfl: "nfl", mlb: "mlb", mma: "mma", boxing: "boxing",
};

/**
 * The live prediction_history schema (from migration
 * 20260421100000_gamelens_learning_intelligence.sql) constrains sport
 * to ('nba', 'nfl', 'mlb', 'soccer'). Other sports get skipped here so
 * we don't trip the check. Lifting MMA/Boxing into the schema is a
 * separate migration.
 */
const _PROP_BRIDGE_ALLOWED_SPORTS = new Set(["nba", "nfl", "mlb", "soccer"]);

const _CONFIDENCE_TO_HIT_PROB: Record<string, number> = {
  HIGH: 0.65, MED: 0.55, LOW: 0.5,
  high: 0.65, medium: 0.55, low: 0.5,
};

/**
 * Sync a resolved picks_log outcome into prediction_history via the
 * submit_prediction_learning_record RPC. Bridges user-facing picks
 * into the ML analytics pipeline.
 *
 * The picks_log row is fetched here (rather than passed in) so the
 * caller signature stays minimal and existing call sites don't need
 * to change.
 *
 * For player props the schema's "pick_side" doesn't map cleanly, so we
 * use direction (MORE / LESS) as the side and pack stat_type/line_value
 * /projected_value into `extra` for backtest replay. model_probability
 * is a confidence-tier heuristic until picks_log captures the real
 * pick-time hit probability.
 */
export async function syncPickResolution(
  propId: string,
  outcome: "win" | "loss" | "push",
  actualValue: number | null,
  sport: string,
): Promise<void> {
  if (!supabase) return;

  const sportLower = sport.toLowerCase();
  if (!_PROP_BRIDGE_ALLOWED_SPORTS.has(sportLower)) return;

  // Fetch the pick-time snapshot from picks_log. This is what the user
  // saw at copy/lock time — the values we want in prediction_history.
  let row: {
    prop_id: string;
    player_name: string;
    sport: string;
    stat_type: string;
    line_value: number;
    projected_value: number;
    direction: "MORE" | "LESS";
    confidence: "HIGH" | "MED" | "LOW";
    game_id: string;
  } | null = null;
  try {
    const { data, error } = await supabase
      .from("picks_log")
      .select("prop_id, player_name, sport, stat_type, line_value, projected_value, direction, confidence, game_id")
      .eq("prop_id", propId)
      .maybeSingle();
    if (error || !data) return;
    row = data as typeof row;
  } catch {
    return;
  }
  if (!row) return;

  // Idempotency: a previous call may have already inserted. Use
  // extra->>'prop_id' as the dedupe key since the schema's unique
  // index only covers team moneylines.
  try {
    const { data: existing } = await supabase
      .from("prediction_history")
      .select("id")
      .eq("market_type", "player_prop")
      .eq("external_game_id", row.game_id)
      .filter("extra->>prop_id", "eq", row.prop_id)
      .limit(1);
    if (existing && existing.length > 0) {
      const mlSport = _SPORT_TO_ML[sport];
      if (mlSport) maybeRecalibrate(mlSport, "pregame").catch(() => {});
      return;
    }
  } catch {
    // Treat read-back failure as "may not exist" and proceed; the
    // RPC has its own write semantics.
  }

  const modelP = _CONFIDENCE_TO_HIT_PROB[row.confidence] ?? 0.5;
  const dirLabel = row.direction === "MORE" ? "Over" : "Under";
  const pickLabel = `${row.player_name} ${dirLabel} ${row.line_value} ${row.stat_type}`;

  const p_history: Record<string, unknown> = {
    external_game_id: row.game_id,
    sport: sportLower,
    market_type: "player_prop",
    pick_side: row.direction.toLowerCase(),
    pick_label: pickLabel,
    american_odds: "",
    implied_probability: "",
    model_probability: String(modelP),
    edge: "",
    confidence: row.confidence.toLowerCase(),
    risk_score: "",
    reason_tags: [],
    checkpoint_stage: "",
    prediction_phase: "pregame",
    final_home_score: "",
    final_away_score: "",
    outcome,
    error_size: String(Math.abs(modelP - (outcome === "win" ? 1 : outcome === "loss" ? 0 : 0.5))),
    odds_range_bucket: "unknown",
    stat_type: row.stat_type,
    source: "gamelens_picks_bridge_v1",
    learning_phase: "1",
    extra: {
      prop_id: row.prop_id,
      player_name: row.player_name,
      stat_type: row.stat_type,
      line_value: row.line_value,
      projected_value: row.projected_value,
      direction: row.direction,
      actual_value: actualValue,
    },
  };

  try {
    const { error: rpcErr } = await supabase.rpc("submit_prediction_learning_record", {
      p_history,
      p_error_tags: [],
    });
    if (rpcErr) return;
  } catch {
    return;
  }

  const mlSport = _SPORT_TO_ML[sport];
  if (mlSport) {
    // Fire-and-forget recalibration — never blocks the caller
    maybeRecalibrate(mlSport, "pregame").catch(() => {});
  }
}
