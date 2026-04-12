-- Analytics infrastructure for GameLens model validation.
--
-- Adds:
--   1. candidate_analytics_log  — all candidates (inc. excluded) per build session
--   2. analytics_timing_bucket_performance()  — hit rate + ROI by timing bucket
--   3. analytics_stability_vs_outcome()       — stability_score → win rate correlation
--   4. analytics_exclusion_frequency()        — why candidates are excluded (7/30d)
--   5. analytics_safe_pool_depth()            — safe-eligible candidates by sport/day
--
-- All RPCs read-only (STABLE SECURITY DEFINER) — safe to call from client.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. candidate_analytics_log
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists candidate_analytics_log (
  id                uuid primary key default gen_random_uuid(),
  -- Client-generated session ID so we can dedupe within a session
  session_id        text not null,
  -- ValueBetCandidate.id from the parlay build pipeline
  candidate_id      text not null,
  sport             text not null,
  pick_type         text not null,     -- team_pick | spread | total | player_prop
  is_recommended    boolean not null,
  -- Null when recommended; present for excluded candidates
  exclusion_reason  text,
  -- Timing signals (null for game-level picks without ML timing)
  timing_urgency    text,             -- now | monitor | wait
  timing_score      numeric,
  -- Risk/value signals
  volatility_score  numeric not null default 0,
  edge              numeric not null default 0,
  confidence        text not null,
  risk_band         text not null,
  value_score       numeric not null default 0,
  logged_at         timestamptz not null default now()
);

-- Index for exclusion reason distribution queries
create index if not exists candidate_log_exclusion_reason
  on candidate_analytics_log (exclusion_reason, logged_at desc)
  where exclusion_reason is not null;

-- Index for safe pool depth queries (sport × timing × date)
create index if not exists candidate_log_sport_timing_date
  on candidate_analytics_log (sport, timing_urgency, logged_at desc);

-- Index for session dedup check
create index if not exists candidate_log_session_candidate
  on candidate_analytics_log (session_id, candidate_id);

alter table candidate_analytics_log enable row level security;

create policy "candidate_log_read" on candidate_analytics_log
  for select using (true);

create policy "candidate_log_write" on candidate_analytics_log
  for all using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. analytics_timing_bucket_performance
