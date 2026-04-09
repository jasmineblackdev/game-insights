-- Prediction quality layer storage: calibration, optional per-game analytics payloads.
-- Client reads calibration when populated (ETL from prediction_outcomes / outcome_log).
-- Snapshots are for service-role jobs / future audit; browser does not require writes.

-- ── Empirical confidence calibration (per sport × bucket × window) ─────────────

create table if not exists public.prediction_confidence_calibration (
  id                        text primary key,
  sport                     text not null check (sport in ('nba', 'nfl', 'mlb', 'soccer')),
  confidence_bucket         text not null check (confidence_bucket in ('high', 'medium', 'low')),
  calibration_window        text not null default '30d',
  sample_count              integer not null default 0,
  empirical_hit_rate        numeric(7,4),
  updated_at                timestamptz not null default now(),
  unique (sport, confidence_bucket, calibration_window)
);

create index if not exists idx_pred_conf_cal_sport_window
  on public.prediction_confidence_calibration (sport, calibration_window);

-- ── Flexible per-game layer snapshot (CLV, blends, components) ─────────────────

create table if not exists public.prediction_quality_snapshots (
  id                        text primary key,
  game_id                   text not null,
  sport                     text not null,
  prediction_id             text,
  phase                     text not null default 'pregame',
  layers_json               jsonb not null default '{}',
  model_implied_probability numeric(6,4),
  opening_market_probability numeric(6,4),
  closing_market_probability numeric(6,4),
  clv_delta                 numeric(6,4),
  created_at                timestamptz not null default now()
);

create index if not exists idx_pqs_game_created
  on public.prediction_quality_snapshots (game_id, created_at desc);

-- ── Named analytics tables (optional narrow storage; can mirror layers_json) ──

create table if not exists public.prediction_market_signals (
  id                        text primary key,
  game_id                   text not null,
  sport                     text not null,
  opening_line              jsonb,
  current_line              jsonb,
  closing_line              jsonb,
  line_movement_delta       numeric(8,4),
  market_implied_probability numeric(6,4),
  market_signal_strength    numeric(8,4),
  sharp_move_hint           boolean,
  created_at                timestamptz not null default now()
);

create table if not exists public.prediction_correlation_scores (
  id                        text primary key,
  slip_fingerprint          text,
  sport                     text,
  correlation_score         numeric(8,4),
  correlation_group_id      text,
  card_risk_penalty         numeric(8,4),
  items_json                jsonb not null default '[]',
  created_at                timestamptz not null default now()
);

create table if not exists public.prediction_model_blends (
  id                        text primary key,
  game_id                   text not null,
  sport                     text not null,
  historical_model_score    numeric(8,4),
  recent_model_score        numeric(8,4),
  matchup_model_score       numeric(8,4),
  market_model_score        numeric(8,4),
  live_model_score          numeric(8,4),
  blended_final_score       numeric(8,4),
  weights_json              jsonb not null default '{}',
  created_at                timestamptz not null default now()
);

do $$ declare
  tbl text;
begin
  foreach tbl in array array[
    'prediction_confidence_calibration',
    'prediction_quality_snapshots',
    'prediction_market_signals',
    'prediction_correlation_scores',
    'prediction_model_blends'
  ] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('drop policy if exists %I on public.%I', 'public read ' || tbl, tbl);
    execute format(
      'create policy %I on public.%I for select using (true)',
      'public read ' || tbl,
      tbl
    );
    execute format('drop policy if exists %I on public.%I', 'service write ' || tbl, tbl);
    execute format(
      'create policy %I on public.%I for insert with check (auth.role() = ''service_role'')',
      'service write ' || tbl,
      tbl
    );
    execute format('drop policy if exists %I on public.%I', 'service update ' || tbl, tbl);
    execute format(
      'create policy %I on public.%I for update using (auth.role() = ''service_role'')',
      'service update ' || tbl,
      tbl
    );
  end loop;
end $$;
