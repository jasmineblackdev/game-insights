-- User-marked "I've verified both probable starters" for MLB games (ESPN game id).
-- Syncs across devices when signed in. Anonymous users keep browser localStorage only.
--
-- PostgREST (authenticated), same project as VITE_SUPABASE_URL:
--   GET    /rest/v1/mlb_starter_user_confirmations?select=game_id,confirmed
--   POST   /rest/v1/mlb_starter_user_confirmations  body: { "game_id": "401772893", "confirmed": true }
--   PATCH  /rest/v1/mlb_starter_user_confirmations?game_id=eq.401772893  body: { "confirmed": false }
--   DELETE /rest/v1/mlb_starter_user_confirmations?game_id=eq.401772893
-- Headers: Authorization: Bearer <access_token>, apikey: <anon_key>

create table if not exists public.mlb_starter_user_confirmations (
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id text not null,
  confirmed boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);

create index if not exists idx_mlb_starter_conf_user_updated
  on public.mlb_starter_user_confirmations (user_id, updated_at desc);

comment on table public.mlb_starter_user_confirmations is
  'Signed-in users: MLB probable-starter self-verification; merged into gamelens-mlb-starters-v1 localStorage on pull.';

alter table public.mlb_starter_user_confirmations enable row level security;

create policy "mlb_starter_conf_select_own"
  on public.mlb_starter_user_confirmations for select
  to authenticated
  using (auth.uid() = user_id);

create policy "mlb_starter_conf_insert_own"
  on public.mlb_starter_user_confirmations for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "mlb_starter_conf_update_own"
  on public.mlb_starter_user_confirmations for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "mlb_starter_conf_delete_own"
  on public.mlb_starter_user_confirmations for delete
  to authenticated
  using (auth.uid() = user_id);
