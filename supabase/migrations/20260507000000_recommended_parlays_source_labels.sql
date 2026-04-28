-- ============================================================
-- Extend recommended_parlays.source check to recognize the new
-- per-surface labels so analytics can distinguish where each parlay
-- came from. Existing labels stay valid; we add four:
--
--   auto_profit       — the daily Auto Profit "Bet Now" pick
--   daily_plan        — Primary / Balanced / Upside cards on /daily
--   parlay_builder    — slip the user assembled in the builder
--   edge_card_legacy  — recovered from the EdgeCard localStorage sync
--
-- Without this, all four surfaces had to write `app_recommended` and
-- the rollups couldn't tell them apart.
-- ============================================================

alter table recommended_parlays
  drop constraint if exists recommended_parlays_source_check;

alter table recommended_parlays
  add constraint recommended_parlays_source_check
  check (source in (
    'app_recommended',
    'user_manual',
    'app_recommended_and_placed',
    'draftkings_manual',
    'auto_profit',
    'daily_plan',
    'parlay_builder',
    'edge_card_legacy'
  ));