-- ─────────────────────────────────────────────────────────────────────────────
-- Hit rate and ROI by timing bucket over a rolling window.
-- ROI uses market_probability_proxy from feature_snapshot to approximate payout.
-- Formula: ROI% = sum(profit per $1 stake) / resolved_count * 100
--   WIN:  profit = (1 / market_prob) - 1
--   LOSS: profit = -1
create or replace function analytics_timing_bucket_performance(
  lookback_days integer default 30
)
returns table (
  timing_bucket          text,
  total_predictions      bigint,
  resolved_predictions   bigint,
  wins                   bigint,
  losses                 bigint,
  hit_rate_pct           numeric,
  roi_pct                numeric,
  avg_edge               numeric,
  avg_hit_prob           numeric
)
language sql stable security definer
as $$
  select
    coalesce(feature_snapshot->>'timing_bucket', 'monitor')             as timing_bucket,
    count(*)                                                            as total_predictions,
    count(*) filter (where outcome is not null)                        as resolved_predictions,
    count(*) filter (where outcome = 'win')                            as wins,
    count(*) filter (where outcome = 'loss')                           as losses,
    round(
      count(*) filter (where outcome = 'win')::numeric
      / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                               as hit_rate_pct,
    round(
      sum(case
        when outcome = 'win' then
          (1.0 / nullif((feature_snapshot->>'market_probability_proxy')::numeric, 0)) - 1
        when outcome = 'loss' then -1.0
        else 0
      end) / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                               as roi_pct,
    round(avg(edge_at_prediction)::numeric, 4)                         as avg_edge,
    round(avg(hit_probability_at_prediction)::numeric, 3)              as avg_hit_prob
  from prediction_history
  where predicted_at >= now() - (lookback_days || ' days')::interval
  group by 1
  order by
    case coalesce(feature_snapshot->>'timing_bucket', 'monitor')
      when 'now'     then 1
      when 'monitor' then 2
      when 'wait'    then 3
      else 4
    end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. analytics_stability_vs_outcome
-- ─────────────────────────────────────────────────────────────────────────────
-- Correlates stability_score (from feature_snapshot) with resolved outcomes.
-- Validates whether high-stability picks actually win more often.
create or replace function analytics_stability_vs_outcome(
  lookback_days integer default 30
)
returns table (
  stability_bucket       text,
  total                  bigint,
  win_count              bigint,
  hit_rate_pct           numeric,
  avg_stability_score    numeric,
  avg_edge               numeric
)
language sql stable security definer
as $$
  select
    case
      when (feature_snapshot->>'stability_score')::numeric >= 0.70 then 'high (≥0.70)'
      when (feature_snapshot->>'stability_score')::numeric >= 0.40 then 'medium (0.40–0.69)'
      when (feature_snapshot->>'stability_score') is not null       then 'low (<0.40)'
      else 'untagged'
    end                                                              as stability_bucket,
    count(*)                                                         as total,
    count(*) filter (where outcome = 'win')                         as win_count,
    round(
      count(*) filter (where outcome = 'win')::numeric
      / nullif(count(*) filter (where outcome is not null), 0) * 100
    , 1)                                                             as hit_rate_pct,
    round(avg((feature_snapshot->>'stability_score')::numeric), 3)  as avg_stability_score,
    round(avg(edge_at_prediction)::numeric, 4)                       as avg_edge
  from prediction_history
  where outcome is not null
    and predicted_at >= now() - (lookback_days || ' days')::interval
  group by 1
  order by avg_stability_score desc nulls last;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. analytics_exclusion_frequency
-- ─────────────────────────────────────────────────────────────────────────────
-- Exclusion reason distribution from candidate_analytics_log.
-- Use to detect overfire: if one reason accounts for >60% of exclusions,
-- that filter may be too strict.
create or replace function analytics_exclusion_frequency(
  lookback_days integer default 30
)
returns table (
  exclusion_reason       text,
  exclusion_count        bigint,
  pct_of_excluded        numeric
)
language sql stable security definer
as $$
  with excluded as (
    select coalesce(exclusion_reason, 'Untagged') as reason
    from candidate_analytics_log
    where is_recommended = false
      and logged_at >= now() - (lookback_days || ' days')::interval
  ),
  total as (select count(*) as n from excluded)
  select
    e.reason                                                          as exclusion_reason,
    count(*)                                                          as exclusion_count,
    round(count(*)::numeric / nullif((select n from total), 0) * 100, 1)
                                                                     as pct_of_excluded
  from excluded e
  group by 1
  order by 2 desc;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. analytics_safe_pool_depth
-- ─────────────────────────────────────────────────────────────────────────────
-- Safe-eligible candidates (not "wait", risk = low/moderate) by sport per day.
-- Tracks whether safe mode pool thins on slower slates (especially combat sports).
create or replace function analytics_safe_pool_depth(
  lookback_days integer default 30
)
returns table (
  day                    date,
  sport                  text,
  safe_eligible          bigint,
  total_candidates       bigint,
  safe_pct               numeric
)
language sql stable security definer
as $$
  select
    logged_at::date                                                   as day,
    sport,
    count(*) filter (
      where timing_urgency != 'wait'
        and risk_band in ('low', 'moderate')
    )                                                                 as safe_eligible,
    count(*)                                                          as total_candidates,
    round(
      count(*) filter (
        where timing_urgency != 'wait'
          and risk_band in ('low', 'moderate')
      )::numeric / nullif(count(*), 0) * 100
    , 1)                                                             as safe_pct
  from candidate_analytics_log
  where logged_at >= now() - (lookback_days || ' days')::interval
  group by 1, 2
  order by 1 desc, 2;
$$;
