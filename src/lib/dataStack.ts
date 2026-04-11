/**
 * Canonical multi-sport data & product stack (target architecture).
 * Narrative + tables: docs/DATA_STACK.md
 * Prop / scoreboard assumptions (heuristic vs feeds): docs/MODEL_ASSUMPTIONS.md
 * Server learning tables + RPC: docs/DATA_STACK.md (GameLens learning intelligence)
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
  nba: ["rotations", "usage_trends", "advanced_team_metrics (shared)"],
  nfl: ["depth_charts", "qb_metrics", "advanced_team_metrics (shared)"],
  mlb: ["probable_pitchers", "bullpen_usage", "team_splits", "advanced_team_metrics (shared)"],
  boxing: ["boxing_fighters", "boxing_fights", "boxing_fight_results", "boxing_odds", "boxing_predictions", "boxing_prediction_versions", "boxing_learning_history"],
};

/** Cross-sport advanced layer (Supabase) — populated by ETL; optional at runtime. */
export const ADVANCED_INTELLIGENCE_ENTITIES = [
  "advanced_team_metrics",
  "advanced_player_metrics",
  "matchup_history",
  "lineup_strength_scores",
  "fatigue_scores",
  "advanced_prediction_inputs",
] as const;

/** Calibration & analytics tables (optional reads; service-role writes). See prediction_quality_layers migration. */
export const PREDICTION_QUALITY_ENTITIES = [
  "prediction_confidence_calibration",
  "prediction_quality_snapshots",
  "prediction_market_signals",
  "prediction_correlation_scores",
  "prediction_model_blends",
] as const;

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
    league: "boxing",
    label: "Boxing",
    predictionDrivers: [
      "Reach / height differential",
      "Age curve (prime vs decline)",
      "Stance matchup (orthodox vs southpaw)",
      "KO% and finishing ability",
      "Inactivity penalty (ring rust)",
      "Opponent quality (SOS)",
      "Style compatibility (boxer vs pressure fighter)",
      "Chin durability",
    ],
    mustHaveData: [
      "Fighter records and KO%",
      "Physical measurements (reach, height)",
      "Recent fight dates",
      "Opponent quality index",
      "Weight class",
      "Scheduled rounds",
    ],
    niceToHaveData: [
      "Punch stats (landed / thrown)",
      "Knockdown rates",
      "Judge scorecards",
      "Training camp reports",
    ],
    mvpApi: "Boxing Data API (Supabase-ingested) + The Odds API",
    mvpOutputs: [
      "Fight winner probability",
      "Method of victory (KO/TKO vs decision)",
      "Over/under rounds pivot",
      "Confidence",
      "Reach / age / style edges",
      "Inactivity and chin risk flags",
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
