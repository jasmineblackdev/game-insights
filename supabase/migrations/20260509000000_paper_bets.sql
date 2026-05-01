-- ============================================================
-- Paper Bets — fake-money manual testing system.
--
-- Lets the user enter DraftKings-style bets with the EXACT
-- DraftKings labels, settle them against game/player feeds, and
-- track a paper bankroll. NEVER connects to DraftKings; never
-- places real money. Purpose: validate that GameLens picks survive
-- the round-trip through DraftKings labelling before risking real
-- bankroll on bets the model recommends but the book might price
-- as a different market.
--
-- Two tables:
--   paper_bets       — one row per submitted ticket (single or parlay)
--   paper_bankroll   — singleton aggregate row with starting + current
--                      paper balance and lifetime stats
-- ============================================================

create table if not exists public.paper_bets (
  id                       uuid primary key default gen_random_uuid(),
  source                   text not null default 'manual_draftkings_entry'
                           check (source in (
                             'manual_draftkings_entry',
                             'app_recommendation_paper'
                           )),
  bet_type                 text not null
                           check (bet_type in ('single', 'parlay', 'sgp')),
  /**
   * Legs of this ticket. Each element is:
   *   {
   *     dkLabel:         "Hits O/U Over 0.5"   (verbatim from DraftKings)
   *     sport:           "MLB" | "NBA" | "NFL" | "WNBA" | "BOXING" | "MMA"
   *     league:          "mlb" | "nba" | ...
   *     gameId:          string (ESPN event id)
   *     gameTimeIso:     "2026-04-29T23:05Z"
   *     teamLabel:       "BOS Celtics" | undefined (player props)
   *     playerName:      "Aaron Judge" | undefined (team bets)
   *     playerId:        ESPN athlete id when known
   *     marketType:      "moneyline" | "spread" | "total" | "player_prop"
   *     statType:        "hits" | "total_bases" | "points" | undefined
   *     direction:       "over" | "under" | undefined
   *     line:            0.5 | 1.5 | -3.5 | undefined (moneyline)
   *     americanOdds:    -159
   *     selectionLabel:  "Aaron Judge Over 1.5 Total Bases"
   *     status:          "open" | "won" | "lost" | "push" | "voided" | "needs_review"
   *     resolvedActual:  number | null  (final stat value when resolved)
   *     resolvedReason:  string | null  (why this status — diagnostic)
   *     resolvedAt:      timestamp | null
   *   }
   */
  legs                     jsonb not null,
  stake                    numeric(10,2) not null check (stake > 0),
  combined_odds_american   integer,
  potential_payout         numeric(12,2),
  /** Computed once at submission so the user sees their max upside. */
  status                   text not null default 'open'
                           check (status in (
                             'open', 'in_progress',
                             'won', 'lost', 'push', 'voided', 'needs_review'
                           )),
  /** Net profit/loss in fake dollars; null until resolved. */
  pnl                      numeric(12,2),
  /** Optional link to an existing app recommendation, when the user
      uses Paper Mode to test an app pick. Stored as text so V2 can
      add a foreign-key constraint without a migration to the
      recommended_parlays type if needed. */
  app_recommendation_id    text,
  app_model_probability    numeric(6,4),
  app_edge                 numeric(6,4),
  app_confidence           text check (app_confidence in ('high', 'medium', 'low') or app_confidence is null),
  notes                    text,
  placed_at                timestamptz not null default now(),
  resolved_at              timestamptz,
  user_id                  uuid references auth.users (id) on delete set null
);

create index if not exists paper_bets_status_placed_at_idx
  on public.paper_bets (status, placed_at desc);
create index if not exists paper_bets_placed_at_idx
  on public.paper_bets (placed_at desc);

-- ── Bankroll singleton ───────────────────────────────────────────────
-- Single row per user_id. The MVP runs in single-user mode (anon
-- access) so a single row with user_id=NULL will hold the value.
-- When auth is added later, rows can be partitioned by user_id with
-- a unique index on it.
create table if not exists public.paper_bankroll (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid unique references auth.users (id) on delete set null,
  starting_bankroll        numeric(12,2) not null default 500,
  current_bankroll         numeric(12,2) not null default 500,
  /** Sum of stake on all open bets — locked, not deducted from current. */
  open_risk                numeric(12,2) not null default 0,
  total_pnl                numeric(12,2) not null default 0,
  /** Lifetime counters. */
  bets_placed              integer not null default 0,
  bets_won                 integer not null default 0,
  bets_lost                integer not null default 0,
  bets_push                integer not null default 0,
  updated_at               timestamptz not null default now()
);

-- Allow a single anon row by creating a partial unique index for
-- NULL user_id so upserts target the same row.
create unique index if not exists paper_bankroll_anon_unique_idx
  on public.paper_bankroll ((coalesce(user_id::text, '__anon__')));

-- ── RLS ──────────────────────────────────────────────────────────────
alter table public.paper_bets enable row level security;
create policy paper_bets_all on public.paper_bets
  for all using (true) with check (true);
grant select, insert, update, delete on public.paper_bets to anon, authenticated;
grant all on public.paper_bets to service_role;

alter table public.paper_bankroll enable row level security;
create policy paper_bankroll_all on public.paper_bankroll
  for all using (true) with check (true);
grant select, insert, update, delete on public.paper_bankroll to anon, authenticated;
grant all on public.paper_bankroll to service_role;
