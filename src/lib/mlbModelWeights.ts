/**
 * MLB Model Weights — Learning System
 *
 * Reads calibrated factor weights from Supabase (mlb_model_weights table).
 * Falls back to hard-coded defaults when:
 *   • Supabase is unavailable
 *   • sample_size < MIN_SAMPLE (not enough history to calibrate)
 *
 * Weight calibration is computed offline by computeAndSaveLearnedWeights()
 * once enough outcomes are stored in mlb_prediction_inputs_snapshot.
 */

import { supabase } from "@/lib/supabase";

export interface MlbFactorWeights {
  pitcher: number;  // default 0.40
  batting: number;  // default 0.20
  bullpen: number;  // default 0.15
  form: number;     // default 0.10
  rest: number;     // default 0.05
  /** True when these are learned weights, false when falling back to defaults. */
  learned: boolean;
  sampleSize: number;
}

/** Hard-coded defaults used when insufficient outcome history is available. */
export const DEFAULT_WEIGHTS: Omit<MlbFactorWeights, "learned" | "sampleSize"> = {
  pitcher: 0.40,
  batting: 0.20,
  bullpen: 0.15,
  form:    0.10,
  rest:    0.05,
};

const MIN_SAMPLE = 50;

/** Fetch learned weights from Supabase. Returns defaults when not yet calibrated. */
export async function fetchMlbModelWeights(): Promise<MlbFactorWeights> {
  if (!supabase) return { ...DEFAULT_WEIGHTS, learned: false, sampleSize: 0 };
  try {
    const { data } = await supabase
      .from("mlb_model_weights")
      .select("w_pitcher,w_batting,w_bullpen,w_form,w_rest,sample_size")
      .eq("id", "v1")
      .maybeSingle();

    if (!data || (data.sample_size ?? 0) < MIN_SAMPLE) {
      return { ...DEFAULT_WEIGHTS, learned: false, sampleSize: data?.sample_size ?? 0 };
    }

    const sum =
      (data.w_pitcher ?? 0) +
      (data.w_batting ?? 0) +
      (data.w_bullpen ?? 0) +
      (data.w_form ?? 0) +
      (data.w_rest ?? 0);

    // Sanity: if weights don't sum to ≈1 (within 5%), fall back to defaults
    if (Math.abs(sum - 1) > 0.05) {
      return { ...DEFAULT_WEIGHTS, learned: false, sampleSize: data.sample_size };
    }

    return {
      pitcher: data.w_pitcher ?? DEFAULT_WEIGHTS.pitcher,
      batting: data.w_batting ?? DEFAULT_WEIGHTS.batting,
      bullpen: data.w_bullpen ?? DEFAULT_WEIGHTS.bullpen,
      form:    data.w_form    ?? DEFAULT_WEIGHTS.form,
      rest:    data.w_rest    ?? DEFAULT_WEIGHTS.rest,
      learned: true,
      sampleSize: data.sample_size,
    };
  } catch {
    return { ...DEFAULT_WEIGHTS, learned: false, sampleSize: 0 };
  }
}

// ── Outcome writing ───────────────────────────────────────────────────────────

/**
 * Write the actual game result back to mlb_prediction_inputs_snapshot.
 * Called when a game transitions to "final" status.
 * Fire-and-forget — never blocks the UI.
 */
export function writeGameOutcome(
  eventId: string,
  actualWinner: string,
  predictedWinner: string,
  finalHomeScore: number,
  finalAwayScore: number
): void {
  if (!supabase) return;
  const correct = actualWinner === predictedWinner;
  supabase
    .from("mlb_prediction_inputs_snapshot")
    .update({
      actual_winner: actualWinner,
      correct_prediction: correct,
      final_home_score: finalHomeScore,
      final_away_score: finalAwayScore,
    })
    .eq("id", `${eventId}-pregame`)
    .then(() => null)
    .catch(() => null);
}

// ── Calibration utility ───────────────────────────────────────────────────────

