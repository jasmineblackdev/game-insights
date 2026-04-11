-- College futures markets (Champion / tournament winner odds + GameLens model layer).
-- Populated by Edge sync or future jobs; app can read via RLS for display archives.

create table if not exists public.futures_markets (
  id uuid primary key default gen_random_uuid(),
  sport text not null,
  league_key text not null,
  season text,
  market_type text not null default 'national_champion',
  competition_name text,
  sportsbook_key text,
  market_name text,
  external_event_id text,
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists futures_markets_dedupe_idx
  on public.futures_markets (league_key, market_type, coalesce(external_event_id, ''), coalesce(sportsbook_key, ''));

create index if not exists futures_markets_sport_idx on public.futures_markets (sport);
create index if not exists futures_markets_league_key_idx on public.futures_markets (league_key);
create index if not exists futures_markets_captured_at_idx on public.futures_markets (captured_at desc);

create table if not exists public.futures_market_options (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.futures_markets (id) on delete cascade,
  selection_name text not null,
  team_id text,
  american_odds integer,
  implied_probability numeric,
  opening_odds integer,
  current_odds integer,
  closing_odds integer,
  line_movement_delta numeric,
  updated_at timestamptz not null default now(),
  unique (market_id, selection_name)
);

create index if not exists futures_market_options_market_id_idx on public.futures_market_options (market_id);

create table if not exists public.futures_model_scores (
  id uuid primary key default gen_random_uuid(),
  market_option_id uuid not null references public.futures_market_options (id) on delete cascade,
  model_probability numeric,
  edge numeric,
  confidence text,
  value_rating text,
  reason_1 text,
  reason_2 text,
  risk_factor text,
  updated_at timestamptz not null default now(),
  unique (market_option_id)
);

create index if not exists futures_model_scores_option_idx on public.futures_model_scores (market_option_id);

alter table public.futures_markets enable row level security;
alter table public.futures_market_options enable row level security;
alter table public.futures_model_scores enable row level security;

-- Public read for app consumers (no PII). Writes via service role / Edge Functions.
drop policy if exists futures_markets_select_public on public.futures_markets;
drop policy if exists futures_market_options_select_public on public.futures_market_options;
drop policy if exists futures_model_scores_select_public on public.futures_model_scores;

create policy futures_markets_select_public on public.futures_markets for select using (true);
create policy futures_market_options_select_public on public.futures_market_options for select using (true);
create policy futures_model_scores_select_public on public.futures_model_scores for select using (true);

grant select on public.futures_markets to anon, authenticated;
grant select on public.futures_market_options to anon, authenticated;
grant select on public.futures_model_scores to anon, authenticated;

comment on table public.futures_markets is 'College (and other) futures boards keyed by Odds API sport + event.';
comment on table public.futures_market_options is 'Per-selection prices and implieds for a futures_markets row.';
comment on table public.futures_model_scores is 'GameLens model probability, edge, value grade, reasons per option.';
