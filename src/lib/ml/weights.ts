/**
 * Adaptive weight storage for the ML layer.
 *
 * Generalizes the mlbModelWeights.ts pattern to all sports and all models.
 *
 * Storage contract:
 *  - localStorage key: `gamelens-ml-weights-v2:{sport}:{model}:{context}`
 *    This is a DIFFERENT namespace from `gamelens-learn-v1` used by
 *    predictionLearningStorage.ts — they must never collide.
 *  - Supabase table: `model_weights` (keyed on sport, model, context, version)
 *  - On first load: seeds sample_size from existing accuracy summary if available
 *    so early ML can inherit the rules engine's accumulated signal count.
 *
 * MIN_SAMPLE gates:
 *  - < 25 samples: use defaults, ML contributes nothing (alpha = 0.05 minimum)
 *  - >= 25 samples: weights start contributing; calibration improves
 *  - >= 50 samples: confidence calibration activates
 *  - >= 300 samples: prop models start diverging meaningfully from defaults
 */

import { supabase } from "@/lib/supabase";
import type { AdaptiveWeights, MLSport, MLContext } from "@/lib/ml/types";

// ── Constants ─────────────────────────────────────────────────────────────────

const LS_PREFIX = "gamelens-ml-weights-v2";
const MIN_SAMPLE_FOR_ML = 25;
const SCHEMA_VERSION = "1.0";

// ── Default weight sets (heuristic starting points per model type) ─────────────

export const DEFAULT_WEIGHTS: Record<string, Record<string, number>> = {
  prop_projection: {
    avg_last5: 0.35,
    season_avg: 0.25,
    matchup_rating: 0.15,
    team_pace: 0.10,
    line_movement_signal: 0.10,
    injury_usage_boost: 0.05,
  },
  hit_probability: {
    edge: 0.40,
    variance_penalty: 0.25,
    matchup_strength: 0.20,
    line_movement: 0.15,
  },
  confidence: {
    performance_variance: 0.30,
    role_consistency: 0.25,
    minutes_volatility: 0.25,
    injury_risk: 0.10,
    matchup_reliability: 0.10,
  },
  // Sport-specific prop feature weights (NBA)
  prop_nba_points: {
    minutes_projection: 0.30,
    usage_rate: 0.25,
    avg_last5: 0.20,
    matchup_defense: 0.15,
    pace: 0.10,
  },
  prop_nfl_passing: {
    qb_efficiency: 0.30,
    pressure_rate: 0.20,
    target_share: 0.20,
    avg_last5: 0.20,
    weather_factor: 0.10,
  },
  prop_mlb_strikeouts: {
    fip: 0.30,
    k_rate: 0.25,
    confirmed_starter: 0.20,
    avg_last5: 0.15,
    handedness_edge: 0.10,
  },
  prop_combat: {
    style_matchup: 0.30,
    recent_performance: 0.25,
    opponent_quality: 0.20,
    physical_edge: 0.15,
    inactivity_penalty: 0.10,
  },
  parlay_leg: {
    edge: 0.35,
    confidence: 0.20,
    low_volatility: 0.15,
    data_quality: 0.15,
    market_stability: 0.15,
  },
};

// ── localStorage helpers ──────────────────────────────────────────────────────

function lsKey(sport: MLSport, model: string, context: MLContext): string {
  return `${LS_PREFIX}:${sport}:${model}:${context}`;
}

function readFromLocalStorage(
  sport: MLSport,
  model: string,
  context: MLContext
): AdaptiveWeights | null {
  try {
    const raw = localStorage.getItem(lsKey(sport, model, context));
    if (!raw) return null;
    return JSON.parse(raw) as AdaptiveWeights;
  } catch {
    return null;
  }
}

function writeToLocalStorage(w: AdaptiveWeights): void {
  try {
    localStorage.setItem(lsKey(w.sport, w.model, w.context), JSON.stringify(w));
  } catch {
    // localStorage unavailable (SSR, private mode) — silently skip
  }
}

// ── Supabase read/write ───────────────────────────────────────────────────────

async function fetchFromSupabase(
  sport: MLSport,
  model: string,
  context: MLContext
): Promise<AdaptiveWeights | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from("model_weights")
      .select("weights,learned,sample_size,calibrated_at,version")
      .eq("sport", sport)
      .eq("model", model)
      .eq("context", context)
      .eq("version", SCHEMA_VERSION)
      .maybeSingle();

    if (!data) return null;
    const w = data as {
      weights: Record<string, number>;
      learned: boolean;
      sample_size: number;
      calibrated_at: string | null;
      version: string;
    };

    // Sanity: weights must sum to ≈1
    const sum = Object.values(w.weights).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.10) return null;

    return { sport, model, context, ...w };
  } catch {
    return null;
  }
}

