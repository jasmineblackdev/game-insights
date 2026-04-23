-- =============================================================
-- Accuracy feedback loop — closes the learning loop with CLV
-- tracking, injury-delta features, pre-confirmation flagging, and
-- Platt recalibration support.
--
-- Additions:
--   1. prediction_history columns for CLV + injury delta +
--      pre-confirmation + platt_applied bookkeeping
--   2. prediction_clv_snapshots — raw line snapshots keyed per
--      prediction so the client can accumulate samples before
--      closing-line selection
--   3. analytics_clv_by_sport_phase() — CLV hit rate + average
--      movement grouped by sport, market_type, confidence
--   4. platt_calibration_params — per-(sport, market_type,
--      confidence_bucket) Platt A/B params updated by the nightly
--      edge function
-- =============================================================

-- ── 1. Extend prediction_history ─────────────────────────────────

alter table prediction_history
  add column if not exists closing_line_american  integer,
  add column if not exists closing_line_snap_at   timestamptz,
  add column if not exists opening_line_american  integer,
  add column if not exists clv_pp                 numeric(6,2),
  add column if not exists injury_delta           numeric(6,4),
  add column if not exists pre_confirmation_flag  boolean default false,
  add column if not exists platt_applied          boolean default false,
  add column if not exists platt_batch_id         uuid;

create index if not exists prediction_history_platt_pending_idx
  on prediction_history (platt_applied, sport, resolved_at)
  where platt_applied = false and outcome is not null;

create index if not exists prediction_history_clv_idx
  on prediction_history (sport, market_type, clv_pp desc)
  where clv_pp is not null;

-- ── 2. Closing-line snapshot buffer ──────────────────────────────
-- Rather than overwrite closing_line_american every odds refresh,
-- accumulate samples here. The edge function / analytics selects
-- the latest snap_at per prediction as the "closing line".

create table if not exists prediction_clv_snapshots (
  id              uuid primary key default gen_random_uuid(),
  prediction_id   text not null,
  sport           text not null,
  market_type     text not null,
  american_odds   integer not null,
  snap_at         timestamptz not null default now(),
  minutes_to_start integer,                          -- negative = post-start
  sportsbook_key  text,
  created_at      timestamptz not null default now()
);

create index if not exists prediction_clv_snapshots_prediction_idx
  on prediction_clv_snapshots (prediction_id, snap_at desc);
create index if not exists prediction_clv_snapshots_sport_idx
  on prediction_clv_snapshots (sport, snap_at desc);

alter table prediction_clv_snapshots enable row level security;
create policy "allow_all_prediction_clv_snapshots" on prediction_clv_snapshots
  for all using (true) with check (true);

-- ── 3. Platt calibration parameters ──────────────────────────────

create table if not exists platt_calibration_params (
  id                 uuid primary key default gen_random_uuid(),
  sport              text not null,
  market_type        text not null,
  confidence_bucket  text not null,                -- 'HIGH' | 'MED' | 'LOW' | 'ALL'
  a_param            numeric(8,4) not null,        -- slope
  b_param            numeric(8,4) not null,        -- intercept
  sample_size        integer not null,
  brier_score        numeric(6,4),
  log_loss           numeric(6,4),
  fitted_at          timestamptz not null default now(),
  unique (sport, market_type, confidence_bucket)
);

create index if not exists platt_calibration_params_lookup_idx
  on platt_calibration_params (sport, market_type, confidence_bucket);

alter table platt_calibration_params enable row level security;
create policy "allow_all_platt_calibration_params" on platt_calibration_params
  for all using (true) with check (true);

-- ── 4. analytics_clv_by_sport_phase RPC ──────────────────────────
-- Returns CLV hit rate (predictions with positive CLV) and average
-- movement by sport × market_type × confidence, over a rolling
-- window.

create or replace function analytics_clv_by_sport_phase(
  window_days integer default 30,
  min_samples integer default 10
)
returns table (
  sport                 text,
  market_type           text,
  confidence            text,
  resolved_count        integer,
  clv_positive_count    integer,
  clv_positive_pct      numeric,
  avg_clv_pp            numeric,
  median_clv_pp         numeric,
  win_rate              numeric,
  clv_win_correlation   numeric       -- Pearson r between clv_pp and win
)
language sql
stable
security definer
as $$
  with base as (
    select
      sport,
      market_type,
      confidence,
      clv_pp,
      case when outcome = 'win' then 1
           when outcome = 'loss' then 0
           else null
      end as win_int
    from prediction_history
    where resolved_at >= now() - (window_days || ' days')::interval
      and clv_pp is not null
      and outcome in ('win','loss')
  ),
  agg as (
    select
      sport,
      market_type,
      confidence,
      count(*)::int                                          as resolved_count,
      count(*) filter (where clv_pp > 0)::int                as clv_positive_count,
      round(100.0 * count(*) filter (where clv_pp > 0) /
            nullif(count(*), 0), 2)                          as clv_positive_pct,
      round(avg(clv_pp)::numeric, 2)                         as avg_clv_pp,
      round((percentile_cont(0.5) within group (order by clv_pp))::numeric, 2)
                                                             as median_clv_pp,
      round(100.0 * avg(win_int)::numeric, 2)                as win_rate,
      round(corr(clv_pp::double precision, win_int::double precision)::numeric, 4)
                                                             as clv_win_correlation
    from base
    group by sport, market_type, confidence
  )
  select * from agg
  where resolved_count >= min_samples
  order by sport, market_type, confidence;
$$;

comment on function analytics_clv_by_sport_phase is
  'Closing-line value analysis: CLV-positive %, avg movement, win-rate correlation by sport × market × confidence.';

-- ── 5. analytics_platt_calibration_status RPC ────────────────────
-- Surfaces which (sport, market) combinations have freshly-fitted
-- Platt params and which are stale or never run.

create or replace function analytics_platt_calibration_status()
returns table (
  sport              text,
  market_type        text,
  confidence_bucket  text,
  sample_size        integer,
  brier_score        numeric,
  log_loss           numeric,
  fitted_at          timestamptz,
  days_since_fit     integer
)
language sql
stable
security definer
as $$
  select
    sport,
    market_type,
    confidence_bucket,
    sample_size,
    brier_score,
    log_loss,
    fitted_at,
    extract(day from now() - fitted_at)::int as days_since_fit
  from platt_calibration_params
  order by fitted_at desc;
$$;
