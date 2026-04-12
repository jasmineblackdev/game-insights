-- ML model tables for the GameLens ML layer.
--
-- Tables:
--   model_weights           — adaptive feature weights per sport/model/context
--   prediction_history      — resolved prop outcomes for the feedback loop
--   player_performance_history — per-player rolling stat history for feature extraction
--   odds_history            — opening vs closing line history for market signal features
--   model_learning_metrics  — Platt scaling params and calibration metadata

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. model_weights
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists model_weights (
  id              uuid primary key default gen_random_uuid(),
  sport           text not null,
  model           text not null,      -- e.g. "prop_projection", "hit_probability"
  context         text not null default 'pregame', -- "pregame" | "live"
  weights         jsonb not null default '{}'::jsonb,
  learned         boolean not null default false,
  sample_size     integer not null default 0,
  calibrated_at   timestamptz,
  version         text not null default '1.0',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (sport, model, context)
);

-- Keep updated_at current
create or replace function update_model_weights_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger model_weights_updated_at
  before update on model_weights
  for each row execute function update_model_weights_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. prediction_history
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists prediction_history (
  id                              uuid primary key default gen_random_uuid(),
  prediction_id                   text not null unique,  -- From picks_log.prop_id
  sport                           text not null,
  stat_type                       text not null,
  market_type                     text not null default 'prop',
  context                         text not null default 'pregame',
  line_value                      numeric not null,
  projected_value                 numeric not null,
  direction                       text not null,         -- "MORE" | "LESS"
  confidence                      text not null,         -- "HIGH" | "MED" | "LOW"
  edge_at_prediction              numeric not null default 0,
  hit_probability_at_prediction   numeric not null default 0.5,
  alpha_at_prediction             numeric not null default 0.05,
  actual_value                    numeric,
  outcome                         text,                  -- "win" | "loss" | "push" | null (unresolved)
  feature_snapshot                jsonb not null default '{}'::jsonb,
  predicted_at                    timestamptz not null default now(),
  resolved_at                     timestamptz,
  created_at                      timestamptz not null default now()
);

create index if not exists prediction_history_sport_context_outcome
  on prediction_history (sport, context, outcome);

create index if not exists prediction_history_sport_resolved
  on prediction_history (sport, resolved_at desc)
  where outcome is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. player_performance_history
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists player_performance_history (
  id              uuid primary key default gen_random_uuid(),
  player_name     text not null,
  sport           text not null,
  stat_type       text not null,
  game_date       date not null,
  actual_value    numeric not null,
  line_value      numeric,
  over_hit        boolean,            -- True if actual_value > line_value
  opponent        text,
  is_home         boolean,
  minutes_played  numeric,
  created_at      timestamptz not null default now(),

  unique (player_name, sport, stat_type, game_date)
);

