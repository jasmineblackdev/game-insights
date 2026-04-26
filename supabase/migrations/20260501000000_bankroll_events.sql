-- =============================================================
-- bankroll_events — append-only ledger for bankroll tracking.
-- Each row records a single delta against the running balance:
--   deposit       — user added funds
--   withdrawal    — user took funds out
--   bet_placed    — stake locked in for an outstanding bet
--   bet_settled   — bet resolved; net delta = payout − stake
--                   (stake is unlocked at settlement)
--   adjustment    — manual correction (loss reconciliation, etc.)
--   reset         — user wiped the bankroll (dev/testing)
--
-- balance_after lets the UI render the bankroll curve without
-- replaying every event client-side, and gives an obvious tripwire
-- for client/server divergence. Negative balance_after is a bug.
-- =============================================================

create table if not exists bankroll_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade,
  occurred_at     timestamptz not null default now(),
  type            text not null check (type in (
    'deposit', 'withdrawal', 'bet_placed', 'bet_settled', 'adjustment', 'reset'
  )),
  amount          numeric(12,2) not null,                   -- always positive; sign comes from `type`
  balance_after   numeric(12,2) not null check (balance_after >= 0),
  bet_id          uuid,                                      -- references recommended_parlays.id when applicable
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists bankroll_events_user_occurred_idx
  on bankroll_events (user_id, occurred_at desc);

create index if not exists bankroll_events_bet_idx
  on bankroll_events (bet_id);

alter table bankroll_events enable row level security;

-- Users can only see + write their own events.
drop policy if exists bankroll_events_select_own on bankroll_events;
create policy bankroll_events_select_own
  on bankroll_events
  for select
  using (auth.uid() = user_id);

drop policy if exists bankroll_events_insert_own on bankroll_events;
create policy bankroll_events_insert_own
  on bankroll_events
  for insert
  with check (auth.uid() = user_id);

drop policy if exists bankroll_events_update_own on bankroll_events;
create policy bankroll_events_update_own
  on bankroll_events
  for update
  using (auth.uid() = user_id);

drop policy if exists bankroll_events_delete_own on bankroll_events;
create policy bankroll_events_delete_own
  on bankroll_events
  for delete
  using (auth.uid() = user_id);

-- Anonymous "starter bankroll" support: when no user is signed in the
-- client mirrors events to localStorage only. The migration is here
-- so that as soon as the user signs in we can start syncing.
