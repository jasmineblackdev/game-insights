/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** the-odds-api.com — optional cross-book lines (500 free tier / month) */
  readonly VITE_THE_ODDS_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
