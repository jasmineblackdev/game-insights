/**
 * Hit probability model — logistic classifier.
 *
 * Converts prop features into P(bet wins) — the probability the stat
 * exceeds the line (for Over) or stays under (for Under).
 *
 * Uses a logit-then-sigmoid pipeline:
 *   1. Compute a log-odds score from features
 *   2. Apply sigmoid to convert to probability in (0, 1)
 *   3. Clamp to [0.05, 0.95] — never fully confident
 *
 * The output is calibrated relative to the market probability:
 *   edge = P(model) - P(market)
 *
 * Platt scaling (A, B parameters) can be applied post-hoc once enough
 * samples accumulate; defaults to identity (A=1, B=0).
 */

import type { PropFeatureVector } from "@/lib/ml/types";
import type { HitProbabilityOutput } from "@/lib/ml/types";
import type { PlattParams } from "@/lib/ml/types";

/** Default Platt scaling parameters (identity — no correction). */
const DEFAULT_PLATT: PlattParams = {
  sport: "nba",  // Placeholder; actual sport passed as arg
  model: "hit_probability",
  A: 1.0,
  B: 0.0,
  sample_size: 0,
  calibrated_at: null,
};

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Apply Platt scaling to a raw probability.
 * P_cal = 1 / (1 + exp(A * logit(p_raw) + B))
 */
function plattScale(pRaw: number, platt: PlattParams): number {
  // Convert to logit
  const clamped = Math.max(0.001, Math.min(0.999, pRaw));
  const logit = Math.log(clamped / (1 - clamped));
  const scaledLogit = platt.A * logit + platt.B;
  return sigmoid(scaledLogit);
}

/**
 * Compute the raw log-odds score from feature vector.
 *
 * Positive log-odds → P > 0.5 → favors Over.
 * Features are weighted and combined before applying sigmoid.
 */
function computeLogOdds(fv: PropFeatureVector): number {
  // Base signal: how does projected stat compare to the line?
  // Use season_avg + recent_form as proxy for projection
  const recentAvg = fv.avg_last5 * 0.65 + fv.avg_last10 * 0.35;
  const avgVsLine = fv.line_value > 0 ? (recentAvg - fv.line_value) / fv.line_value : 0;

  // Season avg vs line
  const seasonVsLine = fv.line_value > 0 ? (fv.season_avg - fv.line_value) / fv.line_value : 0;

  // Market probability as a log-odds baseline (market is informative)
  const marketLogit = fv.market_probability > 0 && fv.market_probability < 1
    ? Math.log(fv.market_probability / (1 - fv.market_probability))
    : 0;

  // Matchup signal: rank 30 (weakest defense) → positive contribution
  const maxRank = 32;
  const matchupSignal = (fv.opponent_rank - (maxRank / 2)) / maxRank;

  // Usage/opportunity signal
  const usageSignal = fv.usage_rate - 0.5; // Centered

  // Pace environment
  const paceSignal = fv.pace_factor * 0.5;

  // Line movement signal: line moving up means harder to hit Over
  const lineMovementSignal = -fv.line_movement * 0.3;

  // Data quality weight: low quality → regress to market
  const q = fv.data_quality;

  // Combine with data-quality weighting
  // Low quality: rely more on market; high quality: rely more on model features
  const modelLogOdds = (
    avgVsLine    * 1.80 * q +
    seasonVsLine * 0.90 * q +
    matchupSignal * 0.60 * q +
    usageSignal  * 0.50 * q +
    paceSignal   * 0.30 * q +
    lineMovementSignal * q
  );

  // Blend model signal with market baseline
  return modelLogOdds * q + marketLogit * (1 - q * 0.5);
}

export function computeHitProbability(
  fv: PropFeatureVector,
  platt: PlattParams = DEFAULT_PLATT,
): HitProbabilityOutput {
  const logOdds = computeLogOdds(fv);
  const rawProbability = sigmoid(logOdds);

  // Apply Platt scaling if calibrated
  const calibratedProbability = platt.sample_size >= 50
    ? plattScale(rawProbability, platt)
    : rawProbability;

  // Clamp to [0.05, 0.95] — never express full certainty
  const probability = Math.max(0.05, Math.min(0.95, calibratedProbability));

  // Edge: model probability minus market implied probability (in percentage points)
  const edge = (probability - fv.market_probability) * 100;

  return {
    probability,
    edge,
    source: "ml",
  };
}
