-- ============================================================
-- odds_api_health — server-side singleton tracking the most
-- recent state of The Odds API as observed by the
-- closing-odds-poller Edge function.
--
-- The browser-side `oddsApiHealth` store in src/lib/oddsApiHealth.ts
-- tracks per-session state from the user's own page-load fetches.
-- That works for the StaleLinesBanner but doesn't help the
-- closing-odds-poller's nightly cron — that runs server-side, so
-- its OUT_OF_USAGE_CREDITS / INVALID_MARKET observations are
-- invisible to the client until the next user fetch hits the same
-- error.
--
-- Persisting the poller's last-observed state lets Insights Data
-- Health show "Closing-line poller: quota exhausted (3h ago)"
-- instead of just "0 CLV samples — why?".
--
-- Singleton row pattern (id = 'singleton') so the table stays
-- bounded — only the latest poll outcome matters for diagnostics.
-- ============================================================

create table if not exists public.odds_api_health (
  id              text primary key default 'singleton'
    check (id = 'singleton'),
  -- "ok" / "quota_exhausted" / "invalid_market" / "rate_limited"
  -- / "auth_failed" / "network_error" / "unknown"
  status          text not null default 'unknown',
  -- The Odds API error_code verbatim when present, e.g.
  -- "OUT_OF_USAGE_CREDITS", "EXCEEDED_FREQ_LIMIT", "INVALID_MARKET".
  -- null on healthy runs.
  error_code      text,
  -- Sport key that triggered the most recent failure, when
  -- applicable. e.g. "basketball_nba". null on healthy runs.
  sport_key       text,
  -- Free-form upstream message + the human-readable banner text
  -- the UI can render directly.
  message         text,
  -- Counts from the most recent run for the dashboard.
  parlays_scanned integer not null default 0,
  games_polled    integer not null default 0,
  legs_updated    integer not null default 0,
  observed_at     timestamptz not null default now()
);

alter table public.odds_api_health enable row level security;
create policy odds_api_health_read on public.odds_api_health
  for select to anon, authenticated using (true);
create policy odds_api_health_service on public.odds_api_health
  for all to service_role using (true) with check (true);

grant select on public.odds_api_health to anon, authenticated;
grant all on public.odds_api_health to service_role;

-- Seed the singleton so the closing-odds-poller can always upsert
-- against a known row id without conditional insert/update logic.
insert into public.odds_api_health (id, status, message)
values ('singleton', 'unknown', 'No poll runs observed yet.')
on conflict (id) do nothing;

-- ── analytics_odds_api_health() ─────────────────────────────────
-- Read RPC the client uses to surface the row in DataSourcesPanel.
-- security definer so anon can read without needing direct table
-- access.

create or replace function analytics_odds_api_health()
returns table (
  status          text,
  error_code      text,
  sport_key       text,
  message         text,
  parlays_scanned integer,
  games_polled    integer,
  legs_updated    integer,
  observed_at     timestamptz
)
language sql
stable
security definer
as $$
  select
    status, error_code, sport_key, message,
    parlays_scanned, games_polled, legs_updated, observed_at
  from public.odds_api_health
  where id = 'singleton'
  limit 1;
$$;

grant execute on function analytics_odds_api_health() to anon, authenticated;

comment on table public.odds_api_health is
  'Singleton snapshot of The Odds API state from the most recent closing-odds-poller run. Written by the Edge function on every invocation. Insights Data Health reads via analytics_odds_api_health().';
