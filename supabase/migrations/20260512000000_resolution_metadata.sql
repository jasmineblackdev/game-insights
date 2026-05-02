-- ============================================================
-- Resolution metadata — visibility into how a bet became "resolved".
--
-- Adds a single column to both bet tables that records the path
-- a bet's terminal status was reached through:
--   'espn'   — auto-resolved against ESPN game/box-score feeds
--   'manual' — user marked the outcome via the UI
--   NULL     — still pending (or pre-existing rows unmigrated)
--
-- Per-leg resolution_diagnosis values are written into the existing
-- legs JSONB on each table (no schema column needed). Canonical enum
-- shipped from the client:
--   game_not_final | box_score_missing | unparseable_id |
--   stat_type_unsupported | team_label_unmatched | missing_direction
--
-- Backfill rule: existing resolved rows stay NULL — we don't know
-- retroactively whether they came from the resolver or a manual
-- click. Going forward, every resolution path writes the column.
-- ============================================================

alter table public.recommended_parlays
  add column if not exists resolved_via text
    check (resolved_via is null or resolved_via in ('espn', 'manual'));

alter table public.paper_bets
  add column if not exists resolved_via text
    check (resolved_via is null or resolved_via in ('espn', 'manual'));

-- Indexes on the resolution-path column so analytics dashboards can
-- segment hit rate by manual vs auto without a full scan.
create index if not exists recommended_parlays_resolved_via_idx
  on public.recommended_parlays (resolved_via)
  where resolved_via is not null;

create index if not exists paper_bets_resolved_via_idx
  on public.paper_bets (resolved_via)
  where resolved_via is not null;
