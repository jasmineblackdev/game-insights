/**
 * College futures intelligence — types shared by odds fetch, model, and UI.
 * Model inputs are structured for future ESPN/stats wiring; V1 uses deterministic heuristics.
 */

export type CollegeSportId = "college_baseball" | "college_basketball" | "college_football";

export type FuturesMarketTypeV1 = "national_champion" | "tournament_winner";

export type ModelConfidenceLabel = "HIGH" | "MED" | "LOW";

export type FuturesValueRating = "A" | "B" | "C" | "D" | "F";

/** Future: stats-backed inputs per team (college baseball). */
export type CollegeBaseballModelInputs = {
  teamStrength: number;
  pitchingDepth: number;
  weekendRotationQuality: number;
  bullpenQuality: number;
  offensiveConsistency: number;
  runProduction: number;
  scheduleStrength: number;
  conferenceStrength: number;
  recentForm: number;
  postseasonExperience: number;
  injuryUncertainty: number;
};

/** Future: stats-backed inputs per team (college basketball). */
export type CollegeBasketballModelInputs = {
  powerRating: number;
  offensiveEfficiency: number;
  defensiveEfficiency: number;
  netRating: number;
  reboundingMargin: number;
  depth: number;
  guardReliability: number;
  threePointDependence: number;
  /** Lower turnover propensity (better ball security). */
  ballSecurity: number;
  freeThrowReliability: number;
  scheduleStrength: number;
  conferenceStrength: number;
  recentForm: number;
  tournamentViability: number;
};

/** Future: stats-backed inputs per team (college football). */
export type CollegeFootballModelInputs = {
  powerRating: number;
  returningProduction: number;
  qbQuality: number;
  offensiveLineQuality: number;
  defensiveLineStrength: number;
  scheduleStrength: number;
  depth: number;
  coachingQuality: number;
  injuryRisk: number;
  conferenceStrength: number;
  playoffPathDifficulty: number;
  turnoverMarginProfile: number;
  explosivePlayRate: number;
  redZoneEfficiency: number;
};

export type RawFuturesOutcome = {
  selectionName: string;
  teamId: string | null;
  americanOdds: number;
};

export type CollegeFuturesBoardMeta = {
  sport: CollegeSportId;
  leagueKey: string;
  sportKeyUsed: string;
  marketName: string;
  competitionName: string;
  sportsbookKey: string;
  sportsbookTitle: string;
  externalEventId: string | null;
  marketType: FuturesMarketTypeV1;
  note?: string;
};

export type CollegeFuturesIntelRow = {
  selectionName: string;
  teamId: string | null;
  americanOdds: number;
  openingOdds: number | null;
  impliedProbability: number;
  fairImpliedProbability: number;
  modelProbability: number;
  edge: number;
  confidence: ModelConfidenceLabel;
  valueRating: FuturesValueRating;
  reason1: string;
  reason2: string;
  riskFactor: string;
  lineMovementDelta: number | null;
};
