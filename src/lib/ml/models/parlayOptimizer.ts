/**
 * Parlay optimizer model.
 *
 * Implements the spec formulas:
 *
 * Leg score (0–100):
 *   leg_score = (edge*0.35) + (confidence*0.20) + (low_volatility*0.15)
 *             + (data_quality*0.15) + (market_stability*0.15)
 *
 * Parlay combo score (0–100):
 *   parlay_score = (sum_leg_scores*0.40) + (combined_edge*0.25)
 *               + (confidence_avg*0.15) + (sport_diversity_bonus*0.10)
 *               - (correlation_penalty*0.05) - (volatility_penalty*0.05)
 *
 * The parlay optimizer scores individual legs for inclusion, then
 * evaluates candidate combinations. Higher-score legs are surfaced first.
 */

import type { PropFeatureVector } from "@/lib/ml/types";
import type { LegScoreOutput, ParlayScoreOutput } from "@/lib/ml/types";

// ── Leg score helpers ─────────────────────────────────────────────────────────

/**
 * Edge component (0–1 → contributes up to 35 points).
 * Normalized from the edge signal in the feature vector.
 * Edge is the gap between model P(hit) and market probability.
 *
 * The edge passed here is already in percentage-point form (e.g. 8.5 = 8.5pp).
 */
function edgeComponent(edgePp: number): number {
  // 0pp edge → 0, 15+pp edge → 1.0 (fully realized)
  return Math.max(0, Math.min(1, edgePp / 15));
}

/**
 * Confidence component (0–1 → contributes up to 20 points).
 * HIGH=1, MED=0.55, LOW=0.20
 */
function confidenceComponent(confidence: "HIGH" | "MED" | "LOW"): number {
  const map: Record<"HIGH" | "MED" | "LOW", number> = {
    HIGH: 1.00,
    MED:  0.55,
    LOW:  0.20,
  };
  return map[confidence];
}

/**
 * Low volatility component (0–1 → contributes up to 15 points).
 * Derived from data quality and the spread in rolling averages.
 */
function lowVolatilityComponent(fv: PropFeatureVector): number {
  if (fv.season_avg === 0) return 0.3;
  const spread = Math.max(fv.avg_last5, fv.avg_last10, fv.season_avg)
    - Math.min(fv.avg_last5, fv.avg_last10, fv.season_avg);
  const cv = spread / fv.season_avg;
  // Low CV → high low-volatility score
  return Math.max(0, Math.min(1, 1 - cv * 1.5));
}

/**
 * Market stability component (0–1 → contributes up to 15 points).
 * Stable lines (low movement magnitude) = market is settled = predictable.
 */
function marketStabilityComponent(fv: PropFeatureVector): number {
  return Math.max(0, 1 - Math.abs(fv.line_movement));
}

// ── Public leg scorer ─────────────────────────────────────────────────────────

export interface LegScorerInput {
  fv: PropFeatureVector;
  edgePp: number;               // Edge in percentage points (from hitProbability model)
  confidence: "HIGH" | "MED" | "LOW";
}

export function computeLegScore(input: LegScorerInput): LegScoreOutput {
  const { fv, edgePp, confidence } = input;

  const edgeComp         = edgeComponent(edgePp);
  const confComp         = confidenceComponent(confidence);
  const lowVolComp       = lowVolatilityComponent(fv);
  const dataQualComp     = fv.data_quality;
  const marketStabComp   = marketStabilityComponent(fv);

  // Spec formula (components are 0–1; multiply by 100 for 0–100 score)
  const rawScore = (
    edgeComp       * 0.35 +
    confComp       * 0.20 +
    lowVolComp     * 0.15 +
    dataQualComp   * 0.15 +
    marketStabComp * 0.15
  ) * 100;

  return {
    leg_score:                   Math.round(rawScore * 10) / 10,
    edge_component:              edgeComp,
    confidence_component:        confComp,
    volatility_component:        lowVolComp,
    data_quality_component:      dataQualComp,
    market_stability_component:  marketStabComp,
  };
}

