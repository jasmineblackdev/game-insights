-- Sport-level analytics breakdown RPCs.
--
-- Adds:
--   1. analytics_timing_by_sport()               — timing hit rate/ROI per sport
--   2. analytics_recommended_vs_excluded_by_sport() — filter quality per sport
--   3. analytics_roi_by_market_type()             — ROI per stat_type / market
--   4. analytics_resolution_completeness()        — % resolved by sport (pipeline health)
--
-- All read-only STABLE SECURITY DEFINER — safe to call from client.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. analytics_timing_by_sport
-- ─────────────────────────────────────────────────────────────────────────────
-- Timing performance split by sport — reveals whether now/monitor/wait
-- behaves consistently across NBA/MLB/MMA/etc or needs per-sport tuning.
create or replace function analytics_timing_by_sport(
  lookback_days integer default 30
)
returns table (
  sport                 text,
  timing_bucket         text,
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
    upper(sport)                                                     as sport,
    coalesce(feature_snapshot->>'timing_bucket', 'monitor')          as timing_bucket,
    count(*)                                                         as total_predictions,
    count(*) filter (where outcome is not null)                     as resolved_count,
    count(*) filter (where outcome = 'win')                         as win_count,
    round(
      count(*) filter (where outcome = 'win')::numeric
      / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                            as hit_rate_pct,
    round(
      sum(case
        when outcome = 'win'  then (1.0 / nullif((feature_snapshot->>'market_probability_proxy')::numeric, 0)) - 1
        when outcome = 'loss' then -1.0
        else 0
      end) / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                            as roi_pct,
    round(avg(edge_at_prediction)::numeric, 4)                       as avg_edge
  from prediction_history
  where predicted_at >= now() - (lookback_days || ' days')::interval
  group by 1, 2
  order by 1,
    case coalesce(feature_snapshot->>'timing_bucket', 'monitor')
      when 'now'     then 1
      when 'monitor' then 2
      when 'wait'    then 3
      else 4
    end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. analytics_recommended_vs_excluded_by_sport
-- ─────────────────────────────────────────────────────────────────────────────
-- Reveals whether the parlay filter works well across all sports, or whether
-- specific sports (e.g., combat sports) are being over-filtered.
-- Joins candidate_analytics_log + prediction_history on ml-prop- prefix.
create or replace function analytics_recommended_vs_excluded_by_sport(
  lookback_days integer default 30
)
returns table (
  sport                 text,
  is_recommended        boolean,
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
      sport,
      is_recommended
    from candidate_analytics_log
    where candidate_id like 'ml-prop-%'
      and logged_at >= now() - (lookback_days || ' days')::interval
    order by candidate_id, logged_at desc
  )
  select
    upper(lc.sport)                                                  as sport,
    lc.is_recommended,
    count(*)                                                         as total_matched,
    count(*) filter (where ph.outcome is not null)                  as resolved_count,
    count(*) filter (where ph.outcome = 'win')                      as win_count,
    round(
      count(*) filter (where ph.outcome = 'win')::numeric
      / nullif(count(*) filter (where ph.outcome is not null), 0) * 100
    , 1)                                                            as hit_rate_pct,
    round(
      sum(case
        when ph.outcome = 'win'  then (1.0 / nullif((ph.feature_snapshot->>'market_probability_proxy')::numeric, 0)) - 1
        when ph.outcome = 'loss' then -1.0
        else 0
      end) / nullif(count(*) filter (where ph.outcome is not null), 0) * 100
    , 1)                                                            as roi_pct,
    round(avg(ph.edge_at_prediction)::numeric, 4)                    as avg_edge
  from latest_candidates lc
  join prediction_history ph
    on ph.prediction_id = regexp_replace(lc.candidate_id, '^ml-prop-', '')
  group by 1, 2
  order by 1, 2 desc; -- recommended=true first within each sport
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. analytics_roi_by_market_type
-- ─────────────────────────────────────────────────────────────────────────────
-- ROI and hit rate broken down by stat_type (e.g., points, rebounds, strikeouts).
-- Shows which prop markets the model understands best — highest signal for
-- deciding where to invest model improvement effort.
-- Minimum 3 resolved predictions to surface a market (reduces noise).
create or replace function analytics_roi_by_market_type(
  lookback_days integer default 30,
  min_resolved  integer default 3
)
returns table (
  sport                 text,
  stat_type             text,
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
    upper(sport)                                                     as sport,
    stat_type,
    count(*)                                                         as total_predictions,
    count(*) filter (where outcome is not null)                     as resolved_count,
    count(*) filter (where outcome = 'win')                         as win_count,
    round(
      count(*) filter (where outcome = 'win')::numeric
      / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                            as hit_rate_pct,
    round(
      sum(case
        when outcome = 'win'  then (1.0 / nullif((feature_snapshot->>'market_probability_proxy')::numeric, 0)) - 1
        when outcome = 'loss' then -1.0
        else 0
      end) / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                            as roi_pct,
    round(avg(edge_at_prediction)::numeric, 4)                       as avg_edge
  from prediction_history
  where predicted_at >= now() - (lookback_days || ' days')::interval
  group by 1, 2
  having count(*) filter (where outcome is not null) >= min_resolved
  order by roi_pct desc nulls last;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. analytics_resolution_completeness
-- ─────────────────────────────────────────────────────────────────────────────
-- Pipeline health check: how many surfaced predictions have resolved outcomes?
-- Low resolution rates mean analytics are biased toward early picks only.
-- Breaks down by sport so you can see which sports resolve poorly.
create or replace function analytics_resolution_completeness(
  lookback_days integer default 30
)
returns table (
  sport                 text,
  total_surfaced        bigint,
  resolved_count        bigint,
  pending_count         bigint,
  resolution_pct        numeric,
  -- Picks older than 24h still pending (should have resolved by now)
  stale_pending         bigint
)
language sql stable security definer
as $$
  select
    upper(sport)                                                      as sport,
    count(*)                                                          as total_surfaced,
    count(*) filter (where outcome is not null)                      as resolved_count,
    count(*) filter (where outcome is null)                          as pending_count,
    round(
      count(*) filter (where outcome is not null)::numeric
      / nullif(count(*), 0) * 100
    , 1)                                                             as resolution_pct,
    -- Stale: still pending but predicted >24h ago (game should be done)
    count(*) filter (
      where outcome is null
        and predicted_at < now() - interval '24 hours'
    )                                                                as stale_pending
  from prediction_history
  where predicted_at >= now() - (lookback_days || ' days')::interval
  group by 1
  order by resolution_pct asc; -- worst resolvers first
$$;
