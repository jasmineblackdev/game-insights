-- Optional per-user mirror of client-side learning JSON (localStorage) for signed-in users.
-- Does not replace prediction_accuracy_summary (fed from prediction_outcome_log + refresh RPC).

create table if not exists public.user_learning_snapshots (
  user_id uuid primary key references auth.users (id) on delete cascade,
  accuracy_summary jsonb not null default '{}'::jsonb,
  edge_floors jsonb,
  confidence_curve jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.user_learning_snapshots is
  'Per-user backup of client learning artifacts when VITE_SYNC_CLIENT_LEARNING_TO_SUPABASE is enabled.';

alter table public.user_learning_snapshots enable row level security;

create policy user_learning_snapshots_own
  on public.user_learning_snapshots
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.user_learning_snapshots to authenticated;

create index if not exists user_learning_snapshots_updated_idx
  on public.user_learning_snapshots (updated_at desc);
