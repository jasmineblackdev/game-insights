-- ============================================================
-- analytics_clv_* — CLV (Closing Line Value) analytics RPCs.
--
-- CLV is the canonical "did the model beat the market?" signal,
-- regardless of whether any individual bet won or lost. Source:
--   prediction_history.extra->>'clv_pp'         (canonical, in pp)
--   prediction_history.extra->'leg'->>'line_value'          (entry line)
--   prediction_history.extra->'leg'->>'closing_line_value'  (close line)
--
-- Apples-to-apples gate: a CLV row counts toward the headline
-- metrics ONLY when either
--   (a) line data is missing on both sides (team markets — no line
--       per-leg, just price), OR
--   (b) entry_line_value === closing_line_value (same-line price move)
-- The "drifted line" cohort is exposed separately so the user can
-- see how often books moved off the entry line, and how that
-- cohort performed on its own merits.
--
-- All RPCs read-only STABLE SECURITY DEFINER — safe to call from
-- the client without a service role.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────
-- 1. analytics_clv_summary — single-row headline
-- ─────────────────────────────────────────────────────────────────────
create or replace function analytics_clv_summary(
  lookback_days integer default 30
)
returns table (
  -- Apples-to-apples cohort
  total_with_clv          bigint,
  beating_close           bigint,
  pct_beating_close       numeric,
  avg_clv_pp              numeric,
  median_clv_pp           numeric,
  -- 7-day window (subset of lookback)
  total_7d                bigint,
  pct_beating_close_7d    numeric,
  avg_clv_pp_7d           numeric,
  -- Drifted-line cohort (line moved between entry and close)
  total_drifted           bigint,
  avg_clv_pp_drifted      numeric
)
language sql stable security definer
as $$
  with rows as (
    select
      ph.created_at,
      (ph.extra->>'clv_pp')::numeric                                  as clv_pp,
      (ph.extra->'leg'->>'line_value')::numeric                       as entry_line,
      (ph.extra->'leg'->>'closing_line_value')::numeric               as close_line
    from prediction_history ph
    where ph.created_at >= now() - make_interval(days => lookback_days)
      and ph.extra ? 'clv_pp'
      and (ph.extra->>'clv_pp') ~ '^-?[0-9]+(\.[0-9]+)?$'
  ),
  classified as (
    select
      *,
      case
        when entry_line is null and close_line is null then 'team_or_unknown'
        when entry_line is null or close_line is null  then 'partial_line'
        when abs(entry_line - close_line) < 0.001      then 'same_line'
        else 'drifted'
      end as cohort
    from rows
  ),
  apples as (
    select * from classified
    where cohort in ('team_or_unknown', 'same_line')
  ),
  apples_7d as (
    select * from apples
    where created_at >= now() - interval '7 days'
  ),
  drifted as (
    select * from classified where cohort = 'drifted'
  )
  select
    (select count(*) from apples)                                                as total_with_clv,
    (select count(*) from apples where clv_pp > 0)                               as beating_close,
    round(
      (select count(*) from apples where clv_pp > 0)::numeric
      / nullif((select count(*) from apples), 0) * 100,
      1
    )                                                                            as pct_beating_close,
    round((select avg(clv_pp) from apples), 2)                                   as avg_clv_pp,
    round(
      -- percentile_cont returns double precision regardless of input
      -- type; round(double precision, int) doesn't exist, so cast.
      (select percentile_cont(0.5) within group (order by clv_pp) from apples)::numeric,
      2
    )                                                                            as median_clv_pp,
    (select count(*) from apples_7d)                                             as total_7d,
    round(
      (select count(*) from apples_7d where clv_pp > 0)::numeric
      / nullif((select count(*) from apples_7d), 0) * 100,
      1
    )                                                                            as pct_beating_close_7d,
    round((select avg(clv_pp) from apples_7d), 2)                                as avg_clv_pp_7d,
    (select count(*) from drifted)                                               as total_drifted,
    round((select avg(clv_pp) from drifted), 2)                                  as avg_clv_pp_drifted;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- 2. analytics_clv_by_sport — breakdown by sport (apples-to-apples only)
