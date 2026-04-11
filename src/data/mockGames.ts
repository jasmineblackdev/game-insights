export type ConfidenceLevel = "high" | "medium" | "low";
export type PlayerTrend = "hot" | "cold" | "steady";
export type InjuryStatus = "OUT" | "QUESTIONABLE" | "PROBABLE" | "GTD";
export type League = "nba" | "nfl" | "mlb" | "boxing";
export type GameDate = "today" | "tomorrow" | "week";

/** "partial" = one pitcher confirmed, the other still unknown. */
export type PitcherCertainty = "confirmed" | "probable" | "partial" | "unknown";


/**
 * Structured output from the MLB weighted prediction model.
 * Stored per-game for display and backtesting.
 */
export interface MlbModelOutput {
  /** Why the model favors one starter over the other. */
  pitcherEdge: string;
  /** Handedness-based batting-split assessment. */
  battingEdge: string;
  /** Bullpen fatigue differential. */
  bullpenEdge: string;
  /** Recent-form differential. */
  formEdge: string;
  /** Park-environment note. */
  parkNote: string;
  /** Non-null when a significant risk caveat exists. */
  riskFlag: string | null;
  /** True when probable pitchers have not been announced. */
  pendingConfirmation: boolean;
  /** ISO time when this model output was computed (backtests / API consumers). */
  lastUpdated?: string;
  /** Internal debug snapshot — not displayed in UI. */
  _debug: {
    pitcherScore: number;
    battingScore: number;
    bullpenScore: number;
    formScore: number;
    restScore: number;
    combinedDelta: number;
    hasOdds: boolean;
    hasStats: boolean;
    homePitcherEra: number | null;
    awayPitcherEra: number | null;
    homePitcherWhip: number | null;
    awayPitcherWhip: number | null;
    /** Layered historical / season / trend / context (internal analytics only). */
    layerDebug?: {
      historicalBaselineEra: { home: number | null; away: number | null };
      seasonEra: { home: number | null; away: number | null };
      recentEraL5: { home: number | null; away: number | null };
      blendedEra: { home: number | null; away: number | null };
      battingUsedDbSplits: boolean;
      bullpenUsedFatigueRows: boolean;
      todayContext: {
        pitchersConfirmed: boolean;
        lineupConfirmed: boolean;
        parkFactor: number;
        weatherVolatile: boolean;
      };
    };
  };
}

/** MLB-specific pregame signals — populated from ESPN when available. */
export interface MlbIntel {
  awayProbablePitcher?: string;
  homeProbablePitcher?: string;
  awayPitcherHand?: "L" | "R";
  homePitcherHand?: "L" | "R";
  pitcherCertainty: PitcherCertainty;
  /** True once the starting lineup is posted (populated when ESPN confirms it). */
  lineupConfirmed?: boolean;
  /** Bullpen / park / handedness / lineup sensitivity */
  modelNotes: string[];
  /** Structured output from the MLB weighted prediction model. */
  modelOutput?: MlbModelOutput;
}

/** Boxing fighter physical/record profile — populated from Supabase boxing_fighters. */
export interface BoxingFighterProfile {
  fighterId: string;
  name: string;
  record: string;          // e.g. "28-2-0 (20 KOs)"
  wins: number;
  losses: number;
  draws: number;
  koWins: number;
  weightClass: string;
  reach?: number;          // inches
  height?: number;         // inches
  stance?: "orthodox" | "southpaw" | "switch";
  age?: number;
  /** Last fight date ISO string — used to compute inactivity penalty. */
  lastFightDate?: string;
  /** Avg opponent quality score 0-100 (based on opponent records). */
  opponentQualityScore?: number;
  /** % of fights won by KO/TKO */
  koPct?: number;
  /** % of fights going to decision */
  decisionPct?: number;
  /** Style tags e.g. "pressure_fighter", "boxer_puncher", "counterpuncher", "brawler" */
  styleTag?: string;
  /** Chin durability score 0-10 (knockdowns taken / fights) */
  chinScore?: number;
}

