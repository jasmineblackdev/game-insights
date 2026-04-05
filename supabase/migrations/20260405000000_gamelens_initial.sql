-- GameLens MVP schema (NBA-first; league column allows NFL later)
-- Run in Supabase: SQL Editor → New query → paste → Run
-- Or: supabase db push (if using Supabase CLI linked to this project)

-- ---------------------------------------------------------------------------
-- Core reference data
-- ---------------------------------------------------------------------------

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  external_id text,
  league text not null default 'nba' check (league in ('nba', 'nfl')),
  key text,
  city text,
  name text not null,
  conference text,
  division text,
  logo_url text,
  updated_at timestamptz not null default now(),
  unique (league, external_id),
  unique (league, key)
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  external_id text,
  team_id uuid references public.teams (id) on delete set null,
  league text not null default 'nba',
  full_name text not null,
  position text,
  jersey_number int,
  status text,
  updated_at timestamptz not null default now(),
  unique (league, external_id)
);

create index players_team_id_idx on public.players (team_id);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  external_id text,
  league text not null default 'nba',
  season int,
  season_type text,
  game_date date,
  scheduled_at timestamptz,
  status text,
  home_team_id uuid references public.teams (id),
  away_team_id uuid references public.teams (id),
  home_score int,
  away_score int,
  venue text,
  updated_at timestamptz not null default now(),
  unique (league, external_id)
);

create index games_scheduled_at_idx on public.games (scheduled_at);
create index games_league_season_idx on public.games (league, season);

create table public.injuries (
  id uuid primary key default gen_random_uuid(),
  external_id text,
  player_id uuid references public.players (id) on delete cascade,
  team_id uuid references public.teams (id),
  league text not null default 'nba',
  game_status text,
  practice_status text,
  body_part text,
  description text,
  updated_at_provider timestamptz,
  updated_at timestamptz not null default now()
);

create index injuries_player_id_idx on public.injuries (player_id);
create index injuries_team_id_idx on public.injuries (team_id);

-- ---------------------------------------------------------------------------
-- Predictions (append-only history via multiple rows per game)
-- ---------------------------------------------------------------------------

create table public.predictions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  model_version text not null default 'v1',
  home_win_probability numeric(6, 5),
  confidence numeric(6, 5),
  summary text,
  factors jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  constraint predictions_home_win_probability_range
    check (home_win_probability is null or (home_win_probability >= 0 and home_win_probability <= 1)),
  constraint predictions_confidence_range
    check (confidence is null or (confidence >= 0 and confidence <= 1))
);

create index predictions_game_computed_idx on public.predictions (game_id, computed_at desc);

-- ---------------------------------------------------------------------------
-- Auth-linked tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.user_favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  team_id uuid references public.teams (id) on delete cascade,
  player_id uuid references public.players (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint user_favorites_one_target check (
    (team_id is not null and player_id is null)
    or (team_id is null and player_id is not null)
  )
);

create unique index user_favorites_user_team_uidx
  on public.user_favorites (user_id, team_id)
  where team_id is not null;

create unique index user_favorites_user_player_uidx
  on public.user_favorites (user_id, player_id)
  where player_id is not null;

create table public.user_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  alert_type text not null,
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index user_alerts_user_id_idx on public.user_alerts (user_id);

-- ---------------------------------------------------------------------------
-- New user → profile row
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.teams enable row level security;
alter table public.players enable row level security;
alter table public.games enable row level security;
alter table public.injuries enable row level security;
alter table public.predictions enable row level security;
alter table public.profiles enable row level security;
alter table public.user_favorites enable row level security;
alter table public.user_alerts enable row level security;

-- Public read for catalog + predictions (tighten later if needed)
create policy teams_select_all on public.teams for select using (true);
create policy players_select_all on public.players for select using (true);
create policy games_select_all on public.games for select using (true);
create policy injuries_select_all on public.injuries for select using (true);
create policy predictions_select_all on public.predictions for select using (true);

-- Profiles: own row only
create policy profiles_select_own on public.profiles for select using (auth.uid() = id);
create policy profiles_update_own on public.profiles for update using (auth.uid() = id);

-- Favorites & alerts: own rows
create policy user_favorites_select_own on public.user_favorites for select using (auth.uid() = user_id);
create policy user_favorites_insert_own on public.user_favorites for insert with check (auth.uid() = user_id);
create policy user_favorites_delete_own on public.user_favorites for delete using (auth.uid() = user_id);

create policy user_alerts_select_own on public.user_alerts for select using (auth.uid() = user_id);
create policy user_alerts_insert_own on public.user_alerts for insert with check (auth.uid() = user_id);
create policy user_alerts_update_own on public.user_alerts for update using (auth.uid() = user_id);
create policy user_alerts_delete_own on public.user_alerts for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Realtime (optional): predictions / games for live UI
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.games;
alter publication supabase_realtime add table public.predictions;