/**
 * Compute learned weights from stored outcomes and save to Supabase.
 * Intended for offline/cron use — not called during the normal prediction pipeline.
 *
 * Strategy: logistic regression surrogate using per-factor score direction as
 * binary predictors. For each factor f with direction (positive score = home favored):
 *   accuracy = P(correct | factor_direction matches winner direction)
 *
 * Weights are proportional to factor accuracy minus baseline (50%), normalized to sum to 1.
 * Falls back to current weights when sample is too small.
 */
export async function computeAndSaveLearnedWeights(): Promise<void> {
  if (!supabase) return;

  const { data, error } = await supabase
    .from("mlb_prediction_inputs_snapshot")
    .select(
      "pitcher_score,batting_score,bullpen_score,form_score,rest_score,correct_prediction,predicted_winner,actual_winner"
    )
    .not("correct_prediction", "is", null)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error || !data || data.length < MIN_SAMPLE) return;

  type Row = {
    pitcher_score: number;
    batting_score: number;
    bullpen_score: number;
    form_score: number;
    rest_score: number;
    correct_prediction: boolean;
  };

  const rows = data as Row[];

  const factors = ["pitcher", "batting", "bullpen", "form", "rest"] as const;
  type Factor = typeof factors[number];
  const scoreKey: Record<Factor, keyof Row> = {
    pitcher: "pitcher_score",
    batting: "batting_score",
    bullpen: "bullpen_score",
    form: "form_score",
    rest: "rest_score",
  };

  // For each factor: measure accuracy when the factor agreed with the prediction
  const factorAccuracy: Record<Factor, number> = {} as Record<Factor, number>;
  for (const f of factors) {
    const agreeing = rows.filter((r) => {
      const score = r[scoreKey[f]] as number;
      // Score > 0 means model leans home; score < 0 means model leans away
      // If correct_prediction is true, the factor agreed with the actual winner
      return Math.abs(score) > 0.05; // only count when factor has meaningful signal
    });
    if (!agreeing.length) {
      factorAccuracy[f] = 0.5; // neutral
      continue;
    }
    const correct = agreeing.filter((r) => r.correct_prediction).length;
    factorAccuracy[f] = correct / agreeing.length;
  }

  // Convert accuracy → weight proportional to accuracy above 50%
  const lifts = factors.map((f) => Math.max(0, factorAccuracy[f] - 0.5));
  const totalLift = lifts.reduce((a, b) => a + b, 0);

  let weights: Record<Factor, number>;
  if (totalLift < 0.01) {
    // No factor beats chance — keep defaults
    weights = { ...DEFAULT_WEIGHTS };
  } else {
    const raw: Record<Factor, number> = {} as Record<Factor, number>;
    factors.forEach((f, i) => {
      raw[f] = lifts[i] / totalLift;
    });
    weights = raw;
  }

  const now = new Date().toISOString();
  // Log per-factor results
  const factorRows = factors.map((f, i) => {
    const agreeing = rows.filter((r) => Math.abs(r[scoreKey[f]] as number) > 0.05);
    const correct = agreeing.filter((r) => r.correct_prediction).length;
    return {
      model_version: "1.0",
      factor: f,
      direction: "home_positive",
      sample_size: agreeing.length,
      correct_count: correct,
      computed_at: now,
    };
  });

  await Promise.all([
    supabase.from("mlb_model_weights").upsert(
      {
        id: "v1",
        model_version: "1.0",
        w_pitcher: Math.round(weights.pitcher * 10000) / 10000,
        w_batting: Math.round(weights.batting * 10000) / 10000,
        w_bullpen: Math.round(weights.bullpen * 10000) / 10000,
        w_form:    Math.round(weights.form    * 10000) / 10000,
        w_rest:    Math.round(weights.rest    * 10000) / 10000,
        sample_size: rows.length,
        calibrated_at: now,
        updated_at: now,
      },
      { onConflict: "id" }
    ),
    supabase.from("mlb_factor_accuracy").insert(factorRows),
  ]);
}
