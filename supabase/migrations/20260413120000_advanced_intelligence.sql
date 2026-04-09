-- Advanced intelligence storage — layered metrics for NBA / NFL / MLB / Soccer.
-- Populated by ETL jobs or external analytics APIs; client reads with public SELECT.
-- When rows are absent, GameLens falls back to the base model only.

-- ── Layer 2–3: team & player rolling metrics (JSON allows schema evolution) ─────

create table if not exists public.advanced_team_metrics (
  id                        text primary key,
  sport                     text not null check (sport in ('nba', 'nfl', 'mlb', 'soccer')),
  team_id                   text not null,
  season                    smallint not null,
  rolling_window            text not null default 'season'
                            check (rolling_window in ('last_3', 'last_5', 'last_10', 'season')),
  metrics                   jsonb not null default '{}',
  confidence_adjustment_weight numeric(6,4),
  source                    text,
  updated_at                timestamptz not null default now()
);

create unique index if not exists idx_adv_team_unique
  on public.advanced_team_metrics (sport, team_id, season, rolling_window);
create index if not exists idx_adv_team_lookup
  on public.advanced_team_metrics (sport, season, team_id);

create table if not exists public.advanced_player_metrics (
  id                        text primary key,
  sport                     text not null check (sport in ('nba', 'nfl', 'mlb', 'soccer')),
  player_id                 text not null,
  team_id                   text,
  season                    smallint not null,
  rolling_window            text not null default 'season'
                            check (rolling_window in ('last_3', 'last_5', 'last_10', 'season')),
  metrics                   jsonb not null default '{}',
  confidence_adjustment_weight numeric(6,4),
  updated_at                timestamptz not null default now()
);

create unique index if not exists idx_adv_player_unique
  on public.advanced_player_metrics (sport, player_id, season, rolling_window);

-- ── Head-to-head / matchup samples ─────────────────────────────────────────────

create table if not exists public.matchup_history (
  id                        text primary key,
  sport                     text not null check (sport in ('nba', 'nfl', 'mlb', 'soccer')),
  team_a_id                 text not null,
  team_b_id                 text not null,
  season                    smallint not null,
  games_sample              integer,
  metrics                   jsonb not null default '{}',
  confidence_adjustment_weight numeric(6,4),
  updated_at                timestamptz not null default now()
);

create unique index if not exists idx_matchup_hist_unique
  on public.matchup_history (sport, team_a_id, team_b_id, season);

-- ── Lineup / rotation proxies (generic; MLB also has mlb_lineup_strength_scores) ─

create table if not exists public.lineup_strength_scores (
  id                        text primary key,
  sport                     text not null check (sport in ('nba', 'nfl', 'mlb', 'soccer')),
  team_id                   text not null,
  game_key                  text not null,
  season                    smallint,
  rolling_window_metrics    jsonb not null default '{}',
  confidence_adjustment_weight numeric(6,4),
  computed_at               timestamptz not null default now()
);

create index if not exists idx_lineup_strength_lookup
  on public.lineup_strength_scores (sport, game_key, team_id);

-- ── Cross-sport fatigue / congestion (complements sport-specific tables) ───────

create table if not exists public.fatigue_scores (
  id                        text primary key,
  sport                     text not null check (sport in ('nba', 'nfl', 'mlb', 'soccer')),
  team_id                   text not null,
  as_of_date                date not null,
  season                    smallint,
  rolling_window_metrics    jsonb not null default '{}',
  confidence_adjustment_weight numeric(6,4),
  computed_at               timestamptz not null default now()
);

create unique index if not exists idx_fatigue_scores_unique
  on public.fatigue_scores (sport, team_id, as_of_date);

-- ── Audit / backtest: what advanced inputs were available per game ──────────────

create table if not exists public.advanced_prediction_inputs (
  id                        text primary key,
  sport                     text not null,
  external_game_id          text not null,
  phase                     text not null default 'pregame',
  base_signals              jsonb,
  advanced_signals          jsonb,
  live_signals              jsonb,
  market_signals            jsonb,
  final_adjustment_note     text,
  created_at                timestamptz not null default now()
);

create index if not exists idx_adv_pred_inputs_game
  on public.advanced_prediction_inputs (sport, external_game_id, phase);

-- ── RLS: read for all; writes via service role (ETL / Edge) ────────────────────

do $$ declare
  tbl text;
begin
  foreach tbl in array array[
    'advanced_team_metrics',
    'advanced_player_metrics',
    'matchup_history',
    'lineup_strength_scores',
    'fatigue_scores',
    'advanced_prediction_inputs'
  ] loop
    execute format('alter table public.%I enable row level security', tbl);
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
