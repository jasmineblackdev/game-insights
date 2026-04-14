-- ============================================================
-- NFL Injury Impact Analytics
--
-- Adds:
--   1. injury_impact_adj column on prediction_history
--      Stores the additive legScore adjustment applied by the
--      NFL Injury Position Multiplier (nflInjuryImpact.ts).
--      Logged by playerEdgeEnrichment → logSurfacedPredictions.
--      Default 0 for all non-NFL legs and legs with no injury context.
--
--   2. analytics_nfl_injury_impact(lookback_days, min_resolved) RPC
--      Groups resolved NFL predictions by injury impact bucket:
--        positive  → injuryImpactAdj > 0.01  (opportunity boost)
--        neutral   → injuryImpactAdj in [-0.01, 0.01]
--        negative  → injuryImpactAdj < -0.01  (efficiency drag)
--      Returns hit_rate, ROI, avg_edge, avg_adj per bucket × market_type.
--
-- Validates whether the injury layer produces better ranking:
--   positive bucket hit_rate > neutral bucket hit_rate → layer is working
--   positive ≈ neutral → widen trigger conditions
--   positive < neutral → investigate over-adjustment
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add injury_impact_adj column
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE prediction_history
  ADD COLUMN IF NOT EXISTS injury_impact_adj numeric(6,4) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_prediction_history_nfl_injury
  ON prediction_history (sport, injury_impact_adj, outcome)
  WHERE outcome IS NOT NULL;

COMMENT ON COLUMN prediction_history.injury_impact_adj IS
  'Additive legScore delta applied by the NFL Injury Position Multiplier. '
  'Positive = injury creates opportunity (e.g. RB1 out → RB2 rush props). '
  'Negative = injury weakens expected performance (e.g. OL cluster → QB yards). '
  'Zero for all non-NFL legs and NFL legs with no OUT-status positional injury.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. analytics_nfl_injury_impact RPC
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION analytics_nfl_injury_impact(
  lookback_days  integer  DEFAULT 90,
  min_resolved   integer  DEFAULT 1
)
RETURNS TABLE (
  bucket            text,      -- 'positive' | 'neutral' | 'negative'
  market_type       text,
  resolved_count    bigint,
  win_count         bigint,
  hit_rate_pct      numeric,
  roi_pct           numeric,
  avg_edge          numeric,
  avg_injury_adj    numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    CASE
      WHEN injury_impact_adj >  0.01 THEN 'positive'
      WHEN injury_impact_adj < -0.01 THEN 'negative'
      ELSE 'neutral'
    END                                                       AS bucket,
    market_type,
    count(*) FILTER (WHERE outcome IS NOT NULL)               AS resolved_count,
    count(*) FILTER (WHERE outcome = 'win')                   AS win_count,
    round(
      count(*) FILTER (WHERE outcome = 'win')::numeric
      / NULLIF(count(*) FILTER (WHERE outcome IS NOT NULL), 0)
      * 100
    , 1)                                                      AS hit_rate_pct,
    round(
      sum(CASE
        WHEN outcome = 'win'  THEN  1.0
        WHEN outcome = 'loss' THEN -1.0
        ELSE 0
      END) / NULLIF(count(*) FILTER (WHERE outcome IS NOT NULL), 0)
      * 100
    , 1)                                                      AS roi_pct,
    round(avg(edge_at_prediction)::numeric, 4)                AS avg_edge,
    round(avg(injury_impact_adj)::numeric, 4)                 AS avg_injury_adj
  FROM prediction_history
  WHERE upper(sport) = 'NFL'
    AND predicted_at >= now() - (lookback_days || ' days')::interval
  GROUP BY bucket, market_type
  HAVING count(*) FILTER (WHERE outcome IS NOT NULL) >= min_resolved
  ORDER BY
    CASE bucket
      WHEN 'positive' THEN 1
      WHEN 'neutral'  THEN 2
      WHEN 'negative' THEN 3
    END,
    market_type;
$$;

COMMENT ON FUNCTION analytics_nfl_injury_impact IS
  'Groups resolved NFL predictions by injury impact bucket (positive/neutral/negative) '
  'and market_type. Used by NflInjuryImpactPanel to validate whether the NFL Injury '
  'Position Multiplier produces better hit rates on positively-adjusted legs.';