/** Structured output from the boxing prediction model. */
export interface BoxingModelOutput {
  reachEdge: string;
  ageEdge: string;
  stanceEdge: string;
  activityEdge: string;
  styleEdge: string;
  opponentQualityEdge: string;
  koPctNote: string;
  methodProbabilities: {
    ko_tko: number;
    decision: number;
    draw: number;
  };
  overUnderRoundsPivot?: number;   // model-estimated avg rounds
  riskFlag: string | null;
  _debug: {
    reachDelta: number | null;
    ageDelta: number | null;
    stanceAdvantage: number;
    inactivityPenalty: number;
    styleMatchup: number;
    opponentQuality: number;
    combinedDelta: number;
  };
}

/** Boxing-specific intel for a fight — parallel to MlbIntel. */
export interface BoxingIntel {
  homeFighter: BoxingFighterProfile;   // "home" = fighter A (displayed left)
  awayFighter: BoxingFighterProfile;   // "away" = fighter B (displayed right)
  weightClass: string;
  scheduledRounds: number;
  venue?: string;
  isTitleFight?: boolean;
  titleDescription?: string;          // e.g. "IBF Heavyweight Title"
  promoter?: string;
  modelNotes: string[];
  modelOutput?: BoxingModelOutput;
  /** Source of odds data. */
  oddsSource?: string;
}

export interface PlayerInjury {
  name: string;
  position: string;
  status: InjuryStatus;
  impactScore: number; // 1-10
  detail: string;
}

export interface PlayerTrendData {
  name: string;
  position: string;
  trend: PlayerTrend;
  last5Avg: number;
  seasonAvg: number;
  keyMetric: string;
  keyMetricValue: string;
}

export interface TeamData {
  name: string;
  abbreviation: string;
  record: string;
  logo: string;
  recentForm: string; // e.g., "W-W-L-W-W"
  // NBA: offensiveRating, defensiveRating, pace
  // NFL: yardsPerGame, pointsAllowed, playsPerGame
  offensiveRating: number;
  defensiveRating: number;
  pace: number;
  /** MLB: home win% and road win% for home/away form scoring */
  homeWinPct?: number;
  roadWinPct?: number;
}

export interface MatchupEdge {
  label: string;
  team: "home" | "away";
  description: string;
}

/** ESPN book open/close moneylines for a fixture (when both sides exist). */
export interface MarketMlSnapshot {
  homeOpen?: string;
  homeClose?: string;
  awayOpen?: string;
  awayClose?: string;
  drawOpen?: string;
  drawClose?: string;
}

export type VolatilityLabel = "low" | "medium" | "high";

/**
 * Layered quality / calibration metadata — populated by predictionQualityPipeline.
 * UI may ignore; used for Edge Card risk, versions, and future analytics persistence.
 */
export interface PredictionQualityMeta {
  pipelineVersion: 1;
  modelBlend?: {
    historical_baseline: number;
    recent_trend: number;
    matchup: number;
    market: number;
    live: number;
    blended_adjustment_pp: number;
  };
  market?: {
    opening_implied_home?: number | null;
    closing_implied_home?: number | null;
    line_movement_home_pp?: number | null;
    model_implied_home?: number;
    clv_delta?: number | null;
    market_signal_strength?: number;
    sharp_move_hint?: boolean;
  };
  calibration?: {
    raw_confidence: ConfidenceLevel;
    bucket: ConfidenceLevel;
    empirical_hit_rate?: number | null;
    calibration_window?: string;
  };
  injury?: {
    injury_importance_score: number;
    replacement_penalty: number;
    total_injury_impact_score: number;
  };
  fatigue?: {
    fatigue_score: number;
    fatigue_penalty: number;
    travel_penalty: number;
    rest_days_home?: number;
    rest_days_away?: number;
  };
  style?: {
    style_matchup_score: number;
    style_notes: string[];
    style_risk_flag: boolean;
  };
  volatility?: {
    volatility_score: number;
    volatility_label: VolatilityLabel;
  };
  schedule?: {
    opponent_strength_score: number;
    recent_schedule_difficulty: number;
  };
  correlation?: {
    correlation_score: number;
    card_risk_penalty: number;
  };
  risk_flags: string[];
  /** True when material late info should surface an extra prediction version. */
  late_news_refresh?: boolean;
  version_timestamp?: string;
}

