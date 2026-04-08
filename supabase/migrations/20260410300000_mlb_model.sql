-- ============================================================
-- MLB Prediction Model — Historical Data + Derived Features
-- ============================================================
-- Supports the layered MLB weighting model:
--   40% Starting pitcher  |  20% Batting splits vs handedness
--   15% Bullpen fatigue   |  10% Recent team form
--   10% Ballpark factor   |   5% Travel / rest
--
-- Tables are designed for forward population.
-- Client writes prediction snapshots; historical game/player logs
-- are populated via an ingestion pipeline (ESPN Game Summary API).
-- ============================================================

-- ── 1. Historical game log ────────────────────────────────────────────────────

create table if not exists public.mlb_historical_games (
  id                text primary key,           -- "{season}-{espn_event_id}"
  espn_event_id     text not null,
  season            smallint not null,
  game_date         date not null,
  home_team         text not null,              -- team abbreviation
  away_team         text not null,
  home_score        smallint,
  away_score        smallint,
  winner            text,                       -- team abbreviation or null (in-progress)
  park              text not null,              -- home team abbreviation used as park key
  weather_note      text,
  home_probable_pitcher  text,
  away_probable_pitcher  text,
  lineups_confirmed bool not null default false,
  created_at        timestamptz not null default now()
);

create index if not exists idx_mhg_season_team   on public.mlb_historical_games (season, home_team);
create index if not exists idx_mhg_season_away   on public.mlb_historical_games (season, away_team);
create index if not exists idx_mhg_game_date     on public.mlb_historical_games (game_date desc);

-- ── 2. Pitcher game logs ──────────────────────────────────────────────────────

create table if not exists public.mlb_pitcher_game_logs (
  id                text primary key,           -- "{espn_event_id}-{athlete_id}"
  espn_event_id     text not null,
  athlete_id        text not null,              -- ESPN athlete ID
  athlete_name      text not null,
  team_id           text not null,
  season            smallint not null,
  game_date         date not null,
  home_or_away      text not null check (home_or_away in ('home', 'away')),
  opponent          text not null,
  innings_pitched   numeric(4,1),
  earned_runs       smallint,
  hits_allowed      smallint,
  strikeouts        smallint,
  walks             smallint,
  pitch_count       smallint,
  era               numeric(5,2),
  fip               numeric(5,2),
  whip              numeric(5,3),
  handedness        char(1) check (handedness in ('L', 'R')),
  result            text check (result in ('W', 'L', 'ND')),
  created_at        timestamptz not null default now()
);

create index if not exists idx_mpgl_athlete_date on public.mlb_pitcher_game_logs (athlete_id, game_date desc);
create index if not exists idx_mpgl_team_season  on public.mlb_pitcher_game_logs (team_id, season);

-- ── 3. Hitter game logs ───────────────────────────────────────────────────────

create table if not exists public.mlb_hitter_game_logs (
  id                    text primary key,       -- "{espn_event_id}-{athlete_id}"
  espn_event_id         text not null,
  athlete_id            text not null,
  athlete_name          text not null,
  team_id               text not null,
  season                smallint not null,
  game_date             date not null,
  lineup_spot           smallint,
  home_or_away          text not null check (home_or_away in ('home', 'away')),
  park                  text not null,
  plate_appearances     smallint,
  hits                  smallint,
  runs                  smallint,
  rbi                   smallint,
  strikeouts            smallint,
  walks                 smallint,
  total_bases           smallint,
  batter_hand           char(1) check (batter_hand in ('L', 'R', 'S')),
  opp_pitcher_hand      char(1) check (opp_pitcher_hand in ('L', 'R')),
  created_at            timestamptz not null default now()
);

create index if not exists idx_mhgl_athlete_date  on public.mlb_hitter_game_logs (athlete_id, game_date desc);
create index if not exists idx_mhgl_team_season   on public.mlb_hitter_game_logs (team_id, season);
create index if not exists idx_mhgl_hand_split    on public.mlb_hitter_game_logs (team_id, opp_pitcher_hand);

-- ── 4. Bullpen usage ─────────────────────────────────────────────────────────

create table if not exists public.mlb_bullpen_usage (
  id                      text primary key,     -- "{espn_event_id}-{athlete_id}"
  espn_event_id           text not null,
  reliever_id             text not null,        -- ESPN athlete ID
  reliever_name           text not null,
  team_id                 text not null,
  game_date               date not null,
  innings_pitched         numeric(4,1),
  pitches_thrown          smallint,
  leverage_role           text,                 -- "closer" | "setup" | "middle" | "mop-up"
  closer_flag             bool not null default false,
  back_to_back_flag       bool not null default false,
  appearances_last_3_days smallint not null default 0,
  created_at              timestamptz not null default now()
);

create index if not exists idx_mbu_team_date     on public.mlb_bullpen_usage (team_id, game_date desc);
create index if not exists idx_mbu_reliever_date on public.mlb_bullpen_usage (reliever_id, game_date desc);

-- ── 5. Team batting splits ────────────────────────────────────────────────────

create table if not exists public.mlb_team_batting_splits (
  id              text primary key,             -- "{team_id}-{season}-{split_type}"
  team_id         text not null,
  season          smallint not null,
  split_type      text not null check (split_type in ('vs_lhp', 'vs_rhp', 'overall')),
  batting_avg     numeric(4,3),
  obp             numeric(4,3),
  slg             numeric(4,3),
  ops             numeric(5,3),
  strikeout_rate  numeric(4,3),
  runs_per_game   numeric(4,2),
  sample_pa       integer not null default 0,   -- plate appearances (sample size guard)
  last_updated    timestamptz not null default now()
);

