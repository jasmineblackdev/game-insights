-- ============================================================
-- decision_log — append-only ledger of decisions surfaced to the user.
--
-- One row per "Today's Decision" render OR explicit user action.
-- Used to measure how often the AI verdict (BET / MODIFY / SKIP)
-- matched what the user actually did, and to feed downstream
-- analytics (e.g. "user followed PLACE 78% of the time").
--
-- Append-only by design: a row is never updated. A user clicking
-- through to Builder writes a new row with action='followed';
-- ignoring it writes nothing (the absence is the signal).
--
-- Not optimizer-feeding. Phase 1 of "Paper as single tracking
-- source" — we're recording what was shown vs what was acted on,
-- not changing how predictions are scored.
-- ============================================================

create table if not exists public.decision_log (
  id              uuid primary key default gen_random_uuid(),
  /** Stable id grouping a (shown, action) pair from one render. */
  decision_id     uuid not null,
  /** When the row was written. */
  logged_at       timestamptz not null default now(),
  /** Source surface — extensible. */
  source          text not null check (source in (
    'todays_decision',  -- Home card
    'builder',          -- explicit Builder click
    'paper_draft',      -- saved to Paper as draft
    'paper_submit',     -- submitted as paper bet
    'manual_override'   -- user disagreed with verdict
  )),
  /** AI's verdict at the time the decision was shown. */
  verdict         text not null check (verdict in ('BET', 'MODIFY', 'SKIP')),
  /** What the user did about it: shown (impression), followed
      (clicked through to Builder / placed), overridden (chose
      something else), ignored (no action). */
  action          text not null check (action in (
    'shown',
    'followed',
    'overridden',
    'ignored'
  )),
  /** Snapshot of headline + reasons + confidence + risk. JSONB so
      analytics can query without joining other tables. */
  payload         jsonb not null default '{}'::jsonb,
  /** When auth lands, attribute decisions to a user; NULL for anon. */
  user_id         uuid references auth.users(id) on delete set null
);

create index if not exists decision_log_logged_at_idx
  on public.decision_log (logged_at desc);
create index if not exists decision_log_decision_id_idx
  on public.decision_log (decision_id);
create index if not exists decision_log_verdict_action_idx
  on public.decision_log (verdict, action);

-- Permissive RLS to match the rest of the read/write surface for
-- this anon-only deployment. Tighten when auth lands.
alter table public.decision_log enable row level security;
create policy "decision_log_anon_all" on public.decision_log
  for all using (true) with check (true);

comment on table public.decision_log is
  'Append-only ledger of Today''s Decision impressions and follow-ups. AI verdict vs user action, used to measure decision-quality compliance over time.';
