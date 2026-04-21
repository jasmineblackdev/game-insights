-- =============================================================
-- ML training data coverage — close the three gaps identified in the
-- parlay-hit-rate audit:
--   1) prop_impressions           — every prop we show, not just copied
--   2) parlay_leg_rejections      — candidates the optimizer filtered out
--   3) game_prediction_snapshots  — pre-game team/market picks at build time
-- All three feed prediction_history + model_weights recalibration via the
-- existing feedback loop so ML learns from displayed-but-not-copied signals,
-- from what we reject, and from every pre-game picked side.
-- =============================================================

-- ── prop_impressions ─────────────────────────────────────────────
-- One row per (prop_id, UTC day) so we capture every prop shown to the user.
-- Today picks_log only writes when the user clicks Copy, which biases the
-- training signal toward popular / visible props. This table removes that bias.
create table if not exists prop_impressions (
  id                  uuid primary key default gen_random_uuid(),
  prop_id             text not null,
  sport               text not null,
  stat_type           text not null,
  line_value          numeric not null,
  projected_value     numeric,
  direction           text not null,                         -- MORE | LESS
  confidence          text not null,                         -- HIGH | MED | LOW
  ml_hit_probability  numeric(5,4),
  edge                numeric(7,4),
  model_variant       text,                                  -- rules | ml_blended | ml_full
  volatility_score    numeric(5,2),
  stability_score     numeric(5,4),
  uncertainty_score   numeric(5,2),
  timing_urgency      text,                                  -- now | monitor | wait
  game_id             text not null,
  game_time           text,
  team                text,
  opponent            text,
  impression_date     date not null default current_date,
  created_at          timestamptz not null default now(),
  unique (prop_id, impression_date)
);

create index if not exists prop_impressions_date_idx     on prop_impressions (impression_date desc);
create index if not exists prop_impressions_sport_idx    on prop_impressions (sport, impression_date);
create index if not exists prop_impressions_game_idx     on prop_impressions (game_id);

alter table prop_impressions enable row level security;
create policy "allow_all_prop_impressions" on prop_impressions
  for all using (true) with check (true);

-- ── parlay_leg_rejections ────────────────────────────────────────
-- Every candidate that failed legPassesParlayBuildFilters gets logged with
-- the reason. Lets us learn which rejection rules are costing us value.
create table if not exists parlay_leg_rejections (
  id                  uuid primary key default gen_random_uuid(),
  mode                text not null,                         -- safe | balanced | aggressive | cashout
  candidate_id        text not null,
  sport               text not null,
  market_type         text not null,
  pick_type           text,
  stat_type           text,
  selection           text,
  american_odds       integer,
  edge                numeric(7,4),
  ml_hit_probability  numeric(5,4),
  confidence          text,
  volatility_score    numeric(5,2),
  stability_score     numeric(5,4),
  timing_urgency      text,
  rejection_reason    text not null,
  rejection_date      date not null default current_date,
  created_at          timestamptz not null default now()
);

create index if not exists parlay_leg_rejections_date_idx    on parlay_leg_rejections (rejection_date desc);
create index if not exists parlay_leg_rejections_reason_idx  on parlay_leg_rejections (rejection_reason);
create index if not exists parlay_leg_rejections_mode_idx    on parlay_leg_rejections (mode, rejection_date);

alter table parlay_leg_rejections enable row level security;
create policy "allow_all_parlay_leg_rejections" on parlay_leg_rejections
  for all using (true) with check (true);

-- ── game_prediction_snapshots ────────────────────────────────────
-- Pre-game snapshot of every team-level pick (moneyline / spread / total).
-- Today these only enter prediction_history after resolution, so we have no
-- visibility into the full pre-game pool or coverage completeness.
create table if not exists game_prediction_snapshots (
  id                   uuid primary key default gen_random_uuid(),
  game_id              text not null,
  sport                text not null,
  pick_type            text not null,   -- team_pick | spread | total
  market_type          text not null,   -- moneyline | spread | total
  selection            text not null,
  team_id              text,
  line_value           numeric,
  american_odds        integer,
  implied_probability  numeric(5,4),
  model_probability    numeric(5,4),
  edge                 numeric(7,4),
  edge_score           numeric(6,1),
  confidence           text,
  volatility_score     numeric(5,2),
  uncertainty_score    numeric(5,2),
  stability_score      numeric(5,4),
  risk_score           numeric(5,2),
  risk_band            text,
  value_score          numeric(5,4),
  value_grade          text,
  is_recommended       boolean,
  matchup_label        text,
  snapshot_date        date not null default current_date,
  created_at           timestamptz not null default now(),
  unique (game_id, pick_type, selection, snapshot_date)
);

create index if not exists game_prediction_snapshots_date_idx    on game_prediction_snapshots (snapshot_date desc);
create index if not exists game_prediction_snapshots_sport_idx   on game_prediction_snapshots (sport, snapshot_date);
create index if not exists game_prediction_snapshots_game_idx    on game_prediction_snapshots (game_id);

alter table game_prediction_snapshots enable row level security;
create policy "allow_all_game_prediction_snapshots" on game_prediction_snapshots
  for all using (true) with check (true);
