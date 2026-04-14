-- ============================================================
-- analytics_mlb_market_mix
--
-- Tracks resolved MLB predictions grouped by MLB Player Intelligence
-- Layer market category. Mirrors the mlbPropCategory() classification
-- from src/lib/valueParlay/mlbPropRanking.ts.
--
-- Category mapping (stat_type → category):
--   strikeouts / k / ks             → pitcher_strikeouts
--   total_bases / tb                 → hitter_total_bases
--   hits / h                         → hitter_hits
--   home_runs / hr / stolen_bases /
--   sb / rbi / runs / r              → hitter_high_vol
--   team bets (market_type != prop)  → fullgame_team
--   all other stat types             → other
--
-- Returns per-category: resolution count, hit rate, ROI, avg edge,
-- avg hit probability. Used by MlbMarketMixPanel to answer whether
-- the priority map (pitcher K > TB > hits > team bets) holds in practice.
-- ============================================================

CREATE OR REPLACE FUNCTION analytics_mlb_market_mix(
  lookback_days  integer  DEFAULT 90,
  min_resolved   integer  DEFAULT 1
)
RETURNS TABLE (
  category          text,
  stat_types        text,         -- comma-joined list of stat types in this bucket
  leg_count         bigint,
  resolved_count    bigint,
  win_count         bigint,
  hit_rate_pct      numeric,
  roi_pct           numeric,
  avg_edge          numeric,
  avg_hit_prob      numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  WITH categorised AS (
    SELECT
      CASE
        -- Pitcher strikeouts
        WHEN lower(stat_type) IN ('strikeouts', 'k', 'ks', 'strikeouts_pitched')
          THEN 'pitcher_strikeouts'

        -- Hitter total bases
        WHEN lower(stat_type) IN ('total_bases', 'tb')
          THEN 'hitter_total_bases'

        -- Hitter hits
        WHEN lower(stat_type) IN ('hits', 'h')
          THEN 'hitter_hits'

        -- High-volatility hitter props
        WHEN lower(stat_type) IN ('home_runs', 'hr', 'home_run',
                                   'stolen_bases', 'sb',
                                   'rbi', 'runs', 'r')
          THEN 'hitter_high_vol'

        -- Full-game team bets (market_type distinguishes these)
        WHEN lower(market_type) NOT IN ('prop', 'player_prop')
          THEN 'fullgame_team'

        -- Everything else
        ELSE 'other'
      END                                                           AS category,
      stat_type,
      outcome,
      edge_at_prediction,
      hit_probability_at_prediction
    FROM prediction_history
    WHERE upper(sport) = 'MLB'
      AND predicted_at >= now() - (lookback_days || ' days')::interval
  )
  SELECT
    c.category,
    string_agg(DISTINCT lower(c.stat_type), ', ' ORDER BY lower(c.stat_type))
                                                                    AS stat_types,
    count(*)                                                        AS leg_count,
    count(*) FILTER (WHERE c.outcome IS NOT NULL)                  AS resolved_count,
    count(*) FILTER (WHERE c.outcome = 'win')                      AS win_count,
    round(
      count(*) FILTER (WHERE c.outcome = 'win')::numeric
      / NULLIF(count(*) FILTER (WHERE c.outcome IS NOT NULL), 0)
      * 100
    , 1)                                                            AS hit_rate_pct,
    -- Unit ROI: +1 unit per win, −1 unit per loss (simplified; no vig adjustment)
    round(
      sum(CASE
        WHEN c.outcome = 'win'  THEN  1.0
        WHEN c.outcome = 'loss' THEN -1.0
        ELSE 0
      END) / NULLIF(count(*) FILTER (WHERE c.outcome IS NOT NULL), 0)
      * 100
    , 1)                                                            AS roi_pct,
    round(avg(c.edge_at_prediction)::numeric, 4)                   AS avg_edge,
    round(avg(c.hit_probability_at_prediction)::numeric, 3)        AS avg_hit_prob
  FROM categorised c
  GROUP BY c.category
  HAVING count(*) FILTER (WHERE c.outcome IS NOT NULL) >= min_resolved
  ORDER BY
    CASE c.category
      WHEN 'pitcher_strikeouts' THEN 1
      WHEN 'hitter_total_bases' THEN 2
      WHEN 'hitter_hits'        THEN 3
      WHEN 'fullgame_team'      THEN 4
      WHEN 'hitter_high_vol'    THEN 5
      ELSE 6
    END;
$$;

COMMENT ON FUNCTION analytics_mlb_market_mix IS
  'Returns resolved MLB prediction performance grouped by mlbPropCategory() '
  'classification. Used by MlbMarketMixPanel to validate whether the '
  'pitcher_strikeouts > hitter_total_bases > hitter_hits > fullgame_team '
  'priority ordering holds in resolved outcomes.';
