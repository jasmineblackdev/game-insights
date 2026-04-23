/**
 * Platt scaling calibration for hit probability outputs.
 *
 * Platt scaling corrects systematic over/under-confidence from the logistic model:
 *   P_cal = 1 / (1 + exp(A * logit(p_raw) + B))
 *
 * A=1, B=0 → identity (no correction, used before calibration data exists).
 * A < 1 → model was overconfident (probabilities too extreme).
 * A > 1 → model was underconfident (probabilities too close to 0.5).
 * B ≠ 0 → model had systematic bias in one direction.
 *
 * Parameters are estimated by minimizing log-loss on resolved predictions
 * from the `prediction_history` Supabase table. We require at least 100
 * resolved predictions before applying calibration (otherwise defaults).
 *
 * Storage: `model_learning_metrics` table in Supabase
 * localStorage key: `gamelens-ml-platt-v2:{sport}:{model}`
 */

import type { PlattParams, MLSport } from "@/lib/ml/types";

const PLATT_LS_PREFIX = "gamelens-ml-platt-v2";
const MIN_CALIBRATION_SAMPLES = 100;

/**
 * localStorage key for Platt params — includes confidence bucket so the
 * nightly-fitted per-bucket params are retrievable. Legacy keys without a
 * bucket (ALL fallback) continue to work.
 */
function plattKey(sport: MLSport, model: string, bucket: string = "ALL"): string {
  return bucket === "ALL"
    ? `${PLATT_LS_PREFIX}:${sport}:${model}`
    : `${PLATT_LS_PREFIX}:${sport}:${model}:${bucket}`;
}

/** Default (identity) Platt params — no calibration applied. */
export function defaultPlattParams(sport: MLSport, model: string): PlattParams {
  return {
    sport,
    model,
    A: 1.0,
    B: 0.0,
    sample_size: 0,
    calibrated_at: null,
  };
}

/**
 * Load cached Platt params from localStorage, preferring the per-(sport,
 * model, confidence_bucket) params when available and falling back to the
 * sport×model "ALL" bucket, then to identity defaults.
 */
export function loadPlattParams(
  sport: MLSport,
  model: string,
  confidenceBucket?: string,
): PlattParams {
  const pick = (bucket: string | undefined): PlattParams | null => {
    try {
      const raw = localStorage.getItem(plattKey(sport, model, bucket ?? "ALL"));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PlattParams;
      if (parsed.sample_size < MIN_CALIBRATION_SAMPLES) return null;
      return parsed;
    } catch {
      return null;
    }
  };
  if (confidenceBucket && confidenceBucket !== "ALL") {
    const bucketed = pick(confidenceBucket.toUpperCase());
    if (bucketed) return bucketed;
  }
  const allBucket = pick("ALL");
  if (allBucket) return allBucket;
  return defaultPlattParams(sport, model);
}

/** Persist updated Platt params to localStorage. */
export function savePlattParams(params: PlattParams, confidenceBucket?: string): void {
  try {
    localStorage.setItem(
      plattKey(params.sport, params.model, confidenceBucket ?? "ALL"),
      JSON.stringify(params),
    );
  } catch {
    // localStorage may be unavailable in SSR
  }
}

/**
 * Apply Platt scaling to a raw probability.
 * Safe to call with default (A=1, B=0) params — returns p_raw unchanged.
 *
 * @param pRaw   Raw model probability (0–1)
 * @param params Platt parameters (use loadPlattParams if unsure)
 * @returns Calibrated probability (0–1)
 */
export function applyPlattScaling(pRaw: number, params: PlattParams): number {
  if (params.A === 1.0 && params.B === 0.0) return pRaw; // Identity shortcut

  const clamped = Math.max(0.001, Math.min(0.999, pRaw));
  const logit = Math.log(clamped / (1 - clamped));
  const scaledLogit = params.A * logit + params.B;
  return 1 / (1 + Math.exp(-scaledLogit));
}

/**
 * Estimate Platt parameters from a set of resolved predictions.
 *
 * Uses simple gradient descent to minimize log-loss.
 * Called by feedbackLoop.ts after each batch of resolved outcomes.
 *
 * @param predictions Array of { p_raw, outcome } — outcome is 1 (win) or 0 (loss)
 * @param iterations  Number of gradient descent steps (default 200)
 * @param lr          Learning rate (default 0.1)
 */
export function estimatePlattParams(
  predictions: Array<{ p_raw: number; outcome: 0 | 1 }>,
  iterations = 200,
  lr = 0.1,
): { A: number; B: number } {
  if (predictions.length < MIN_CALIBRATION_SAMPLES) {
    return { A: 1.0, B: 0.0 }; // Not enough data
  }

  let A = 1.0;
  let B = 0.0;

  for (let iter = 0; iter < iterations; iter++) {
    let dA = 0;
    let dB = 0;

    for (const { p_raw, outcome } of predictions) {
      const clamped = Math.max(0.001, Math.min(0.999, p_raw));
      const logit = Math.log(clamped / (1 - clamped));
      const p_cal = 1 / (1 + Math.exp(-(A * logit + B)));
      const error = p_cal - outcome;
      dA += error * logit;
      dB += error;
    }

    A -= (lr / predictions.length) * dA;
    B -= (lr / predictions.length) * dB;
  }

  // Sanity bounds: A should be in [0.3, 3.0], B in [-2, 2]
  return {
    A: Math.max(0.3, Math.min(3.0, A)),
    B: Math.max(-2.0, Math.min(2.0, B)),
  };
}

// ── Server → client sync ─────────────────────────────────────────────────────
// The nightly ml-recalibrate edge function writes per (sport, market_type,
// confidence_bucket) rows to Supabase.platt_calibration_params. The browser
// reads from localStorage via loadPlattParams. Without a sync path the
// server fits are never applied client-side.

import { supabase } from "@/lib/supabase";

let syncRanThisSession = false;

/**
 * Pull the latest platt_calibration_params rows and mirror them into
 * localStorage under the per-bucket keys loadPlattParams() reads.
 *
 * Safe to call multiple times — no-ops after first run per session.
 * Fire-and-forget: any failure leaves existing localStorage untouched
 * and calibration falls back to identity.
 */
export async function syncPlattParamsFromSupabase(): Promise<void> {
  if (!supabase || syncRanThisSession) return;
  syncRanThisSession = true;
  try {
    const { data, error } = await supabase
      .from("platt_calibration_params")
      .select("sport, market_type, confidence_bucket, a_param, b_param, sample_size, fitted_at");
    if (error || !data) return;
    for (const row of data) {
      const sport = String(row.sport).toLowerCase() as MLSport;
      const market = String(row.market_type).toLowerCase();
      const bucket = String(row.confidence_bucket).toUpperCase();
      const params: PlattParams = {
        sport,
        model: market,
        A: Number(row.a_param),
        B: Number(row.b_param),
        sample_size: Number(row.sample_size),
        calibrated_at: row.fitted_at ? new Date(row.fitted_at).toISOString() : null,
      };
      savePlattParams(params, bucket);
    }
  } catch {
    // silent — fall back to whatever localStorage already has
  }
}
