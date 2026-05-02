-- ============================================================
-- analytics_data_quality_extras — additional quality buckets
-- the per-leg JSONB walk in 20260516 doesn't catch.
--
-- Returns rows in the same shape as analytics_data_quality_summary
-- so the client can merge results into a single DataQualityCounts
-- object. Three new diagnosis names are produced here:
--
--   unresolved_after_final — bet still open even though the game's
--                            latest start + 6h has passed. For
--                            recommended_parlays, the parlay date
--                            is at least one day before today and
--                            outcome is still pending.
--   manual_override_used   — bet reached its terminal status via
--                            user click (resolved_via='manual')
--                            instead of the auto-resolver.
--   odds_unavailable       — bridged prediction_history row never
--                            captured a closing line, so CLV can't
--                            be computed for that pick.
--
-- stale_odds is intentionally NOT here — it's a real-time signal
-- from the odds-API health store, surfaced as its own tile rather
-- than a count over a time window.
--
-- Read-side only. No schema changes. No optimizer impact.
-- ============================================================

create or replace function analytics_data_quality_extras(
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
  with
  -- Paper bets that should be over by now but are still open. We
  -- compute max(legs[].gameTimeIso) per bet and call it stale once
  -- 6h have passed past that point — typical sport games settle
  -- within that window in ESPN box scores.
  pb_unresolved as (
    select 'unresolved_after_final'::text as diagnosis,
           'paper_bets'::text             as source_table,
           count(*)::bigint               as count
    from public.paper_bets b
    where b.status in ('open', 'in_progress', 'needs_review')
      and b.placed_at >= now() - make_interval(days => lookback_days)
      and (
        select max((lg->>'gameTimeIso')::timestamptz)
        from jsonb_array_elements(coalesce(b.legs, '[]'::jsonb)) as lg
        where lg ? 'gameTimeIso' and lg->>'gameTimeIso' <> ''
      ) is not null
      and (
        select max((lg->>'gameTimeIso')::timestamptz)
        from jsonb_array_elements(coalesce(b.legs, '[]'::jsonb)) as lg
        where lg ? 'gameTimeIso' and lg->>'gameTimeIso' <> ''
      ) < now() - interval '6 hours'
  ),
  -- Recommended parlays whose game date is strictly before yesterday
  -- but still pending. Same window filter as the leg-walk RPC.
  rp_unresolved as (
    select 'unresolved_after_final'::text   as diagnosis,
           'recommended_parlays'::text      as source_table,
           count(*)::bigint                 as count
    from public.recommended_parlays p
    where p.outcome in ('pending', 'partial')
      and p.recommended_at >= now() - make_interval(days => lookback_days)
      and p.date < (current_date - interval '1 day')::date
  ),
  -- resolved_via='manual' on either table → user clicked Won/Lost/Push
  -- instead of the auto-resolver settling. Surfaced so the user can
  -- see when the resolver isn't catching what it should.
  pb_manual as (
    select 'manual_override_used'::text as diagnosis,
           'paper_bets'::text           as source_table,
           count(*)::bigint             as count
    from public.paper_bets b
    where b.resolved_via = 'manual'
      and b.placed_at >= now() - make_interval(days => lookback_days)
  ),
  rp_manual as (
    select 'manual_override_used'::text   as diagnosis,
           'recommended_parlays'::text    as source_table,
           count(*)::bigint               as count
    from public.recommended_parlays p
    where p.resolved_via = 'manual'
      and p.recommended_at >= now() - make_interval(days => lookback_days)
  ),
  -- prediction_history rows where the closing line poll never
  -- captured a value. Without it CLV can't be computed, so the
  -- pick falls into the "unavailable" CLV bucket.
  ph_no_close as (
    select 'odds_unavailable'::text     as diagnosis,
           'prediction_history'::text   as source_table,
           count(*)::bigint             as count
    from public.prediction_history ph
    where ph.created_at >= now() - make_interval(days => lookback_days)
      and (
        ph.extra->'leg'->>'closing_line_value' is null
        or ph.extra->'leg'->>'closing_line_value' = ''
      )
  )
  select * from pb_unresolved where count > 0
  union all
  select * from rp_unresolved where count > 0
  union all
  select * from pb_manual     where count > 0
  union all
  select * from rp_manual     where count > 0
  union all
  select * from ph_no_close   where count > 0;
$$;

comment on function analytics_data_quality_extras is
  'Quality buckets that the per-leg JSONB walk does not surface: unresolved_after_final, manual_override_used, odds_unavailable. Same {diagnosis, source_table, count} shape as analytics_data_quality_summary so callers can union the two.';