export async function saveWeightsToSupabase(w: AdaptiveWeights): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("model_weights").upsert(
      {
        sport: w.sport,
        model: w.model,
        context: w.context,
        version: w.version,
        weights: w.weights,
        learned: w.learned,
        sample_size: w.sample_size,
        calibrated_at: w.calibrated_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "sport,model,context,version" }
    );
  } catch {
    // Non-critical — silently skip
  }
}

// ── Alpha blend factor ────────────────────────────────────────────────────────

/**
 * How much weight to give the ML layer vs the rules engine.
 * Grows gradually as evidence accumulates, capped at 40%.
 *
 *   alpha = min(0.40, 0.05 + sampleSize / 2000)
 *
 * At 0 samples:    alpha = 0.05  (5% ML, 95% rules)
 * At 50 samples:   alpha = 0.075
 * At 300 samples:  alpha = 0.20
 * At 700 samples:  alpha = 0.40  (max)
 */
export function computeAlpha(sampleSize: number): number {
  return Math.min(0.40, 0.05 + sampleSize / 2000);
}

export function mlIsActive(sampleSize: number): boolean {
  return sampleSize >= MIN_SAMPLE_FOR_ML;
}

// ── Primary API ───────────────────────────────────────────────────────────────

/**
 * Fetch weights for a given sport + model + context.
 * Priority: Supabase (freshest) → localStorage (cached) → hardcoded defaults.
 * Writes Supabase result to localStorage for offline use.
 */
export async function getAdaptiveWeights(
  sport: MLSport,
  model: string,
  context: MLContext = "pregame"
): Promise<AdaptiveWeights> {
  // Try Supabase first
  const fromDb = await fetchFromSupabase(sport, model, context);
  if (fromDb && fromDb.sample_size >= MIN_SAMPLE_FOR_ML) {
    writeToLocalStorage(fromDb);
    return fromDb;
  }

  // Fall back to localStorage
  const fromLs = readFromLocalStorage(sport, model, context);
  if (fromLs && fromLs.sample_size >= MIN_SAMPLE_FOR_ML) {
    return fromLs;
  }

  // Hardcoded defaults
  const defaults = DEFAULT_WEIGHTS[model] ?? DEFAULT_WEIGHTS.prop_projection;
  return {
    sport,
    model,
    context,
    weights: { ...defaults },
    learned: false,
    sample_size: fromDb?.sample_size ?? fromLs?.sample_size ?? 0,
    calibrated_at: null,
    version: SCHEMA_VERSION,
  };
}

/**
 * Synchronous weight fetch for hot paths (prediction pipeline).
 * Uses localStorage only — no Supabase network call.
 */
export function getAdaptiveWeightsSync(
  sport: MLSport,
  model: string,
  context: MLContext = "pregame"
): AdaptiveWeights {
  const fromLs = readFromLocalStorage(sport, model, context);
  if (fromLs) return fromLs;

  const defaults = DEFAULT_WEIGHTS[model] ?? DEFAULT_WEIGHTS.prop_projection;
  return {
    sport,
    model,
    context,
    weights: { ...defaults },
    learned: false,
    sample_size: 0,
    calibrated_at: null,
    version: SCHEMA_VERSION,
  };
}

/**
 * Update weights after outcome learning.
 * Normalizes weights to sum to 1 before saving.
 */
export async function updateWeights(
  sport: MLSport,
  model: string,
  context: MLContext,
  newWeights: Record<string, number>,
  sampleSize: number
): Promise<void> {
  // Normalize
  const total = Object.values(newWeights).reduce((a, b) => a + b, 0);
  const normalized: Record<string, number> = {};
  for (const [k, v] of Object.entries(newWeights)) {
    normalized[k] = total > 1e-6 ? v / total : 1 / Object.keys(newWeights).length;
  }

  const updated: AdaptiveWeights = {
    sport,
    model,
    context,
    weights: normalized,
    learned: sampleSize >= MIN_SAMPLE_FOR_ML,
    sample_size: sampleSize,
    calibrated_at: new Date().toISOString(),
    version: SCHEMA_VERSION,
  };

  writeToLocalStorage(updated);
  await saveWeightsToSupabase(updated);
}
