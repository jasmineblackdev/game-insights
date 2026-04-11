-- =============================================================
-- Parlay Edge: Auto Parlay Engine tables
-- Sports: NBA, NFL, MLB, Boxing, UFC/MMA (no soccer)
-- =============================================================

-- ─── parlay_candidates ──────────────────────────────────────────
-- Scored leg candidates staged before parlay generation.
-- Written by the client engine; one row per pick per day.
create table if not exists parlay_candidates (
  id               uuid primary key default gen_random_uuid(),
  prediction_id    uuid,
  sport            text not null check (sport in ('nba','nfl','mlb','boxing','mma')),
  market_type      text not null,   -- moneyline | spread | total | player_prop
  selection        text not null,   -- human-readable label
  odds             integer not null,
  model_probability numeric(5,4) not null check (model_probability between 0 and 1),
  implied_probability numeric(5,4) not null check (implied_probability between 0 and 1),
  edge             numeric(6,4) not null,
  confidence       text not null check (confidence in ('high','medium','low')),
  volatility_score numeric(5,2) default 0,
  uncertainty_score numeric(5,2) default 0,
  correlation_group text not null default 'default',
  -- sport tier: 1=NBA/NFL (foundation), 2=MLB (support), 3=boxing/mma (selective)
  sport_tier       smallint not null check (sport_tier in (1,2,3)),
  leg_score_safe        numeric(7,5),
  leg_score_balanced    numeric(7,5),
  leg_score_aggressive  numeric(7,5),
  game_id          text,
  matchup_label    text,
  stat_type        text,
  line_value       numeric(7,2),
  generated_date   date not null default current_date,
  created_at       timestamptz not null default now()
);

create index if not exists parlay_candidates_date_sport_idx
  on parlay_candidates (generated_date, sport);

-- ─── auto_parlays ────────────────────────────────────────────────
-- One row per generated parlay (safe/balanced/aggressive).
create table if not exists auto_parlays (
  id                   uuid primary key default gen_random_uuid(),
  mode                 text not null check (mode in ('safe','balanced','aggressive')),
  leg_count            smallint not null,
  sport_mix            text not null,    -- e.g. "nba,nfl,mlb"
  market_mix           text not null,    -- e.g. "player_prop,moneyline"
  combined_probability numeric(5,4),
  combined_edge        numeric(6,4),
  combined_american_odds integer,
  payout_multiplier    numeric(8,3),
  confidence           text check (confidence in ('high','medium','low')),
  strength_score       numeric(7,5),
  correlation_penalty  numeric(5,4) default 0,
  volatility_penalty   numeric(5,4) default 0,
  sport_balance_score  numeric(5,4) default 0,
  warnings             text[],
  explanation          text[],
  parlay_rank          smallint default 1,
  generated_date       date not null default current_date,
  created_at           timestamptz not null default now()
);

create index if not exists auto_parlays_date_mode_idx
  on auto_parlays (generated_date, mode);

-- ─── auto_parlay_legs ────────────────────────────────────────────
-- Maps parlays to their candidate legs.
create table if not exists auto_parlay_legs (
  id           uuid primary key default gen_random_uuid(),
  parlay_id    uuid not null references auto_parlays(id) on delete cascade,
  candidate_id uuid references parlay_candidates(id) on delete set null,
  leg_position smallint not null,
  sport        text not null,
  market_type  text not null,
  selection    text not null,
  odds         integer not null,
  model_probability numeric(5,4),
  edge         numeric(6,4),
  confidence   text,
  created_at   timestamptz not null default now()
);

create index if not exists auto_parlay_legs_parlay_idx
  on auto_parlay_legs (parlay_id);

-- ─── auto_parlay_results ─────────────────────────────────────────
-- Outcomes tracked for learning (written when games settle).
create table if not exists auto_parlay_results (
  id           uuid primary key default gen_random_uuid(),
  parlay_id    uuid not null references auto_parlays(id) on delete cascade,
  hit          boolean,
  legs_won     smallint,
  legs_lost    smallint,
  payout       numeric(10,2),
  profit_loss  numeric(10,2),
  failed_leg_sports  text[],   -- which sports caused failures
  failed_leg_markets text[],   -- which market types caused failures
  result_notes text,
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);

-- ─── parlay_pattern_learning ─────────────────────────────────────
-- Aggregated sport+market combination performance.
-- Updated as results accumulate.
create table if not exists parlay_pattern_learning (
  id            uuid primary key default gen_random_uuid(),
  sport_mix     text not null,     -- sorted CSV of sports, e.g. "mlb,nba,nfl"
  market_mix    text not null,     -- sorted CSV of market types
  leg_count     smallint,
  mode          text check (mode in ('safe','balanced','aggressive')),
  avg_odds      numeric(7,2),
  avg_edge      numeric(6,4),
  hit_rate      numeric(5,4),      -- 0–1
  roi           numeric(8,4),      -- e.g. 0.14 = +14%
  sample_size   integer not null default 0,
  last_hit_at   timestamptz,
  updated_at    timestamptz not null default now(),
  unique (sport_mix, market_mix, leg_count, mode)
);

