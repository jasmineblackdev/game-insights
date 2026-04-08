-- Document ETL for pitcher recent form (table created in 20260410300000_mlb_model.sql).
-- Populate with: `npm run mlb:sync-pitcher-recent-form` (service role env required).

comment on table public.mlb_pitcher_recent_form is
  'Rolling last-3 / last-5 start ERAs keyed by ESPN MLB athlete id. Seeded by scripts/refresh-mlb-pitcher-recent-form.mjs (MLB Stats API + ESPN search). Used by the client model for 50/50 season/recent ERA blend.';
