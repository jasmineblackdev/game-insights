-- prediction_versions
-- Stores each snapshot version of a game prediction (pregame, live, final).
-- The client generates these in-browser from ESPN data; this table allows
-- them to be persisted for accuracy analytics and learning loops.

create table if not exists public.prediction_versions (
  id              text primary key,              -- "{game_id}-{phase}"
  game_id         text not null,
  sport           text not null,                 -- "NBA" | "NFL" | "MLB" | "SOCCER"
  phase           text not null,                 -- "pregame" | "live_q1" | "live_f5" | "live_15min" | "live_halftime" | "final"
  trigger_type    text not null,                 -- "scheduled" | "end_q1_signal" | ...
  predicted_side  text not null,                 -- team abbreviation
  probability     integer not null,              -- 0–100
  confidence      text not null,                 -- "HIGH" | "MED" | "LOW"
  reasons_json    jsonb not null default '[]',
  risks_json      jsonb not null default '[]',
  live_state_snapshot_json jsonb,
  created_at      timestamptz not null default now()
);

-- prediction_outcomes
-- Records the actual result of a game for comparison against prediction_versions.

create table if not exists public.prediction_outcomes (
  id              text primary key,              -- "{game_id}-outcome"
  game_id         text not null unique,
  sport           text not null,
  actual_winner   text not null,                 -- team abbreviation
  final_score_json jsonb not null,               -- { "home": 114, "away": 106, "homeAbbr": "BOS", "awayAbbr": "TOR" }
  closed_at       timestamptz not null default now()
);

-- Indexes for analytics queries
create index if not exists idx_pv_game_id     on public.prediction_versions (game_id);
create index if not exists idx_pv_sport_phase on public.prediction_versions (sport, phase);
create index if not exists idx_po_sport       on public.prediction_outcomes (sport);
create index if not exists idx_po_closed_at   on public.prediction_outcomes (closed_at desc);

-- RLS: public read, service-role write (app inserts via service key)
alter table public.prediction_versions  enable row level security;
alter table public.prediction_outcomes  enable row level security;

create policy "anyone can read prediction_versions"
  on public.prediction_versions for select using (true);

create policy "service role can insert prediction_versions"
  on public.prediction_versions for insert
  with check (auth.role() = 'service_role');

create policy "anyone can read prediction_outcomes"
  on public.prediction_outcomes for select using (true);

create policy "service role can insert prediction_outcomes"
  on public.prediction_outcomes for insert
  with check (auth.role() = 'service_role');

-- Accuracy rollup view (per sport × phase × 7-day window)
create or replace view public.prediction_accuracy_by_phase as
select
  pv.sport,
  pv.phase,
  count(*)                                     as total,
  count(*) filter (where pv.predicted_side = po.actual_winner) as hits,
  round(
    count(*) filter (where pv.predicted_side = po.actual_winner)::numeric
    / nullif(count(*), 0) * 100, 1
  )                                            as hit_rate_pct,
  avg(pv.probability)                          as avg_probability,
  max(pv.created_at)                           as last_updated
from public.prediction_versions pv
join public.prediction_outcomes po on po.game_id = pv.game_id
where pv.phase != 'final'
  and pv.created_at >= now() - interval '30 days'
group by pv.sport, pv.phase
order by pv.sport, pv.phase;