export interface GameLines {
  /** DraftKings spread string e.g. "LAL -4.5" — home team implied by negative */
  spread?: string;
  /** Negative = home team is favorite, positive = away team */
  spreadNum?: number;
  /** Over/under total */
  total?: number;
  /** American odds for home team, e.g. "-185" */
  homeMl?: string;
  /** American odds for away team, e.g. "+155" */
  awayMl?: string;
  /** Soccer 1X2 — draw moneyline when provided by the book payload */
  drawMl?: string;
}

/**
 * VALUE EDGE / betting market layer for the model’s primary pick on a game.
 * Populated client-side when odds bundles are merged (Odds API + ESPN lines).
 */
export interface BettingIntelligenceMeta {
  pickSide: "home" | "away" | "draw";
  pickAbbrev: string;
  americanOdds: number;
  modelProbability: number;
  impliedProbability: number;
  sportsbookProbability: number;
  edge: number;
  edgeScore: number;
  betQualityRating: "A" | "B" | "C";
  valueRating: "low" | "medium" | "high";
  parlayFitScore: number;
  parlaySafetyScore: number;
  recommendedForParlay: boolean;
  sportsbookKey?: string;
  lineMovementSharpTowardPick?: boolean | null;
  filterNotes: string[];
}

export interface GamePrediction {
  id: string;
  league: League;
  gameDate: GameDate;
  gameTime: string;
  status: "upcoming" | "live" | "final";
  homeTeam: TeamData;
  awayTeam: TeamData;
  winProbability: { home: number; away: number };
  /** Soccer: de-vig 1X2 implied % from book (home / away / draw). Sums to ~100. */
  threeWay?: { home: number; away: number; draw: number };
  confidence: ConfidenceLevel;
  topReasons: string[];
  riskFactors: string[];
  keyMatchup: string;
  injuries: { home: PlayerInjury[]; away: PlayerInjury[] };
  playerTrends: { home: PlayerTrendData[]; away: PlayerTrendData[] };
  matchupEdges: MatchupEdge[];
  upsetPath: string;
  lastUpdated: string;
  situationalTags: string[];
  lines?: GameLines;
  /** Cross-book odds, weather, etc. */
  enrichmentNotes?: string[];
  mlb?: MlbIntel;
  boxing?: BoxingIntel;
  /** ESPN / client-only sort key */
  _meta?: {
    easternYmd: string;
    sortTime: number;
    eventId?: string;
    homeTeamId?: string;
    awayTeamId?: string;
    /** Set when ORtg/DRtg/pace were merged from stats.nba.com via Edge proxy. */
    nbaRatingsFromStats?: boolean;
    nbaStatsSeason?: string;
    /** Populated for live games from ESPN scoreboard period/score data. */
    liveState?: {
      /** Period/quarter/inning number (1-based). Halftime = period 2 for timed sports. */
      periodNum: number;
      /** Human-readable label e.g. "Q2", "Bot 5th", "72'" */
      periodLabel: string;
      homeScore: number;
      awayScore: number;
      /** True when halftime is active (NFL/NBA). */
      isHalftime?: boolean;
    };
    /** Final score — populated for status === "final" games. */
    finalHomeScore?: number;
    finalAwayScore?: number;
    /** ESPN athlete IDs for probable pitchers — used to fetch ERA/WHIP stats. */
    homePitcherAthleteId?: string;
    awayPitcherAthleteId?: string;
    /** Client-only: user marked probable starters as verified (localStorage). */
    userConfirmedMlbStarters?: boolean;
    /** Populated after park weather fetch during MLB enrichment (model confidence). */
    mlbWeather?: { tempF: number | null; windMph: number | null };
    /** Boxing: Supabase fight ID for this matchup. */
    boxingFightId?: string;
    marketMl?: MarketMlSnapshot;
    /** Layered scoring outputs (market, calibration, volatility, etc.). */
    quality?: PredictionQualityMeta;
    /** Model vs book value for primary pick — see `bettingIntelligence.ts`. */
    bettingIntel?: BettingIntelligenceMeta;
  };
}

