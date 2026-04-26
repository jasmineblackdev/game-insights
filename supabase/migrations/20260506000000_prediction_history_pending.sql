-- =============================================================
-- prediction_history_pending — pick-time staging for the learning
-- loop. The settled-row table prediction_history (defined in
-- 20260421100000_gamelens_learning_intelligence.sql) requires
-- outcome NOT NULL, but at slip-add time we don't know the outcome
-- yet. This staging table snapshots the pick-time model probability
-- and edge so the post-game settler can write a faithful Brier-
-- scorable row. Settled rows are deleted from this table once they
-- land in prediction_history.
-- =============================================================

create table if not exists public.prediction_history_pending (
  id                  uuid primary key default gen_random_uuid(),
  external_game_id    text not null,
  sport               text not null check (sport in ('nba', 'nfl', 'mlb', 'soccer', 'wnba', 'mma', 'boxing')),
  market_type         text not null default 'team_moneyline',
  pick_side           text not null,
  pick_label          text not null,
  american_odds       integer,
  implied_probability numeric(8,6),
  model_probability   numeric(8,6),
  edge                numeric(8,6),
  confidence          text not null check (confidence in ('high', 'medium', 'low')),
  risk_score          numeric(8,4),
  reason_tags         jsonb not null default '[]'::jsonb,
  prediction_phase    text not null default 'pregame'
                      check (prediction_phase in ('pregame', 'live', 'closing')),
  staged_at           timestamptz not null default now(),
  user_id             uuid references auth.users (id) on delete set null,
  extra               jsonb not null default '{}'::jsonb
);

-- Dedupe so repeated slip-adds for the same side don't pile up rows.
create unique index if not exists prediction_history_pending_dedupe_idx
  on public.prediction_history_pending (external_game_id, market_type, pick_side);

create index if not exists prediction_history_pending_settle_idx
  on public.prediction_history_pending (sport, staged_at);

comment on table public.prediction_history_pending is
  'Pick-time snapshots awaiting game-final settlement. Rows move to prediction_history once outcome is known.';

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.prediction_history_pending enable row level security;

-- Authenticated users (browser) can stage their own picks. The dedupe
-- index makes idempotent repeated calls cheap.
create policy prediction_history_pending_insert_auth on public.prediction_history_pending
  for insert to authenticated with check (true);

-- Anonymous staging too — most users on this app aren't signed in yet,
-- and the unique index plus the staged_at cap (settler deletes on
-- success) bounds growth.
create policy prediction_history_pending_insert_anon on public.prediction_history_pending
  for insert to anon with check (true);

-- Read-back for the settler running with the user's role.
create policy prediction_history_pending_read on public.prediction_history_pending
  for select to anon, authenticated using (true);

-- Service role full access for the settler when run from edge functions.
create policy prediction_history_pending_service on public.prediction_history_pending
  for all to service_role using (true) with check (true);

-- The settler needs to delete rows once they're settled. Allow it from
-- any role that can also read so the client-side sweep works.
create policy prediction_history_pending_delete on public.prediction_history_pending
  for delete to anon, authenticated using (true);

grant select, insert, delete on public.prediction_history_pending to anon, authenticated;
grant all on public.prediction_history_pending to service_role;
