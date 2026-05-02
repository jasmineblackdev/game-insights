-- ============================================================
-- analytics_clv_per_pick — per-prediction CLV outcome bucket.
--
-- The existing CLV stack (20260511) reports apples-to-apples vs
-- drifted-line aggregates. This RPC adds a finer enum bucket per
-- pick so the dashboard can distribute outcomes into:
--
--   beat_close     — clv_pp > 0 on apples-to-apples cohort
--   lost_to_close  — clv_pp < 0 on apples-to-apples cohort
--   same           — abs(clv_pp) < 0.01 on apples-to-apples cohort
--   line_changed   — line moved between entry and close (drifted
--                    cohort, kept separate so it doesn't pollute
--                    the headline beat-rate)
--   unavailable    — clv_pp missing OR partial_line cohort (one
--                    side of the line absent)
--
-- Reads from prediction_history only. No optimizer impact.
-- No recommendation logic changes. Pure aggregation.
-- ============================================================

create or replace function analytics_clv_results_summary(
  lookback_days integer default 30
)
returns table (
  total                  bigint,
  beat_close             bigint,
  lost_to_close          bigint,
  same                   bigint,
  line_changed           bigint,
  unavailable            bigint,
  pct_beat_close_apples  numeric,
  pct_beat_close_drifted numeric
)
language sql
stable
security definer
as $$
  with rows as (
    select
      ph.created_at,
      case
        when (ph.extra->>'clv_pp') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (ph.extra->>'clv_pp')::numeric
        else null
      end                                                            as clv_pp,
      (ph.extra->'leg'->>'line_value')::numeric                      as entry_line,
      (ph.extra->'leg'->>'closing_line_value')::numeric              as close_line
    from prediction_history ph
    where ph.created_at >= now() - make_interval(days => lookback_days)
  ),
  classified as (
    select
      *,
      case
        when entry_line is null and close_line is null then 'team_or_unknown'
        when entry_line is null or close_line is null  then 'partial_line'
        when abs(entry_line - close_line) < 0.001      then 'same_line'
        else 'drifted'
      end                                                            as cohort,
      case
        -- unavailable trumps everything: no clv_pp OR partial line
        when clv_pp is null
          or (entry_line is null) <> (close_line is null) then 'unavailable'
        -- line moved → separate bucket regardless of sign
        when entry_line is not null and close_line is not null
          and abs(entry_line - close_line) >= 0.001     then 'line_changed'
        when abs(coalesce(clv_pp, 0)) < 0.01            then 'same'
        when clv_pp > 0                                 then 'beat_close'
        else                                                 'lost_to_close'
      end                                                            as clv_result
    from rows
  ),
  apples as (
    select * from classified where cohort in ('team_or_unknown', 'same_line')
  ),
  drifted as (
    select * from classified where cohort = 'drifted'
  )
  select
    (select count(*) from classified)                                as total,
    (select count(*) from classified where clv_result = 'beat_close')    as beat_close,
    (select count(*) from classified where clv_result = 'lost_to_close') as lost_to_close,
    (select count(*) from classified where clv_result = 'same')          as same,
    (select count(*) from classified where clv_result = 'line_changed')  as line_changed,
    (select count(*) from classified where clv_result = 'unavailable')   as unavailable,
    -- Headline beat-rate restricted to the apples-to-apples cohort
    -- so a drifted-line winner doesn't inflate the number that the
    -- dashboard advertises as "% beating close".
    round(
      100.0 * (select count(*) from apples where coalesce(clv_pp, 0) > 0)::numeric
      / nullif((select count(*) from apples where clv_pp is not null), 0),
      1
    )                                                                as pct_beat_close_apples,
    round(
      100.0 * (select count(*) from drifted where coalesce(clv_pp, 0) > 0)::numeric
      / nullif((select count(*) from drifted where clv_pp is not null), 0),
      1
    )                                                                as pct_beat_close_drifted;
$$;

comment on function analytics_clv_results_summary is
  'Per-pick CLV outcome bucket distribution + headline beat-rate split by cohort (apples-to-apples vs line-changed). Reads prediction_history.extra. No optimizer impact.';

-- ─────────────────────────────────────────────────────────────────────
-- Same shape, segmented by sport, so the dashboard can surface
-- which sports are systematically beating / losing to the close.
-- ─────────────────────────────────────────────────────────────────────
create or replace function analytics_clv_results_by_sport(
  lookback_days integer default 30
)
returns table (
  sport         text,
  total         bigint,
  beat_close    bigint,
  lost_to_close bigint,
  same          bigint,
  line_changed  bigint,
  unavailable   bigint
)
language sql
stable
security definer
as $$
  with rows as (
    select
      ph.sport,
      case
        when (ph.extra->>'clv_pp') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (ph.extra->>'clv_pp')::numeric
        else null
      end                                                            as clv_pp,
      (ph.extra->'leg'->>'line_value')::numeric                      as entry_line,
      (ph.extra->'leg'->>'closing_line_value')::numeric              as close_line
    from prediction_history ph
    where ph.created_at >= now() - make_interval(days => lookback_days)
  ),
  classified as (
    select
      sport,
      clv_pp,
      case
        when clv_pp is null
          or (entry_line is null) <> (close_line is null) then 'unavailable'
        when entry_line is not null and close_line is not null
          and abs(entry_line - close_line) >= 0.001     then 'line_changed'
        when abs(coalesce(clv_pp, 0)) < 0.01            then 'same'
        when clv_pp > 0                                 then 'beat_close'
        else                                                 'lost_to_close'
      end                                                            as clv_result
    from rows
  )
  select
    sport,
    count(*)::bigint                                               as total,
    count(*) filter (where clv_result = 'beat_close')::bigint      as beat_close,
    count(*) filter (where clv_result = 'lost_to_close')::bigint   as lost_to_close,
    count(*) filter (where clv_result = 'same')::bigint            as same,
    count(*) filter (where clv_result = 'line_changed')::bigint    as line_changed,
    count(*) filter (where clv_result = 'unavailable')::bigint     as unavailable
  from classified
  group by sport
  having count(*) > 0
  order by sport;
$$;

comment on function analytics_clv_results_by_sport is
  'Per-pick CLV result distribution segmented by sport — surfaces which sports are systematically beating or losing to the close.';
