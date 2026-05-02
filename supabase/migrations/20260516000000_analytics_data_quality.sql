-- ============================================================
-- analytics_data_quality_summary — surface what's silently broken
-- in the bet pipeline so the Data Health section can show it.
--
-- Walks the legs JSONB on both recommended_parlays and paper_bets,
-- groups by resolution_diagnosis, and returns one row per
-- diagnosis category with a count. Used by the Insights → Data
-- Health section to flag missing gameId / missing playerId /
-- unsupported stat / invalid market / etc. without forcing the
-- client to read every row's JSONB.
--
-- Read-side only. No schema changes. No optimizer impact.
--
-- Note: recommended_parlays.legs uses snake_case
-- (resolution_diagnosis), paper_bets.legs uses camelCase
-- (resolutionDiagnosis) — UNION ALL handles both.
-- ============================================================

create or replace function analytics_data_quality_summary(
  lookback_days integer default 30
)
returns table (
  diagnosis        text,
  source_table     text,
  count            bigint
)
language sql
stable
security definer
as $$
  with rp_legs as (
    select
      lg ->> 'resolution_diagnosis' as diagnosis,
      'recommended_parlays'::text   as source_table
    from public.recommended_parlays p,
         lateral jsonb_array_elements(coalesce(p.legs, '[]'::jsonb)) as lg
    where p.recommended_at >= now() - make_interval(days => lookback_days)
      and lg ->> 'resolution_diagnosis' is not null
      and lg ->> 'resolution_diagnosis' <> ''
  ),
  pb_legs as (
    select
      lg ->> 'resolutionDiagnosis' as diagnosis,
      'paper_bets'::text           as source_table
    from public.paper_bets b,
         lateral jsonb_array_elements(coalesce(b.legs, '[]'::jsonb)) as lg
    where b.placed_at >= now() - make_interval(days => lookback_days)
      and lg ->> 'resolutionDiagnosis' is not null
      and lg ->> 'resolutionDiagnosis' <> ''
  ),
  all_legs as (
    select * from rp_legs
    union all
    select * from pb_legs
  )
  select
    diagnosis,
    source_table,
    count(*)::bigint as count
  from all_legs
  group by diagnosis, source_table
  order by count desc, diagnosis;
$$;

comment on function analytics_data_quality_summary is
  'Per-diagnosis leg counts across recommended_parlays and paper_bets. Surfaces silently-broken rows (missing gameId, unsupported stat, etc.) so Data Health can flag them.';
