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
  sportsbookKey?: string;
  matchupLabel: string;
  lineMovementDeltaPp?: number | null;
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
