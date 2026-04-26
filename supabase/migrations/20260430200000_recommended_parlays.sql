-- =============================================================
-- recommended_parlays — single table backing the Parlay Tracking
-- + Review system. Captures every parlay surfaced by the app
-- (auto-save), every parlay the user enters manually, and every
-- recommended parlay the user actually placed. Source labelling
-- keeps the three populations distinguishable for analytics.
-- =============================================================

create table if not exists recommended_parlays (
  id                       uuid primary key default gen_random_uuid(),
  -- ── Provenance ──────────────────────────────────────────────
  source                   text not null
    check (source in ('app_recommended', 'user_manual', 'app_recommended_and_placed')),
  recommended_at           timestamptz not null default now(),
  date                     date not null default current_date,
  model_version            text,
  rules_only               boolean not null default false,   -- true when no leg used ML calibration
  ml_active                boolean not null default false,   -- true when at least one leg's ML was active
  -- ── Build context ───────────────────────────────────────────
  tier                     text check (tier in ('safe','balanced','aggressive','cashout','manual','other')),
  variant                  text,                              -- 'best_value' | 'safer' | 'higher_payout' | 'cashout_best' | etc.
  sport_mix                text,                              -- comma-joined sports list
  market_mix               text,
  -- ── Legs ────────────────────────────────────────────────────
  -- Each leg: { selection, odds, sport, market_type, edge, confidence,
  --             rules_only, ml_active, model_status, reason_included,
  --             reason_excluded, leg_outcome }
  legs                     jsonb not null,
  leg_count                smallint not null,
  -- ── Pricing / model output ──────────────────────────────────
  combined_american_odds   integer,
  payout_multiplier        numeric(8,3),
  combined_probability     numeric(5,4),
  card_score               numeric(7,4),
  card_confidence          text check (card_confidence in ('high','medium','low')),
  warnings                 text[],
  reasons                  text[],
  -- ── User actions ────────────────────────────────────────────
  user_placed              boolean not null default false,
  user_stake               numeric(10,2),
  user_payout              numeric(12,2),
  user_notes               text,
  -- ── Resolution ──────────────────────────────────────────────
  outcome                  text check (outcome in ('won','lost','push','pending','partial')) default 'pending',
  resolved_at              timestamptz,
  -- ── Indexing helpers ────────────────────────────────────────
  user_id                  uuid,                              -- nullable for single-user mode
  session_dedup_key        text,                              -- per-session "tier:variant:legs-fingerprint"
  unique (session_dedup_key)
);

create index if not exists recommended_parlays_date_idx
  on recommended_parlays (date desc);
create index if not exists recommended_parlays_outcome_idx
  on recommended_parlays (outcome, date desc);
create index if not exists recommended_parlays_source_idx
  on recommended_parlays (source, date desc);
create index if not exists recommended_parlays_tier_idx
  on recommended_parlays (tier, outcome);

-- Permissive RLS — same pattern as picks_log, prop_impressions, etc.
alter table recommended_parlays enable row level security;
create policy "allow_all_recommended_parlays" on recommended_parlays
  for all using (true) with check (true);

-- ── analytics_recommended_parlay_rollup() ─────────────────────
-- Best-performing tiers / sports / markets over a window. Powers the
-- analytics view on the Recommended Parlays page.

create or replace function analytics_recommended_parlay_rollup(
  window_days integer default 30
)
returns table (
  bucket            text,
  source            text,
  tier              text,
  resolved_count    integer,
  pending_count     integer,
  won_count         integer,
  lost_count        integer,
  hit_rate_pct      numeric,
  avg_payout_x      numeric,
  est_roi_pct       numeric
)
language sql stable security definer as $$
  with base as (
    select
      coalesce(tier, 'unknown')                                     as tier,
      source,
      coalesce(card_confidence, 'unknown')                          as bucket,
      outcome,
      payout_multiplier,
      user_stake,
      user_payout
    from recommended_parlays
    where recommended_at >= now() - (window_days || ' days')::interval
  )
  select
    bucket,
    source,
    tier,
    count(*) filter (where outcome in ('won','lost','push'))::int   as resolved_count,
    count(*) filter (where outcome = 'pending')::int                as pending_count,
    count(*) filter (where outcome = 'won')::int                    as won_count,
    count(*) filter (where outcome = 'lost')::int                   as lost_count,
    round(100.0 *
      count(*) filter (where outcome = 'won') /
      nullif(count(*) filter (where outcome in ('won','lost')), 0), 2) as hit_rate_pct,
    round(avg(payout_multiplier), 2)                                as avg_payout_x,
    round(100.0 *
      (sum(coalesce(user_payout, 0)) - sum(coalesce(user_stake, 0))) /
      nullif(sum(coalesce(user_stake, 0)), 0), 2)                   as est_roi_pct
  from base
  group by bucket, source, tier
  order by source, tier, bucket;
$$;

comment on function analytics_recommended_parlay_rollup is
  'Recommended-parlay performance by source × tier × confidence bucket. Used by the Recommended Parlays analytics tab.';
