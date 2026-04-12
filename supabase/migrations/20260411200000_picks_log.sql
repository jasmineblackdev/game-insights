-- Picks log: tracks every prop copied by the user, with outcome resolution
create table if not exists picks_log (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now() not null,
  prop_id         text not null,
  player_name     text not null,
  sport           text not null,
  stat_type       text not null,
  line_value      numeric not null,
  projected_value numeric not null,
  direction       text not null,   -- 'MORE' | 'LESS'
  confidence      text not null,   -- 'HIGH' | 'MED' | 'LOW'
  game_id         text not null,
  game_time       text,
  team            text not null default '',
  opponent        text not null default '',
  actual_value    numeric,         -- filled by resolver
  outcome         text,            -- 'win' | 'loss' | 'push' | null = pending
  resolved_at     timestamptz
);

-- Allow anonymous reads/writes (personal app — no multi-user concern)
alter table picks_log enable row level security;
create policy "allow_all_picks" on picks_log for all using (true) with check (true);

-- Indexes for common query patterns
create index if not exists picks_log_created_at_idx on picks_log (created_at desc);
create index if not exists picks_log_outcome_idx on picks_log (outcome);
create index if not exists picks_log_sport_idx on picks_log (sport);

-- Accuracy view: rolling 30-day win rate by confidence tier
create or replace view prop_accuracy_30d as
select
  confidence,
  count(*) filter (where outcome = 'win')                          as wins,
  count(*) filter (where outcome = 'loss')                         as losses,
  count(*) filter (where outcome = 'push')                         as pushes,
  count(*) filter (where outcome is null)                          as pending,
  count(*)                                                          as total,
  round(
    count(*) filter (where outcome = 'win')::numeric /
    nullif(count(*) filter (where outcome in ('win','loss')), 0) * 100, 1
  ) as win_pct
from picks_log
where created_at > now() - interval '30 days'
group by confidence;
