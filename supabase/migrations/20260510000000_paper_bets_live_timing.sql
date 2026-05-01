-- ============================================================
-- Live Paper Bet Tracking — additive columns on paper_bets.
--
-- Adds:
--   bet_timing  text 'pregame' | 'live' (default 'pregame')
--   live_state  jsonb  — entry-time game context for live bets:
--     { score_home, score_away, period, game_clock, player_stat_at_entry,
--       model_prob_at_entry, score_margin_at_entry }
--
-- Live bets resolve through the SAME resolver as pregame bets — the
-- distinction is purely for tracking + analytics. Calibration loops
-- intentionally do NOT mix live results with pregame results yet
-- (per the user's spec).
-- ============================================================

alter table public.paper_bets
  add column if not exists bet_timing text not null default 'pregame'
    check (bet_timing in ('pregame', 'live')),
  add column if not exists live_state jsonb;

-- Partial index — most rows are pregame; this lets the analytics
-- aggregator scan live rows efficiently without a full table scan.
create index if not exists paper_bets_live_idx
  on public.paper_bets (placed_at desc)
  where bet_timing = 'live';
