-- ============================================================
-- MMA/UFC tables + Boxing v2 upgrade
-- Migration: 20260411120000_mma_boxing_upgrade.sql
-- ============================================================

-- ── Boxing v2: new fighter fields ──────────────────────────────────────────

ALTER TABLE boxing_fighters
  ADD COLUMN IF NOT EXISTS rounds_fought         integer,
  ADD COLUMN IF NOT EXISTS rounds_won_pct        numeric(5,4),
  ADD COLUMN IF NOT EXISTS strikes_defense_pct   numeric(5,4),
  ADD COLUMN IF NOT EXISTS recent_wins           smallint,
  ADD COLUMN IF NOT EXISTS recent_fights         smallint DEFAULT 5,
  ADD COLUMN IF NOT EXISTS weight_class_moves    smallint DEFAULT 0;

-- Boxing odds snapshots (line movement tracking)
CREATE TABLE IF NOT EXISTS boxing_odds_snapshots (
  snapshot_id  bigint    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fight_id     text      NOT NULL REFERENCES boxing_fights(fight_id) ON DELETE CASCADE,
  sportsbook_key text    NOT NULL,
  home_moneyline  integer,
  away_moneyline  integer,
  draw_moneyline  integer,
  over_rounds     numeric(4,1),
  over_odds       integer,
  under_odds      integer,
  is_opening      boolean NOT NULL DEFAULT false,
  snapshot_time   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_boxing_odds_snapshots_fight
  ON boxing_odds_snapshots (fight_id, snapshot_time DESC);

-- Boxing odds latest (current best line per fight)
CREATE TABLE IF NOT EXISTS boxing_odds_latest (
  fight_id        text PRIMARY KEY REFERENCES boxing_fights(fight_id) ON DELETE CASCADE,
  sportsbook_key  text    NOT NULL,
  home_moneyline  integer,
  away_moneyline  integer,
  draw_moneyline  integer,
  over_rounds     numeric(4,1),
  over_odds       integer,
  under_odds      integer,
  home_open_ml    integer,   -- opening line for line movement calc
  away_open_ml    integer,
  fetched_at      timestamptz NOT NULL DEFAULT now()
);

-- Boxing prediction factors (per-factor breakdown for audit/backtesting)
CREATE TABLE IF NOT EXISTS boxing_prediction_factors (
  factor_id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prediction_id          bigint REFERENCES boxing_predictions(prediction_id) ON DELETE CASCADE,
  fight_id               text   NOT NULL REFERENCES boxing_fights(fight_id) ON DELETE CASCADE,
  factor_opponent_quality  numeric(6,4),
  factor_style_matchup     numeric(6,4),
  factor_recent_form       numeric(6,4),
  factor_ko_power_durability numeric(6,4),
  factor_reach_height      numeric(6,4),
  factor_activity_inactivity numeric(6,4),
  factor_age_curve         numeric(6,4),
  factor_defense_efficiency numeric(6,4),
  factor_market_movement   numeric(6,4),
  combined_delta           numeric(7,5),
  model_version            text NOT NULL DEFAULT '2.0',
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_boxing_prediction_factors_fight
  ON boxing_prediction_factors (fight_id);

-- Upgrade boxing_learning_history for v2 weights
ALTER TABLE boxing_learning_history
  ADD COLUMN IF NOT EXISTS w_opponent_quality   numeric(5,4),
  ADD COLUMN IF NOT EXISTS w_style_matchup      numeric(5,4),
  ADD COLUMN IF NOT EXISTS w_recent_form        numeric(5,4),
  ADD COLUMN IF NOT EXISTS w_ko_power_durability numeric(5,4),
  ADD COLUMN IF NOT EXISTS w_reach_height       numeric(5,4),
  ADD COLUMN IF NOT EXISTS w_activity_inactivity numeric(5,4),
  ADD COLUMN IF NOT EXISTS w_age_curve          numeric(5,4),
  ADD COLUMN IF NOT EXISTS w_defense_efficiency numeric(5,4),
  ADD COLUMN IF NOT EXISTS w_market_movement    numeric(5,4);

-- Seed v2 default weights row
INSERT INTO boxing_learning_history (
  id, model_version, sample_size,
  w_opponent_quality, w_style_matchup, w_recent_form, w_ko_power_durability,
  w_reach_height, w_activity_inactivity, w_age_curve, w_defense_efficiency, w_market_movement
) VALUES (
  'v2', '2.0', 0,
  0.20, 0.18, 0.12, 0.12, 0.10, 0.08, 0.08, 0.07, 0.05
) ON CONFLICT (id) DO NOTHING;

-- Boxing learning miss tags
ALTER TABLE boxing_predictions
  ADD COLUMN IF NOT EXISTS miss_tag text
    CHECK (miss_tag IN (
      'padded_record_overrated',
      'style_mismatch_misread',
      'inactivity_penalty_missed',
      'age_decline_underweighted',
      'market_overreaction',
      'correct'
    ));

-- ── MMA / UFC tables ──────────────────────────────────────────────────────────

-- Fighter profiles
CREATE TABLE IF NOT EXISTS mma_fighters (
  fighter_id                  text PRIMARY KEY,
  name                        text NOT NULL,
  wins                        smallint NOT NULL DEFAULT 0,
  losses                      smallint NOT NULL DEFAULT 0,
  draws                       smallint NOT NULL DEFAULT 0,
  no_contests                 smallint NOT NULL DEFAULT 0,
  ko_tko_wins                 smallint NOT NULL DEFAULT 0,
  sub_wins                    smallint NOT NULL DEFAULT 0,
  decision_wins               smallint NOT NULL DEFAULT 0,
  weight_class                text NOT NULL,
  reach_inches                numeric(5,1),
  height_inches               numeric(5,1),
  stance                      text CHECK (stance IN ('orthodox','southpaw','switch')),
  age                         smallint,
  last_fight_date             date,
  opponent_quality_score      numeric(5,2),   -- 0-100
  ko_tko_pct                  numeric(5,4),   -- 0.0-1.0
  sub_pct                     numeric(5,4),
  decision_pct                numeric(5,4),
  style_tag                   text CHECK (style_tag IN (
    'striker','grappler','wrestler','submission_specialist','well_rounded','pressure_fighter'
  )),
  -- Striking stats (per 15 min)
  sig_strikes_landed_per_min  numeric(6,3),
  sig_strikes_absorbed_per_min numeric(6,3),
  strike_accuracy             numeric(5,4),
  strike_defense              numeric(5,4),
  -- Grappling stats (per 15 min)
  avg_takedowns_per15         numeric(6,3),
  takedown_accuracy           numeric(5,4),
  takedown_defense            numeric(5,4),
  avg_sub_attempts_per15      numeric(6,3),
  control_time_per15          numeric(7,2),   -- seconds per 15 min
  -- Durability
  knockdowns_received         smallint,
  ko_penalty                  numeric(4,1),   -- 0-10
  -- Cardio
  cardio_rating               numeric(4,1),   -- 0-10
  -- Activity
  recent_wins                 smallint,
  recent_fights               smallint DEFAULT 5,
  short_notice                boolean NOT NULL DEFAULT false,
  weight_class_moves          smallint DEFAULT 0,
  -- Metadata
  data_source                 text,
  external_id                 text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Fights schedule
CREATE TABLE IF NOT EXISTS mma_fights (
  fight_id              text PRIMARY KEY,
  home_fighter_id       text NOT NULL REFERENCES mma_fighters(fighter_id),
  away_fighter_id       text NOT NULL REFERENCES mma_fighters(fighter_id),
  weight_class          text NOT NULL,
  scheduled_rounds      smallint NOT NULL DEFAULT 3,
  fight_date            date NOT NULL,
  fight_time            time,
  venue                 text,
  is_main_event         boolean NOT NULL DEFAULT false,
  is_championship_bout  boolean NOT NULL DEFAULT false,
  title_description     text,
  promotion             text,     -- 'UFC', 'Bellator', 'PFL', etc.
  status                text NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('upcoming','live','final','cancelled')),
  odds_event_id         text,     -- The Odds API event id
  result_winner_id      text REFERENCES mma_fighters(fighter_id),
  data_source           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mma_fights_date_status
  ON mma_fights (fight_date, status);

-- Fight results
CREATE TABLE IF NOT EXISTS mma_fight_results (
  result_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fight_id         text NOT NULL REFERENCES mma_fights(fight_id) ON DELETE CASCADE,
  winner_id        text REFERENCES mma_fighters(fighter_id),
  method           text CHECK (method IN (
    'ko','tko','submission','decision','split_decision','majority_decision',
    'draw','no_contest','dq','nc_overturned'
  )),
  round_ended      smallint,
  time_in_round    text,          -- e.g. "4:32"
  judges_scores    text,          -- optional scorecard string
  recorded_at      timestamptz NOT NULL DEFAULT now()
);

-- Odds snapshots (line movement history)
CREATE TABLE IF NOT EXISTS mma_odds_snapshots (
  snapshot_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fight_id        text NOT NULL REFERENCES mma_fights(fight_id) ON DELETE CASCADE,
  sportsbook_key  text NOT NULL,
  home_moneyline  integer,
  away_moneyline  integer,
  draw_moneyline  integer,
  over_rounds     numeric(4,1),
  over_odds       integer,
  under_odds      integer,
  is_opening      boolean NOT NULL DEFAULT false,
  snapshot_time   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mma_odds_snapshots_fight
  ON mma_odds_snapshots (fight_id, snapshot_time DESC);

-- Latest odds (current best line)
CREATE TABLE IF NOT EXISTS mma_odds_latest (
  fight_id        text PRIMARY KEY REFERENCES mma_fights(fight_id) ON DELETE CASCADE,
  sportsbook_key  text NOT NULL,
  home_moneyline  integer,
  away_moneyline  integer,
  draw_moneyline  integer,
  over_rounds     numeric(4,1),
  over_odds       integer,
  under_odds      integer,
  home_open_ml    integer,
  away_open_ml    integer,
  fetched_at      timestamptz NOT NULL DEFAULT now()
);

-- Predictions
CREATE TABLE IF NOT EXISTS mma_predictions (
  prediction_id     text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  fight_id          text NOT NULL REFERENCES mma_fights(fight_id) ON DELETE CASCADE,
  model_version     text NOT NULL DEFAULT '1.0',
  home_win_prob     numeric(5,2) NOT NULL,
  away_win_prob     numeric(5,2) NOT NULL,
  confidence        text NOT NULL CHECK (confidence IN ('high','medium','low')),
  predicted_winner_id text REFERENCES mma_fighters(fighter_id),
  ko_tko_prob       numeric(5,4),
  submission_prob   numeric(5,4),
  decision_prob     numeric(5,4),
  model_delta       numeric(7,5),
  parlay_fit_score  smallint,     -- 0-100
  -- per-factor scores
  factor_opponent_quality   numeric(6,4),
  factor_style_matchup      numeric(6,4),
  factor_cardio_pace        numeric(6,4),
  factor_grappling_control  numeric(6,4),
  factor_durability         numeric(6,4),
  factor_physical           numeric(6,4),
  factor_activity_layoff    numeric(6,4),
  factor_defense_efficiency numeric(6,4),
  factor_market_movement    numeric(6,4),
  -- outcome (populated after fight)
  actual_winner_id   text REFERENCES mma_fighters(fighter_id),
  actual_method      text,
  actual_rounds      smallint,
  correct_prediction boolean,
  miss_tag           text CHECK (miss_tag IN (
    'wrestling_edge_overstated',
    'cardio_dropoff_underestimated',
    'durability_misread',
    'opponent_quality_misread',
    'market_signal_ignored',
    'short_notice_underweighted',
    'correct'
  )),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mma_predictions_fight ON mma_predictions (fight_id);
CREATE INDEX IF NOT EXISTS idx_mma_predictions_outcome
  ON mma_predictions (correct_prediction, created_at);

-- Prediction version snapshots (pregame / live R1 / final)
CREATE TABLE IF NOT EXISTS mma_prediction_versions (
  version_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prediction_id    text NOT NULL REFERENCES mma_predictions(prediction_id) ON DELETE CASCADE,
  version_number   smallint NOT NULL DEFAULT 1,
  phase            text NOT NULL CHECK (phase IN ('pregame','live_r1','final')),
  home_win_prob    numeric(5,2) NOT NULL,
  away_win_prob    numeric(5,2) NOT NULL,
  confidence       text NOT NULL,
  live_round       smallint,      -- 1 when live_r1 snapshot
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Learning history (sport-isolated — never mixed with boxing, NBA, NFL, MLB)
CREATE TABLE IF NOT EXISTS mma_learning_history (
  id              text PRIMARY KEY DEFAULT 'v1',
  model_version   text NOT NULL DEFAULT '1.0',
  sample_size     integer NOT NULL DEFAULT 0,
  -- Learned factor weights
  w_opponent_quality   numeric(5,4),
  w_style_matchup      numeric(5,4),
  w_cardio_pace        numeric(5,4),
  w_grappling_control  numeric(5,4),
  w_durability         numeric(5,4),
  w_physical           numeric(5,4),
  w_activity_layoff    numeric(5,4),
  w_defense_efficiency numeric(5,4),
  w_market_movement    numeric(5,4),
  brier_score          numeric(6,5),
  accuracy_pct         numeric(5,2),
  computed_at          timestamptz NOT NULL DEFAULT now()
);

-- Seed default weights
INSERT INTO mma_learning_history (
  id, model_version, sample_size,
  w_opponent_quality, w_style_matchup, w_cardio_pace, w_grappling_control,
  w_durability, w_physical, w_activity_layoff, w_defense_efficiency, w_market_movement
) VALUES (
  'v1', '1.0', 0,
  0.20, 0.18, 0.12, 0.12, 0.10, 0.08, 0.08, 0.07, 0.05
) ON CONFLICT (id) DO NOTHING;

-- Accuracy view (rolling 180 days)
CREATE OR REPLACE VIEW mma_prediction_accuracy AS
SELECT
  model_version,
  confidence,
  COUNT(*)                                           AS total_predictions,
  SUM(CASE WHEN correct_prediction THEN 1 ELSE 0 END) AS correct_count,
  ROUND(
    AVG(CASE WHEN correct_prediction THEN 1.0 ELSE 0.0 END) * 100,
    2
  )                                                  AS accuracy_pct,
  MIN(created_at)                                    AS window_start,
  MAX(created_at)                                    AS window_end
FROM mma_predictions
WHERE
  correct_prediction IS NOT NULL
  AND created_at >= now() - interval '180 days'
GROUP BY model_version, confidence;

-- ── Row Level Security ────────────────────────────────────────────────────────

-- Enable RLS
ALTER TABLE mma_fighters           ENABLE ROW LEVEL SECURITY;
ALTER TABLE mma_fights             ENABLE ROW LEVEL SECURITY;
ALTER TABLE mma_fight_results      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mma_odds_snapshots     ENABLE ROW LEVEL SECURITY;
ALTER TABLE mma_odds_latest        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mma_predictions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mma_prediction_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mma_learning_history   ENABLE ROW LEVEL SECURITY;

ALTER TABLE boxing_odds_snapshots       ENABLE ROW LEVEL SECURITY;
ALTER TABLE boxing_odds_latest          ENABLE ROW LEVEL SECURITY;
ALTER TABLE boxing_prediction_factors   ENABLE ROW LEVEL SECURITY;

-- Public read. Postgres has no `CREATE POLICY IF NOT EXISTS`, so we
-- DROP-then-CREATE to keep the migration idempotent.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mma_fighters','mma_fights','mma_fight_results','mma_odds_snapshots',
    'mma_odds_latest','mma_predictions','mma_prediction_versions','mma_learning_history',
    'boxing_odds_snapshots','boxing_odds_latest','boxing_prediction_factors'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%s_public_read" ON %s', t, t);
    EXECUTE format(
      'CREATE POLICY "%s_public_read" ON %s FOR SELECT USING (true)',
      t, t
    );
  END LOOP;
END$$;

-- Service role write
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mma_fighters','mma_fights','mma_fight_results','mma_odds_snapshots',
    'mma_odds_latest','mma_predictions','mma_prediction_versions','mma_learning_history',
    'boxing_odds_snapshots','boxing_odds_latest','boxing_prediction_factors'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%s_service_write" ON %s', t, t);
    EXECUTE format(
      'CREATE POLICY "%s_service_write" ON %s FOR ALL TO service_role USING (true) WITH CHECK (true)',
      t, t
    );
  END LOOP;
END$$;
