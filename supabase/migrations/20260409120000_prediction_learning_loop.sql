-- GameLens model learning layer (backend / ETL only).
-- Existing public.prediction_results remains the player-prop settlement table (FK to player_projections).
-- New tables: unified outcome log, rollup summaries, factor weight history.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.prediction_outcome_kind as enum (
  'team_game',
  'player_prop',
  'draft_pick'
);

-- ---------------------------------------------------------------------------
-- prediction_outcome_log: one row per evaluated prediction (team / prop / draft)
-- ---------------------------------------------------------------------------

create table public.prediction_outcome_log (
  id uuid primary key default gen_random_uuid(),
  kind public.prediction_outcome_kind not null,
  sport text not null,
  league_slug text,

  predicted_at timestamptz not null default now(),
  evaluated_at timestamptz,
  source_system text not null default 'gamelens_v1',

  player_projection_id uuid references public.player_projections (id) on delete set null,
  draft_prediction_id uuid references public.draft_predictions (id) on delete set null,
  external_game_id text,

  predicted_winner_side text
    check (predicted_winner_side is null or predicted_winner_side in ('home', 'away', 'draw')),
  predicted_home_probability numeric,
  predicted_away_probability numeric,
  confidence text,
  actual_winner_side text,
  correct_prediction boolean,
  prediction_edge numeric,
  injury_flags jsonb not null default '{}'::jsonb,
  rest_flags jsonb not null default '{}'::jsonb,

  stat_type text,
  line_value numeric,
  projected_value numeric,
  prediction_direction text,
  actual_stat_value numeric,
  difference_from_projection numeric,
  minutes_played numeric,
  injury_status text,
  prop_outcome text check (prop_outcome is null or prop_outcome in ('win', 'loss', 'push')),

  draft_year int,
  pick_number int,
  predicted_player_id text,
  predicted_player_name text,
  actual_player_id text,
  actual_player_name text,
  draft_probability numeric,
  difference_in_pick_position int,
  draft_card_kind text,

  factor_tags text[] not null default '{}',
  factor_scores jsonb not null default '{}'::jsonb,
  calibration_bucket text,
  evaluation_notes text,
  snapshot_prediction jsonb not null default '{}'::jsonb,
  snapshot_actual jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index prediction_outcome_log_kind_sport_eval_idx
  on public.prediction_outcome_log (kind, sport, evaluated_at desc nulls last);

create index prediction_outcome_log_evaluated_idx
  on public.prediction_outcome_log (evaluated_at desc nulls last)
  where evaluated_at is not null;

create index prediction_outcome_log_player_proj_idx
  on public.prediction_outcome_log (player_projection_id)
  where player_projection_id is not null;

create index prediction_outcome_log_draft_idx
  on public.prediction_outcome_log (draft_prediction_id)
  where draft_prediction_id is not null;

create trigger prediction_outcome_log_updated_at
  before update on public.prediction_outcome_log
  for each row execute function public.update_updated_at();

comment on table public.prediction_outcome_log is
  'Unified evaluated predictions for learning: team games, player props, draft. '
  'Populate via ETL / Edge jobs after results are known. '
  'Legacy player prop grades also live in public.prediction_results; backfill or dual-write as needed.';

-- ---------------------------------------------------------------------------
-- prediction_accuracy_summary: rolled-up calibration & accuracy (internal)
-- ---------------------------------------------------------------------------

create table public.prediction_accuracy_summary (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null,
  rollup_window_days int not null default 7,
  sport text,
  outcome_kind public.prediction_outcome_kind,
  confidence_bucket text,
  prediction_type_tag text,
  sample_size int not null,
  correct_count int not null,
  accuracy_ratio numeric generated always as (
    case when sample_size > 0 then round(correct_count::numeric / sample_size, 6) else null end
  ) stored,
  extra_metrics jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  constraint prediction_accuracy_summary_sample_chk check (sample_size >= 0),
  constraint prediction_accuracy_summary_correct_chk check (correct_count >= 0 and correct_count <= sample_size)
);

-- PG requires index expressions to be immutable; enum::text in coalesce() fails.
-- NULLS NOT DISTINCT (PG15+) treats nulls as equal for uniqueness, matching prior coalesce semantics.
create unique index prediction_accuracy_summary_period_idx
  on public.prediction_accuracy_summary (
    period_start,
    period_end,
    rollup_window_days,
    sport,
    outcome_kind,
    confidence_bucket,
    prediction_type_tag
  )
  nulls not distinct;

comment on table public.prediction_accuracy_summary is
  'Aggregated accuracy by sport, kind, confidence — refresh via refresh_prediction_accuracy_summary().';

-- ---------------------------------------------------------------------------
-- factor_weight_adjustments: weekly / batch weight moves (interpretable tuning)
-- ---------------------------------------------------------------------------

create table public.factor_weight_adjustments (
  id uuid primary key default gen_random_uuid(),
  effective_from date not null,
  effective_to date,
  sport text not null,
  factor_key text not null,
  weight_before numeric not null,
  weight_after numeric not null,
  sample_size_basis int,
  adjustment_reason text,
  batch_id uuid,
  created_at timestamptz not null default now(),
  unique (sport, factor_key, effective_from)
);

create index factor_weight_adjustments_sport_from_idx
  on public.factor_weight_adjustments (sport, effective_from desc);

comment on table public.factor_weight_adjustments is
  'Audit trail for factor weights over time; optional batch_id groups a weekly tuning run.';

-- ---------------------------------------------------------------------------
-- Refresh rollups from prediction_outcome_log (service_role / postgres only)
-- ---------------------------------------------------------------------------

create or replace function public.refresh_prediction_accuracy_summary(
  p_period_days int,
  p_label text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_end date := (timezone('utc', now()))::date;
  v_start date := v_end - (p_period_days - 1);
  v_inserted int := 0;
begin
  if p_period_days is null or p_period_days < 1 then
    raise exception 'p_period_days must be >= 1';
  end if;

  delete from public.prediction_accuracy_summary pas
  where pas.period_start = v_start
    and pas.period_end = v_end
    and pas.rollup_window_days = p_period_days;

  insert into public.prediction_accuracy_summary (
    period_start,
    period_end,
    rollup_window_days,
    sport,
    outcome_kind,
    confidence_bucket,
    prediction_type_tag,
    sample_size,
    correct_count,
    extra_metrics,
    computed_at
  )
  select
    v_start,
    v_end,
    p_period_days,
    q.sport,
    q.outcome_kind,
    q.confidence_bucket,
    q.prediction_type_tag,
    count(*)::int,
    count(*) filter (where q.correct_prediction is true)::int,
    jsonb_build_object(
      'window_days', p_period_days,
      'label', p_label,
      'evaluated_with_null_correct', count(*) filter (where q.correct_prediction is null)
    ),
    now()
  from (
    select
      pol.sport,
      pol.kind as outcome_kind,
      pol.calibration_bucket as confidence_bucket,
      pol.correct_prediction,
      case pol.kind
        when 'draft_pick'::public.prediction_outcome_kind then pol.draft_card_kind
        when 'player_prop'::public.prediction_outcome_kind then pol.stat_type
        else null::text
      end as prediction_type_tag
    from public.prediction_outcome_log pol
    where pol.evaluated_at is not null
      and (pol.evaluated_at at time zone 'utc')::date between v_start and v_end
  ) q
  group by q.sport, q.outcome_kind, q.confidence_bucket, q.prediction_type_tag;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

comment on function public.refresh_prediction_accuracy_summary(int, text) is
  'Rebuilds rollup rows for UTC date window [today-(N-1), today] from prediction_outcome_log. '
  'Deletes prior rows for the same window + rollup_window_days, then inserts. '
  'prediction_type_tag is draft_card_kind or stat_type for draft/prop; null for team_game aggregates.';

-- ---------------------------------------------------------------------------
-- RLS: internal tables — no anon/authenticated access via PostgREST
-- ---------------------------------------------------------------------------

alter table public.prediction_outcome_log enable row level security;
alter table public.prediction_accuracy_summary enable row level security;
alter table public.factor_weight_adjustments enable row level security;

revoke all on public.prediction_outcome_log from PUBLIC, anon, authenticated;
revoke all on public.prediction_accuracy_summary from PUBLIC, anon, authenticated;
revoke all on public.factor_weight_adjustments from PUBLIC, anon, authenticated;

grant select, insert, update, delete on public.prediction_outcome_log to service_role;
grant select, insert, update, delete, truncate on public.prediction_accuracy_summary to service_role;
grant select, insert, update, delete on public.factor_weight_adjustments to service_role;

grant execute on function public.refresh_prediction_accuracy_summary(int, text) to service_role;
