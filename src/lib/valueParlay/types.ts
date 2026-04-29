import type { ConfidenceLevel, GamePrediction, League } from "@/data/mockGames";

export type ParlayBuildMode =
  | "safe"        // Safe Builder    — lower payout, higher hit chance
  | "balanced"    // Balanced Builder — medium payout, medium risk
  | "aggressive"  // legacy "anything goes" tier
  | "cashout"     // Cash-Out friendly: staggered starts, ordered legs
  | "bigwin"      // Big Win Builder  — targets +800 to +1200; strict per-leg floors
  | "lotto";      // Lotto Builder    — high payout, clearly risky, no floors

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
  /**
   * Pre-calibration model probability. When set, `modelProbability`
   * is the Platt-scaled / calibrated value and this field carries
   * the raw blend output. Kelly + value-gate logic should prefer
   * `modelProbability` (calibrated); diagnostics use the delta.
   * Undefined when no calibration was applied (raw == final).
   */
  rawModelProbability?: number;
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
   * Human-readable local start label (e.g. "7:30 PM ET"). Optional.
   * Used as a proxy for start-time diversity in the Cash-Out parlay mode.
   * When absent, cash-out stagger scoring falls back to gameId distinctness.
   */
  gameTimeLabel?: string;
  /**
   * Fraction of the player's last N (default 5) games where the stat value
   * cleared the line in the prop's direction. 0–1; undefined when the
   * gamelog couldn't be fetched (unsupported sport/stat, missing athlete id,
   * or API failure). Computed post-fetch and attached before parlay build.
   */
  recentHitRate?: number;
  /** Sample size behind recentHitRate. */
  recentHitRateSamples?: number;
  /**
   * MLB-only: true when the candidate's game has unconfirmed probable
   * pitchers. Predictions emitted before confirmation are capped at
   * low-confidence and re-issued once confirmation lands.
   */
  preConfirmationFlag?: boolean;
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
  /**
   * Bookmaker line freshness — ISO timestamp of the upstream
   * `last_update` field for the price used. Older than
   * STALE_LINE_MAX_AGE_MS triggers `staleLineFlag` and excludes the
   * leg from parlay recommendation.
   */
  bookmakerLastUpdate?: string;
  /** True when the price used is older than STALE_LINE_MAX_AGE_MS. */
  staleLineFlag?: boolean;
  /**
   * True when a late roster / lineup change was detected for this
   * game after the model was scored. Hard-invalidates parlay use:
   * isRecommended forced to false, exclusionReason set.
   */
  lateChangeInvalidated?: boolean;
  /**
   * "Would I bet this as a single?" gate (Step 8 of the discipline
   * checklist). When false, SAFE / CASHOUT parlays must NOT include
   * this leg even if it has positive edge — a leg unworthy of a
   * straight bet is unworthy of a parlay slot.
   *
   * Computed once in buildCandidates from: modelProbability ≥ 0.58,
   * confidence != "low", volatility < 60, recentHitRate ≥ 0.45 (when
   * sampled), edge > 0.02, no stale/late-change flags, price within
   * the single-bet range (-300 .. +110).
   */
  eligibleAsSingle?: boolean;
  /** Short reason this leg is NOT single-bet eligible. Undefined when eligible. */
  singleBetReason?: string;
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
  /**
   * Composite fragility score 0–100 (higher = more fragile).
   * Derived from weakest leg quality, medium-confidence density,
   * same-game exposure, and volatility concentration.
   * Safe tier rejects parlays with fragilityScore ≥ 55; balanced penalises.
   */
  fragilityScore?: number;
  /** Lowest per-leg score in the parlay (0–1). */
  weakestLegScore?: number;
  /** ID of the strongest leg by computeLegScore. */
  strongestLegId?: string;
  /** ID of the weakest leg by computeLegScore. */
  weakestLegId?: string;
  /** Per-leg short reason for inclusion (parallel to legs[]). */
  legInclusionReasons?: string[];
  /** Reasons rejected legs were dropped — diagnostic info from the optimizer. */
  rejectedLegReasons?: { selection: string; reason: string }[];
  /**
   * "Would I personally take this?" — yes when:
   *  - data quality / model_status is reasonable across legs
   *  - fragilityScore < 55
   *  - weakestLegScore at or above tier floor
   *  - hit-rate × payout offers positive EV at vig-adjusted odds
   * Always false in lotto mode (the mode itself implies "risky on purpose").
   */
  wouldITakeIt?: boolean;
  /** Short rationale for the wouldITakeIt verdict. */
  wouldITakeItReason?: string;
  /**
   * Per-tier risk-level distribution across the parlay's legs.
   * Used by the UI to render a "1 HIGH · 2 MED · 0 LOW" summary and
   * to flag overall card aggressiveness. See propRiskLevels.ts.
   */
  riskLevelCounts?: { low: number; medium: number; high: number };
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
