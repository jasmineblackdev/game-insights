export type ConfidenceLevel = "high" | "medium" | "low";
export type PlayerTrend = "hot" | "cold" | "steady";
export type InjuryStatus = "OUT" | "QUESTIONABLE" | "PROBABLE" | "GTD";
export type League = "nba" | "wnba" | "nfl" | "mlb" | "boxing" | "mma";
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
  // ── v2 factors (used by 9-factor model) ──────────────────────────────────
  /** Total professional rounds fought. */
  roundsFought?: number;
  /** Fraction of rounds won per CompuBox/judge scoring (0.0–1.0). */
  roundsWonPct?: number;
  /** Defensive slip/block rate — punches evaded / total thrown at fighter (0.0–1.0). */
  strikesDefensePct?: number;
  /** Wins in the last 5 fights (for recent-form score). */
  recentWins?: number;
  /** Number of recent fights the recentWins window covers (typically 5). */
  recentFights?: number;
  /** Weight classes moved in career — 0 = stable, ≥2 = high-variance. */
  weightClassMoves?: number;
}

/** Structured output from the boxing prediction model. */
export interface BoxingModelOutput {
  reachEdge: string;
  ageEdge: string;
  stanceEdge: string;
  activityEdge: string;
  styleEdge: string;
  opponentQualityEdge: string;
  recentFormEdge: string;
  defenseEdge: string;
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

// ── MMA / UFC types ───────────────────────────────────────────────────────────

/** MMA fighter profile — populated from Supabase mma_fighters. */
export interface MmaFighterProfile {
  fighterId: string;
  name: string;
  record: string;               // e.g. "22-5-0 (1 NC)"
  wins: number;
  losses: number;
  draws: number;
  noContests: number;
  koTkoWins: number;
  subWins: number;
  decisionWins: number;
  weightClass: string;
  reach?: number;               // inches
  height?: number;              // inches
  stance?: "orthodox" | "southpaw" | "switch";
  age?: number;
  lastFightDate?: string;
  opponentQualityScore?: number; // 0-100
  koTkoPct?: number;             // % of wins by KO/TKO
  subPct?: number;               // % of wins by submission
  decisionPct?: number;
  /** Style: striker | grappler | wrestler | submission_specialist | well_rounded | pressure_fighter */
  styleTag?: string;
  // Striking stats (per 15 min)
  sigStrikesLandedPerMin?: number;
  sigStrikesAbsorbedPerMin?: number;
  strikeAccuracy?: number;       // 0.0–1.0
  strikeDefense?: number;        // 0.0–1.0
  // Grappling stats (per 15 min)
  avgTakedownsPer15?: number;
  takedownAccuracy?: number;     // 0.0–1.0
  takedownDefense?: number;      // 0.0–1.0
  avgSubAttemptsPer15?: number;
  controlTimePer15?: number;     // seconds per 15 min of fight time
  // Durability
  knockdownsReceived?: number;   // total career knockdowns received
  koPenalty?: number;            // 0-10: 0=iron chin, 10=severely KO-tested
  // Cardio/pace
  cardioRating?: number;         // 0-10: late-round output decline
  // Activity
  recentWins?: number;           // wins in last 5
  recentFights?: number;
  /** True when given less than 10 days' notice. */
  shortNotice?: boolean;
  /** Weight classes moved in career. */
  weightClassMoves?: number;
}

/** Structured output from the MMA prediction model (v2, 10-factor). */
export interface MmaModelOutput {
  // Factor edge descriptions (one per model factor)
  styleMatchupEdge: string;       // style matrix result
  opponentQualityEdge: string;    // schedule strength
  strikingEfficiencyEdge: string; // slpm, sapm, accuracy, defense
  grapplingEdge: string;          // takedown accuracy/defense, control time, subs
  cardioEdge: string;             // late-round output, pace decline
  durabilityEdge: string;         // KO penalty, knockdowns, absorbed strikes
  physicalEdge: string;           // reach + height advantage
  activityEdge: string;           // layoff + short-notice
  ageCurveEdge: string;           // age relative to prime window
  marketEdge: string;             // line movement signal
  // Method of victory
  methodProbabilities: {
    ko_tko: number;
    submission: number;
    decision: number;
  };
  /** Model-estimated fight length (avg rounds). */
  overUnderRoundsPivot?: number;
  /** Goes-the-distance probability (0.0–1.0). */
  goesDistanceProb: number;
  riskFlag: string | null;
  _debug: {
    styleScore: number;
    strikingScore: number;
    grapplingScore: number;
    cardioScore: number;
    durabilityScore: number;
    physicalScore: number;
    opponentQualityScore: number;
    activityScore: number;
    ageCurveScore: number;
    marketScore: number;
    combinedDelta: number;
  };
}

/** MMA-specific intel for a fight — parallel to BoxingIntel. */
export interface MmaIntel {
  homeFighter: MmaFighterProfile;
  awayFighter: MmaFighterProfile;
  weightClass: string;
  scheduledRounds: number;      // 3 (regular) or 5 (main event / title)
  venue?: string;
  isMainEvent?: boolean;
  isChampionshipBout?: boolean;
  titleDescription?: string;
  promotion?: string;           // "UFC", "Bellator", "PFL", etc.
  modelNotes: string[];
  modelOutput?: MmaModelOutput;
  oddsSource?: string;
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
 * Extended signals for calibration, live timing, learning, and parlay risk (no UI requirement).
 * Populated by predictionQualityPipeline + client enrichment pass.
 */
export interface PredictionIntelMeta {
  /** ms since ESPN/board timestamp vs client now for live games */
  live_update_latency_ms?: number;
  /** When latency exceeds target, pipeline may soften confidence */
  live_latency_confidence_penalty?: boolean;
  /** Injury/pitcher snapshot changed materially vs last client view */
  late_change_flag?: boolean;
  /** 0–100 materiality of late change */
  late_change_impact_score?: number;
  /** Estimated edge erosion per minute (positive = edge falling) from client snapshots */
  edge_decay_rate_pp_per_min?: number;
  /** Current model edge vs opening implied, pp (moneyline layer) when known */
  edge_current_vs_open_pp?: number | null;
  /** Sport-specific floor learned + bounded (see sportEdgeThresholds) */
  optimal_edge_threshold?: number;
  /** 0–100 role/minutes certainty proxy */
  role_stability_score?: number;
  /** 0–100 blowout script risk (props/minutes) */
  blowout_risk_score?: number;
  /** 0–100 spread across model blend pillars */
  model_disagreement_score?: number;
  /** 0–100 uncertain injury / GTD mass */
  injury_uncertainty_score?: number;
  /** 0–100 season phase variance / rest context */
  season_phase_score?: number;
  /** 0–100 public-side overpricing hint (model fades popular side) */
  public_bias_score?: number;
  /** Keys into local learning store (accuracy, failure heatmap) */
  learning_store_keys?: {
    accuracy_summary: string;
    correlation_failures: string;
    confidence_curve: string;
  };
  /** 0–100 inverse of missing lineup / injury / pitcher certainty gaps */
  data_completeness_score?: number;
  /** 0–100 consistency of recent form vs season baseline */
  statistical_stability_score?: number;
  /** 0–100 line move likely driven by public steam vs sharp info */
  market_sentiment_steam_score?: number;
  /** 0–100 heuristic usage spike vs season for key players */
  role_change_volatility_score?: number;
}

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
  /** v2 intelligence — live latency, decay, diversification inputs, learning hooks */
  predictionIntel?: PredictionIntelMeta;
  risk_flags: string[];
  /** True when material late info should surface an extra prediction version. */
  late_news_refresh?: boolean;
  version_timestamp?: string;
  /** Tags used for interaction learning at settlement time */
  learning_context_tags?: string[];
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

/** Live / pregame value stages — see `liveBettingIntelligence.ts`. */
export type LiveRecommendedAction =
  | "Bet Now"
  | "Wait"
  | "Pass"
  | "Value Gone"
  | "Live Edge Active";

export interface LiveBettingStageRow {
  stageId: string;
  stageLabel: string;
  pickAbbrev: string;
  pickSide: "home" | "away" | "draw";
  /** Model win probability for the pick (0–1). */
  modelProbability: number;
  confidence: "HIGH" | "MED" | "LOW";
  americanOdds: number;
  impliedProbability: number;
  edge: number;
  recommendedAction: LiveRecommendedAction;
  /** Sport-specific live inputs (heuristic until vendor feeds). */
  sportSignals: string[];
  liveStateSnapshot?: { period: number; scoreHome: number; scoreAway: number };
  capturedAt: string;
  oddsSource?: "sportsbook" | "estimated";
}

export interface LiveBettingIntelMeta {
  schemaVersion: 1;
  /** Frozen opening read when available (localStorage); else current book row. */
  pregame: LiveBettingStageRow;
  /** One row per active checkpoint (refreshed each fetch while in-window). */
  checkpoints: LiveBettingStageRow[];
  /** Outcome vs pregame pick when final. */
  final?: LiveBettingStageRow;
  /** First view was after tip — pregame row is a best-effort replay. */
  pregameSnapshotMissing?: boolean;
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
  mma?: MmaIntel;
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
    /** The Odds API event id — used for in-play line refresh (see `oddsEvents.ts`). */
    oddsApiEventId?: string;
    bookmakerLastUpdate?: string;
    oddsFetchedAt?: string;
    /** Layered scoring outputs (market, calibration, volatility, etc.). */
    quality?: PredictionQualityMeta;
    /** Model vs book value for primary pick — see `bettingIntelligence.ts`. */
    bettingIntel?: BettingIntelligenceMeta;
    /** Pregame vs live checkpoint vs final value — see `liveBettingIntelligence.ts`. */
    liveBetting?: LiveBettingIntelMeta;
  };
}

