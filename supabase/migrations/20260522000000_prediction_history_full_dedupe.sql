-- ============================================================
-- Full-coverage unique index on prediction_history.
--
-- Background: the partial index added in 20260421 only covered
-- team_moneyline rows. Player-prop and other market_types had no
-- DB-level dedupe, so when the bridge's pre-query dedupe SELECT
-- got blocked by RLS (anon has no SELECT policy on this table),
-- repeated settles of the same paper bet could insert duplicate
-- rows into prediction_history without anything noticing.
--
-- Verified before applying: 0 duplicate (external_game_id,
-- market_type) pairs across all 128 existing rows. Safe to add
-- the unique constraint without backfill.
--
-- Companion change in TS bridges (paperBetLegBridge,
-- parlayLegBridge) catches Postgres error code 23505
-- (unique_violation) and counts the row as
-- skipped_already_bridged instead of an error.
-- ============================================================

create unique index if not exists prediction_history_dedupe_eid_market
  on public.prediction_history (external_game_id, market_type);

-- The team_moneyline-only partial index is now subsumed by the
-- full one above. Drop to avoid maintaining two equivalent
-- indexes on every insert.
drop index if exists public.prediction_history_dedupe_team_ml;

comment on index prediction_history_dedupe_eid_market is
  'Full-coverage dedupe — replaces the team_moneyline-only partial index. Backed by the bridge code which now catches 23505 unique violations and treats them as already-bridged.';