create unique index if not exists idx_mbs_team_season_split
  on public.mlb_team_batting_splits (team_id, season, split_type);

-- ── 6. Pitcher recent form (derived) ─────────────────────────────────────────

create table if not exists public.mlb_pitcher_recent_form (
  pitcher_id              text primary key,
  pitcher_name            text not null,
  season                  smallint not null,
  last_3_starts_era       numeric(5,2),
  last_5_starts_era       numeric(5,2),
  last_3_starts_fip       numeric(5,2),
  last_5_starts_fip       numeric(5,2),
  avg_pitch_count         numeric(4,1),
  avg_innings_pitched     numeric(4,2),
  last_start_date         date,
  last_updated            timestamptz not null default now()
);

-- ── 7. Bullpen fatigue scores (derived, per team per date) ───────────────────

create table if not exists public.mlb_bullpen_fatigue_scores (
  id                          text primary key,  -- "{team_id}-{date}"
  team_id                     text not null,
  score_date                  date not null,
  bullpen_innings_last_3_days numeric(5,1),
  bullpen_pitches_last_3_days smallint,
  closer_available_score      smallint check (closer_available_score between 0 and 10),
  fatigue_score               smallint check (fatigue_score between 0 and 10),
  last_updated                timestamptz not null default now()
);

create unique index if not exists idx_mbfs_team_date
  on public.mlb_bullpen_fatigue_scores (team_id, score_date);

-- ── 8. Lineup strength scores (derived, per game) ────────────────────────────

create table if not exists public.mlb_lineup_strength_scores (
  id                        text primary key,   -- "{espn_event_id}-{team_id}"
  espn_event_id             text not null,
  team_id                   text not null,
  game_date                 date not null,
  confirmed_lineup_flag     bool not null default false,
  lineup_strength_vs_lhp    numeric(4,1),
  lineup_strength_vs_rhp    numeric(4,1),
  star_absence_penalty      numeric(4,1) not null default 0,
  last_updated              timestamptz not null default now()
);

create index if not exists idx_mlss_event on public.mlb_lineup_strength_scores (espn_event_id);

-- ── 9. Prediction inputs snapshot (backtesting + accuracy loop) ──────────────

create table if not exists public.mlb_prediction_inputs_snapshot (
  id                    text primary key,  -- "{espn_event_id}-{phase}"
  espn_event_id         text not null,
  game_date             date not null,
  home_team             text not null,
  away_team             text not null,
  phase                 text not null check (phase in ('pregame', 'live_f5', 'final')),
  model_version         text not null default '1.0',

  -- Inputs
  home_pitcher_id       text,
  away_pitcher_id       text,
  home_pitcher_era      numeric(5,2),
  away_pitcher_era      numeric(5,2),
  home_pitcher_whip     numeric(5,3),
  away_pitcher_whip     numeric(5,3),
  pitcher_certainty     text,
  home_b2b              bool not null default false,
  away_b2b              bool not null default false,
  park_factor           numeric(4,2),
  has_odds              bool not null default false,

  -- Score breakdown (_debug fields)
  pitcher_score         numeric(4,2),
  batting_score         numeric(4,2),
  bullpen_score         numeric(4,2),
  form_score            numeric(4,2),
  rest_score            numeric(4,2),
  combined_delta        numeric(4,1),

  -- Output
  predicted_winner      text not null,
  win_probability       smallint not null,
  confidence            text not null,
  pending_confirmation  bool not null default false,
  risk_flag             text,

  -- Outcome (populated when game is final)
  actual_winner         text,
  correct_prediction    bool,

  created_at            timestamptz not null default now()
);

create index if not exists idx_mpis_game_date  on public.mlb_prediction_inputs_snapshot (game_date desc);
create index if not exists idx_mpis_event_team on public.mlb_prediction_inputs_snapshot (espn_event_id, home_team);

-- ── RLS: public read / service-role write ────────────────────────────────────

do $$ declare
  tbl text;
begin
  foreach tbl in array array[
    'mlb_historical_games',
    'mlb_pitcher_game_logs',
    'mlb_hitter_game_logs',
    'mlb_bullpen_usage',
    'mlb_team_batting_splits',
    'mlb_pitcher_recent_form',
    'mlb_bullpen_fatigue_scores',
    'mlb_lineup_strength_scores',
    'mlb_prediction_inputs_snapshot'
  ] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('drop policy if exists %I on public.%I', 'public read ' || tbl, tbl);
    execute format(
      'create policy %I on public.%I for select using (true)',
      'public read ' || tbl,
      tbl
    );
    execute format('drop policy if exists %I on public.%I', 'service write ' || tbl, tbl);
    execute format(
      'create policy %I on public.%I for insert with check (auth.role() = ''service_role'')',
      'service write ' || tbl,
      tbl
    );
  end loop;
end $$;

-- ── Accuracy summary view ─────────────────────────────────────────────────────

create or replace view public.mlb_prediction_accuracy as
select
  phase,
  model_version,
  count(*)                                                    as total,
  count(*) filter (where correct_prediction = true)           as hits,
  round(
    count(*) filter (where correct_prediction = true)::numeric
    / nullif(count(*) filter (where correct_prediction is not null), 0) * 100, 1
  )                                                           as hit_rate_pct,
  avg(win_probability)                                        as avg_confidence,
  max(created_at)                                             as last_updated
from public.mlb_prediction_inputs_snapshot
where correct_prediction is not null
  and created_at >= now() - interval '60 days'
group by phase, model_version
order by phase, model_version;
