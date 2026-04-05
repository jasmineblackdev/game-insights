/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** the-odds-api.com — optional cross-book lines (500 free tier / month) */
  readonly VITE_THE_ODDS_API_KEY?: string;
  /**
   * Optional override: absolute URL to GET `{ items, accuracy? }` (query: sport, statType, id).
   * If unset, `VITE_SUPABASE_URL` + anon key target `/functions/v1/player-edge`. Mock fallback on error.
   */
  readonly VITE_PLAYER_EDGE_API_URL?: string;
  /** Optional override for GET `{ season, ratings }` from stats.nba.com proxy. Default: `/functions/v1/nba-stats-proxy` on Supabase origin. */
  readonly VITE_NBA_STATS_PROXY_URL?: string;
  /**
   * Optional override: GET `{ items: DraftEdgeCard[] }` (query: year, league).
   * If unset, `VITE_SUPABASE_URL` + anon key target `/functions/v1/draft-edge`. Mock fallback on error.
   */
  readonly VITE_DRAFT_EDGE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
