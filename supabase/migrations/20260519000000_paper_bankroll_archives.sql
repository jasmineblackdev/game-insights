-- ============================================================
-- paper_bankroll_archives — historical snapshots of the paper
-- bankroll singleton, captured every time the user resets the
-- starting balance. Without this, a reset wipes the running
-- counters and the user loses the record of how the prior
-- session went.
--
-- Snapshot is taken BEFORE the reset writes to paper_bankroll,
-- so each archive row reflects the state at the moment the
-- session ended. Append-only — no updates, no deletes from the
-- client.
-- ============================================================

create table if not exists public.paper_bankroll_archives (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references auth.users (id) on delete set null,
  -- Snapshot of the headline numbers at archive time. We copy
  -- the columns rather than referencing paper_bankroll.id so the
  -- archive survives the singleton row being recreated.
  starting_bankroll   numeric(12,2) not null,
  ending_bankroll     numeric(12,2) not null,
  total_pnl           numeric(12,2) not null,
  open_risk_at_close  numeric(12,2) not null default 0,
  bets_placed         integer       not null default 0,
  bets_won            integer       not null default 0,
  bets_lost           integer       not null default 0,
  bets_push           integer       not null default 0,
  -- When the prior session began (the prior row's updated_at
  -- when the previous reset occurred). Null for the first
  -- archive since we don't know when the singleton was first
  -- initialized.
  session_started_at  timestamptz,
  archived_at         timestamptz not null default now(),
  -- Optional human label for the session. The reset UI prompts
  -- for one ("Pre-MLB", "Tournament Run", etc.) — null when the
  -- user skips the prompt.
  label               text,
  -- Why the user reset. "user_reset" is the only path that
  -- creates archives today; reserved for future automation
  -- (e.g. weekly auto-archive).
  reason              text not null default 'user_reset'
    check (reason in ('user_reset', 'auto_weekly', 'auto_monthly'))
);

create index if not exists paper_bankroll_archives_archived_at_idx
  on public.paper_bankroll_archives (archived_at desc);

-- Permissive RLS — same pattern as paper_bankroll itself. Single-
-- user MVP runs in anon mode; the partition will become user_id
-- when auth lands.
alter table public.paper_bankroll_archives enable row level security;
create policy paper_bankroll_archives_all on public.paper_bankroll_archives
  for all using (true) with check (true);
grant select, insert, update, delete on public.paper_bankroll_archives to anon, authenticated;
grant all on public.paper_bankroll_archives to service_role;

comment on table public.paper_bankroll_archives is
  'Append-only snapshots of paper_bankroll captured at every reset. Lets the user see how prior paper-trading sessions performed without keeping every settled bet around.';
