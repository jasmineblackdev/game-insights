-- =============================================================
-- ML performance rollups — RPCs that drive the analytics dashboard
-- showing win rate by sport, by bet type, by odds range, plus best
-- and worst leg combinations from the resolved history.
-- =============================================================

-- ── Win rate by sport ────────────────────────────────────────────
create or replace function analytics_model_performance_by_sport(
  window_days integer default 30
)
returns table (
  sport            text,
  resolved_count   integer,
  won              integer,
  lost             integer,
  pushed           integer,
  win_pct          numeric,
  avg_payout_x     numeric
)
language sql stable security definer as $$
  select
    coalesce(legs.sport, ph.sport)                           as sport,
    count(*) filter (where ph.outcome in ('win','loss','push'))::int as resolved_count,
    count(*) filter (where ph.outcome = 'win')::int          as won,
    count(*) filter (where ph.outcome = 'loss')::int         as lost,
    count(*) filter (where ph.outcome = 'push')::int         as pushed,
    round(100.0 * count(*) filter (where ph.outcome = 'win') /
      nullif(count(*) filter (where ph.outcome in ('win','loss')), 0), 2) as win_pct,
    null::numeric                                            as avg_payout_x
  from prediction_history ph
  left join lateral (select ph.sport) legs on true
  where ph.resolved_at >= now() - (window_days || ' days')::interval
  group by sport
  order by sport;
$$;

-- ── Win rate by bet/market type ──────────────────────────────────
create or replace function analytics_model_performance_by_bet_type(
  window_days integer default 30
)
returns table (
  bet_type         text,
  resolved_count   integer,
  won              integer,
  lost             integer,
  win_pct          numeric
)
language sql stable security definer as $$
  select
    coalesce(market_type, stat_type, 'unknown')              as bet_type,
    count(*) filter (where outcome in ('win','loss','push'))::int as resolved_count,
    count(*) filter (where outcome = 'win')::int             as won,
    count(*) filter (where outcome = 'loss')::int            as lost,
    round(100.0 * count(*) filter (where outcome = 'win') /
      nullif(count(*) filter (where outcome in ('win','loss')), 0), 2) as win_pct
  from prediction_history
  where resolved_at >= now() - (window_days || ' days')::interval
  group by bet_type
  having count(*) filter (where outcome in ('win','loss')) >= 5
  order by win_pct desc nulls last;
$$;

-- ── Win rate by odds range ───────────────────────────────────────
-- Buckets parlays by combined American odds so we can see whether
-- "around +800 to +1200" is actually paying off.
create or replace function analytics_model_performance_by_odds_range(
  window_days integer default 30
)
returns table (
  odds_bucket      text,
  resolved_count   integer,
  won              integer,
  lost             integer,
  win_pct          numeric,
  avg_payout_x     numeric,
  est_roi_pct      numeric
)
language sql stable security definer as $$
  with bucketed as (
    select
      case
        when combined_american_odds is null then 'unknown'
        when combined_american_odds < 100   then '< +100'
        when combined_american_odds < 300   then '+100 to +299'
        when combined_american_odds < 600   then '+300 to +599'
        when combined_american_odds < 900   then '+600 to +899'
        when combined_american_odds < 1300  then '+900 to +1299'
        when combined_american_odds < 2000  then '+1300 to +1999'
        else '+2000 and up'
      end as odds_bucket,
      outcome,
      payout_multiplier,
      user_stake,
      user_payout
    from recommended_parlays
    where recommended_at >= now() - (window_days || ' days')::interval
  )
  select
    odds_bucket,
    count(*) filter (where outcome in ('won','lost','push'))::int as resolved_count,
    count(*) filter (where outcome = 'won')::int                  as won,
    count(*) filter (where outcome = 'lost')::int                 as lost,
    round(100.0 * count(*) filter (where outcome = 'won') /
      nullif(count(*) filter (where outcome in ('won','lost')), 0), 2)
                                                                  as win_pct,
    round(avg(payout_multiplier), 2)                              as avg_payout_x,
    round(100.0 *
      (sum(coalesce(user_payout, 0)) - sum(coalesce(user_stake, 0))) /
      nullif(sum(coalesce(user_stake, 0)), 0), 2)                 as est_roi_pct
  from bucketed
  group by odds_bucket
  order by case odds_bucket
    when '< +100' then 1
    when '+100 to +299' then 2
    when '+300 to +599' then 3
    when '+600 to +899' then 4
    when '+900 to +1299' then 5
    when '+1300 to +1999' then 6
    when '+2000 and up' then 7
    else 8
  end;
$$;

-- ── Worst-performing prop categories ─────────────────────────────
-- "Most common reasons for losses" view — ranks the stat_type buckets
-- where resolved predictions most often hit loss.
create or replace function analytics_loss_reasons(
  window_days integer default 30
)
returns table (
  sport         text,
  stat_type     text,
  losses        integer,
  hits          integer,
  loss_pct      numeric
)
language sql stable security definer as $$
  select
    sport,
    stat_type,
    count(*) filter (where outcome = 'loss')::int  as losses,
    count(*) filter (where outcome = 'win')::int   as hits,
    round(100.0 * count(*) filter (where outcome = 'loss') /
      nullif(count(*) filter (where outcome in ('win','loss')), 0), 2) as loss_pct
  from prediction_history
  where resolved_at >= now() - (window_days || ' days')::interval
  group by sport, stat_type
  having count(*) filter (where outcome in ('win','loss')) >= 5
  order by loss_pct desc nulls last
  limit 15;
$$;
