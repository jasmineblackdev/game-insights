import type { ConfidenceLevel, GamePrediction, League } from "@/data/mockGames";

export type ParlayBuildMode = "safe" | "balanced" | "aggressive";

export type ValuePickType = "team_pick" | "spread" | "total" | "player_prop";

export type ValueMarketType = "moneyline" | "spread" | "total" | "player_prop";

export interface ValueBetCandidate {
  id: string;
  sport: League;
  gameId: string;
  pickType: ValuePickType;
  marketType: ValueMarketType;
  selectionLabel: string;
  teamId?: string;
  playerId?: string;
  playerName?: string;
  statType?: string;
  lineValue?: number;
  americanOdds: number;
  impliedProbability: number;
  modelProbability: number;
  edge: number;
  /** Edge vs implied in percentage points (e.g. 6.5 = +6.5%). */
  edgeScore: number;
  /** A–C from betting intelligence filters. */
  betQualityRating?: "A" | "B" | "C";
  valueRating?: "low" | "medium" | "high";
  parlayFitScore?: number;
  parlaySafetyScore?: number;
  confidence: ConfidenceLevel;
  volatilityScore: number;
  uncertaintyScore: number;
  correlationGroupId: string;
  valueScore: number;
  valueGrade: "A" | "B" | "C" | "D";
  riskScore: number;
  riskBand: "low" | "moderate" | "elevated" | "high";
  riskNote: string;
  isRecommended: boolean;
  /**
   * ML timing urgency signal — first-class parlay scoring dimension.
   * "now"     = optimal window, positive timing bonus in parlay score
   * "monitor" = neutral timing, no bonus/penalty
   * "wait"    = adverse timing; excluded from safe parlays, penalised in balanced
   */
  timingUrgency?: "now" | "wait" | "monitor";
  /**
   * Continuous timing quality: 0–1.
   * "now" → ~0.85, "monitor" → ~0.55, "wait" → ~0.15.
   * Used as explicit parlay-score component (separate from volatilityScore).
   */
  timingScore?: number;
  /**
   * Human-readable reason this candidate was excluded / not recommended.
   * Present when isRecommended=false; undefined when recommended.
   */
  exclusionReason?: string;
  /**
   * ML stability score (0–1). Higher = more consistent historical performance.
   * Source: ml_debug.stability_score for enriched props; undefined for game-level candidates.
   * Used as a leg quality signal in the ML-aware parlay scorer.
   */
  stabilityScore?: number;
  /**
   * Which model variant generated this candidate.
   * "rules"      — pure rules engine (no ML contribution)
   * "ml_blended" — rules + ML alpha blend (ml_active = true)
   * "ml_full"    — future: fully ML-driven prediction
   * Used in parlay_build_legs and analytics_model_contribution tracking.
   */
  modelVariant?: "rules" | "ml_blended" | "ml_full";
  /**
   * Additive confidence adjustment derived from analytics_confidence_calibration_by_market.
   * Applied in computeLegScore as: (conf01 + confidenceCalibrationAdjustment) * 0.18
   * Clamped to ±0.08. Positive = confidence labels reliably predictive for this market.
   * Negative = confidence labels unreliable or inverted. Undefined = no data (neutral).
   */
  confidenceCalibrationAdjustment?: number;
  sportsbookKey?: string;
  matchupLabel: string;
  lineMovementDeltaPp?: number | null;
  /**
   * NFL-only: pre-computed injury position multiplier.
   * Populated by buildCandidates when game.league === "nfl" and injury data
   * is present. Positive = injuries create opportunity; negative = injuries
   * weaken expected performance. Clamped to ±0.08 at source.
   * Consumed by computeLegScore as a direct additive term.
   * Undefined (treated as 0) for all non-NFL candidates and when no
   * OUT-status injuries affect the relevant positions.
   */
  injuryImpactAdj?: number;
}

export interface PlayerPropModelRow {
  gameId: string;
  sport: League;
  playerId: string;
  playerName: string;
  teamAbbr: string;
  opponentAbbr: string;
  statType: string;
  lineValue: number;
  projectedValue: number;
  overProbability: number;
  underProbability: number;
  recommendedSide: "OVER" | "UNDER";
  edge: number;
  confidence: ConfidenceLevel;
  volatilityScore: number;
  uncertaintyScore: number;
  reason1: string;
  reason2: string;
  riskFactor: string;
}

export interface SmartParlayResult {
  legs: ValueBetCandidate[];
  projectedHitProbability: number;
  projectedPayoutMultiplier: number;
  combinedAmericanOdds: number;
  cardConfidence: ConfidenceLevel;
  correlationPenalty: number;
  volatilityPenalty: number;
  uncertaintyPenalty: number;
  smartParlayScore: number;
  warnings: string[];
}

export interface ParlayTriple {
  bestValue: SmartParlayResult;
  safer: SmartParlayResult;
  higherPayout: SmartParlayResult;
}

export interface OddsH2hRow {
  homeAmerican: number;
  awayAmerican: number;
  /** Soccer 1X2 draw price when present on h2h market. */
  drawAmerican?: number;
  bookKey: string;
}
