-- ============================================================
-- Replace analytics_data_quality_extras so the odds_unavailable
-- bucket excludes paper-bridged rows (#164). Paper bets don't yet
-- run a closing-line poll, so 100% of paper-bridged rows would
-- always count as odds_unavailable, drowning out the genuine
-- closing-line gaps in the parlay-bridged population.
--
-- Filter: count odds_unavailable only on rows that DON'T carry
-- extra.paper_source. The paper bridge will pick up its own
-- closing-line capture in a future commit; until then we treat
-- paper rows as "CLV unknown by design" rather than "data
-- pipeline broke".
--
-- Read-side only. No schema changes.
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
  rp_unresolved as (
    select 'unresolved_after_final'::text   as diagnosis,
           'recommended_parlays'::text      as source_table,
           count(*)::bigint                 as count
    from public.recommended_parlays p
    where p.outcome in ('pending', 'partial')
      and p.recommended_at >= now() - make_interval(days => lookback_days)
      and p.date < (current_date - interval '1 day')::date
  ),
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
  -- captured a value. Paper-bridged rows (extra ? 'paper_source')
  -- are excluded — paper bets don't run a closing-line poll yet,
  -- so counting them here would drown out genuine pipeline gaps
  -- in the parlay-bridged population.
  ph_no_close as (
    select 'odds_unavailable'::text     as diagnosis,
           'prediction_history'::text   as source_table,
           count(*)::bigint             as count
    from public.prediction_history ph
    where ph.created_at >= now() - make_interval(days => lookback_days)
      and not (ph.extra ? 'paper_source')
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
  'Quality buckets that the per-leg JSONB walk does not surface: unresolved_after_final, manual_override_used, odds_unavailable. odds_unavailable excludes paper-bridged rows because paper does not yet run a closing-line poll (#164).';
