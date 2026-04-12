-- Early value label impact tracking.
--
-- Answers three empirical validation questions for the Tomorrow tab:
--   1. Do LINE VALUE props outperform EARLY VALUE props?
--   2. Does the stability threshold (0.58) improve selection quality?
--   3. Do early-value labeled legs show different conversion rates?
--
-- Two parts:
--   1. ADD early_value_label column to parlay_build_legs
--   2. analytics_early_value_impact RPC grouped by label

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. parlay_build_legs.early_value_label
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE parlay_build_legs
  ADD COLUMN IF NOT EXISTS early_value_label text;

COMMENT ON COLUMN parlay_build_legs.early_value_label IS
  'Early-value signal label at time of build. '
  '"LINE VALUE"   = |line_movement_delta_pp| >= 0.5 (line active). '
  '"OPENING EDGE" = edge >= 10% (strong model vs market gap). '
  '"EARLY VALUE"  = edge >= 6% AND stability_score >= 0.60. '
  'NULL = no early-value signal.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. analytics_early_value_impact
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Groups parlay_build_legs by early_value_label, joins prediction_history
-- for resolved outcomes. Returns one row per label + one for null (no label).
--
-- Labels:
--   "LINE VALUE"   — active line movement at build time
--   "OPENING EDGE" — high raw edge (≥10pp)
--   "EARLY VALUE"  — solid edge (≥6pp) + high stability (≥0.60)
--   "none"         — no early-value signal
--
-- Signal validation:
--   Positive if: LINE VALUE hit% > OPENING EDGE hit% >= EARLY VALUE hit% > none hit%
--   The RPC returns all buckets so the UI can compute the ordering.

CREATE OR REPLACE FUNCTION analytics_early_value_impact(
  lookback_days integer DEFAULT 30,
  min_resolved  integer DEFAULT 0
)
RETURNS TABLE (
  label           text,
  leg_count       bigint,
  parlay_count    bigint,
  resolved_count  bigint,
  win_count       bigint,
  hit_rate_pct    numeric,
  roi_pct         numeric,
  avg_edge        numeric,
  avg_stability   numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH legs AS (
    SELECT
      COALESCE(l.early_value_label, 'none')                           AS label,
      l.parlay_id,
      l.prediction_id,
      l.edge,
      l.stability_score,
      ph.outcome,
      ph.edge_at_prediction,
      ph.feature_snapshot->>'market_probability_proxy'               AS market_prob_proxy
    FROM parlay_build_legs l
    LEFT JOIN prediction_history ph
           ON ph.prediction_id = l.prediction_id
    WHERE l.created_at >= NOW() - (lookback_days || ' days')::interval
  )
  SELECT
    label,
    COUNT(*)                                                          AS leg_count,
    COUNT(DISTINCT parlay_id)                                         AS parlay_count,
    COUNT(*) FILTER (WHERE outcome IS NOT NULL)                       AS resolved_count,
    COUNT(*) FILTER (WHERE outcome = 'win')                           AS win_count,
    ROUND(
      COUNT(*) FILTER (WHERE outcome = 'win')::numeric
      / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                              AS hit_rate_pct,
    ROUND(
      SUM(CASE
        WHEN outcome = 'win'  THEN (1.0 / NULLIF(market_prob_proxy::numeric, 0)) - 1
        WHEN outcome = 'loss' THEN -1.0
        ELSE 0
      END) / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                              AS roi_pct,
    ROUND(AVG(COALESCE(edge_at_prediction, edge))::numeric, 4)        AS avg_edge,
    ROUND(AVG(stability_score)::numeric, 3)                           AS avg_stability
  FROM legs
  GROUP BY 1
  HAVING COUNT(*) FILTER (WHERE outcome IS NOT NULL) >= min_resolved
      OR COUNT(*) > 0
  ORDER BY
    CASE label
      WHEN 'LINE VALUE'   THEN 1
      WHEN 'OPENING EDGE' THEN 2
      WHEN 'EARLY VALUE'  THEN 3
      WHEN 'none'         THEN 4
      ELSE                     5
    END;
$$;
