-- GameLens learning intelligence layer (backend / analytics).
-- Does not replace public.prediction_results (player_projections settlement) or prediction_outcome_log (ETL).
-- Phases: 1 = logging + rollups, 2 = calibration/threshold hints, 3 = weight suggestions (min samples).

-- ── Error tag catalog (failure attribution) ─────────────────────────────────

create table if not exists public.prediction_error_tags (
  code text primary key,
  label text not null,
  category text not null default 'general',
  created_at timestamptz not null default now()
);

insert into public.prediction_error_tags (code, label, category) values
  ('injury_surprise', 'Injury surprise', 'roster'),
  ('lineup_change', 'Lineup change', 'roster'),
  ('foul_trouble', 'Foul trouble', 'game_state'),
  ('pace_misread', 'Pace misread', 'game_state'),
  ('blowout', 'Blowout script', 'game_state'),
  ('bullpen_collapse', 'Bullpen collapse', 'mlb'),
  ('substitution_risk', 'Substitution risk', 'soccer'),
  ('market_movement', 'Market movement', 'market'),
  ('unknown', 'Unattributed', 'general')
on conflict (code) do nothing;

-- ── Unified prediction history (one row per settled market pick) ───────────

create table if not exists public.prediction_history (
  id uuid primary key default gen_random_uuid(),
  external_game_id text not null,
  sport text not null check (sport in ('nba', 'nfl', 'mlb', 'soccer')),
  market_type text not null,
  pick_side text not null,
  pick_label text not null,
  american_odds integer,
  implied_probability numeric(8,6),
  model_probability numeric(8,6),
  edge numeric(8,6),
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  risk_score numeric(8,4),
  reason_tags jsonb not null default '[]'::jsonb,
  checkpoint_stage text,
  prediction_phase text not null default 'pregame'
    check (prediction_phase in ('pregame', 'live', 'closing')),
  settled_at timestamptz not null default now(),
  final_home_score integer,
  final_away_score integer,
  outcome text not null check (outcome in ('win', 'loss', 'push')),
  error_size numeric(8,6),
  odds_range_bucket text,
  stat_type text,
  parlay_leg_count integer,
  source text not null default 'gamelens_web_v1',
  learning_phase smallint not null default 1 check (learning_phase between 1 and 3),
  user_id uuid references auth.users (id) on delete set null,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists prediction_history_sport_settled_idx
  on public.prediction_history (sport, settled_at desc);
create index if not exists prediction_history_market_conf_idx
  on public.prediction_history (sport, market_type, confidence, settled_at desc);
create index if not exists prediction_history_checkpoint_idx
  on public.prediction_history (sport, checkpoint_stage, prediction_phase);
create index if not exists prediction_history_odds_bucket_idx
  on public.prediction_history (sport, odds_range_bucket);

create unique index if not exists prediction_history_dedupe_team_ml
  on public.prediction_history (external_game_id, market_type)
  where market_type = 'team_moneyline';

comment on table public.prediction_history is
  'Settled predictions for learning: odds, model prob, edge, checkpoint, outcome. Distinct from prediction_results (player props).';

-- ── Junction: history ↔ error tags ──────────────────────────────────────────

create table if not exists public.prediction_history_error_tags (
  history_id uuid not null references public.prediction_history (id) on delete cascade,
  tag_code text not null references public.prediction_error_tags (code) on delete restrict,
  primary key (history_id, tag_code)
);

-- ── Legacy naming: learning-side "results" metrics (optional extension row) ─

create table if not exists public.prediction_learning_results (
  id uuid primary key default gen_random_uuid(),
  history_id uuid not null unique references public.prediction_history (id) on delete cascade,
  brier_score numeric(10,6),
  calibration_residual numeric(10,6),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.prediction_learning_results is
  'Derived metrics per prediction_history row (Brier, calibration residual). Not the player_projection prediction_results table.';

-- ── Feature weight audit trail ────────────────────────────────────────────────

create table if not exists public.feature_weight_history (
  id uuid primary key default gen_random_uuid(),
  sport text not null check (sport in ('nba', 'nfl', 'mlb', 'soccer')),
  feature_key text not null,
  weight_before numeric(12,6) not null,
  weight_after numeric(12,6) not null,
  sample_size_basis int,
  min_sample_required int not null default 200,
  learning_phase smallint not null default 3,
  suggestion_source text,
  batch_id uuid,
  applied boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists feature_weight_history_sport_created_idx
  on public.feature_weight_history (sport, created_at desc);

-- ── Confidence calibration history (time series; complements live calibration row) ─

create table if not exists public.confidence_calibration_history (
  id uuid primary key default gen_random_uuid(),
  sport text not null check (sport in ('nba', 'nfl', 'mlb', 'soccer')),
  confidence_bucket text not null check (confidence_bucket in ('high', 'medium', 'low')),
  prediction_phase text not null default 'pregame' check (prediction_phase in ('pregame', 'live', 'closing')),
  window_days int not null default 30,
  sample_count int not null,
  empirical_hit_rate numeric(8,6),
  target_rate_adjustment numeric(8,6),
  min_sample_met boolean not null default false,
  computed_at timestamptz not null default now()
);

create index if not exists confidence_calibration_history_lookup_idx
  on public.confidence_calibration_history (sport, confidence_bucket, prediction_phase, computed_at desc);

-- ── Rollups ─────────────────────────────────────────────────────────────────

create table if not exists public.market_accuracy_summary (
  id uuid primary key default gen_random_uuid(),
  sport text not null,
  market_type text not null,
  odds_range_bucket text,
  sample_size int not null,
  correct_count int not null,
  window_days int not null default 30,
  parlay_leg_bucket text,
  computed_at timestamptz not null default now(),
  constraint market_accuracy_summary_chk check (sample_size >= 0 and correct_count >= 0 and correct_count <= sample_size)
);

create index if not exists market_accuracy_summary_dims_idx
  on public.market_accuracy_summary (sport, market_type, odds_range_bucket, computed_at desc);

create table if not exists public.checkpoint_accuracy_summary (
  id uuid primary key default gen_random_uuid(),
  sport text not null,
  checkpoint_stage text,
  prediction_phase text not null default 'live',
  sample_size int not null,
  correct_count int not null,
  window_days int not null default 30,
  computed_at timestamptz not null default now(),
  constraint checkpoint_accuracy_summary_chk check (sample_size >= 0 and correct_count >= 0 and correct_count <= sample_size)
);

create index if not exists checkpoint_accuracy_summary_dims_idx
  on public.checkpoint_accuracy_summary (sport, checkpoint_stage, computed_at desc);

-- ── RPC: atomic insert history + tags ─────────────────────────────────────

create or replace function public.submit_prediction_learning_record(
  p_history jsonb,
  p_error_tags text[] default array[]::text[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_tag text;
begin
  if coalesce(p_history->>'market_type', '') = 'team_moneyline' then
    select ph.id into v_id
    from public.prediction_history ph
    where ph.external_game_id = (p_history->>'external_game_id')
      and ph.market_type = 'team_moneyline'
    limit 1;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  insert into public.prediction_history (
    external_game_id,
    sport,
    market_type,
    pick_side,
    pick_label,
    american_odds,
    implied_probability,
    model_probability,
    edge,
    confidence,
    risk_score,
    reason_tags,
    checkpoint_stage,
    prediction_phase,
    final_home_score,
    final_away_score,
    outcome,
    error_size,
    odds_range_bucket,
    stat_type,
    parlay_leg_count,
    source,
    learning_phase,
    user_id,
    extra
  )
  values (
    p_history->>'external_game_id',
    p_history->>'sport',
    p_history->>'market_type',
    p_history->>'pick_side',
    p_history->>'pick_label',
    nullif(p_history->>'american_odds', '')::integer,
    nullif(p_history->>'implied_probability', '')::numeric,
    nullif(p_history->>'model_probability', '')::numeric,
    nullif(p_history->>'edge', '')::numeric,
    p_history->>'confidence',
    nullif(p_history->>'risk_score', '')::numeric,
    coalesce(p_history->'reason_tags', '[]'::jsonb),
    nullif(p_history->>'checkpoint_stage', ''),
    coalesce(nullif(p_history->>'prediction_phase', ''), 'pregame'),
    nullif(p_history->>'final_home_score', '')::integer,
    nullif(p_history->>'final_away_score', '')::integer,
    p_history->>'outcome',
    nullif(p_history->>'error_size', '')::numeric,
    nullif(p_history->>'odds_range_bucket', ''),
    nullif(p_history->>'stat_type', ''),
    nullif(p_history->>'parlay_leg_count', '')::integer,
    coalesce(nullif(p_history->>'source', ''), 'gamelens_web_v1'),
    coalesce(nullif(p_history->>'learning_phase', '')::smallint, 1),
    nullif(p_history->>'user_id', '')::uuid,
    coalesce(p_history->'extra', '{}'::jsonb)
  )
  returning id into v_id;

  foreach v_tag in array p_error_tags loop
    if exists (select 1 from public.prediction_error_tags t where t.code = v_tag) then
      insert into public.prediction_history_error_tags (history_id, tag_code)
      values (v_id, v_tag)
      on conflict do nothing;
    end if;
  end loop;

  return v_id;
end;
$$;

comment on function public.submit_prediction_learning_record is
  'Phase 1: insert one settled prediction + error tags. Idempotent for team_moneyline via unique index.';

-- ── Rollup refresh (service / cron) — requires min samples per bucket ────────

create or replace function public.refresh_learning_market_accuracy_summary(
  p_window_days int default 30,
  p_min_sample int default 30
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
begin
  delete from public.market_accuracy_summary
  where window_days = p_window_days
    and computed_at::date = (timezone('utc', now()))::date;

  insert into public.market_accuracy_summary (
    sport, market_type, odds_range_bucket, sample_size, correct_count, window_days, parlay_leg_bucket, computed_at
  )
  select
    ph.sport,
    ph.market_type,
    ph.odds_range_bucket,
    count(*)::int,
    count(*) filter (where ph.outcome = 'win')::int,
    p_window_days,
    case
      when ph.parlay_leg_count is null then null
      when ph.parlay_leg_count <= 3 then '2_3'
      when ph.parlay_leg_count <= 5 then '4_5'
      else '6_plus'
    end,
    now()
  from public.prediction_history ph
  where ph.settled_at >= (timezone('utc', now()) - (p_window_days || ' days')::interval)
    and ph.outcome in ('win', 'loss')
  group by ph.sport, ph.market_type, ph.odds_range_bucket,
    case
      when ph.parlay_leg_count is null then null
      when ph.parlay_leg_count <= 3 then '2_3'
      when ph.parlay_leg_count <= 5 then '4_5'
      else '6_plus'
    end
  having count(*) >= p_min_sample;

  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.refresh_learning_checkpoint_accuracy_summary(
  p_window_days int default 30,
  p_min_sample int default 25
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
begin
  delete from public.checkpoint_accuracy_summary
  where window_days = p_window_days
    and computed_at::date = (timezone('utc', now()))::date;

  insert into public.checkpoint_accuracy_summary (
    sport, checkpoint_stage, prediction_phase, sample_size, correct_count, window_days, computed_at
  )
  select
    ph.sport,
    coalesce(ph.checkpoint_stage, 'none'),
    ph.prediction_phase,
    count(*)::int,
    count(*) filter (where ph.outcome = 'win')::int,
    p_window_days,
    now()
  from public.prediction_history ph
  where ph.settled_at >= (timezone('utc', now()) - (p_window_days || ' days')::interval)
    and ph.outcome in ('win', 'loss')
  group by ph.sport, coalesce(ph.checkpoint_stage, 'none'), ph.prediction_phase
  having count(*) >= p_min_sample;

  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.refresh_confidence_calibration_history(
  p_window_days int default 30,
  p_min_sample int default 40
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
begin
  delete from public.confidence_calibration_history
  where window_days = p_window_days
    and computed_at::date = (timezone('utc', now()))::date;

  insert into public.confidence_calibration_history (
    sport, confidence_bucket, prediction_phase, window_days, sample_count,
    empirical_hit_rate, target_rate_adjustment, min_sample_met, computed_at
  )
  select
    ph.sport,
    ph.confidence,
    ph.prediction_phase,
    p_window_days,
    count(*)::int,
    (count(*) filter (where ph.outcome = 'win'))::numeric / nullif(count(*) filter (where ph.outcome in ('win', 'loss')), 0),
    0,
    count(*) >= p_min_sample,
    now()
  from public.prediction_history ph
  where ph.settled_at >= (timezone('utc', now()) - (p_window_days || ' days')::interval)
    and ph.outcome in ('win', 'loss')
  group by ph.sport, ph.confidence, ph.prediction_phase
  having count(*) >= p_min_sample;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- ── Internal suggestions (read-only reporting; min samples) ───────────────────

create or replace function public.learning_internal_suggestions(
  p_min_sample int default 80
)
returns table (
  suggestion_key text,
  suggestion_text text,
  sport text,
  sample_size bigint,
  priority int
)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select * from public.prediction_history
    where settled_at >= timezone('utc', now()) - interval '60 days'
      and outcome in ('win', 'loss')
  ),
  blow as (
    select b.sport, count(*) as n,
      avg(case when b.outcome = 'loss' then 1 else 0 end) as loss_rate
    from base b
    where b.extra->>'blowout_risk' = 'high'
      and b.market_type = 'player_prop'
      and b.extra->>'recommended_side' = 'OVER'
    group by b.sport
    having count(*) >= p_min_sample
  ),
  mlb_lineup as (
    select count(*) as n
    from base b
    where b.sport = 'mlb'
      and (b.extra->>'lineup_confirmed')::boolean = true
  ),
  soccer_low as (
    select count(*) as n,
      avg(case when b.outcome = 'win' then 1 else 0 end) as hit_rate
    from base b
    where b.sport = 'soccer'
      and (b.extra->>'low_xg_fixture')::boolean = true
  )
  select 'reduce_conf_high_blowout_prop_overs'::text,
    'Reduce confidence on high blowout-risk player overs when loss_rate elevates.'::text,
    blow.sport,
    blow.n::bigint,
    3
  from blow where blow.loss_rate > 0.52
  union all
  select 'mlb_pitcher_weight_lineups_confirmed',
    'Increase MLB pitcher weighting when lineups are confirmed (sufficient sample).',
    'mlb',
    mlb_lineup.n,
    2
  from mlb_lineup where mlb_lineup.n >= p_min_sample
  union all
  select 'soccer_draw_low_xg',
    'Increase draw probability weight in low-xG soccer fixtures when calibration supports it.',
    'soccer',
    soccer_low.n,
    1
  from soccer_low where soccer_low.n >= p_min_sample and soccer_low.hit_rate is not null;
$$;

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table public.prediction_error_tags enable row level security;
alter table public.prediction_history enable row level security;
alter table public.prediction_history_error_tags enable row level security;
alter table public.prediction_learning_results enable row level security;
alter table public.feature_weight_history enable row level security;
alter table public.confidence_calibration_history enable row level security;
alter table public.market_accuracy_summary enable row level security;
alter table public.checkpoint_accuracy_summary enable row level security;

create policy prediction_error_tags_read on public.prediction_error_tags for select using (true);

create policy prediction_history_insert_auth on public.prediction_history
  for insert to authenticated with check (true);

create policy prediction_history_service_all on public.prediction_history
  for all to service_role using (true) with check (true);

create policy prediction_history_error_tags_service on public.prediction_history_error_tags
  for all to service_role using (true) with check (true);

create policy prediction_learning_results_service on public.prediction_learning_results
  for all to service_role using (true) with check (true);

create policy feature_weight_history_read on public.feature_weight_history for select using (true);
create policy feature_weight_history_service on public.feature_weight_history
  for all to service_role using (true) with check (true);

create policy confidence_calibration_history_read on public.confidence_calibration_history for select using (true);
create policy confidence_calibration_history_service on public.confidence_calibration_history
  for all to service_role using (true) with check (true);

create policy market_accuracy_summary_read on public.market_accuracy_summary for select using (true);
create policy market_accuracy_summary_service on public.market_accuracy_summary
  for all to service_role using (true) with check (true);

create policy checkpoint_accuracy_summary_read on public.checkpoint_accuracy_summary for select using (true);
create policy checkpoint_accuracy_summary_service on public.checkpoint_accuracy_summary
  for all to service_role using (true) with check (true);

grant select on public.prediction_error_tags to anon, authenticated;
grant insert on public.prediction_history to authenticated;
grant select on public.feature_weight_history to anon, authenticated;
grant select on public.confidence_calibration_history to anon, authenticated;
grant select on public.market_accuracy_summary to anon, authenticated;
grant select on public.checkpoint_accuracy_summary to anon, authenticated;

grant all on public.prediction_history to service_role;
grant all on public.prediction_history_error_tags to service_role;
grant all on public.prediction_learning_results to service_role;
grant all on public.feature_weight_history to service_role;
grant all on public.confidence_calibration_history to service_role;
grant all on public.market_accuracy_summary to service_role;
grant all on public.checkpoint_accuracy_summary to service_role;

grant execute on function public.submit_prediction_learning_record(jsonb, text[]) to anon, authenticated, service_role;
grant execute on function public.refresh_learning_market_accuracy_summary(int, int) to service_role;
grant execute on function public.refresh_learning_checkpoint_accuracy_summary(int, int) to service_role;
grant execute on function public.refresh_confidence_calibration_history(int, int) to service_role;
grant execute on function public.learning_internal_suggestions(int) to service_role;

revoke all on function public.refresh_learning_market_accuracy_summary(int, int) from public, anon, authenticated;
revoke all on function public.refresh_learning_checkpoint_accuracy_summary(int, int) from public, anon, authenticated;
revoke all on function public.refresh_confidence_calibration_history(int, int) from public, anon, authenticated;
revoke all on function public.learning_internal_suggestions(int) from public, anon, authenticated;
