-- Calibration impact tracking.
--
-- Measures whether confidence calibration adjustments are actually helping
-- leg selection quality. Answers:
--   - Are "boosted" legs (adj > +0.02) winning at a higher rate than neutral?
--   - Are "penalized" legs (adj < -0.02) winning less often?
--   - How is each adjustment bucket distributed across the built parlay pool?
--
-- Two parts:
--   1. ADD conf_cal_adj column to parlay_build_legs
--   2. analytics_calibration_impact RPC (buckets by adj, joins outcomes)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. parlay_build_legs.conf_cal_adj
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE parlay_build_legs
  ADD COLUMN IF NOT EXISTS conf_cal_adj numeric(6,4);

COMMENT ON COLUMN parlay_build_legs.conf_cal_adj IS
  'Confidence calibration adjustment value at time of build, from confidenceCalibrationMap. '
  'Positive = confidence labels reliable for this market. '
  'Negative = labels unreliable/inverted. NULL = no data available at build time.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. analytics_calibration_impact
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Buckets:
--   "boosted"   conf_cal_adj >  0.02  (calibration signal: trust more)
--   "neutral"   conf_cal_adj BETWEEN -0.02 AND 0.02  (within noise band)
--   "penalized" conf_cal_adj < -0.02  (calibration signal: trust less)
--   "no_data"   conf_cal_adj IS NULL  (no calibration data at build time)
--
-- Outcome data comes from prediction_history joined by prediction_id.
-- Legs where prediction_id is null or not present in prediction_history
-- are counted in leg_count / parlay_count but excluded from resolved_count.
--
-- min_resolved gates the RPC: buckets with fewer than min_resolved
-- resolved outcomes are still returned (with null hit_rate_pct / roi_pct)
-- so the UI can show sample size even when signal is too thin.

CREATE OR REPLACE FUNCTION analytics_calibration_impact(
  lookback_days integer DEFAULT 30,
  min_resolved  integer DEFAULT 0
)
RETURNS TABLE (
  adj_bucket      text,
  leg_count       bigint,
  parlay_count    bigint,
  resolved_count  bigint,
  win_count       bigint,
  hit_rate_pct    numeric,
  roi_pct         numeric,
  avg_adj         numeric,
  avg_edge        numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH legs AS (
    SELECT
      l.conf_cal_adj,
      l.prediction_id,
      l.parlay_id,
      l.edge,
      ph.outcome,
      ph.edge_at_prediction,
      ph.feature_snapshot->>'market_probability_proxy' AS market_prob_proxy,
      CASE
        WHEN l.conf_cal_adj IS NULL         THEN 'no_data'
        WHEN l.conf_cal_adj >  0.02         THEN 'boosted'
        WHEN l.conf_cal_adj < -0.02         THEN 'penalized'
        ELSE                                     'neutral'
      END AS adj_bucket
    FROM parlay_build_legs l
    LEFT JOIN prediction_history ph
           ON ph.prediction_id = l.prediction_id
    WHERE l.created_at >= NOW() - (lookback_days || ' days')::interval
  )
  SELECT
    adj_bucket,
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
    ROUND(AVG(conf_cal_adj)::numeric, 4)                              AS avg_adj,
    ROUND(AVG(COALESCE(edge_at_prediction, edge))::numeric, 4)        AS avg_edge
  FROM legs
  GROUP BY 1
  HAVING COUNT(*) FILTER (WHERE outcome IS NOT NULL) >= min_resolved
      OR COUNT(*) > 0    -- always show bucket if any legs exist (even with 0 resolved)
  ORDER BY
    CASE adj_bucket
      WHEN 'boosted'   THEN 1
      WHEN 'neutral'   THEN 2
      WHEN 'penalized' THEN 3
      WHEN 'no_data'   THEN 4
    END;
$$;
