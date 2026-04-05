export type ConfidenceLevel = "high" | "medium" | "low";
export type PlayerTrend = "hot" | "cold" | "steady";
export type InjuryStatus = "OUT" | "QUESTIONABLE" | "PROBABLE" | "GTD";
export type League = "nba" | "nfl" | "mlb" | "soccer";
/** Soccer also uses "week" for fixtures within the next 7 days (sparse EPL calendar). */
export type GameDate = "today" | "tomorrow" | "week";

export type PitcherCertainty = "confirmed" | "probable" | "unknown";

/**
 * Soccer is modeled on a different axis than NBA/NFL/MLB: low scoring, draws matter,
 * and the strongest engines lean on xG, possession profile, congestion, and lineups.
 * ESPN covers fixtures and 1X2 odds; layer SportsDataIO / football-data.org for ops data
 * and StatsBomb (or similar) for xG and event-level tactics when you wire APIs.
 */
export interface SoccerIntel {
  competition: string;
  /** Human-readable factors we’d score with vendor + event data (placeholders until wired). */
  modelNotes: string[];
  /** What this build does not yet ingest — drives conservative confidence. */
  dataGaps: string[];
  /** Completed league matches in rolling windows (fatigue / rotation signal). */
  congestion?: {
    homeLast7: number;
    awayLast7: number;
    homeLast14: number;
    awayLast14: number;
  };
  /** From football-data.org standings when mapped by club TLA. */
  table?: {
    homePosition?: number;
    awayPosition?: number;
    homePoints?: number;
    awayPoints?: number;
  };
  /** Where schedule/table numbers came from for transparency. */
  scheduleSource?: "football-data.org" | "espn-scoreboard";
}

/** MLB-specific pregame signals — populated from ESPN when available. */
export interface MlbIntel {
  awayProbablePitcher?: string;
  homeProbablePitcher?: string;
  awayPitcherHand?: "L" | "R";
  homePitcherHand?: "L" | "R";
  pitcherCertainty: PitcherCertainty;
  /** Bullpen / park / handedness / lineup sensitivity */
  modelNotes: string[];
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
}

export interface MatchupEdge {
  label: string;
  team: "home" | "away";
  description: string;
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
  soccer?: SoccerIntel;
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
  };
}