-- ─────────────────────────────────────────────────────────────────────
create or replace function analytics_clv_by_sport(
  lookback_days integer default 30
)
returns table (
  sport              text,
  n                  bigint,
  beating_close      bigint,
  pct_beating_close  numeric,
  avg_clv_pp         numeric
)
language sql stable security definer
as $$
  with rows as (
    select
      upper(coalesce(ph.sport, ''))                                  as sport,
      (ph.extra->>'clv_pp')::numeric                                 as clv_pp,
      (ph.extra->'leg'->>'line_value')::numeric                      as entry_line,
      (ph.extra->'leg'->>'closing_line_value')::numeric              as close_line
    from prediction_history ph
    where ph.created_at >= now() - make_interval(days => lookback_days)
      and ph.extra ? 'clv_pp'
      and (ph.extra->>'clv_pp') ~ '^-?[0-9]+(\.[0-9]+)?$'
  ),
  apples as (
    select * from rows
    where (entry_line is null and close_line is null)
       or (entry_line is not null and close_line is not null
           and abs(entry_line - close_line) < 0.001)
  )
  select
    sport,
    count(*)                                                          as n,
    count(*) filter (where clv_pp > 0)                                as beating_close,
    round(
      count(*) filter (where clv_pp > 0)::numeric
      / nullif(count(*), 0) * 100,
      1
    )                                                                 as pct_beating_close,
    round(avg(clv_pp), 2)                                             as avg_clv_pp
  from apples
  where sport <> ''
  group by sport
  order by n desc;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- 3. analytics_clv_by_market — breakdown by market type
-- ─────────────────────────────────────────────────────────────────────
create or replace function analytics_clv_by_market(
  lookback_days integer default 30
)
returns table (
  market_type        text,
  n                  bigint,
  beating_close      bigint,
  pct_beating_close  numeric,
  avg_clv_pp         numeric
)
language sql stable security definer
as $$
  with rows as (
    select
      coalesce(ph.market_type, 'unknown')                            as market_type,
      (ph.extra->>'clv_pp')::numeric                                 as clv_pp,
      (ph.extra->'leg'->>'line_value')::numeric                      as entry_line,
      (ph.extra->'leg'->>'closing_line_value')::numeric              as close_line
    from prediction_history ph
    where ph.created_at >= now() - make_interval(days => lookback_days)
      and ph.extra ? 'clv_pp'
      and (ph.extra->>'clv_pp') ~ '^-?[0-9]+(\.[0-9]+)?$'
  ),
  apples as (
    select * from rows
    where (entry_line is null and close_line is null)
       or (entry_line is not null and close_line is not null
           and abs(entry_line - close_line) < 0.001)
  )
  select
    market_type,
    count(*)                                                          as n,
    count(*) filter (where clv_pp > 0)                                as beating_close,
    round(
      count(*) filter (where clv_pp > 0)::numeric
      / nullif(count(*), 0) * 100,
      1
    )                                                                 as pct_beating_close,
    round(avg(clv_pp), 2)                                             as avg_clv_pp
  from apples
  group by market_type
  order by n desc;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- 4. analytics_clv_by_sport_market — sport × market crossed
-- ─────────────────────────────────────────────────────────────────────
create or replace function analytics_clv_by_sport_market(
  lookback_days integer default 30
)
returns table (
  sport              text,
  market_type        text,
  n                  bigint,
  beating_close      bigint,
  pct_beating_close  numeric,
  avg_clv_pp         numeric
)
language sql stable security definer
as $$
  with rows as (
    select
      upper(coalesce(ph.sport, ''))                                  as sport,
      coalesce(ph.market_type, 'unknown')                            as market_type,
      (ph.extra->>'clv_pp')::numeric                                 as clv_pp,
      (ph.extra->'leg'->>'line_value')::numeric                      as entry_line,
      (ph.extra->'leg'->>'closing_line_value')::numeric              as close_line
    from prediction_history ph
    where ph.created_at >= now() - make_interval(days => lookback_days)
      and ph.extra ? 'clv_pp'
      and (ph.extra->>'clv_pp') ~ '^-?[0-9]+(\.[0-9]+)?$'
  ),
  apples as (
    select * from rows
    where (entry_line is null and close_line is null)
       or (entry_line is not null and close_line is not null
           and abs(entry_line - close_line) < 0.001)
  )
  select
    sport,
    market_type,
    count(*)                                                          as n,
    count(*) filter (where clv_pp > 0)                                as beating_close,
    round(
      count(*) filter (where clv_pp > 0)::numeric
      / nullif(count(*), 0) * 100,
      1
    )                                                                 as pct_beating_close,
    round(avg(clv_pp), 2)                                             as avg_clv_pp
  from apples
  where sport <> ''
  group by sport, market_type
  order by n desc;
$$;

grant execute on function analytics_clv_summary(integer)          to anon, authenticated;
grant execute on function analytics_clv_by_sport(integer)         to anon, authenticated;
grant execute on function analytics_clv_by_market(integer)        to anon, authenticated;
grant execute on function analytics_clv_by_sport_market(integer)  to anon, authenticated;
