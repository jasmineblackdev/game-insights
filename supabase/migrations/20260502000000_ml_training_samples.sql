-- =============================================================
-- ml_training_samples + ml_outcomes — clean training-data foundation.
--
-- Why split from prediction_history / recommended_parlays:
--   prediction_history is keyed to a model output. recommended_parlays
--   is keyed to a parlay ticket. ML training needs a feature snapshot
--   keyed to the *recommendation event* with structured columns and a
--   JSONB feature_vector so we can retrain offline without backfilling.
--
-- Outcome is stored separately so we can backfill / overwrite without
-- touching the sample record (resolved-line, settlement source, push
-- handling, cash-out partials all live in the outcome row).
-- =============================================================

create table if not exists ml_training_samples (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid references auth.users(id) on delete cascade,
  created_at                  timestamptz not null default now(),

  -- Identity ────────────────────────────────────────────────────
  sport                       text not null,                       -- "NBA" | "WNBA" | "NFL" | "MLB" | "Boxing" | "MMA"
  league                      text not null,                       -- "nba" | "wnba" | ...
  game_id                     text,
  event_date                  date,
  bet_type                    text not null,                       -- "moneyline" | "spread" | "total" | "player_prop"
  market                      text,                                -- stat_type for player props, market_type for team
  team                        text,
  player                      text,
  side                        text,                                -- "home" | "away" | "OVER" | "UNDER" | "MORE" | "LESS"

  -- Pricing ─────────────────────────────────────────────────────
  line                        numeric(8,3),
  odds_at_recommendation      integer,
  odds_at_placement           integer,
  implied_probability         numeric(6,4),
  model_probability           numeric(6,4),
  rules_score                 numeric(8,4),
  final_score                 numeric(8,4),

  -- Quality / context ───────────────────────────────────────────
  confidence                  text check (confidence in ('high','medium','low')),
  risk_level                  text check (risk_level in ('low','medium','high')),
  data_quality                numeric(4,3),                        -- 0–1
  matchup_quality             text,
  matchup_score               numeric(6,3),
  volatility_score            integer,
  sport_priority_score        numeric(5,2),
  sport_streak_state          text check (sport_streak_state in ('hot','stable','cold','low_data')),
  auto_profit_mode            text check (auto_profit_mode in ('green','caution','no_bet')),
  auto_profit_action          text check (auto_profit_action in ('BET_NOW','SMALL_BET','WAIT','SKIP')),
  bankroll_stage              text,                                -- "$30-50" | "$75-150" | "$200-400" etc.

  -- Stake ───────────────────────────────────────────────────────
  suggested_stake             numeric(10,2),
  actual_stake                numeric(10,2),
  placed_by_user              boolean not null default false,
  sportsbook                  text,                                -- "DraftKings" | "FanDuel" | etc.

  -- Provenance ──────────────────────────────────────────────────
  source                      text not null check (source in (
    'app_recommended',
    'auto_profit',
    'daily_plan',
    'user_manual',
    'draftkings_manual'
  )),
  model_version               text not null,
  feature_version             text not null default 'v1',

  -- Feature snapshot ────────────────────────────────────────────
  -- Recent form, opponent stats, injury flags, pitcher matchup,
  -- defensive matchup, sport priority ranking, line movement, etc.
  features_snapshot           jsonb,

  -- Data-quality bookkeeping ────────────────────────────────────
  -- When non-empty the sample is missing fields we'd normally want
  -- for ML; use this column to filter low-quality rows out of training.
  missing_fields              text[] not null default '{}',
  notes                       text
);

create index if not exists ml_training_samples_user_created_idx
  on ml_training_samples (user_id, created_at desc);

create index if not exists ml_training_samples_sport_market_idx
  on ml_training_samples (sport, bet_type, market);

create index if not exists ml_training_samples_game_idx
  on ml_training_samples (game_id);

