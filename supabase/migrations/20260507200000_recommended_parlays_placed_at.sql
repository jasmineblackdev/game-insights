-- ============================================================
-- Add placed_at timestamp to recommended_parlays so the bridge can
-- record when the user actually placed each parlay (vs just when the
-- optimizer recommended it). The bridge already reads each leg's
-- american_odds; "Mark as placed" now also stamps each leg with
-- odds_at_placement (in legs jsonb) so we can compute the partial
-- CLV signal:
--
--   clv_at_placement = implied(odds_at_placement) - implied(odds_at_recommendation)
--
-- This measures line movement between recommend and place, which is
-- the sharp-agreement half of full CLV. The closing-line half still
-- needs a polling job to capture odds near kickoff — that's a
-- separate change.
-- ============================================================

alter table recommended_parlays
  add column if not exists placed_at timestamptz;

create index if not exists recommended_parlays_placed_at_idx
  on recommended_parlays (placed_at desc)
  where placed_at is not null;
