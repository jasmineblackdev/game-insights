-- Early value label impact by sport.
--
-- Breaks analytics_early_value_impact down by sport so we can answer:
--   - LINE VALUE validated in NBA but sparse in MLB?
--   - OPENING EDGE reliable in MLB (more stat-stable lines)?
--   - Combat sports still no-label at expected high rate?
--
-- Returns one row per (sport, label).
-- no_label_pct: fraction of that sport's legs with NULL/no early-value label.
-- Same value for every row of a sport; lets UI show signal maturity per sport.

CREATE OR REPLACE FUNCTION analytics_early_value_impact_by_sport(
  lookback_days integer DEFAULT 30
)
RETURNS TABLE (
  sport           text,
  label           text,
  leg_count       bigint,
  resolved_count  bigint,
  win_count       bigint,
  hit_rate_pct    numeric,
  roi_pct         numeric,
  avg_edge        numeric,
  avg_stability   numeric,
  -- Fraction (0–1) of this sport's legs with no early-value label.
  -- Same for every row of the sport; signals how mature the label is per sport.
  no_label_pct    numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH legs AS (
    SELECT
      upper(l.sport)                                                   AS sport,
      COALESCE(l.early_value_label, 'none')                            AS label,
      l.parlay_id,
      l.prediction_id,
      l.edge,
      l.stability_score,
      ph.outcome,
      ph.edge_at_prediction,
      ph.feature_snapshot->>'market_probability_proxy'                AS market_prob_proxy
    FROM parlay_build_legs l
    LEFT JOIN prediction_history ph
           ON ph.prediction_id = l.prediction_id
    WHERE l.created_at >= NOW() - (lookback_days || ' days')::interval
  ),
  sport_totals AS (
    SELECT
      sport,
      COUNT(*)                                          AS total_legs,
      COUNT(*) FILTER (WHERE label = 'none')            AS no_label_legs
    FROM legs
    GROUP BY 1
  )
  SELECT
    l.sport,
    l.label,
    COUNT(*)                                                           AS leg_count,
    COUNT(*) FILTER (WHERE outcome IS NOT NULL)                        AS resolved_count,
    COUNT(*) FILTER (WHERE outcome = 'win')                            AS win_count,
    ROUND(
      COUNT(*) FILTER (WHERE outcome = 'win')::numeric
      / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                               AS hit_rate_pct,
    ROUND(
      SUM(CASE
        WHEN outcome = 'win'  THEN (1.0 / NULLIF(market_prob_proxy::numeric, 0)) - 1
        WHEN outcome = 'loss' THEN -1.0
        ELSE 0
      END) / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                               AS roi_pct,
    ROUND(AVG(COALESCE(edge_at_prediction, edge))::numeric, 4)         AS avg_edge,
    ROUND(AVG(stability_score)::numeric, 3)                            AS avg_stability,
    ROUND(st.no_label_legs::numeric / NULLIF(st.total_legs, 0), 3)    AS no_label_pct
  FROM legs l
  JOIN sport_totals st USING (sport)
  GROUP BY l.sport, l.label, st.no_label_legs, st.total_legs
  ORDER BY
    l.sport,
    CASE l.label
      WHEN 'LINE VALUE'   THEN 1
      WHEN 'OPENING EDGE' THEN 2
      WHEN 'EARLY VALUE'  THEN 3
      WHEN 'none'         THEN 4
      ELSE                     5
    END;
$$;
