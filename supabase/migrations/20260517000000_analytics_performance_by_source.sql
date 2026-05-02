-- ============================================================
-- analytics_performance_by_source — split ROI / hit rate / CLV
-- across the 5 origin categories the user actually cares about:
--
--   manual_user        — user-typed paper bet (no auto-plan)
--   auto_plan          — paper bet sourced from Today's Decision
--                         → "Track as Paper Bet" (#167)
--   system_recommended — AI-generated parlay (recommended_parlays
--                         where source ∈ app_recommended,
--                         app_recommended_and_placed, auto_profit,
--                         daily_plan, parlay_builder,
--                         edge_card_legacy)
--   paper_test         — user-entered rows in recommended_parlays
--                         (source ∈ user_manual, draftkings_manual)
--   live_paper         — paper bet placed in-game (bet_timing=live)
--
-- ROI / hit rate are computed per category from the underlying
-- table (paper_bets vs recommended_parlays). CLV is only available
-- for the two recommended_parlays-backed categories because the
-- ML bridge (#94) writes prediction_history rows tagged with
-- extra.parlay_source. paper_bets aren't bridged yet (held under
-- #164), so manual_user / auto_plan / live_paper return null CLV
-- — surfaced as "—" in the UI.
--
-- Read-side only. No schema changes. No optimizer impact.
-- ============================================================

create or replace function analytics_performance_by_source(
  lookback_days integer default 30
)
returns table (
  category        text,
  total           bigint,
  resolved        bigint,
  won             bigint,
  lost            bigint,
  push            bigint,
  hit_rate_pct    numeric,
  total_stake     numeric,
  total_pnl       numeric,
  roi_pct         numeric,
  clv_sample      bigint,
  clv_pp_avg      numeric,
  pct_beat_close  numeric
)
language sql
stable
security definer
as $$
  with paper_rows as (
    select
      case
        when b.bet_timing = 'live'                          then 'live_paper'
        when b.source = 'app_recommendation_paper'          then 'auto_plan'
        else                                                     'manual_user'
      end                                                          as category,
      b.status,
      b.stake,
      b.pnl,
      b.placed_at as t
    from public.paper_bets b
    where b.placed_at >= now() - make_interval(days => lookback_days)
  ),
  parlay_rows as (
    select
      case
        when p.source in ('user_manual', 'draftkings_manual') then 'paper_test'
        else                                                       'system_recommended'
      end                                                          as category,
      -- normalize parlay outcome → paper status vocabulary
      case
        when p.outcome = 'won'  then 'won'
        when p.outcome = 'lost' then 'lost'
        when p.outcome = 'push' then 'push'
        else                         'open'
      end                                                          as status,
      coalesce(p.user_stake, 0)                                    as stake,
      -- Net pnl = payout - stake when both known; else null so it
      -- doesn't pollute ROI for unstaked recommendations.
      case
        when p.user_stake is not null and p.user_payout is not null
          then p.user_payout - p.user_stake
        else null
      end                                                          as pnl,
      p.recommended_at                                             as t
    from public.recommended_parlays p
    where p.recommended_at >= now() - make_interval(days => lookback_days)
  ),
  all_rows as (
    select * from paper_rows
    union all
    select * from parlay_rows
  ),
  agg as (
    select
      category,
      count(*)::bigint                                           as total,
      count(*) filter (where status in ('won','lost'))::bigint   as resolved,
      count(*) filter (where status = 'won')::bigint             as won,
      count(*) filter (where status = 'lost')::bigint            as lost,
      count(*) filter (where status = 'push')::bigint            as push,
      round(
        100.0 * count(*) filter (where status = 'won')::numeric
        / nullif(count(*) filter (where status in ('won','lost')), 0),
        1
      )                                                          as hit_rate_pct,
      sum(stake)::numeric                                        as total_stake,
      sum(pnl)::numeric                                          as total_pnl,
      round(
        100.0 * sum(pnl)::numeric / nullif(sum(stake), 0),
        2
      )                                                          as roi_pct
    from all_rows
    group by category
  ),
  -- CLV per leg, segmented by parlay_source on the bridged row.
  -- Apples-to-apples cohort only (line didn't move) so a drifted-
  -- line winner doesn't pollute the headline beat-rate.
  clv_legs as (
    select
      ph.extra->>'parlay_source'                                 as parlay_source,
      case
        when (ph.extra->>'clv_pp') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (ph.extra->>'clv_pp')::numeric
        else null
      end                                                        as clv_pp,
      (ph.extra->'leg'->>'line_value')::numeric                  as entry_line,
      (ph.extra->'leg'->>'closing_line_value')::numeric          as close_line
    from public.prediction_history ph
    where ph.created_at >= now() - make_interval(days => lookback_days)
      and ph.extra ? 'parlay_source'
  ),
  clv_apples as (
    select
      case
        when parlay_source in ('user_manual', 'draftkings_manual') then 'paper_test'
        else                                                            'system_recommended'
      end                                                        as category,
      clv_pp
    from clv_legs
    where clv_pp is not null
      -- apples-to-apples: line didn't materially move
      and (
        (entry_line is null and close_line is null)
        or (entry_line is not null and close_line is not null
            and abs(entry_line - close_line) < 0.001)
      )
  ),
  clv_agg as (
    select
      category,
      count(*)::bigint                                             as clv_sample,
      round(avg(clv_pp), 3)                                        as clv_pp_avg,
      round(
        100.0 * count(*) filter (where clv_pp > 0)::numeric
        / nullif(count(*), 0),
        1
      )                                                            as pct_beat_close
    from clv_apples
    group by category
  ),
  -- Pre-seed all 5 categories so the UI never has to guess which
  -- ones are missing. Empty categories return zero counts, null
  -- ratios — the dashboard renders "—" rather than vanishing.
  categories as (
    select unnest(array[
      'manual_user',
      'auto_plan',
      'system_recommended',
      'paper_test',
      'live_paper'
    ]) as category
  )
  select
    c.category,
    coalesce(a.total, 0)            as total,
    coalesce(a.resolved, 0)         as resolved,
    coalesce(a.won, 0)              as won,
    coalesce(a.lost, 0)             as lost,
    coalesce(a.push, 0)             as push,
    a.hit_rate_pct                  as hit_rate_pct,
    coalesce(a.total_stake, 0)      as total_stake,
    coalesce(a.total_pnl, 0)        as total_pnl,
    a.roi_pct                       as roi_pct,
    coalesce(cv.clv_sample, 0)      as clv_sample,
    cv.clv_pp_avg                   as clv_pp_avg,
    cv.pct_beat_close               as pct_beat_close
  from categories c
    left join agg a      on a.category = c.category
    left join clv_agg cv on cv.category = c.category
  order by
    case c.category
      when 'system_recommended' then 1
      when 'auto_plan'          then 2
      when 'manual_user'        then 3
      when 'live_paper'         then 4
      when 'paper_test'         then 5
    end;
$$;

comment on function analytics_performance_by_source is
  'Per-origin (manual_user / auto_plan / system_recommended / paper_test / live_paper) ROI, hit rate, and CLV. Reads paper_bets + recommended_parlays + prediction_history.extra. Read-side only.';
