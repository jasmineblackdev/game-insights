-- ============================================================
-- pro_trade_queue — durable queue for Pro Mode trade decisions.
-- Each row represents ONE proposed bet emitted by the Pro Mode
-- pipeline. The user can confirm (→ bridge to recommended_parlays
-- as user_placed=true) or dismiss. Stale rows expire automatically.
--
-- Status state machine:
--   ready     — passed all filters; user can confirm
--   wait      — passed but bankroll discipline says WAIT
--   blocked   — failed at least one hard gate (stop_loss, etc)
--   confirmed — user clicked Confirm
--   dismissed — user clicked Dismiss
--   expired   — auto-rolled at >24h old without action
-- ============================================================

create table if not exists public.pro_trade_queue (
  id              uuid primary key default gen_random_uuid(),
  status          text not null
                  check (status in ('ready', 'wait', 'blocked', 'confirmed', 'dismissed', 'expired')),
  parlay_id       uuid references public.recommended_parlays (id) on delete set null,
  /** Snapshot of the parlay at queue time so the trade is reproducible
      even if the underlying parlay row mutates later. */
  parlay_snapshot jsonb not null,
  /** Suggested stake from the Pro Mode pipeline (already discipline-
      adjusted via the stakeMultiplier). */
  stake           numeric(10,2) not null default 0,
  /** Source mode that generated the trade — "pro_mode" today, future
      modes can write here too. */
  mode            text not null default 'pro_mode',
  /** Human-readable explanation surfaced in the ProBetCard. */
  reason          text,
  /** Sport priority dimensions at queue time — analytics. */
  sport           text,
  ev              numeric(8,4),
  edge            numeric(8,4),
  created_at      timestamptz not null default now(),
  confirmed_at    timestamptz,
  dismissed_at    timestamptz,
  user_id         uuid references auth.users (id) on delete set null,
  extra           jsonb not null default '{}'::jsonb
);

create index if not exists pro_trade_queue_active_idx
  on public.pro_trade_queue (status, created_at desc)
  where status in ('ready', 'wait', 'blocked');

create index if not exists pro_trade_queue_history_idx
  on public.pro_trade_queue (created_at desc);

comment on table public.pro_trade_queue is
  'Pro Mode daily trade queue. One row per emitted decision; user confirms or dismisses, stale rows expire.';

-- ── RLS ──────────────────────────────────────────────────────
alter table public.pro_trade_queue enable row level security;

create policy pro_trade_queue_all on public.pro_trade_queue
  for all using (true) with check (true);

grant select, insert, update, delete on public.pro_trade_queue to anon, authenticated;
grant all on public.pro_trade_queue to service_role;

-- ── Auto-expire helper ───────────────────────────────────────
-- Marks rows as 'expired' when they're >24h old in an active state.
-- Called from the client on Pro Mode mount to keep the queue clean
-- without needing pg_cron.
create or replace function public.pro_trade_queue_sweep_expired()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  update public.pro_trade_queue
  set    status = 'expired'
  where  status in ('ready', 'wait', 'blocked')
    and  created_at < now() - interval '24 hours';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.pro_trade_queue_sweep_expired() to anon, authenticated;
