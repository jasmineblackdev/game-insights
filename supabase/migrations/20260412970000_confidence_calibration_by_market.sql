-- Confidence calibration by market type (stat_type × confidence level).
--
-- Answers: are HIGH/MED/LOW confidence labels behaving correctly within
-- each sport's specific market types?
--
-- Example questions this answers:
--   - NBA assists: HIGH confidence 68% hit rate vs LOW 41%? (well calibrated)
--   - MLB strikeouts: HIGH 57% vs LOW 54%? (labels doing almost nothing)
--   - Boxing rounds: too few resolved to say anything yet
--
-- Gated by min_resolved (default 5) per sport/market/confidence combination
-- to prevent surfacing noise from one or two outcomes.

CREATE OR REPLACE FUNCTION analytics_confidence_calibration_by_market(
  lookback_days integer DEFAULT 30,
  min_resolved  integer DEFAULT 5
)
RETURNS TABLE (
  sport              text,
  stat_type          text,
  confidence         text,
  total_predictions  bigint,
  resolved_count     bigint,
  win_count          bigint,
  hit_rate_pct       numeric,
  roi_pct            numeric,
  avg_edge           numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    upper(sport)                                                         AS sport,
    COALESCE(stat_type, 'unknown')                                       AS stat_type,
    confidence,
    COUNT(*)                                                             AS total_predictions,
    COUNT(*) FILTER (WHERE outcome IS NOT NULL)                          AS resolved_count,
    COUNT(*) FILTER (WHERE outcome = 'win')                              AS win_count,
    ROUND(
      COUNT(*) FILTER (WHERE outcome = 'win')::numeric
      / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                                 AS hit_rate_pct,
    ROUND(
      SUM(CASE
        WHEN outcome = 'win'  THEN (1.0 / NULLIF((feature_snapshot->>'market_probability_proxy')::numeric, 0)) - 1
        WHEN outcome = 'loss' THEN -1.0
        ELSE 0
      END) / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                                 AS roi_pct,
    ROUND(AVG(edge_at_prediction)::numeric, 4)                           AS avg_edge
  FROM prediction_history
  WHERE predicted_at >= NOW() - (lookback_days || ' days')::interval
    AND confidence IS NOT NULL
  GROUP BY 1, 2, 3
  HAVING COUNT(*) FILTER (WHERE outcome IS NOT NULL) >= min_resolved
  ORDER BY 1, 2,
    CASE confidence
      WHEN 'HIGH' THEN 1
      WHEN 'MED'  THEN 2
      WHEN 'LOW'  THEN 3
      ELSE 4
    END;
$$;
