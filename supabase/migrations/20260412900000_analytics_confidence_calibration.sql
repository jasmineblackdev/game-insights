-- Confidence calibration analytics.
--
-- Adds:
--   1. analytics_confidence_calibration(lookback_days)
--      Overall: does HIGH actually outperform MED which outperforms LOW?
--      If not, confidence scoring is mis-calibrated for that sport/market.
--
--   2. analytics_confidence_calibration_by_sport(lookback_days)
--      Per-sport breakdown — reveals sport-specific calibration gaps.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. analytics_confidence_calibration
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function analytics_confidence_calibration(
  lookback_days integer default 30
)
returns table (
  confidence            text,
  total_predictions     bigint,
  resolved_count        bigint,
  win_count             bigint,
  hit_rate_pct          numeric,
  roi_pct               numeric,
  avg_edge              numeric,
  avg_hit_prob          numeric
)
language sql stable security definer
as $$
  select
    confidence,
    count(*)                                                          as total_predictions,
    count(*) filter (where outcome is not null)                      as resolved_count,
    count(*) filter (where outcome = 'win')                          as win_count,
    round(
      count(*) filter (where outcome = 'win')::numeric
      / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                             as hit_rate_pct,
    round(
      sum(case
        when outcome = 'win'  then (1.0 / nullif((feature_snapshot->>'market_probability_proxy')::numeric, 0)) - 1
        when outcome = 'loss' then -1.0
        else 0
      end) / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                             as roi_pct,
    round(avg(edge_at_prediction)::numeric, 4)                        as avg_edge,
    round(avg(hit_probability_at_prediction)::numeric, 3)             as avg_hit_prob
  from prediction_history
  where predicted_at >= now() - (lookback_days || ' days')::interval
  group by 1
  order by
    case confidence
      when 'HIGH' then 1
      when 'MED'  then 2
      when 'LOW'  then 3
      else 4
    end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. analytics_confidence_calibration_by_sport
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function analytics_confidence_calibration_by_sport(
  lookback_days integer default 30
)
returns table (
  sport                 text,
  confidence            text,
  total_predictions     bigint,
  resolved_count        bigint,
  win_count             bigint,
  hit_rate_pct          numeric,
  roi_pct               numeric,
  avg_edge              numeric
)
language sql stable security definer
as $$
  select
    upper(sport)                                                      as sport,
    confidence,
    count(*)                                                          as total_predictions,
    count(*) filter (where outcome is not null)                      as resolved_count,
    count(*) filter (where outcome = 'win')                          as win_count,
    round(
      count(*) filter (where outcome = 'win')::numeric
      / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                             as hit_rate_pct,
    round(
      sum(case
        when outcome = 'win'  then (1.0 / nullif((feature_snapshot->>'market_probability_proxy')::numeric, 0)) - 1
        when outcome = 'loss' then -1.0
        else 0
      end) / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                             as roi_pct,
    round(avg(edge_at_prediction)::numeric, 4)                        as avg_edge
  from prediction_history
  where predicted_at >= now() - (lookback_days || ' days')::interval
  group by 1, 2
  order by 1,
    case confidence
      when 'HIGH' then 1
      when 'MED'  then 2
      when 'LOW'  then 3
      else 4
    end;
$$;
