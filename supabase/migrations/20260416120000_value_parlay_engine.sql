-- Value-first parlay engine: sportsbook odds, candidates, builds, player props.
-- Read policies mirror prediction_quality_layers (public SELECT, service writes).

-- ---------------------------------------------------------------------------
-- Reference: books
-- ---------------------------------------------------------------------------
create table if not exists public.sportsbooks (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name text not null,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Append-only odds captures (ingestion / audit)
-- ---------------------------------------------------------------------------
create table if not exists public.odds_snapshots (
  id uuid primary key default gen_random_uuid(),
  sport text not null,
  game_id text not null,
  sportsbook_id uuid references public.sportsbooks (id) on delete set null,
  market_type text not null,
  side_key text not null,
  stat_type text,
  line_value numeric,
  american_odds integer not null,
  implied_probability numeric not null,
  captured_at timestamptz default now()
);

create index if not exists idx_odds_snapshots_game on public.odds_snapshots (sport, game_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- Latest rolling line per book + market + side
-- ---------------------------------------------------------------------------
create table if not exists public.odds_latest (
  id uuid primary key default gen_random_uuid(),
  sport text not null,
  game_id text not null,
  sportsbook_id uuid references public.sportsbooks (id) on delete set null,
  market_type text not null,
  side_key text not null,
  stat_type text,
  line_value numeric,
  opening_odds integer,
  current_odds integer not null,
  closing_odds integer,
  opening_implied_probability numeric,
  current_implied_probability numeric not null,
  closing_implied_probability numeric,
  line_movement_delta numeric default 0,
  updated_at timestamptz default now()
);

create unique index if not exists uq_odds_latest_key on public.odds_latest (
  sport,
  game_id,
  sportsbook_id,
  market_type,
  side_key,
  stat_type,
  line_value
) nulls not distinct;

-- ---------------------------------------------------------------------------
-- Model vs book candidates (ETL or client-sync)
-- ---------------------------------------------------------------------------
create table if not exists public.bet_candidates (
  id uuid primary key default gen_random_uuid(),
  sport text not null,
  game_id text not null,
  pick_type text not null,
  market_type text not null,
  selection_label text not null,
  team_id text,
  player_id text,
  stat_type text,
  line_value numeric,
  american_odds integer not null,
  implied_probability numeric not null,
  model_probability numeric not null,
  edge numeric not null,
  confidence text not null,
  volatility_score numeric default 0,
  uncertainty_score numeric default 0,
  correlation_group_id text,
  value_score numeric not null,
  is_recommended boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_bet_candidates_game on public.bet_candidates (sport, game_id);
create index if not exists idx_bet_candidates_value on public.bet_candidates (value_score desc nulls last);

-- ---------------------------------------------------------------------------
-- Saved parlay builds
-- ---------------------------------------------------------------------------
create table if not exists public.parlay_builds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  mode text not null,
  leg_count integer not null,
  projected_hit_probability numeric,
  projected_payout_multiplier numeric,
  total_edge_score numeric,
  total_value_score numeric,
  correlation_penalty numeric default 0,
  volatility_penalty numeric default 0,
  uncertainty_penalty numeric default 0,
  final_parlay_score numeric not null,
  created_at timestamptz default now()
);

create table if not exists public.parlay_build_items (
  id uuid primary key default gen_random_uuid(),
  parlay_build_id uuid not null references public.parlay_builds (id) on delete cascade,
  bet_candidate_id uuid references public.bet_candidates (id) on delete set null,
  leg_order integer not null,
  created_at timestamptz default now()
);

create index if not exists idx_parlay_build_items_build on public.parlay_build_items (parlay_build_id, leg_order);

-- ---------------------------------------------------------------------------
-- Player prop lines & projections
-- ---------------------------------------------------------------------------
create table if not exists public.player_prop_lines (
  id uuid primary key default gen_random_uuid(),
  sport text not null,
  game_id text not null,
  player_id text not null,
  sportsbook_id uuid references public.sportsbooks (id) on delete set null,
  stat_type text not null,
  line_value numeric not null,
  over_odds integer,
  under_odds integer,
  over_implied_probability numeric,
  under_implied_probability numeric,
  captured_at timestamptz default now()
);

create index if not exists idx_player_prop_lines_lookup on public.player_prop_lines (sport, game_id, player_id, stat_type);

create table if not exists public.player_prop_projections (
  id uuid primary key default gen_random_uuid(),
  sport text not null,
  game_id text not null,
  player_id text not null,
  stat_type text not null,
  projected_value numeric not null,
  over_probability numeric,
  under_probability numeric,
  recommended_side text,
  edge numeric,
  confidence text,
  volatility_score numeric default 0,
  uncertainty_score numeric default 0,
  reason_1 text,
  reason_2 text,
  risk_factor text,
  updated_at timestamptz default now()
);

create index if not exists idx_player_prop_proj_lookup on public.player_prop_projections (sport, game_id, player_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.sportsbooks enable row level security;
alter table public.odds_snapshots enable row level security;
alter table public.odds_latest enable row level security;
alter table public.bet_candidates enable row level security;
alter table public.parlay_builds enable row level security;
alter table public.parlay_build_items enable row level security;
alter table public.player_prop_lines enable row level security;
alter table public.player_prop_projections enable row level security;

-- Public read (same pattern as prediction quality tables)
do $$ declare
  tbl text;
begin
  foreach tbl in array array[
    'sportsbooks',
    'odds_snapshots',
    'odds_latest',
    'bet_candidates',
    'player_prop_lines',
    'player_prop_projections'
  ] loop
    execute format('drop policy if exists %I on public.%I', 'public read ' || tbl, tbl);
    execute format(
      'create policy %I on public.%I for select using (true)',
      'public read ' || tbl,
      tbl
    );
    execute format('drop policy if exists %I on public.%I', 'service write ' || tbl, tbl);
    execute format(
      'create policy %I on public.%I for insert with check (auth.role() = ''service_role'')',
      'service write ' || tbl,
      tbl
    );
    execute format('drop policy if exists %I on public.%I', 'service update ' || tbl, tbl);
    execute format(
      'create policy %I on public.%I for update using (auth.role() = ''service_role'')',
      'service update ' || tbl,
      tbl
    );
  end loop;
end $$;

-- Parlay builds: owners read/write; optional anonymous builds (user_id null) not inserted from browser without policy
drop policy if exists "parlay_builds_select_own" on public.parlay_builds;
create policy "parlay_builds_select_own" on public.parlay_builds
  for select using (auth.uid() = user_id);

drop policy if exists "parlay_builds_insert_own" on public.parlay_builds;
create policy "parlay_builds_insert_own" on public.parlay_builds
  for insert with check (auth.uid() = user_id);

drop policy if exists "parlay_builds_update_own" on public.parlay_builds;
create policy "parlay_builds_update_own" on public.parlay_builds
  for update using (auth.uid() = user_id);

drop policy if exists "parlay_builds_delete_own" on public.parlay_builds;
create policy "parlay_builds_delete_own" on public.parlay_builds
  for delete using (auth.uid() = user_id);

drop policy if exists "parlay_build_items_select" on public.parlay_build_items;
create policy "parlay_build_items_select" on public.parlay_build_items
  for select using (
    exists (
      select 1 from public.parlay_builds b
      where b.id = parlay_build_id and b.user_id = auth.uid()
    )
  );

drop policy if exists "parlay_build_items_insert" on public.parlay_build_items;
create policy "parlay_build_items_insert" on public.parlay_build_items
  for insert with check (
    exists (
      select 1 from public.parlay_builds b
      where b.id = parlay_build_id and b.user_id = auth.uid()
    )
  );

drop policy if exists "parlay_build_items_delete" on public.parlay_build_items;
create policy "parlay_build_items_delete" on public.parlay_build_items
  for delete using (
    exists (
      select 1 from public.parlay_builds b
      where b.id = parlay_build_id and b.user_id = auth.uid()
    )
  );

-- Seed a default book for FK from snapshots (id stable for references)
insert into public.sportsbooks (key, name, is_active)
values ('draftkings', 'DraftKings', true)
on conflict (key) do nothing;