-- ─── parlay_correlation_matrix ───────────────────────────────────
-- Pairwise leg-type correlation measured from historical results.
create table if not exists parlay_correlation_matrix (
  id              uuid primary key default gen_random_uuid(),
  leg_type_a      text not null,   -- e.g. "nba:player_prop"
  leg_type_b      text not null,   -- e.g. "nba:player_prop"
  correlation_score numeric(5,4),  -- -1 to 1; positive = tend to win/lose together
  both_won_rate   numeric(5,4),
  both_lost_rate  numeric(5,4),
  sample_size     integer not null default 0,
  updated_at      timestamptz not null default now(),
  unique (leg_type_a, leg_type_b)
);

-- ─── parlay_edge_daily_summary ───────────────────────────────────
-- Daily rollup for performance tracking.
create table if not exists parlay_edge_daily_summary (
  id                    uuid primary key default gen_random_uuid(),
  date                  date not null unique,
  total_parlays         integer default 0,
  safe_count            integer default 0,
  balanced_count        integer default 0,
  aggressive_count      integer default 0,
  safe_hit_rate         numeric(5,4),
  balanced_hit_rate     numeric(5,4),
  aggressive_hit_rate   numeric(5,4),
  total_profit_loss     numeric(12,2),
  total_roi             numeric(8,4),
  best_sport_mix        text,
  worst_sport_mix       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ─── parlay_mix_performance ──────────────────────────────────────
-- Sport + market mix ROI tracking.
create table if not exists parlay_mix_performance (
  id            uuid primary key default gen_random_uuid(),
  sport_mix     text not null,
  market_mix    text not null,
  leg_count     smallint,
  hit_rate      numeric(5,4),
  roi           numeric(8,4),
  avg_edge      numeric(6,4),
  sample_size   integer not null default 0,
  updated_at    timestamptz not null default now(),
  unique (sport_mix, market_mix, leg_count)
);

-- ─── parlay_failure_analysis ─────────────────────────────────────
-- Tracks which leg types / sports / markets cause most failures.
create table if not exists parlay_failure_analysis (
  id              uuid primary key default gen_random_uuid(),
  sport           text check (sport in ('nba','nfl','mlb','boxing','mma')),
  market_type     text,
  leg_count       smallint,
  mode            text check (mode in ('safe','balanced','aggressive')),
  failure_reason  text,            -- e.g. "high_volatility", "correlated", "line_moved"
  failure_count   integer default 0,
  sample_size     integer default 0,
  failure_rate    numeric(5,4),
  updated_at      timestamptz not null default now(),
  unique (sport, market_type, leg_count, mode, failure_reason)
);

-- ─── Seed known correlation patterns ────────────────────────────
insert into parlay_correlation_matrix
  (leg_type_a, leg_type_b, correlation_score, both_won_rate, both_lost_rate, sample_size)
values
  -- Same-game props are highly correlated
  ('nba:player_prop', 'nba:player_prop',  0.55, null, null, 0),
  ('nfl:player_prop', 'nfl:player_prop',  0.52, null, null, 0),
  ('mlb:player_prop', 'mlb:player_prop',  0.48, null, null, 0),
  -- Cross-sport: independent by definition
  ('nba:moneyline',   'nfl:moneyline',    0.05, null, null, 0),
  ('nba:moneyline',   'mlb:moneyline',    0.04, null, null, 0),
  ('nfl:moneyline',   'mlb:moneyline',    0.04, null, null, 0),
  -- Combat sports: uncorrelated with other sports
  ('boxing:moneyline','nba:moneyline',    0.02, null, null, 0),
  ('mma:moneyline',   'nba:moneyline',    0.02, null, null, 0),
  -- QB yards + WR yards: correlated (same offensive script)
  ('nfl:player_prop', 'nfl:spread',       0.38, null, null, 0),
  -- MLB pitcher props: relatively independent of team result
  ('mlb:player_prop', 'mlb:moneyline',    0.22, null, null, 0)
on conflict (leg_type_a, leg_type_b) do nothing;

-- ─── Seed failure analysis with known patterns ───────────────────
insert into parlay_failure_analysis
  (sport, market_type, leg_count, mode, failure_reason, failure_count, sample_size, failure_rate)
values
  ('mma',     'moneyline', 3, 'safe',       'high_volatility',   0, 0, null),
  ('boxing',  'moneyline', 3, 'safe',       'high_volatility',   0, 0, null),
  ('mlb',     'player_prop', 4, 'balanced', 'bullpen_variance',  0, 0, null),
  ('nba',     'player_prop', 6, 'aggressive','same_game_corr',   0, 0, null),
  ('nfl',     'player_prop', 6, 'aggressive','same_game_corr',   0, 0, null)
on conflict (sport, market_type, leg_count, mode, failure_reason) do nothing;

-- ─── RLS ─────────────────────────────────────────────────────────
alter table parlay_candidates         enable row level security;
alter table auto_parlays              enable row level security;
alter table auto_parlay_legs          enable row level security;
alter table auto_parlay_results       enable row level security;
alter table parlay_pattern_learning   enable row level security;
alter table parlay_correlation_matrix enable row level security;
alter table parlay_edge_daily_summary enable row level security;
alter table parlay_mix_performance    enable row level security;
alter table parlay_failure_analysis   enable row level security;

-- Public read (same pattern as existing tables)
create policy "public read parlay_candidates"
  on parlay_candidates for select using (true);
create policy "public read auto_parlays"
  on auto_parlays for select using (true);
create policy "public read auto_parlay_legs"
  on auto_parlay_legs for select using (true);
create policy "public read auto_parlay_results"
  on auto_parlay_results for select using (true);
create policy "public read parlay_pattern_learning"
  on parlay_pattern_learning for select using (true);
create policy "public read parlay_correlation_matrix"
  on parlay_correlation_matrix for select using (true);
create policy "public read parlay_edge_daily_summary"
  on parlay_edge_daily_summary for select using (true);
create policy "public read parlay_mix_performance"
  on parlay_mix_performance for select using (true);
create policy "public read parlay_failure_analysis"
  on parlay_failure_analysis for select using (true);

-- Service role write
create policy "service write parlay_candidates"
  on parlay_candidates for all using (auth.role() = 'service_role');
create policy "service write auto_parlays"
  on auto_parlays for all using (auth.role() = 'service_role');
create policy "service write auto_parlay_legs"
  on auto_parlay_legs for all using (auth.role() = 'service_role');
create policy "service write auto_parlay_results"
  on auto_parlay_results for all using (auth.role() = 'service_role');
create policy "service write parlay_pattern_learning"
  on parlay_pattern_learning for all using (auth.role() = 'service_role');
create policy "service write parlay_correlation_matrix"
  on parlay_correlation_matrix for all using (auth.role() = 'service_role');
create policy "service write parlay_edge_daily_summary"
  on parlay_edge_daily_summary for all using (auth.role() = 'service_role');
create policy "service write parlay_mix_performance"
  on parlay_mix_performance for all using (auth.role() = 'service_role');
create policy "service write parlay_failure_analysis"
  on parlay_failure_analysis for all using (auth.role() = 'service_role');

-- ─── parlay_edge_performance view ────────────────────────────────
create or replace view parlay_edge_performance as
select
  ap.mode,
  ap.leg_count,
  ap.sport_mix,
  count(*)                                              as total_parlays,
  count(*) filter (where apr.hit = true)               as wins,
  count(*) filter (where apr.hit = false)              as losses,
  round(
    count(*) filter (where apr.hit = true)::numeric
    / nullif(count(*) filter (where apr.hit is not null), 0), 4
  )                                                     as hit_rate,
  round(
    sum(apr.profit_loss) / nullif(count(*) filter (where apr.completed_at is not null), 0), 4
  )                                                     as avg_profit_loss,
  avg(ap.combined_edge)                                 as avg_edge,
  avg(ap.combined_probability)                          as avg_probability,
  min(ap.generated_date)                                as first_date,
  max(ap.generated_date)                                as last_date
from auto_parlays ap
left join auto_parlay_results apr on apr.parlay_id = ap.id
group by ap.mode, ap.leg_count, ap.sport_mix
order by hit_rate desc nulls last;

comment on table parlay_candidates        is 'Scored leg candidates staged each day before parlay generation';
comment on table auto_parlays             is 'Auto-generated parlays: safe 3-leg, balanced 4-leg, aggressive 6-leg';
comment on table auto_parlay_legs         is 'Legs that make up each auto_parlay';
comment on table auto_parlay_results      is 'Outcome tracking — drives parlay_pattern_learning updates';
comment on table parlay_pattern_learning  is 'Sport+market combo hit rates and ROI — updated as results accumulate';
comment on table parlay_correlation_matrix is 'Pairwise leg-type correlations seeded from domain knowledge, refined by results';
comment on table parlay_edge_daily_summary is 'Daily hit rate and ROI rollup by risk tier';
comment on table parlay_mix_performance   is 'Sport mix ROI tracking for ranking which combos perform best';
comment on table parlay_failure_analysis  is 'Failure reason breakdown — drives penalty weights in the engine';