create index if not exists player_perf_history_lookup
  on player_performance_history (player_name, sport, stat_type, game_date desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. odds_history
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists odds_history (
  id              uuid primary key default gen_random_uuid(),
  prop_id         text not null,
  sport           text not null,
  player_name     text not null,
  stat_type       text not null,
  game_date       date not null,
  opening_line    numeric not null,
  current_line    numeric not null,
  opening_over    numeric,            -- Opening over juice (American odds)
  current_over    numeric,
  opening_under   numeric,
  current_under   numeric,
  market_prob     numeric,            -- Juice-removed implied probability
  provider        text,
  captured_at     timestamptz not null default now(),

  unique (prop_id, captured_at)
);

create index if not exists odds_history_prop_lookup
  on odds_history (prop_id, captured_at desc);

create index if not exists odds_history_sport_date
  on odds_history (sport, game_date desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. model_learning_metrics
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists model_learning_metrics (
  id              uuid primary key default gen_random_uuid(),
  sport           text not null,
  model           text not null,
  platt_a         numeric not null default 1.0,
  platt_b         numeric not null default 0.0,
  sample_size     integer not null default 0,
  win_rate        numeric,            -- Observed win rate over last N predictions
  log_loss        numeric,            -- Log-loss score (lower = better calibrated)
  brier_score     numeric,            -- Brier score (lower = better)
  calibrated_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (sport, model)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: Allow authenticated users to read; service role to write
-- ─────────────────────────────────────────────────────────────────────────────
alter table model_weights enable row level security;
alter table prediction_history enable row level security;
alter table player_performance_history enable row level security;
alter table odds_history enable row level security;
alter table model_learning_metrics enable row level security;

-- Read policies (authenticated users can read model data)
create policy "ml_model_weights_read" on model_weights
  for select using (true);

create policy "ml_prediction_history_read" on prediction_history
  for select using (true);

create policy "ml_player_perf_read" on player_performance_history
  for select using (true);

create policy "ml_odds_history_read" on odds_history
  for select using (true);

create policy "ml_learning_metrics_read" on model_learning_metrics
  for select using (true);

-- Write policies (allow inserts/upserts from authenticated users — no user_id required)
create policy "ml_model_weights_write" on model_weights
  for all using (true) with check (true);

create policy "ml_prediction_history_write" on prediction_history
  for all using (true) with check (true);

create policy "ml_player_perf_write" on player_performance_history
  for all using (true) with check (true);

create policy "ml_odds_history_write" on odds_history
  for all using (true) with check (true);

create policy "ml_learning_metrics_write" on model_learning_metrics
  for all using (true) with check (true);

-- Seed default model weights for each sport (identity weights — all features equal)
insert into model_weights (sport, model, context, weights, learned, sample_size, version)
values
  -- NBA
  ('nba', 'prop_projection',   'pregame', '{"recent_form":0.32,"season_base":0.25,"matchup":0.18,"role":0.15,"pace_env":0.07,"volatility":0.03}'::jsonb, false, 0, '1.0'),
  ('nba', 'hit_probability',   'pregame', '{"avg_vs_line":1.80,"season_vs_line":0.90,"matchup":0.60,"usage":0.50,"pace":0.30,"line_movement":-0.30}'::jsonb, false, 0, '1.0'),
  ('nba', 'confidence',        'pregame', '{"variability":-0.35,"drift":-0.30,"market_stability":0.20,"data_quality":0.15}'::jsonb, false, 0, '1.0'),
  -- NFL
  ('nfl', 'prop_projection',   'pregame', '{"recent_form":0.32,"season_base":0.25,"matchup":0.18,"role":0.15,"pace_env":0.07,"volatility":0.03}'::jsonb, false, 0, '1.0'),
  ('nfl', 'hit_probability',   'pregame', '{"avg_vs_line":1.80,"season_vs_line":0.90,"matchup":0.60,"usage":0.50,"pace":0.30,"line_movement":-0.30}'::jsonb, false, 0, '1.0'),
  ('nfl', 'confidence',        'pregame', '{"variability":-0.35,"drift":-0.30,"market_stability":0.20,"data_quality":0.15}'::jsonb, false, 0, '1.0'),
  -- MLB
  ('mlb', 'prop_projection',   'pregame', '{"recent_form":0.32,"season_base":0.25,"matchup":0.18,"role":0.15,"pace_env":0.07,"volatility":0.03}'::jsonb, false, 0, '1.0'),
  ('mlb', 'hit_probability',   'pregame', '{"avg_vs_line":1.80,"season_vs_line":0.90,"matchup":0.60,"usage":0.50,"pace":0.30,"line_movement":-0.30}'::jsonb, false, 0, '1.0'),
  ('mlb', 'confidence',        'pregame', '{"variability":-0.35,"drift":-0.30,"market_stability":0.20,"data_quality":0.15}'::jsonb, false, 0, '1.0'),
  -- MMA
  ('mma', 'prop_projection',   'pregame', '{"recent_form":0.32,"season_base":0.25,"matchup":0.18,"role":0.15,"pace_env":0.07,"volatility":0.03}'::jsonb, false, 0, '1.0'),
  ('mma', 'hit_probability',   'pregame', '{"avg_vs_line":1.80,"season_vs_line":0.90,"matchup":0.60,"usage":0.50,"pace":0.30,"line_movement":-0.30}'::jsonb, false, 0, '1.0'),
  ('mma', 'confidence',        'pregame', '{"variability":-0.35,"drift":-0.30,"market_stability":0.20,"data_quality":0.15}'::jsonb, false, 0, '1.0'),
  -- Boxing
  ('boxing', 'prop_projection',   'pregame', '{"recent_form":0.32,"season_base":0.25,"matchup":0.18,"role":0.15,"pace_env":0.07,"volatility":0.03}'::jsonb, false, 0, '1.0'),
  ('boxing', 'hit_probability',   'pregame', '{"avg_vs_line":1.80,"season_vs_line":0.90,"matchup":0.60,"usage":0.50,"pace":0.30,"line_movement":-0.30}'::jsonb, false, 0, '1.0'),
  ('boxing', 'confidence',        'pregame', '{"variability":-0.35,"drift":-0.30,"market_stability":0.20,"data_quality":0.15}'::jsonb, false, 0, '1.0')
on conflict (sport, model, context) do nothing;
