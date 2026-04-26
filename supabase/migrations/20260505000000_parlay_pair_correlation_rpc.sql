-- =============================================================
-- analytics_parlay_pair_correlation — backfit ρ per pair-category
-- from resolved leg outcomes in recommended_parlays.
--
-- Replaces the hard-coded same-game ρ = 0.25 in
-- correlatedParlayProbability.ts with values derived from the
-- actual relationship between leg outcomes. Same-team prop pairs
-- learn that they correlate ~+0.4 in NBA but only ~+0.2 in MLB
-- (sample-size dependent), instead of carrying the same number
-- forever.
--
-- Pair classification mirrors the client's pairKey() in
-- correlatedParlayProbability.ts so the lookup is direction-
-- agnostic and cross-keyed without conversion:
--   cross_sport
--   same_sport_diff_game
--   same_game:team:team
--   same_game:team:prop_same_team / prop_opp_team
--   same_game:prop:prop_same_team / prop_opp_team
--   same_game:prop:prop_pitcher  (MLB-specific)
--
-- Activation: client uses learned ρ only when sample_size ≥ 30.
-- =============================================================

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
    -- Expand each parlay's legs into ordered pairs (i < j) so a
    -- 3-leg parlay yields 3 pairs without double-counting.
    select
      p.id as parlay_id,
      la->>'sport'        as sport_a,
      la->>'pick_type'    as pick_type_a,
      la->>'market_type'  as market_a,
      coalesce(la->>'stat_type', '')   as stat_a,
      la->>'game_id'      as game_id_a,
      la->>'team_id'      as team_id_a,
      coalesce(la->>'leg_outcome', 'pending') as outcome_a,
      lb->>'sport'        as sport_b,
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
      and p.outcome in ('won', 'loss', 'push')  -- only resolved parlays
  ),
  classified as (
    select
      case
        -- Cross-sport
        when lower(sport_a) <> lower(sport_b) then 'cross_sport'
        -- Same sport, different game
        when game_id_a <> game_id_b then 'same_sport_diff_game'
        -- Same-game team-team
        when pick_type_a <> 'player_prop' and pick_type_b <> 'player_prop'
          then 'same_game:team:team'
        -- MLB pitcher-vs-pitcher special case (both are pitcher K props)
        when lower(sport_a) = 'mlb'
             and pick_type_a = 'player_prop' and pick_type_b = 'player_prop'
             and lower(stat_a) like '%strike%' and lower(stat_b) like '%strike%'
          then 'same_game:prop:prop_pitcher'
        -- Same-game prop-prop
        when pick_type_a = 'player_prop' and pick_type_b = 'player_prop' then
          case when team_id_a is not null and team_id_a = team_id_b
               then 'same_game:prop:prop_same_team'
               else 'same_game:prop:prop_opp_team'
          end
        -- Mixed: one team bet + one prop
        else
          case when (case when pick_type_a = 'player_prop' then team_id_a else team_id_b end)
                  = (case when pick_type_a = 'player_prop' then team_id_b else team_id_a end)
               then 'same_game:team:prop_same_team'
               else 'same_game:team:prop_opp_team'
          end
      end as pair_key,
      (outcome_a = 'won')::int as a_won,
      (outcome_b = 'won')::int as b_won
    from pair_legs
    where outcome_a in ('won', 'lost') and outcome_b in ('won', 'lost')
  ),
  agg as (
    select
      pair_key,
      count(*)::numeric as n,
      sum(a_won)::numeric as sx,
      sum(b_won)::numeric as sy,
      sum(a_won * b_won)::numeric as sxy,
      sum(case when a_won = 1 and b_won = 1 then 1 else 0 end)::numeric as both_won,
      sum(case when a_won = 0 and b_won = 0 then 1 else 0 end)::numeric as both_lost
    from classified
    group by pair_key
  )
  select
    pair_key,
    -- Pearson correlation for binary outcomes:
    --   r = (n·Σxy − Σx·Σy) / sqrt(Σx·(n−Σx) · Σy·(n−Σy))
    -- (since for x ∈ {0,1}: Σx² = Σx, so n·Σx − Σx² = Σx·(n−Σx))
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
    round(both_won / nullif(n, 0)::numeric, 4) as both_won_rate,
    round(both_lost / nullif(n, 0)::numeric, 4) as both_lost_rate
  from agg
  order by sample_size desc;
$$;

grant execute on function analytics_parlay_pair_correlation() to authenticated, anon;
