/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** the-odds-api.com — optional cross-book lines (500 free tier / month) */
  readonly VITE_THE_ODDS_API_KEY?: string;
  /** Absolute URL to GET JSON `{ items: PlayerEdgePrediction[] }` (query: sport, statType). Mock fallback if unset or on error. */
  readonly VITE_PLAYER_EDGE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
