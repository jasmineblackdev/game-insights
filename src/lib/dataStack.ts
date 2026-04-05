/**
 * Canonical multi-sport data & product stack (target architecture).
 * Narrative + tables: docs/DATA_STACK.md
 * Current app may still use ESPN/optional vendors until SportsDataIO → Supabase ingestion exists.
 */

import type { League } from "@/data/mockGames";

export type DataPhaseId = "phase1_mvp" | "phase2_analytics" | "phase3_premium";

export type PrimaryMvpVendor = "sportsdataio";

export interface DataPhase {
  id: DataPhaseId;
  title: string;
  includes: string[];
}

export const DATA_PHASES: DataPhase[] = [
  {
    id: "phase1_mvp",
    title: "Phase 1 — operational MVP",
    includes: [
      "SportsDataIO (NBA, NFL, MLB, Soccer)",
      "Supabase (DB, auth, Edge/API)",
      "Firebase Cloud Messaging (alerts)",
      "React Native (mobile client)",
    ],
  },
  {
    id: "phase2_analytics",
    title: "Phase 2 — smarter analytics",
    includes: [
      "StatsBomb — soccer xG & event data",
      "Sportradar MLB — push probable pitchers, richer lineups",
    ],
  },
  {
    id: "phase3_premium",
    title: "Phase 3 — premium",
    includes: [
      "Odds comparison & line movement",
      "News / sentiment",
      "Model accuracy dashboards by sport",
    ],
  },
];

/** Shared relational core (all sports). */
export const SHARED_DB_ENTITIES = [
  "teams",
  "players",
  "games",
  "injuries",
  "lineups_or_depth",
  "team_game_logs",
  "player_game_logs",
  "predictions",
  "prediction_factors",
  "prediction_versions",
  "user_favorites",
  "user_alerts",
] as const;

/** Extensions per sport (in addition to shared core). */
export const SPORT_SPECIFIC_DB_ENTITIES: Record<League, readonly string[]> = {
  nba: ["rotations", "usage_trends"],
  nfl: ["depth_charts", "qb_metrics"],
  mlb: ["probable_pitchers", "bullpen_usage", "team_splits"],
  soccer: ["fixtures", "lineups", "xg_metrics", "congestion_metrics"],
};

/** Product capabilities mirrored across every sport in the app. */
export const SHARED_PRODUCT_FEATURES = [
  "Daily best picks / Edge Card (Pick 3, 4, 6)",
  "Manual + auto-build slips",
  "Confidence score & top reasons & biggest risk",
  "Last updated timestamp",
  "Replacement suggestion when conditions change",
  "Prediction history & hit rate",
] as const;

export interface SportStackRow {
  league: League;
  label: string;
  predictionDrivers: string[];
  mustHaveData: string[];
  niceToHaveData: string[];
  mvpApi: string;
  mvpOutputs: string[];
}

export const SPORT_STACK: SportStackRow[] = [
  {
    league: "nba",
    label: "NBA",
    predictionDrivers: [
      "Injury status",
      "Rotation changes",
      "Usage rate shifts",
      "Back-to-back / rest disadvantage",
      "Offense vs defense style matchup",
    ],
    mustHaveData: [
      "Schedules",
      "Injuries",
      "Lineups / depth charts",
      "Player & team stats",
      "Standings",
    ],
    niceToHaveData: ["Odds", "Player news"],
    mvpApi: "SportsDataIO NBA",
    mvpOutputs: [
      "Win probability",
      "Confidence",
      "Top 3 reasons",
      "Biggest risk",
      "Injury impact",
      "What changed since last update",
    ],
  },
  {
    league: "nfl",
    label: "NFL",
    predictionDrivers: [
      "QB performance",
      "OL vs pass rush",
      "Injury impact by position",
      "Depth chart stability",
      "Red-zone efficiency",
      "Turnover tendency",
      "Rest / travel context",
    ],
    mustHaveData: [
      "Schedules",
      "Injuries",
      "Lineups / depth charts",
      "Team & player stats",
      "Standings",
    ],
    niceToHaveData: ["Odds", "Player news", "Estimated return timelines"],
    mvpApi: "SportsDataIO NFL",
    mvpOutputs: [
      "Win probability",
      "Confidence",
      "Trench matchup edge",
      "QB edge",
      "Injury risk",
      "Upset path",
    ],
  },
  {
    league: "mlb",
    label: "MLB",
    predictionDrivers: [
      "Probable pitcher quality",
      "Starter ERA / FIP",
      "Bullpen fatigue",
      "L/R splits",
      "Batting splits vs pitcher type",
      "Confirmed lineup strength",
    ],
    mustHaveData: [
      "Schedules",
      "Injuries",
      "Projected & confirmed lineups",
      "Projected & confirmed pitchers",
      "Split stats",
      "Play-by-play / pitch data",
      "Advanced metrics",
    ],
    niceToHaveData: ["Statcast", "Push probable-pitcher changes (e.g. Sportradar)"],
    mvpApi: "SportsDataIO MLB (+ Sportradar push workflows)",
    mvpOutputs: [
      "Team win probability",
      "Starter edge",
      "Bullpen risk",
      "Handedness edge",
      "Lineup confidence",
      "Prediction pending pitcher confirmation flag",
    ],
  },
  {
    league: "soccer",
    label: "Soccer",
    predictionDrivers: [
      "Possession style",
      "Expected goals (xG)",
      "Fixture / travel congestion",
      "Starting lineup strength",
      "Home / away profile",
      "Style-vs-style tactical conflict",
    ],
    mustHaveData: [
      "Fixtures",
      "Standings",
      "Lineups",
      "Live match status",
      "Team & player stats (20+ competitions via SportsDataIO)",
    ],
    niceToHaveData: [
      "xG & event data (StatsBomb)",
      "Tactical event detail",
      "football-data.org (lightweight fixtures/tables)",
      "Sportradar soccer lineups (kickoff timing)",
    ],
    mvpApi: "SportsDataIO Soccer (+ StatsBomb later)",
    mvpOutputs: [
      "Home / draw / away probabilities",
      "Confidence",
      "xG edge",
      "Possession / control edge",
      "Congestion warning",
      "Lineup confirmation status",
    ],
  },
];

export const BASE_STACK = {
  primaryVendor: "SportsDataIO" as const,
  role:
    "Cross-sport operational feed: scores, stats, injuries, lineups/depth, standings; soccer spans many competitions.",
  backend: "Supabase",
  push: "Firebase Cloud Messaging",
  mobile: "React Native",
} as const;

/** Lookup sport row by league key. */
export function getSportStack(league: League): SportStackRow | undefined {
  return SPORT_STACK.find((r) => r.league === league);
}
