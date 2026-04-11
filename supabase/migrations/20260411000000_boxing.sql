-- Boxing Sport — Supabase Schema
--
-- Tables: boxing_fighters, boxing_fights, boxing_fight_results,
--         boxing_odds, boxing_predictions, boxing_prediction_versions,
--         boxing_learning_history, boxing_model_accuracy
--
-- Fighter data is written by backend ingestion only (service_role).
-- Odds are stored for caching and audit trail.
-- Learning is kept strictly separate from MLB/NBA/NFL learning.

-- ── Fighters ──────────────────────────────────────────────────────────────────

create table if not exists public.boxing_fighters (
  fighter_id            text primary key,
  name                  text not null,
  wins                  integer not null default 0,
  losses                integer not null default 0,
  draws                 integer not null default 0,
  ko_wins               integer not null default 0,
  weight_class          text not null,
  reach_inches          numeric(5,2),
  height_inches         numeric(5,2),
  stance                text check (stance in ('orthodox', 'southpaw', 'switch')),
  age                   integer,
  last_fight_date       date,
  opponent_quality_score numeric(5,2),  -- 0-100 composite SOS score
  ko_pct                numeric(5,4),   -- 0.0–1.0
  decision_pct          numeric(5,4),   -- 0.0–1.0
  style_tag             text,           -- pressure_fighter | counterpuncher | boxer_puncher | brawler
  chin_score            numeric(4,2),   -- 0–10
  -- Data provenance
  data_source           text default 'manual',  -- manual | boxing_data_api | tapology
  external_id           text,           -- source system fighter ID
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ── Fights ────────────────────────────────────────────────────────────────────

create table if not exists public.boxing_fights (
  fight_id              text primary key,
  home_fighter_id       text not null references public.boxing_fighters(fighter_id),
  away_fighter_id       text not null references public.boxing_fighters(fighter_id),
  weight_class          text not null,
  scheduled_rounds      integer not null default 12,
  fight_date            date not null,
  fight_time            time,           -- local time (venue timezone)
  venue                 text,
  is_title_fight        boolean not null default false,
  title_description     text,           -- e.g. "IBF Heavyweight Title"
  promoter              text,
  status                text not null default 'upcoming'
                        check (status in ('upcoming', 'live', 'final', 'cancelled')),
  -- Odds API event ID for moneyline lookup (set by ingestion)
  odds_event_id         text,
  -- Data provenance
  data_source           text default 'manual',
  external_id           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists boxing_fights_date_idx
  on public.boxing_fights (fight_date, status);

-- ── Fight results ─────────────────────────────────────────────────────────────

create table if not exists public.boxing_fight_results (
  result_id             bigint generated always as identity primary key,
  fight_id              text not null references public.boxing_fights(fight_id),
  winner_fighter_id     text references public.boxing_fighters(fighter_id),
  method                text check (method in ('KO', 'TKO', 'decision', 'split_decision', 'draw', 'no_contest', 'DQ')),
  round_ended           integer,
  official_judges_scores text,          -- free text e.g. "115-113, 115-113, 114-114"
  recorded_at           timestamptz not null default now()
);

-- ── Odds snapshot (cached from The Odds API) ──────────────────────────────────

create table if not exists public.boxing_odds (
  odds_id               bigint generated always as identity primary key,
  fight_id              text not null references public.boxing_fights(fight_id),
  odds_event_id         text,           -- The Odds API event ID
  sportsbook_key        text,
  home_moneyline        integer,
  away_moneyline        integer,
  over_rounds           numeric(4,1),
  over_odds             integer,
  under_odds            integer,
  fetched_at            timestamptz not null default now()
);

create index if not exists boxing_odds_fight_idx
  on public.boxing_odds (fight_id, fetched_at desc);

-- ── Predictions ───────────────────────────────────────────────────────────────

create table if not exists public.boxing_predictions (
  prediction_id         bigint generated always as identity primary key,
  fight_id              text not null references public.boxing_fights(fight_id),
  model_version         text not null default '1.0',
  home_win_prob         numeric(5,2),
  away_win_prob         numeric(5,2),
  confidence            text check (confidence in ('high', 'medium', 'low')),
  predicted_winner_id   text references public.boxing_fighters(fighter_id),
  ko_tko_prob           numeric(5,2),
  decision_prob         numeric(5,2),
  draw_prob             numeric(5,2),
  model_delta           numeric(6,4),  -- raw combinedDelta from model
  -- Factor scores at prediction time (debug / learning)
  score_reach           numeric(6,4),
  score_age             numeric(6,4),
  score_stance          numeric(6,4),
  score_inactivity      numeric(6,4),
  score_opponent_quality numeric(6,4),
  score_style           numeric(6,4),
  score_ko_pct          numeric(6,4),
  score_chin            numeric(6,4),
  -- Outcome (written after fight)
  actual_winner_id      text references public.boxing_fighters(fighter_id),
  actual_method         text,
  actual_rounds         integer,
  correct_prediction    boolean,
  created_at            timestamptz not null default now()
);

create index if not exists boxing_predictions_fight_idx
  on public.boxing_predictions (fight_id);
create index if not exists boxing_predictions_outcome_idx
  on public.boxing_predictions (correct_prediction, created_at)
  where correct_prediction is not null;

-- ── Prediction versions (re-score when new data arrives) ─────────────────────

create table if not exists public.boxing_prediction_versions (
  version_id            bigint generated always as identity primary key,
  prediction_id         bigint not null references public.boxing_predictions(prediction_id),
  version_number        integer not null default 1,
  reason                text,          -- "odds_updated" | "fighter_data_updated" | "model_retrained"
  home_win_prob         numeric(5,2),
  away_win_prob         numeric(5,2),
  confidence            text,
  created_at            timestamptz not null default now()
);

-- ── Learning history (self-improving weights, boxing-only) ───────────────────
-- Written by computeBoxingLearnedWeights() offline utility.
-- Separated from MLB/NBA learning — never mixed.

create table if not exists public.boxing_learning_history (
  id                    text primary key default 'v1',
  model_version         text not null default '1.0',
  -- Learned factor weights (null = use hard-coded defaults)
  w_reach               numeric(6,4),  -- default 0.12
  w_age                 numeric(6,4),  -- default 0.18
  w_stance              numeric(6,4),  -- default 0.08
  w_inactivity          numeric(6,4),  -- default 0.10
  w_opponent_quality    numeric(6,4),  -- default 0.22
  w_style               numeric(6,4),  -- default 0.14
  w_ko_pct              numeric(6,4),  -- default 0.10
  w_chin                numeric(6,4),  -- default 0.06
  -- Calibration metadata
  sample_size           integer not null default 0,
  brier_score           numeric(8,6),
  accuracy_pct          numeric(5,2),
  calibrated_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ── Model accuracy view ───────────────────────────────────────────────────────

drop view if exists public.boxing_prediction_accuracy;

create view public.boxing_prediction_accuracy as
select
  model_version,
  confidence,
  count(*)                                                    as total_predictions,
  count(*) filter (where correct_prediction = true)           as correct_predictions,
  round(
    count(*) filter (where correct_prediction = true)::numeric
    / nullif(count(*), 0) * 100,
    2
  )                                                           as accuracy_pct,
  avg(case when correct_prediction is not null
        then (home_win_prob / 100.0 - (correct_prediction::int))^2
        else null end
  )                                                           as brier_score,
  min(created_at)                                             as window_start,
  max(created_at)                                             as window_end
from public.boxing_predictions
where
  created_at >= now() - interval '180 days'
  and correct_prediction is not null
group by model_version, confidence
order by model_version, accuracy_pct desc;

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table public.boxing_fighters enable row level security;
drop policy if exists "public read boxing_fighters" on public.boxing_fighters;
create policy "public read boxing_fighters"
  on public.boxing_fighters for select using (true);
drop policy if exists "service write boxing_fighters" on public.boxing_fighters;
create policy "service write boxing_fighters"
  on public.boxing_fighters for insert with check (auth.role() = 'service_role');
drop policy if exists "service update boxing_fighters" on public.boxing_fighters;
create policy "service update boxing_fighters"
  on public.boxing_fighters for update using (auth.role() = 'service_role');

alter table public.boxing_fights enable row level security;
drop policy if exists "public read boxing_fights" on public.boxing_fights;
create policy "public read boxing_fights"
  on public.boxing_fights for select using (true);
drop policy if exists "service write boxing_fights" on public.boxing_fights;
create policy "service write boxing_fights"
  on public.boxing_fights for insert with check (auth.role() = 'service_role');
drop policy if exists "service update boxing_fights" on public.boxing_fights;
create policy "service update boxing_fights"
  on public.boxing_fights for update using (auth.role() = 'service_role');

alter table public.boxing_fight_results enable row level security;
drop policy if exists "public read boxing_fight_results" on public.boxing_fight_results;
create policy "public read boxing_fight_results"
  on public.boxing_fight_results for select using (true);
drop policy if exists "service write boxing_fight_results" on public.boxing_fight_results;
create policy "service write boxing_fight_results"
  on public.boxing_fight_results for insert with check (auth.role() = 'service_role');

alter table public.boxing_odds enable row level security;
drop policy if exists "public read boxing_odds" on public.boxing_odds;
create policy "public read boxing_odds"
  on public.boxing_odds for select using (true);
drop policy if exists "service write boxing_odds" on public.boxing_odds;
create policy "service write boxing_odds"
  on public.boxing_odds for insert with check (auth.role() = 'service_role');

alter table public.boxing_predictions enable row level security;
drop policy if exists "public read boxing_predictions" on public.boxing_predictions;
create policy "public read boxing_predictions"
  on public.boxing_predictions for select using (true);
drop policy if exists "service write boxing_predictions" on public.boxing_predictions;
create policy "service write boxing_predictions"
  on public.boxing_predictions for insert with check (auth.role() = 'service_role');
drop policy if exists "service update boxing_predictions" on public.boxing_predictions;
create policy "service update boxing_predictions"
  on public.boxing_predictions for update using (auth.role() = 'service_role');

alter table public.boxing_prediction_versions enable row level security;
drop policy if exists "public read boxing_prediction_versions" on public.boxing_prediction_versions;
create policy "public read boxing_prediction_versions"
  on public.boxing_prediction_versions for select using (true);
drop policy if exists "service write boxing_prediction_versions" on public.boxing_prediction_versions;
create policy "service write boxing_prediction_versions"
  on public.boxing_prediction_versions for insert with check (auth.role() = 'service_role');

alter table public.boxing_learning_history enable row level security;
drop policy if exists "public read boxing_learning_history" on public.boxing_learning_history;
create policy "public read boxing_learning_history"
  on public.boxing_learning_history for select using (true);
drop policy if exists "service write boxing_learning_history" on public.boxing_learning_history;
create policy "service write boxing_learning_history"
  on public.boxing_learning_history for insert with check (auth.role() = 'service_role');
drop policy if exists "service update boxing_learning_history" on public.boxing_learning_history;
create policy "service update boxing_learning_history"
  on public.boxing_learning_history for update using (auth.role() = 'service_role');

-- ── Seed default learning row ─────────────────────────────────────────────────

insert into public.boxing_learning_history (id, model_version, sample_size)
values ('v1', '1.0', 0)
on conflict (id) do nothing;
