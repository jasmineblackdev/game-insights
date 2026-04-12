-- Additional analytics RPCs for model comparison and ROI breakdowns.
--
-- Adds:
--   1. analytics_recommended_vs_excluded() — parlay filter quality validation
--      Joins candidate_analytics_log (is_recommended) with prediction_history (outcome)
--      to prove whether recommended candidates actually outperform excluded ones.
--
--   2. analytics_roi_by_sport()            — ROI + hit rate per sport
--   3. analytics_roi_by_risk_band()        — ROI + hit rate per risk band
--
-- Depends on: candidate_analytics_log (migration 20260412600000)
--             prediction_history (migration 20260412500000)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. analytics_recommended_vs_excluded
-- ─────────────────────────────────────────────────────────────────────────────
-- How it works:
--   candidate_analytics_log.candidate_id for ML props = 'ml-prop-' || prediction_id
--   We strip the prefix to join with prediction_history.prediction_id.
--
--   Only ML prop candidates (candidate_id LIKE 'ml-prop-%') can be joined since
--   game-level candidates (vp-*) are not logged to prediction_history.
--
--   Use the most recent candidate_analytics_log entry per candidate to determine
--   its is_recommended status (it can change across sessions as model evolves).
create or replace function analytics_recommended_vs_excluded(
  lookback_days integer default 30
)
returns table (
  is_recommended        boolean,
  total_matched         bigint,
  resolved_count        bigint,
  win_count             bigint,
  loss_count            bigint,
  hit_rate_pct          numeric,
  roi_pct               numeric,
  avg_edge              numeric
)
language sql stable security definer
as $$
  with latest_candidates as (
    -- Most recent is_recommended status per candidate (handles model evolution)
    select distinct on (candidate_id)
      candidate_id,
      is_recommended
    from candidate_analytics_log
    where candidate_id like 'ml-prop-%'
      and logged_at >= now() - (lookback_days || ' days')::interval
    order by candidate_id, logged_at desc
  ),
  joined as (
    select
      lc.is_recommended,
      ph.outcome,
      ph.edge_at_prediction,
      ph.feature_snapshot->>'market_probability_proxy' as market_prob_str
    from latest_candidates lc
    join prediction_history ph
      on ph.prediction_id = regexp_replace(lc.candidate_id, '^ml-prop-', '')
  )
  select
    is_recommended,
    count(*)                                                        as total_matched,
    count(*) filter (where outcome is not null)                    as resolved_count,
    count(*) filter (where outcome = 'win')                        as win_count,
    count(*) filter (where outcome = 'loss')                       as loss_count,
    round(
      count(*) filter (where outcome = 'win')::numeric
      / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                           as hit_rate_pct,
    round(
      sum(case
        when outcome = 'win'  then (1.0 / nullif(market_prob_str::numeric, 0)) - 1
        when outcome = 'loss' then -1.0
        else 0
      end) / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                           as roi_pct,
    round(avg(edge_at_prediction)::numeric, 4)                     as avg_edge
  from joined
  group by 1
  order by 1 desc; -- recommended=true first
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. analytics_roi_by_sport
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function analytics_roi_by_sport(
  lookback_days integer default 30
)
returns table (
  sport                 text,
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
    upper(sport)                                                   as sport,
    count(*)                                                       as total_predictions,
    count(*) filter (where outcome is not null)                   as resolved_count,
    count(*) filter (where outcome = 'win')                       as win_count,
    round(
      count(*) filter (where outcome = 'win')::numeric
      / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                          as hit_rate_pct,
    round(
      sum(case
        when outcome = 'win'  then (1.0 / nullif((feature_snapshot->>'market_probability_proxy')::numeric, 0)) - 1
        when outcome = 'loss' then -1.0
        else 0
      end) / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                          as roi_pct,
    round(avg(edge_at_prediction)::numeric, 4)                    as avg_edge,
    round(avg(hit_probability_at_prediction)::numeric, 3)         as avg_hit_prob
  from prediction_history
  where predicted_at >= now() - (lookback_days || ' days')::interval
  group by 1
  order by resolved_count desc;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. analytics_roi_by_risk_band
-- ─────────────────────────────────────────────────────────────────────────────
-- Reads risk_band from candidate_analytics_log (not in prediction_history).
-- Joins on candidate_id = 'ml-prop-' || prediction_id.
create or replace function analytics_roi_by_risk_band(
  lookback_days integer default 30
)
returns table (
  risk_band             text,
  total_matched         bigint,
  resolved_count        bigint,
  win_count             bigint,
  hit_rate_pct          numeric,
  roi_pct               numeric,
  avg_edge              numeric
)
language sql stable security definer
as $$
  with latest_candidates as (
    select distinct on (candidate_id)
      candidate_id,
      risk_band
    from candidate_analytics_log
    where candidate_id like 'ml-prop-%'
      and logged_at >= now() - (lookback_days || ' days')::interval
    order by candidate_id, logged_at desc
  )
  select
    lc.risk_band,
    count(*)                                                        as total_matched,
    count(*) filter (where ph.outcome is not null)                 as resolved_count,
    count(*) filter (where ph.outcome = 'win')                     as win_count,
    round(
      count(*) filter (where ph.outcome = 'win')::numeric
      / nullif(count(*) filter (where ph.outcome is not null), 0) * 100
    , 1)                                                           as hit_rate_pct,
    round(
      sum(case
        when ph.outcome = 'win'  then (1.0 / nullif((ph.feature_snapshot->>'market_probability_proxy')::numeric, 0)) - 1
        when ph.outcome = 'loss' then -1.0
        else 0
      end) / nullif(count(*) filter (where ph.outcome is not null), 0) * 100
    , 1)                                                           as roi_pct,
    round(avg(ph.edge_at_prediction)::numeric, 4)                  as avg_edge
  from latest_candidates lc
  join prediction_history ph
    on ph.prediction_id = regexp_replace(lc.candidate_id, '^ml-prop-', '')
  group by 1
  order by
    case lc.risk_band
      when 'low'      then 1
      when 'moderate' then 2
      when 'elevated' then 3
      when 'high'     then 4
      else 5
    end;
$$;
