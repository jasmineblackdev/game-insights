-- Player props (Player Edge) + graded results + per-user favorites by external player id

-- ---------------------------------------------------------------------------
-- player_projections: one row per active prop the Edge Function exposes as JSON items
-- ---------------------------------------------------------------------------

create table public.player_projections (
  id uuid primary key default gen_random_uuid(),
  sport text not null check (sport in ('NBA', 'NFL', 'MLB', 'Soccer')),
  game_id text not null,
  player_id text not null,
  player_name text not null,
  team_abbr text not null,
  opponent_abbr text not null,
  game_time text not null,
  stat_type text not null,
  line_value numeric not null,
  projected_value numeric not null,
  prediction_direction text not null check (prediction_direction in ('MORE', 'LESS')),
  edge numeric not null default 0,
  confidence text not null check (confidence in ('HIGH', 'MED', 'LOW')),
  reason_1 text not null default '',
  reason_2 text not null default '',
  risk_factor text not null default '',
  game_sort int not null default 0,
  confidence_score_0_100 int check (confidence_score_0_100 is null or (confidence_score_0_100 >= 0 and confidence_score_0_100 <= 100)),
  explanations jsonb not null default '[]'::jsonb,
  risk_tier text check (
    risk_tier is null
    or risk_tier in ('safe', 'balanced', 'high_upside', 'longshot')
  ),
  consistency_label text check (
    consistency_label is null
    or consistency_label in ('stable', 'medium', 'volatile')
  ),
  trend_note text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index player_projections_sport_stat_idx on public.player_projections (sport, stat_type)
  where status = 'active';
create index player_projections_game_sort_idx on public.player_projections (game_sort)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- prediction_results: graded outcomes for accuracy rollup (one row per projection)
-- ---------------------------------------------------------------------------

create table public.prediction_results (
  id uuid primary key default gen_random_uuid(),
  projection_id uuid not null references public.player_projections (id) on delete cascade,
  outcome text not null check (outcome in ('win', 'loss', 'push')),
  settled_at timestamptz not null default now(),
  unique (projection_id)
);

create index prediction_results_settled_at_idx on public.prediction_results (settled_at desc);

-- ---------------------------------------------------------------------------
-- user_favorite_players: favorites keyed by provider player id (matches player_projections.player_id)
-- ---------------------------------------------------------------------------

create table public.user_favorite_players (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  sport text not null check (sport in ('NBA', 'NFL', 'MLB', 'Soccer')),
  player_external_id text not null,
  created_at timestamptz not null default now(),
  unique (user_id, sport, player_external_id)
);

create index user_favorite_players_user_id_idx on public.user_favorite_players (user_id);

-- ---------------------------------------------------------------------------
-- Accuracy rollup for Edge / UI (last 7 days of settled props)
-- ---------------------------------------------------------------------------

create or replace function public.player_edge_accuracy_7d()
returns table (
  wins bigint,
  losses bigint,
  pushes bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(count(*) filter (where pr.outcome = 'win'), 0)::bigint,
    coalesce(count(*) filter (where pr.outcome = 'loss'), 0)::bigint,
    coalesce(count(*) filter (where pr.outcome = 'push'), 0)::bigint
  from public.prediction_results pr
  where pr.settled_at >= (now() at time zone 'utc') - interval '7 days';
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.player_projections enable row level security;
alter table public.prediction_results enable row level security;
alter table public.user_favorite_players enable row level security;

create policy player_projections_select_public on public.player_projections
  for select using (status = 'active');

create policy prediction_results_select_public on public.prediction_results
  for select using (true);

create policy user_favorite_players_select_own on public.user_favorite_players
  for select using (auth.uid() = user_id);
create policy user_favorite_players_insert_own on public.user_favorite_players
  for insert with check (auth.uid() = user_id);
create policy user_favorite_players_delete_own on public.user_favorite_players
  for delete using (auth.uid() = user_id);

grant select on public.player_projections to anon, authenticated;
grant select on public.prediction_results to anon, authenticated;
grant select, insert, delete on public.user_favorite_players to authenticated;

grant execute on function public.player_edge_accuracy_7d() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Optional realtime
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.player_projections;

-- ---------------------------------------------------------------------------
-- Seed rows (replace via ETL in production)
-- ---------------------------------------------------------------------------

insert into public.player_projections (
  id, sport, game_id, player_id, player_name, team_abbr, opponent_abbr, game_time,
  stat_type, line_value, projected_value, prediction_direction, edge, confidence,
  reason_1, reason_2, risk_factor, game_sort, confidence_score_0_100, explanations,
  risk_tier, consistency_label, trend_note
) values
  (
    'a0000001-0000-4000-8000-000000000001'::uuid,
    'NBA', 'nba_seed_bos_mia', 'player_tatum_seed', 'Jayson Tatum', 'BOS', 'MIA', '7:30 PM ET',
    'points', 28.5, 31.2, 'MORE', 2.7, 'HIGH',
    'Top-10 usage vs bottom-10 defense vs wings', 'Pace ticks up — extra possessions',
    'Blowout risk could cap minutes in Q4', 10, 88,
    '["Elite shot volume", "Favorable matchup"]'::jsonb,
    'balanced', 'stable', 'Averaged 30+ in last 5 home games.'
  ),
  (
    'a0000002-0000-4000-8000-000000000002'::uuid,
    'NBA', 'nba_seed_lal_gsw', 'player_curry_seed', 'Stephen Curry', 'GSW', 'LAL', '10:00 PM ET',
    'points', 26.5, 24.1, 'LESS', 2.4, 'MED',
    'Elite defender primary matchup', 'Back-to-back — legs matter from deep',
    'Explosion game always possible', 20, 62,
    '["Tough on-ball matchup"]'::jsonb,
    'high_upside', 'volatile', 'Three of last four under vs similar defenses.'
  ),
  (
    'a0000003-0000-4000-8000-000000000003'::uuid,
    'NFL', 'nfl_seed_demo', 'player_allen_seed', 'Josh Allen', 'BUF', 'MIA', '1:00 PM ET',
    'passing_yards', 245.5, 268.0, 'MORE', 22.5, 'HIGH',
    'Miami secondary injuries', 'Game script favors pass-heavy second half',
    'Weather / wind snapshot', 30, 81,
    '[]'::jsonb,
    'safe', 'stable', null
  );

insert into public.prediction_results (projection_id, outcome, settled_at) values
  ('a0000001-0000-4000-8000-000000000001'::uuid, 'win', now() - interval '2 days'),
  ('a0000002-0000-4000-8000-000000000002'::uuid, 'loss', now() - interval '4 days');
