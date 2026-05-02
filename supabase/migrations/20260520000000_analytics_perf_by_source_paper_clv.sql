-- ============================================================
-- Replace analytics_performance_by_source so paper-bridged
-- prediction_history rows (#164) feed the CLV columns for the
-- paper-backed categories. Before this commit those rows existed
-- but the function only looked at extra.parlay_source — which
-- only the parlay bridge sets — so manual_user / auto_plan /
-- live_paper had null CLV.
--
-- Mapping additions (CLV side only, ROI / hit-rate stays read
-- straight from paper_bets + recommended_parlays):
--
--   extra.paper_bet_timing = 'live'                   → live_paper
--   extra.paper_source     = 'app_recommendation_paper'
--                            AND paper_bet_timing != 'live' → auto_plan
--   extra.paper_source     = 'manual_draftkings_entry'
--                            AND paper_bet_timing != 'live' → manual_user
--   extra.parlay_source    IN (user_manual, draftkings_manual)
--                                                     → paper_test
--   extra.parlay_source    everything else            → system_recommended
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
      case
        when p.outcome = 'won'  then 'won'
        when p.outcome = 'lost' then 'lost'
        when p.outcome = 'push' then 'push'
        else                         'open'
      end                                                          as status,
      coalesce(p.user_stake, 0)                                    as stake,
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
  -- CLV per leg, segmented by either parlay_source (parlay bridge)
  -- or paper_source + paper_bet_timing (paper bridge introduced in
  -- #164). Apples-to-apples cohort only — line didn't move.
  clv_legs as (
    select
      ph.extra->>'parlay_source'                                 as parlay_source,
      ph.extra->>'paper_source'                                  as paper_source,
      ph.extra->>'paper_bet_timing'                              as paper_bet_timing,
      case
        when (ph.extra->>'clv_pp') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (ph.extra->>'clv_pp')::numeric
        else null
      end                                                        as clv_pp,
      (ph.extra->'leg'->>'line_value')::numeric                  as entry_line,
      (ph.extra->'leg'->>'closing_line_value')::numeric          as close_line
    from public.prediction_history ph
    where ph.created_at >= now() - make_interval(days => lookback_days)
      and (ph.extra ? 'parlay_source' or ph.extra ? 'paper_source')
  ),
  clv_classified as (
    select
      case
        -- Paper bridge takes precedence — a paper bet rebridged
        -- via the wrong tag can't happen, but if it ever does we
        -- want the paper categorization to win.
        when paper_bet_timing = 'live'                              then 'live_paper'
        when paper_source = 'app_recommendation_paper'              then 'auto_plan'
        when paper_source = 'manual_draftkings_entry'               then 'manual_user'
        when parlay_source in ('user_manual', 'draftkings_manual')  then 'paper_test'
        when parlay_source is not null                              then 'system_recommended'
        else                                                              'unknown'
      end                                                          as category,
      clv_pp,
      entry_line,
      close_line
    from clv_legs
  ),
  clv_apples as (
    select
      category,
      clv_pp
    from clv_classified
    where clv_pp is not null
      and category <> 'unknown'
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
  'Per-origin (manual_user / auto_plan / system_recommended / paper_test / live_paper) ROI, hit rate, and CLV. ROI/hit rate read paper_bets + recommended_parlays. CLV reads prediction_history.extra and recognizes both parlay_source (parlay bridge) and paper_source (paper bridge, #164).';
