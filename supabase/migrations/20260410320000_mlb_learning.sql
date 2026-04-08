-- MLB Model Learning System
--
-- Adds a weight-storage table so the model can self-improve from historical outcomes.
-- Weights start as null (model uses hard-coded defaults) and are written by the
-- computeAndSaveLearnedWeights() utility once sample_size >= 50 predictions.
--
-- Also adds a factor-accuracy view to power the calibration UI.

-- ── Weight storage ────────────────────────────────────────────────────────────

create table if not exists public.mlb_model_weights (
  id              text primary key default 'v1',   -- single-row keyed by model version
  model_version   text not null default '1.0',
  -- Factor weights (sum to 1.0 when all set; null = use hard-coded default)
  w_pitcher       numeric(6,4),   -- default 0.40
  w_batting       numeric(6,4),   -- default 0.20
  w_bullpen       numeric(6,4),   -- default 0.15
  w_form          numeric(6,4),   -- default 0.10
  w_rest          numeric(6,4),   -- default 0.05
  -- Calibration metadata
  sample_size     integer not null default 0,
  brier_score     numeric(8,6),   -- lower is better; null until first calibration
  accuracy_pct    numeric(5,2),   -- % correct predictions in calibration window
  calibrated_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ── Factor accuracy log ───────────────────────────────────────────────────────
-- Stores per-factor calibration results from each learning run.
-- Used to show "pitcher score was +X% accurate" in the debug UI.

create table if not exists public.mlb_factor_accuracy (
  id              bigint generated always as identity primary key,
  model_version   text not null default '1.0',
  factor          text not null,   -- 'pitcher' | 'batting' | 'bullpen' | 'form' | 'rest'
  direction       text not null,   -- 'home_positive' | 'away_positive' | 'neutral'
  sample_size     integer not null,
  correct_count   integer not null,
  accuracy_pct    numeric(5,2) generated always as (
    case when sample_size > 0
      then round((correct_count::numeric / sample_size) * 100, 2)
      else null end
  ) stored,
  computed_at     timestamptz not null default now()
);

-- ── Outcome writing: extend mlb_prediction_inputs_snapshot ───────────────────
-- Add columns for actual result so accuracy can be tracked.
-- Safe to run even if column already exists (DO block catches duplicate_column).

do $$ begin
  begin
    alter table public.mlb_prediction_inputs_snapshot add column actual_winner text;
  exception when duplicate_column then null;
  end;
  begin
    alter table public.mlb_prediction_inputs_snapshot add column correct_prediction boolean;
  exception when duplicate_column then null;
  end;
  begin
    alter table public.mlb_prediction_inputs_snapshot add column final_home_score integer;
  exception when duplicate_column then null;
  end;
  begin
    alter table public.mlb_prediction_inputs_snapshot add column final_away_score integer;
  exception when duplicate_column then null;
  end;
end $$;

-- ── Accuracy view ─────────────────────────────────────────────────────────────
-- Rolling 60-day accuracy grouped by model_version and confidence tier.
-- Drop first: prior migration defined different column order; CREATE OR REPLACE cannot rename columns.

drop view if exists public.mlb_prediction_accuracy;

create view public.mlb_prediction_accuracy as
select
  model_version,
  confidence,
  phase,
  count(*)                                                   as total_predictions,
  count(*) filter (where correct_prediction = true)          as correct_predictions,
  round(
    count(*) filter (where correct_prediction = true)::numeric
    / nullif(count(*), 0) * 100,
    2
  )                                                          as accuracy_pct,
  avg(case when correct_prediction is not null
        then (win_probability / 100.0 - (correct_prediction::int))^2
        else null end
  )                                                          as brier_score,
  min(created_at)                                            as window_start,
  max(created_at)                                            as window_end
from public.mlb_prediction_inputs_snapshot
where
  created_at >= now() - interval '60 days'
  and correct_prediction is not null
group by model_version, confidence, phase
order by model_version, accuracy_pct desc;

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table public.mlb_model_weights enable row level security;
drop policy if exists "public read mlb_model_weights" on public.mlb_model_weights;
create policy "public read mlb_model_weights"
  on public.mlb_model_weights for select using (true);
drop policy if exists "service write mlb_model_weights" on public.mlb_model_weights;
create policy "service write mlb_model_weights"
  on public.mlb_model_weights for insert with check (auth.role() = 'service_role');
drop policy if exists "service update mlb_model_weights" on public.mlb_model_weights;
create policy "service update mlb_model_weights"
  on public.mlb_model_weights for update using (auth.role() = 'service_role');

alter table public.mlb_factor_accuracy enable row level security;
drop policy if exists "public read mlb_factor_accuracy" on public.mlb_factor_accuracy;
create policy "public read mlb_factor_accuracy"
  on public.mlb_factor_accuracy for select using (true);
drop policy if exists "service write mlb_factor_accuracy" on public.mlb_factor_accuracy;
create policy "service write mlb_factor_accuracy"
  on public.mlb_factor_accuracy for insert with check (auth.role() = 'service_role');

-- ── Seed default weight row ───────────────────────────────────────────────────
-- Inserts the default v1 row so the model can always read weights.
-- All weight columns are null → model uses hard-coded defaults until calibrated.

insert into public.mlb_model_weights (id, model_version, sample_size)
values ('v1', '1.0', 0)
on conflict (id) do nothing;
