-- =============================================================
-- mlb_prediction_inputs_snapshot — append-only client policy.
--
-- The earlier RLS fix (20260410310000_mlb_rls_fix.sql) restricted
-- inserts to service_role only. Browser clients run as anon /
-- authenticated, so every snapshot write was returning 42501 and
-- silently breaking the learning feedback loop.
--
-- This migration adds an append-only policy that lets any client
-- insert telemetry rows without read access — same pattern we use
-- for picks_log. Updates / deletes remain blocked. Reads stay open
-- to authenticated for analytics dashboards.
-- =============================================================

alter table public.mlb_prediction_inputs_snapshot enable row level security;

-- Drop the service-only insert policy if it's there.
drop policy if exists "service write mlb_prediction_inputs_snapshot"
  on public.mlb_prediction_inputs_snapshot;

-- Append-only — any client can write, no one can update or delete
-- via the API surface. Service-role still has full bypass.
drop policy if exists mlb_snapshot_append_only_insert
  on public.mlb_prediction_inputs_snapshot;
create policy mlb_snapshot_append_only_insert
  on public.mlb_prediction_inputs_snapshot
  for insert
  to anon, authenticated
  with check (true);

-- Read access for the analytics layer (already exists from the prior
-- migration but recreated idempotently here in case the order changes).
drop policy if exists "public read mlb_prediction_inputs_snapshot"
  on public.mlb_prediction_inputs_snapshot;
create policy "public read mlb_prediction_inputs_snapshot"
  on public.mlb_prediction_inputs_snapshot
  for select
  using (true);
