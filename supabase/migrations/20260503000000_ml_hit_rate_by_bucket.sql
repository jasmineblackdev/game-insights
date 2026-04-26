-- =============================================================
-- analytics_ml_hit_rate_by_bucket — observed win rate per
-- (sport, bet_type, market, confidence) bucket from resolved
-- ml_training_samples joined to ml_outcomes.
--
-- The ML prediction layer reads this RPC to source a base hit
-- probability per bucket, then applies Platt scaling on top.
--
-- Activation rule: bucket is "active" once resolved_count ≥ 25.
-- =============================================================

create or replace function analytics_ml_hit_rate_by_bucket()
returns table (
  sport            text,
  bet_type         text,
  market           text,
  confidence       text,
  resolved_count   bigint,
  win_count        bigint,
  loss_count       bigint,
  push_count       bigint,
  hit_rate         numeric,
  active           boolean
)
language sql
stable
as $$
  with samples as (
    select
      s.sport,
      s.bet_type,
      coalesce(s.market, '(any)')        as market,
      coalesce(s.confidence, 'unknown')  as confidence,
      o.result
    from ml_training_samples s
    join ml_outcomes o on o.sample_id = s.id
    where (auth.uid() is null or s.user_id = auth.uid() or s.user_id is null)
      and o.result in ('win', 'loss', 'push')
  )
  select
    sport,
    bet_type,
    market,
    confidence,
    count(*)                                            as resolved_count,
    count(*) filter (where result = 'win')              as win_count,
    count(*) filter (where result = 'loss')             as loss_count,
    count(*) filter (where result = 'push')             as push_count,
    -- Hit rate excludes pushes from the denominator since they
    -- don't represent a hit/miss decision.
    round(
      count(*) filter (where result = 'win')::numeric
      / nullif(count(*) filter (where result in ('win','loss')), 0)::numeric,
      4
    )                                                   as hit_rate,
    (count(*) >= 25)                                    as active
  from samples
  group by sport, bet_type, market, confidence
  order by resolved_count desc;
$$;

grant execute on function analytics_ml_hit_rate_by_bucket() to authenticated, anon;
