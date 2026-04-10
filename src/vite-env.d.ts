/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /**
   * Legacy: Odds API key in the browser bundle. Prefer server-side `THE_ODDS_API_KEY` + Edge Function
   * `odds-api-proxy` or dev proxy (see .env.example).
   */
  readonly VITE_THE_ODDS_API_KEY?: string;
  /** Optional full URL to `odds-api-proxy` (default: Supabase `/functions/v1/odds-api-proxy`). */
  readonly VITE_ODDS_API_PROXY_URL?: string;
  /**
   * When "1" or "true", ESPN scoreboards load via `espn-proxy` Edge Function (requires deploy + VITE_SUPABASE_URL).
   */
  readonly VITE_ENABLE_ESPN_PROXY?: string;
  /** Optional absolute URL to `espn-proxy` (default: `${VITE_SUPABASE_URL}/functions/v1/espn-proxy`). */
  readonly VITE_ESPN_PROXY_URL?: string;
  /**
   * Optional: The Odds API `sport_key` for NFL draft / outrights when catalog discovery fails.
   * See GET /v4/sports?all=true — keys vary by season.
   */
  readonly VITE_THE_ODDS_API_NFL_DRAFT_SPORT_KEY?: string;
  /**
   * Optional override: absolute URL to GET `{ items, accuracy? }` (query: sport, statType, id).
   * If unset, `VITE_SUPABASE_URL` + anon key target `/functions/v1/player-edge`. Mock fallback on error.
   */
  readonly VITE_PLAYER_EDGE_API_URL?: string;
  /** Optional override for GET `{ season, ratings }` from stats.nba.com proxy. Default: `/functions/v1/nba-stats-proxy` on Supabase origin. */
  readonly VITE_NBA_STATS_PROXY_URL?: string;
  /**
   * Optional override: GET `{ items: DraftEdgeCard[] }` for live draft cards (query: year, league).
   * If unset, uses `VITE_SUPABASE_URL` + anon key against `/functions/v1/draft-edge`. Sample cards if unreachable.
   */
  readonly VITE_DRAFT_EDGE_API_URL?: string;
  /** ESPN scoreboard refetch when a feed has live games (ms). See scoreboardPollConfig.ts */
  readonly VITE_SCOREBOARD_POLL_MS_LIVE?: string;
  /** ESPN scoreboard refetch when no live games in feed (ms). */
  readonly VITE_SCOREBOARD_POLL_MS_IDLE?: string;
  /** When "1" or "true", sync client learning JSON to user_learning_snapshots for signed-in users. */
  readonly VITE_SYNC_CLIENT_LEARNING_TO_SUPABASE?: string;
  /** Learning engine phase 1 | 2 | 3 (stored on prediction_history.learning_phase). Default 1. */
  readonly VITE_LEARNING_ENGINE_PHASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected by Vite `define` when dev server proxies Odds API (see vite.config). */
declare const __GAMELENS_ODDS_DEV_PROXY__: boolean;
