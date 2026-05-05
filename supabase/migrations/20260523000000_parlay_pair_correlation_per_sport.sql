-- ============================================================
-- analytics_parlay_pair_correlation — per-sport stratification
--
-- The original RPC (20260505) pooled ALL sports into one ρ per
-- pair-category. The scorer's `pairKey()` already constructs
-- sport-prefixed keys (`nba|same_game:team:team`, `mlb|same_game:
-- prop:prop_pitcher`, …) and tries those FIRST, falling back to
-- the unprefixed bucket only when no sport-specific learned row
-- exists.
--
-- This migration emits BOTH rows per pair so the client picks up
-- the more specific one when the sample is large enough:
--   - `${sport}|${base_pair_key}` — sport-stratified Pearson ρ
--   - `${base_pair_key}`          — global pooled (existing behavior)
--
-- A 30-leg sample size still gates activation client-side; pooled
-- rows remain useful when a single sport hasn't crossed the gate.
-- Cross-sport pairs naturally only emit the global row (no single
-- sport applies).
-- ============================================================

create or replace function analytics_parlay_pair_correlation()
returns table (
  pair_key            text,
  correlation_score   numeric,
  sample_size         bigint,
  both_won_rate       numeric,
  both_lost_rate      numeric
)
language sql
stable
as $$
  with pair_legs as (
    select
      p.id as parlay_id,
      lower(la->>'sport')        as sport_a,
      la->>'pick_type'    as pick_type_a,
      la->>'market_type'  as market_a,
      coalesce(la->>'stat_type', '')   as stat_a,
      la->>'game_id'      as game_id_a,
      la->>'team_id'      as team_id_a,
      coalesce(la->>'leg_outcome', 'pending') as outcome_a,
      lower(lb->>'sport')        as sport_b,
      lb->>'pick_type'    as pick_type_b,
      lb->>'market_type'  as market_b,
      coalesce(lb->>'stat_type', '')   as stat_b,
      lb->>'game_id'      as game_id_b,
      lb->>'team_id'      as team_id_b,
      coalesce(lb->>'leg_outcome', 'pending') as outcome_b
    from recommended_parlays p
    cross join lateral jsonb_array_elements(p.legs) with ordinality la(la, ia)
    cross join lateral jsonb_array_elements(p.legs) with ordinality lb(lb, ib)
    where ib > ia
      and p.outcome in ('won', 'loss', 'push')
  ),
  classified as (
    select
      sport_a,
      sport_b,
      case
        when sport_a <> sport_b then 'cross_sport'
        when game_id_a <> game_id_b then 'same_sport_diff_game'
        when pick_type_a <> 'player_prop' and pick_type_b <> 'player_prop'
          then 'same_game:team:team'
        when sport_a = 'mlb'
             and pick_type_a = 'player_prop' and pick_type_b = 'player_prop'
             and lower(stat_a) like '%strike%' and lower(stat_b) like '%strike%'
          then 'same_game:prop:prop_pitcher'
        when pick_type_a = 'player_prop' and pick_type_b = 'player_prop' then
          case when team_id_a is not null and team_id_a = team_id_b
               then 'same_game:prop:prop_same_team'
               else 'same_game:prop:prop_opp_team'
          end
        else
          case when (case when pick_type_a = 'player_prop' then team_id_a else team_id_b end)
                  = (case when pick_type_a = 'player_prop' then team_id_b else team_id_a end)
               then 'same_game:team:prop_same_team'
               else 'same_game:team:prop_opp_team'
          end
      end as base_key,
      (outcome_a = 'won')::int as a_won,
      (outcome_b = 'won')::int as b_won
    from pair_legs
    where outcome_a in ('won', 'lost') and outcome_b in ('won', 'lost')
  ),
  -- Two parallel streams: per-sport and pooled. UNION ALL keeps
  -- both visible so the client (which already prefers
  -- `${sport}|${base}` over plain `${base}`) can route correctly.
  -- Pooled rows are emitted with the bare base_key; sport rows are
  -- emitted with `${sport}|${base_key}`. cross_sport pairs only
  -- enter the pooled stream — no single sport can claim them.
  per_sport_classified as (
    select
      sport_a as sport,
      base_key,
      a_won,
      b_won
    from classified
    where base_key <> 'cross_sport'
  ),
  pooled_agg as (
    select
      base_key as pair_key,
      count(*)::numeric as n,
      sum(a_won)::numeric as sx,
      sum(b_won)::numeric as sy,
      sum(a_won * b_won)::numeric as sxy,
      sum(case when a_won = 1 and b_won = 1 then 1 else 0 end)::numeric as both_won,
      sum(case when a_won = 0 and b_won = 0 then 1 else 0 end)::numeric as both_lost
    from classified
    group by base_key
  ),
  per_sport_agg as (
    select
      sport || '|' || base_key as pair_key,
      count(*)::numeric as n,
      sum(a_won)::numeric as sx,
      sum(b_won)::numeric as sy,
      sum(a_won * b_won)::numeric as sxy,
      sum(case when a_won = 1 and b_won = 1 then 1 else 0 end)::numeric as both_won,
      sum(case when a_won = 0 and b_won = 0 then 1 else 0 end)::numeric as both_lost
    from per_sport_classified
    group by sport, base_key
  ),
  combined as (
    select * from pooled_agg
    union all
    select * from per_sport_agg
  )
  select
    pair_key,
    case
      when n >= 2 and sx > 0 and sx < n and sy > 0 and sy < n then
        round(
          ((n * sxy) - (sx * sy)) /
          nullif(sqrt(sx * (n - sx) * sy * (n - sy)), 0)::numeric,
          4
        )
      else null
    end as correlation_score,
    n::bigint as sample_size,
    round(both_won  / nullif(n, 0)::numeric, 4) as both_won_rate,
    round(both_lost / nullif(n, 0)::numeric, 4) as both_lost_rate
  from combined
  order by sample_size desc;
$$;

grant execute on function analytics_parlay_pair_correlation() to authenticated, anon;

comment on function analytics_parlay_pair_correlation is
  'Backfit ρ per pair-category from settled recommended_parlays. Emits both pooled and per-sport rows so the scorer can prefer sport-specific correlation when sample is large enough, fall back to pooled when not.';