-- Dedup hint: same user, same game, same player, same market, same
-- line, same source on the same calendar day = same sample.
-- Sentinel epoch date instead of current_date — Postgres requires
-- IMMUTABLE expressions in unique-index keys, and current_date is
-- STABLE.
create unique index if not exists ml_training_samples_dedup_idx
  on ml_training_samples (
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    sport, bet_type, coalesce(market, ''), coalesce(player, team, ''), coalesce(line, 0),
    coalesce(event_date, '1970-01-01'::date), source
  );

alter table ml_training_samples enable row level security;

drop policy if exists ml_training_samples_select_own on ml_training_samples;
create policy ml_training_samples_select_own
  on ml_training_samples for select
  using (auth.uid() = user_id or user_id is null);

drop policy if exists ml_training_samples_insert_own on ml_training_samples;
create policy ml_training_samples_insert_own
  on ml_training_samples for insert
  with check (auth.uid() = user_id or user_id is null);

drop policy if exists ml_training_samples_update_own on ml_training_samples;
create policy ml_training_samples_update_own
  on ml_training_samples for update
  using (auth.uid() = user_id or user_id is null);

-- ── Outcomes ──────────────────────────────────────────────────
create table if not exists ml_outcomes (
  id                          uuid primary key default gen_random_uuid(),
  sample_id                   uuid not null references ml_training_samples(id) on delete cascade,
  user_id                     uuid references auth.users(id) on delete cascade,
  settled_at                  timestamptz not null default now(),
  result                      text not null check (result in ('win','loss','push','cashed_out','void')),
  closing_line                numeric(8,3),
  closing_odds                integer,
  profit_loss                 numeric(10,2),
  settlement_source           text check (settlement_source in ('user_marked','auto_settled','sportsbook_sync','manual_correction')),
  notes                       text,
  unique (sample_id)
);

create index if not exists ml_outcomes_user_settled_idx
  on ml_outcomes (user_id, settled_at desc);

alter table ml_outcomes enable row level security;

drop policy if exists ml_outcomes_select_own on ml_outcomes;
create policy ml_outcomes_select_own
  on ml_outcomes for select
  using (auth.uid() = user_id or user_id is null);

drop policy if exists ml_outcomes_insert_own on ml_outcomes;
create policy ml_outcomes_insert_own
  on ml_outcomes for insert
  with check (auth.uid() = user_id or user_id is null);

drop policy if exists ml_outcomes_update_own on ml_outcomes;
create policy ml_outcomes_update_own
  on ml_outcomes for update
  using (auth.uid() = user_id or user_id is null);

-- ── Training Data Health RPC ──────────────────────────────────
-- Returns counts by sport / market so the analytics panel can show
-- "samples by sport", resolved vs pending, average data quality, and
-- whether ML is active per bucket.
create or replace function analytics_ml_training_health()
returns table (
  sport               text,
  bet_type            text,
  market              text,
  total_samples       bigint,
  resolved_samples    bigint,
  pending_samples     bigint,
  avg_data_quality    numeric,
  missing_field_rate  numeric,
  ml_active           boolean
)
language sql
stable
as $$
  with samples as (
    select s.*,
           o.id is not null as is_resolved
    from ml_training_samples s
    left join ml_outcomes o on o.sample_id = s.id
    where (auth.uid() is null or s.user_id = auth.uid() or s.user_id is null)
  )
  select
    sport,
    bet_type,
    coalesce(market, '(any)') as market,
    count(*)                                              as total_samples,
    count(*) filter (where is_resolved)                   as resolved_samples,
    count(*) filter (where not is_resolved)               as pending_samples,
    round(avg(data_quality)::numeric, 3)                  as avg_data_quality,
    round((sum(case when array_length(missing_fields, 1) > 0 then 1 else 0 end)::numeric
           / nullif(count(*), 0))::numeric, 3)            as missing_field_rate,
    -- ML is "active" once resolved samples ≥ 25 AND avg_data_quality ≥ 0.6
    (count(*) filter (where is_resolved) >= 25 and avg(data_quality) >= 0.6) as ml_active
  from samples
  group by sport, bet_type, market
  order by total_samples desc;
$$;

grant execute on function analytics_ml_training_health() to authenticated, anon;
