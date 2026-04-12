/**
 * Core ML layer types for GameLens.
 *
 * Architecture contract:
 *  - ML enhances the rules engine; never replaces it.
 *  - Alpha-blend factor starts at 0.05 and grows as evidence accumulates.
 *  - Sport models are kept strictly separate — no cross-sport weight pollution.
 *  - Pregame and live models are separate contexts.
 *
 * Key boundaries:
 *  - `FeatureVector` is the ML-layer's input representation.
 *  - `MLModelOutput` is what each model produces before blending.
 *  - `BlendedOutput` is what the rules engine receives as an adjustment layer.
 *  - `FeedbackRecord` is what gets written to Supabase after an outcome resolves.
 */

import type { League } from "@/data/mockGames";

// Re-export for convenience — ML layer uses League as MLSport
export type MLSport = League;
export type MLContext = "pregame" | "live";

// ── Feature vectors ───────────────────────────────────────────────────────────

/** Generic feature vector — all values normalized to reasonable numeric ranges. */
export interface BaseFeatureVector {
  sport: MLSport;
  context: MLContext;
  /** ISO date string — used to partition features for decay. */
  capturedAt: string;
}

/** Feature vector for player prop predictions. */
export interface PropFeatureVector extends BaseFeatureVector {
  type: "prop";
  // Performance history
  avg_last5: number;        // Rolling average over last 5 games
  avg_last10: number;       // Rolling average over last 10 games
  season_avg: number;       // Full season average
  // Matchup
  opponent_rank: number;    // Opponent defensive rank for this stat (1=hardest, 30=easiest)
  // Role / opportunity
  usage_rate: number;       // 0–1 usage share
  minutes_projection: number; // Expected minutes
  // Environment
  pace_factor: number;      // Team pace relative to league average (1.0 = avg)
  // Market signal
  line_movement: number;    // Delta from opening line (positive = line moved up)
  line_value: number;       // The actual over/under line
  market_probability: number; // Implied probability from current odds (0–1)
  // Meta
  data_quality: number;     // 0–1 — how much of the above we actually have
  has_injury_flag: boolean;
  // Sport-specific extras (nullable, filled by sport extractors)
  extra: Record<string, number>;
}

/** Feature vector for game-level (team) predictions. */
export interface GameFeatureVector extends BaseFeatureVector {
  type: "game";
  home_win_prob_rules: number;  // From rules engine (0–1)
  home_spread_lean: number;     // Positive = home covers
  market_home_prob: number;     // Market-implied (0–1)
  line_movement_home: number;   // Positive = public / sharp money on home
  volatility_score: number;     // 0–1
  data_quality: number;
  extra: Record<string, number>;
}

export type FeatureVector = PropFeatureVector | GameFeatureVector;

// ── Model outputs ─────────────────────────────────────────────────────────────

/** Output from the prop projection model (regression). */
export interface PropProjectionOutput {
  projected_value: number;     // Predicted stat value
  projection_ci_low: number;   // 80% confidence interval lower bound
  projection_ci_high: number;  // 80% confidence interval upper bound
  source: "ml" | "rules";      // Whether ML or rules engine drove this
}

/** Output from the hit probability model (classification). */
export interface HitProbabilityOutput {
  probability: number;         // P(bet wins) — clamped to [0.05, 0.95]
  edge: number;                // probability - market_probability (pp)
  source: "ml" | "rules";
}

/** Output from the confidence model. */
export interface ConfidenceOutput {
  confidence: "HIGH" | "MED" | "LOW";
  stability_score: number;     // 0–1 raw stability score
  volatility_flag: boolean;    // True if stat variance is high
  source: "ml" | "rules";
}

/** Output from the timing model. */
export interface TimingOutput {
  best_context: MLContext;
  pregame_multiplier: number;  // Signal strength pregame (1.0 = baseline)
  live_checkpoint: string | null; // e.g. "after Q1", "after 5th inning"
  urgency: "now" | "wait" | "monitor";
}

/** Output from the parlay leg scorer. */
export interface LegScoreOutput {
  leg_score: number;           // 0–100 composite score
  edge_component: number;
  confidence_component: number;
  volatility_component: number;
  data_quality_component: number;
  market_stability_component: number;
}

/** Output from the parlay combo optimizer. */
export interface ParlayScoreOutput {
  parlay_score: number;        // 0–100 composite score
  recommended_legs: number;    // Suggested leg count
  sport_diversity_bonus: number;
  correlation_penalty: number;
  volatility_penalty: number;
}

// ── Blended output ────────────────────────────────────────────────────────────

/**
 * The final blended output combining rules engine + ML adjustments.
 * Alpha grows with evidence: α = min(0.40, 0.05 + sampleSize / 2000)
 *
 * IMPORTANT: blending is applied AFTER the rules engine fully scores the
 * prediction (including learningSignalAdjustments). Never applied inside
 * the signal weight computation.
 */
export interface BlendedPropOutput {
  projected_value: number;
  hit_probability: number;
  confidence: "HIGH" | "MED" | "LOW";
  edge: number;
  timing: TimingOutput;
  alpha: number;               // The blend factor used (0.05 to 0.40)
  ml_sample_size: number;      // How many outcomes the ML has seen for this sport
  ml_active: boolean;          // Whether ML is contributing (sampleSize >= 25)
}

// ── Feedback / learning loop ──────────────────────────────────────────────────

/**
 * Written to Supabase `prediction_history` after a pick outcome resolves.
 * Keyed by `(prop_id, sport, stat_type, resolved_at)` — not by user session.
 */
export interface FeedbackRecord {
  prediction_id: string;       // From picks_log.prop_id
  sport: MLSport;
  stat_type: string;
  market_type: "prop" | "game_winner" | "spread" | "total";
  context: MLContext;
  line_value: number;
  projected_value: number;
  direction: "MORE" | "LESS";
  confidence: "HIGH" | "MED" | "LOW";
  edge_at_prediction: number;
  hit_probability_at_prediction: number;
  alpha_at_prediction: number;
  // Outcome
  actual_value: number | null;
  outcome: "win" | "loss" | "push" | null;
  // Feature snapshot (serialized)
  feature_snapshot: Record<string, number>;
  // Timestamps
  predicted_at: string;
  resolved_at: string | null;
}

// ── Weight storage ────────────────────────────────────────────────────────────

/**
 * Generic adaptive weights for any sport+model combination.
 * The weights map feature names → importance (0–1, sum ≈ 1).
 * Stored in Supabase `model_weights` table.
 * localStorage key: `gamelens-ml-weights-v2:{sport}:{model}:{context}`
 */
export interface AdaptiveWeights {
  sport: MLSport;
  model: string;              // e.g. "prop_projection", "hit_probability"
  context: MLContext;
  weights: Record<string, number>;
  learned: boolean;           // False = using defaults, True = calibrated from data
  sample_size: number;
  calibrated_at: string | null;
  version: string;            // Schema version, e.g. "1.0"
}

// ── Platt scaling calibration ─────────────────────────────────────────────────

/** Platt scaling parameters per sport+model. Stored in model_learning_metrics. */
export interface PlattParams {
  sport: MLSport;
  model: string;
  A: number;    // Platt parameter A (default 1.0 — identity)
  B: number;    // Platt parameter B (default 0.0 — no shift)
  sample_size: number;
  calibrated_at: string | null;
}
