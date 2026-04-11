-- Live betting snapshots: pregame, per-checkpoint, and final — stable id = upsert key.
-- Writes go through Edge `persist-live-betting` (service role). Clients read via anon if needed.

create table if not exists public.live_betting_stages (
  id text primary key,
  game_id text not null,
  league text not null,
  stage_kind text not null check (stage_kind in ('pregame', 'live_checkpoint', 'final')),
  checkpoint_id text,
  pick_side text not null,
  pick_abbrev text not null,
  model_probability double precision not null,
  implied_probability double precision not null,
  edge double precision not null,
  american_odds integer not null,
  confidence text not null,
  recommended_action text not null,
  odds_source text,
  sport_signals_json jsonb not null default '[]'::jsonb,
  live_state_json jsonb,
  odds_event_id text,
  schema_version integer not null default 1,
  client_captured_at timestamptz not null,
  inserted_at timestamptz not null default now()
);

create index if not exists idx_live_betting_stages_game on public.live_betting_stages (game_id);
create index if not exists idx_live_betting_stages_league_inserted
  on public.live_betting_stages (league, inserted_at desc);

alter table public.live_betting_stages enable row level security;

create policy "live_betting_stages_select_public"
  on public.live_betting_stages for select
  to anon, authenticated
  using (true);

comment on table public.live_betting_stages is
  'Pregame/live/final value rows; id format {game_id}:lb:pregame | {game_id}:lb:{checkpoint_id} | {game_id}:lb:final';
