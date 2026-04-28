-- ============================================================
-- edge_card_history — durable backup for the EdgeCard slip history
-- that previously lived ONLY in localStorage. Without this, a
-- browser clear / device switch wiped every saved slip + outcome.
--
-- We don't persist the in-flight slip (changes too often, every
-- micro-edit would be wasteful). Just the saved entries — same
-- granularity the user already maintains via "Save slip" / outcome
-- marking.
--
-- Source labels:
--   "edge_card"        — slip saved while the user is using the app
--   "edge_card_legacy" — recovered from a localStorage JSON dump via
--                        scripts/backfill-edge-card-legacy.mjs
-- ============================================================

create table if not exists public.edge_card_history (
  id                    uuid primary key default gen_random_uuid(),
  /** Original client-side id (e.g. "hist-1771234567000") so DB upserts
      stay idempotent across re-saves and device migrations. */
  client_id             text unique,
  saved_at              timestamptz not null,
  card_size             smallint not null,
  items                 jsonb not null,
  aggregate_confidence  text,
  risk_label            text check (risk_label in ('controlled', 'moderate', 'elevated')),
  outcome               text check (outcome in ('win', 'loss', 'push')),
  source                text not null default 'edge_card'
                        check (source in ('edge_card', 'edge_card_legacy')),
  user_id               uuid references auth.users (id) on delete set null,
  extra                 jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

create index if not exists edge_card_history_saved_at_idx
  on public.edge_card_history (saved_at desc);
create index if not exists edge_card_history_outcome_idx
  on public.edge_card_history (outcome, saved_at desc)
  where outcome is not null;

comment on table public.edge_card_history is
  'Durable backup of the localStorage edge_card history. items jsonb mirrors EdgeSlipItem[].';

-- ── RLS ──────────────────────────────────────────────────────
alter table public.edge_card_history enable row level security;

-- Permissive: same pattern as picks_log / recommended_parlays. The
-- column user_id stays null in single-user mode; once auth lands the
-- policy can tighten to "user_id = auth.uid()".
create policy edge_card_history_all on public.edge_card_history
  for all using (true) with check (true);

grant select, insert, update, delete on public.edge_card_history to anon, authenticated;
grant all on public.edge_card_history to service_role;