// ── Parlay combo scorer ───────────────────────────────────────────────────────

export interface ParlayScorerInput {
  legs: LegScorerInput[];
  legScores: LegScoreOutput[];
}

/**
 * Sport diversity bonus: more unique sports in the parlay = lower correlation.
 * 1 sport = 0, 2 = 0.5, 3+ = 1.0
 */
function sportDiversityBonus(legs: LegScorerInput[]): number {
  const uniqueSports = new Set(legs.map(l => l.fv.sport)).size;
  if (uniqueSports >= 3) return 1.0;
  if (uniqueSports === 2) return 0.5;
  return 0.0;
}

/**
 * Correlation penalty: same sport legs on the same game are correlated.
 * Each pair of same-sport legs adds 0.15 to the penalty (capped at 1.0).
 */
function correlationPenalty(legs: LegScorerInput[]): number {
  const sportCounts: Record<string, number> = {};
  for (const leg of legs) {
    sportCounts[leg.fv.sport] = (sportCounts[leg.fv.sport] ?? 0) + 1;
  }
  let penalty = 0;
  for (const count of Object.values(sportCounts)) {
    if (count > 1) {
      // Each additional same-sport leg adds penalty
      penalty += (count - 1) * 0.15;
    }
  }
  return Math.min(1.0, penalty);
}

/**
 * Volatility penalty: high-volatility legs drag down parlay confidence.
 * Average volatility (inverted low_vol) across legs.
 */
function volatilityPenalty(legScores: LegScoreOutput[]): number {
  if (legScores.length === 0) return 0;
  const avgLowVol = legScores.reduce((s, l) => s + l.volatility_component, 0) / legScores.length;
  // High avg-low-vol → low penalty; low avg-low-vol → high penalty
  return Math.max(0, 1 - avgLowVol);
}

/**
 * Combined edge: average edge across all legs (0–1).
 */
function combinedEdge(legs: LegScorerInput[]): number {
  if (legs.length === 0) return 0;
  const avgEdgePp = legs.reduce((s, l) => s + l.edgePp, 0) / legs.length;
  return Math.max(0, Math.min(1, avgEdgePp / 15));
}

/**
 * Recommended leg count based on average leg score.
 * Higher quality → can sustain more legs.
 */
function recommendedLegs(legScores: LegScoreOutput[]): number {
  if (legScores.length === 0) return 2;
  const avgScore = legScores.reduce((s, l) => s + l.leg_score, 0) / legScores.length;
  if (avgScore >= 70) return Math.min(5, legScores.length);
  if (avgScore >= 55) return Math.min(4, legScores.length);
  if (avgScore >= 40) return Math.min(3, legScores.length);
  return Math.min(2, legScores.length);
}

export function computeParlayScore(input: ParlayScorerInput): ParlayScoreOutput {
  const { legs, legScores } = input;

  if (legs.length === 0) {
    return {
      parlay_score: 0,
      recommended_legs: 2,
      sport_diversity_bonus: 0,
      correlation_penalty: 0,
      volatility_penalty: 0,
    };
  }

  const avgLegScore = legScores.reduce((s, l) => s + l.leg_score, 0) / legScores.length;
  const avgConfidence = legScores.reduce((s, l) => s + l.confidence_component, 0) / legScores.length;
  const combEdge = combinedEdge(legs);
  const divBonus = sportDiversityBonus(legs);
  const corrPen = correlationPenalty(legs);
  const volPen = volatilityPenalty(legScores);

  // Spec formula (components 0–1 for the positive terms; penalty terms subtract)
  const rawScore = (
    (avgLegScore / 100) * 0.40 +
    combEdge             * 0.25 +
    avgConfidence        * 0.15 +
    divBonus             * 0.10 -
    corrPen              * 0.05 -
    volPen               * 0.05
  ) * 100;

  return {
    parlay_score:          Math.max(0, Math.round(rawScore * 10) / 10),
    recommended_legs:      recommendedLegs(legScores),
    sport_diversity_bonus: divBonus,
    correlation_penalty:   corrPen,
    volatility_penalty:    volPen,
  };
}
