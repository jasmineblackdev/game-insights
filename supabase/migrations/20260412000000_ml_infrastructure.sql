-- ============================================================
-- GameLens ML Infrastructure — Phase 1–3
-- Migration: 20260412000000_ml_infrastructure.sql
--
-- Phase 1: Tracking layer (predictions_master, features, results)
-- Phase 2: Learning layer (learning_log, feature_importance)
-- Phase 3: ML model layer (model_versions, model_outputs)
-- Phase 4: Blending layer (parlay_evaluations, live_prediction_updates)
-- Sport feature tables: NBA, NFL, MLB, Boxing, MMA
--
-- Rules:
--   - Sport feature tables are NEVER mixed across sports
--   - Pregame and live features are separated via checkpoint_stage
--   - Models are versioned; multiple versions can coexist
--   - ML layer supplements (never replaces) the rules engine
-- ============================================================

-- ── Patch: MMA learning history weight columns for v2 (10-factor model) ───────

ALTER TABLE mma_learning_history
  ADD COLUMN IF NOT EXISTS w_striking_efficiency numeric(5,4),
  ADD COLUMN IF NOT EXISTS w_age_curve           numeric(5,4);

-- Update default weights row with v2 factors
INSERT INTO mma_learning_history (
  id, model_version, sample_size,
  w_style_matchup, w_opponent_quality, w_striking_efficiency, w_grappling_control,
  w_cardio_pace, w_durability, w_physical, w_activity_layoff, w_age_curve, w_market_movement
) VALUES (
  'v2', '2.0', 0,
  0.20, 0.15, 0.12, 0.15, 0.10, 0.08, 0.07, 0.06, 0.04, 0.03
) ON CONFLICT (id) DO NOTHING;

-- ── Phase 1: Universal prediction tracking ────────────────────────────────────

-- Central prediction log across all sports and market types.
-- One row per prediction generated (pregame or live checkpoint).
CREATE TABLE IF NOT EXISTS predictions_master (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport               text NOT NULL,   -- 'nba' | 'nfl' | 'mlb' | 'boxing' | 'mma' | 'soccer'
  league              text NOT NULL,
  event_id            text NOT NULL,   -- sport-specific fight_id / game_id
  market_type         text NOT NULL,
  -- 'moneyline' | 'spread' | 'total' | 'fight_winner' | 'goes_distance' | 'over_under_rounds'
  -- 'prop_points' | 'prop_yards' | 'prop_strikeouts' | 'method_of_victory'
  prediction_type     text NOT NULL,
  selection           text NOT NULL,   -- team abbreviation or fighter name or "over/under"
  model_version       text NOT NULL DEFAULT '1.0',
  model_probability   numeric(5,4) NOT NULL,  -- 0.0–1.0
  implied_probability numeric(5,4) NOT NULL,  -- de-vig book probability
  edge                numeric(6,4) NOT NULL,  -- model_probability - implied_probability
  confidence          text NOT NULL CHECK (confidence IN ('high','medium','low')),
  volatility_score    numeric(5,2),           -- 0–100
  data_completeness   numeric(5,2),           -- 0–100 (key fields populated)
  checkpoint_stage    text NOT NULL DEFAULT 'pregame'
    CHECK (checkpoint_stage IN ('pregame','late_news','live_q1','live_f5','live_r1','live_15min','final')),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_predictions_master_event
  ON predictions_master (sport, event_id, market_type, checkpoint_stage);
CREATE INDEX IF NOT EXISTS idx_predictions_master_created
  ON predictions_master (created_at DESC);

-- Per-feature log: one row per model feature, per prediction.
-- Enables feature importance analysis and model debugging.
CREATE TABLE IF NOT EXISTS prediction_features (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id   uuid NOT NULL REFERENCES predictions_master(id) ON DELETE CASCADE,
  feature_name    text NOT NULL,   -- e.g. 'style_matchup_score', 'cardio_score'
  feature_value   numeric(10,6),   -- raw computed score for this feature
  feature_weight  numeric(5,4),    -- weight applied to this feature
  weighted_value  numeric(10,6),   -- feature_value * feature_weight
  feature_group   text,            -- 'striking' | 'grappling' | 'physical' | 'market' | etc.
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prediction_features_prediction
  ON prediction_features (prediction_id);

-- Prediction results: actual outcome linked back to the prediction.
CREATE TABLE IF NOT EXISTS prediction_results (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id               uuid NOT NULL REFERENCES predictions_master(id) ON DELETE CASCADE,
  actual_outcome              text,    -- winning team/fighter or "over/under"
  correct_prediction          boolean,
  closing_odds                integer, -- American odds at market close
  closing_implied_probability numeric(5,4),
  -- Closing Line Value: did the model beat the closing line?
  clv                         numeric(6,4), -- model_probability - closing_implied_probability
  profit_loss                 numeric(8,2), -- in units (1 unit = $100)
  result_timestamp            timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prediction_results_prediction
  ON prediction_results (prediction_id);
CREATE INDEX IF NOT EXISTS idx_prediction_results_correct
  ON prediction_results (sport, correct_prediction, created_at DESC)
  FROM predictions_master pm JOIN prediction_results pr ON pr.prediction_id = pm.id;
-- ^ This would be a join index; use a simpler index instead:
DROP INDEX IF EXISTS idx_prediction_results_correct;
CREATE INDEX IF NOT EXISTS idx_prediction_results_created
  ON prediction_results (created_at DESC);

-- ── Phase 2: Learning layer ───────────────────────────────────────────────────

-- Model version registry. Enables A/B comparison across versions.
CREATE TABLE IF NOT EXISTS model_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_name text NOT NULL,    -- e.g. 'mma_v2', 'boxing_v2', 'nba_v1'
  sport        text NOT NULL,
  model_type   text NOT NULL,    -- 'rules' | 'logistic' | 'gbm' | 'ensemble'
  market_type  text,             -- null = all markets; or 'moneyline' | 'prop' | etc.
  description  text,
  is_active    boolean NOT NULL DEFAULT true,
  deployed_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Learning miss log: human-readable tags for model failures.
-- Enables rolling post-mortem and automatic weight adjustment signals.
CREATE TABLE IF NOT EXISTS prediction_learning_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id   uuid NOT NULL REFERENCES predictions_master(id) ON DELETE CASCADE,
  sport           text NOT NULL,
  error_reason    text NOT NULL,
  -- Per-sport miss tags (see below)
  error_category  text NOT NULL,
  -- 'model_factor' | 'market_signal' | 'lineup_injury' | 'data_quality' | 'correct'
  severity_score  numeric(4,2),  -- 0–10: how badly the model was off
  note            text,          -- free-form analyst note
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- Valid miss tags per sport (enforced at application layer, documented here):
-- MMA/UFC: wrestling_edge_overstated, cardio_dropoff_underestimated,
--          durability_misread, opponent_quality_misread, market_signal_ignored,
--          short_notice_underweighted, style_mismatch_misread, correct
-- Boxing:  padded_record_overrated, style_mismatch_misread, inactivity_penalty_missed,
--          age_decline_underweighted, market_overreaction, correct
-- NBA:     injury_impact_missed, pace_mismatch, blowout_variance, correct
-- NFL:     weather_underweighted, qb_injury_ignored, gamescript_mismatch, correct
-- MLB:     bullpen_fatigue_missed, pitcher_command_overrated, lineup_handedness, correct
-- Soccer:  draw_underestimated, xg_overfit, congestion_ignored, correct

CREATE INDEX IF NOT EXISTS idx_learning_log_sport_error
  ON prediction_learning_log (sport, error_reason, created_at DESC);

-- Feature importance: rolling performance by feature per sport and market type.
-- Updated by the learning system after each result batch.
CREATE TABLE IF NOT EXISTS feature_importance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport           text NOT NULL,
  market_type     text NOT NULL,  -- 'moneyline' | 'prop' | 'goes_distance' | etc.
  checkpoint_stage text NOT NULL DEFAULT 'pregame',
  feature_name    text NOT NULL,
  current_weight  numeric(5,4) NOT NULL,
  baseline_weight numeric(5,4) NOT NULL,  -- default weight when no data
  sample_size     integer NOT NULL DEFAULT 0,
  -- Rolling accuracy metrics (last 90 days)
  accuracy_with_feature    numeric(5,2),  -- % correct when feature had strong signal
  accuracy_without_feature numeric(5,2),
  avg_clv_contribution     numeric(6,4),  -- avg CLV improvement attributed to this feature
  -- Adjustment thresholds
  increase_threshold numeric(5,4) DEFAULT 0.60,
  decrease_threshold numeric(5,4) DEFAULT 0.45,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sport, market_type, checkpoint_stage, feature_name)
);
CREATE INDEX IF NOT EXISTS idx_feature_importance_sport
  ON feature_importance (sport, market_type);

-- ── Phase 3: ML model output layer ──────────────────────��────────────────────

-- ML model raw outputs, stored alongside rules-engine predictions.
-- Both can coexist; the blend layer combines them.
CREATE TABLE IF NOT EXISTS model_outputs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id   uuid NOT NULL REFERENCES predictions_master(id) ON DELETE CASCADE,
  model_version_id uuid REFERENCES model_versions(id),
  -- Raw ML outputs
  ml_probability  numeric(5,4),   -- output of the ML classifier
  ml_confidence   numeric(5,4),
  regression_value numeric(10,4), -- for prop regression models (projected stat value)
  ranking_score   numeric(6,4),   -- for ranking/value models
  ensemble_weight numeric(5,4) DEFAULT 0.30, -- how much ML contributes to final blend
  -- Blend result
  blended_probability numeric(5,4), -- (rules * (1-ensemble_weight)) + (ml * ensemble_weight)
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Phase 4: Blending and parlay layer ──────────────────────────��────────────

-- Parlay evaluation log: one row per parlay built.
CREATE TABLE IF NOT EXISTS parlay_evaluations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlay_id            text NOT NULL,   -- client-generated parlay session ID
  mode                 text NOT NULL DEFAULT 'balanced'
    CHECK (mode IN ('safe','balanced','aggressive')),
  total_legs           integer NOT NULL,
  combined_probability numeric(5,4),   -- product of de-vig probabilities
  combined_edge        numeric(6,4),   -- sum of individual edges
  correlation_score    numeric(5,2),   -- 0–100: 0 = independent, 100 = highly correlated
  diversification_score numeric(5,2),  -- sports/leagues represented
  payout_efficiency    numeric(5,2),   -- combined_probability / book payout probability
  recommended          boolean NOT NULL DEFAULT false,
  reject_reason        text,           -- why this parlay was NOT recommended (if applicable)
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Parlay legs: normalized from edge_slips joined to parlay_evaluations.
CREATE TABLE IF NOT EXISTS parlay_legs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlay_evaluation_id uuid NOT NULL REFERENCES parlay_evaluations(id) ON DELETE CASCADE,
  prediction_id     uuid REFERENCES predictions_master(id),
  sport             text NOT NULL,
  event_id          text NOT NULL,
  selection         text NOT NULL,
  leg_probability   numeric(5,4),
  leg_edge          numeric(6,4),
  leg_fit_score     numeric(5,2),   -- single-leg parlay score (0–100)
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Live prediction checkpoint updates.
-- Preserves the original pregame prediction; stores live update as a new row.
CREATE TABLE IF NOT EXISTS live_prediction_updates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id        uuid NOT NULL REFERENCES predictions_master(id) ON DELETE CASCADE,
  checkpoint_stage     text NOT NULL
    CHECK (checkpoint_stage IN ('live_q1','live_f5','live_r1','live_15min')),
  -- Live state at checkpoint
  period_num           smallint,
  home_score           smallint,
  away_score           smallint,
  -- Updated model output
  updated_probability  numeric(5,4) NOT NULL,
  pregame_probability  numeric(5,4) NOT NULL,  -- original, preserved for CLV calc
  probability_shift    numeric(6,4),            -- updated - pregame
  updated_edge         numeric(6,4),
  updated_confidence   text CHECK (updated_confidence IN ('high','medium','low')),
  -- Live signal details (sport-specific; stored as JSONB for flexibility)
  live_signals         jsonb,
  -- MMA R1 signals example:
  -- { "home_strike_success": 0.48, "away_takedown_success": 0.33,
  --   "home_control_time": 82, "home_damage": "light", "away_damage": "none" }
  update_reason        text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_live_updates_prediction
  ON live_prediction_updates (prediction_id, checkpoint_stage);

-- ── Sport feature tables ──────────────────────────────────────────────────────
-- One per sport. NEVER mix features between sports.
-- These are per-game/fight snapshots used by the ML layer.

-- NBA team features (per game)
CREATE TABLE IF NOT EXISTS nba_team_features (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id             text NOT NULL,
  team                text NOT NULL,
  offensive_rating    numeric(6,2),  -- points per 100 possessions
  defensive_rating    numeric(6,2),
  pace                numeric(6,2),  -- possessions per 48 min
  net_rating          numeric(6,2),
  usage_star          numeric(5,2),  -- primary star usage %
  expected_minutes_star numeric(4,1),
  rest_days           integer,
  back_to_back        boolean NOT NULL DEFAULT false,
  home_game           boolean NOT NULL DEFAULT false,
  blowout_risk_score  numeric(5,2),  -- 0–100: high = likely blowout (avoid spread)
  injury_impact_score numeric(5,2),  -- 0–100: 0 = full strength
  checkpoint_stage    text NOT NULL DEFAULT 'pregame',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nba_team_features_game
  ON nba_team_features (game_id, team);

-- NBA player features (per game, key contributors only)
CREATE TABLE IF NOT EXISTS nba_player_features (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id             text NOT NULL,
  player_name         text NOT NULL,
  team                text NOT NULL,
  points_baseline     numeric(5,1),   -- season avg
  rebounds_baseline   numeric(4,1),
  assists_baseline    numeric(4,1),
  usage_pct           numeric(5,2),
  expected_minutes    numeric(4,1),
  matchup_rating      numeric(5,2),   -- 0–100: vs tonight's defender
  injury_status       text,           -- 'out' | 'questionable' | 'probable' | 'active'
  checkpoint_stage    text NOT NULL DEFAULT 'pregame',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nba_player_features_game
  ON nba_player_features (game_id, player_name);

-- NFL team features (per game)
CREATE TABLE IF NOT EXISTS nfl_team_features (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id             text NOT NULL,
  team                text NOT NULL,
  qb_efficiency       numeric(5,2),  -- composite (completion%, air yards, aDOT, EPA)
  pressure_rate       numeric(5,4),  -- % of pass plays with QB pressure
  rush_success_rate   numeric(5,4),
  pass_success_rate   numeric(5,4),
  red_zone_efficiency numeric(5,4),
  turnovers_pg        numeric(4,2),
  sacks_allowed_pg    numeric(4,2),
  weather_score       numeric(5,2),  -- 0 = neutral; negative = hurts passing game
  home_game           boolean NOT NULL DEFAULT false,
  rest_days           integer,
  checkpoint_stage    text NOT NULL DEFAULT 'pregame',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nfl_team_features_game
  ON nfl_team_features (game_id, team);

-- NFL player features (key skill players)
CREATE TABLE IF NOT EXISTS nfl_player_features (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id               text NOT NULL,
  player_name           text NOT NULL,
  team                  text NOT NULL,
  position              text,          -- 'QB' | 'RB' | 'WR' | 'TE'
  snap_share            numeric(5,4),
  target_share          numeric(5,4),  -- WR/TE only
  carry_share           numeric(5,4),  -- RB only
  expected_touch_volume numeric(5,1),
  matchup_grade         text,          -- 'A' | 'B' | 'C' | 'D'
  injury_status         text,
  checkpoint_stage      text NOT NULL DEFAULT 'pregame',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nfl_player_features_game
  ON nfl_player_features (game_id, player_name);

-- MLB pitcher features (per start)
CREATE TABLE IF NOT EXISTS mlb_pitcher_features (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id             text NOT NULL,
  pitcher_name        text NOT NULL,
  team                text NOT NULL,
  side                text NOT NULL CHECK (side IN ('home','away')),
  era                 numeric(5,2),
  fip                 numeric(5,2),   -- fielding-independent pitching
  whip                numeric(5,3),
  strikeout_rate      numeric(5,4),   -- K/9 normalized
  walk_rate           numeric(5,4),
  hr_rate             numeric(5,4),
  pitch_count_trend   numeric(5,1),   -- avg pitches per start last 5
  days_rest           integer,
  handedness          text CHECK (handedness IN ('L','R')),
  vs_lhb_avg          numeric(5,3),   -- opponent batting avg vs lefty/righty
  vs_rhb_avg          numeric(5,3),
  certainty           text CHECK (certainty IN ('confirmed','probable','questionable')),
  checkpoint_stage    text NOT NULL DEFAULT 'pregame',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_features_game
  ON mlb_pitcher_features (game_id, pitcher_name);

-- MLB team features (per game)
CREATE TABLE IF NOT EXISTS mlb_team_features (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id               text NOT NULL,
  team                  text NOT NULL,
  bullpen_fatigue_score numeric(5,2),  -- 0–100: 100 = heavily taxed pen
  lineup_strength       numeric(5,2),  -- 0–100 vs average
  lineup_certainty      text CHECK (lineup_certainty IN ('confirmed','probable','unknown')),
  splits_vs_lhp         numeric(5,3),  -- team OPS vs lefty starters
  splits_vs_rhp         numeric(5,3),
  park_factor           numeric(5,3),  -- 1.00 = neutral; >1.00 = hitter-friendly
  home_game             boolean NOT NULL DEFAULT false,
  checkpoint_stage      text NOT NULL DEFAULT 'pregame',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mlb_team_features_game
  ON mlb_team_features (game_id, team);

-- Boxing fighter features (per fight, snapshot at prediction time)
CREATE TABLE IF NOT EXISTS boxing_fighter_features (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fight_id            text NOT NULL,
  fighter_name        text NOT NULL,
  side                text NOT NULL CHECK (side IN ('home','away')),
  reach               numeric(5,1),
  height              numeric(5,1),
  age                 integer,
  stance              text,
  ko_rate             numeric(5,4),
  decision_rate       numeric(5,4),
  rounds_won_pct      numeric(5,4),
  strikes_defense_pct numeric(5,4),
  inactivity_months   numeric(5,1),
  opponent_quality    numeric(5,2),   -- 0–100
  recent_wins         smallint,
  recent_fights       smallint,
  weight_class_moves  smallint,
  checkpoint_stage    text NOT NULL DEFAULT 'pregame',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_boxing_fighter_features_fight
  ON boxing_fighter_features (fight_id, fighter_name);

-- MMA fighter features (per fight, snapshot at prediction time)
-- Richer than mma_fighters: captures per-fight context.
CREATE TABLE IF NOT EXISTS mma_fighter_features (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fight_id                    text NOT NULL,
  fighter_name                text NOT NULL,
  side                        text NOT NULL CHECK (side IN ('home','away')),
  -- Style
  style_tag                   text,
  -- Striking
  sig_strikes_landed_per_min  numeric(6,3),
  sig_strikes_absorbed_per_min numeric(6,3),
  strike_accuracy             numeric(5,4),
  strike_defense              numeric(5,4),
  -- Grappling
  avg_takedowns_per15         numeric(6,3),
  takedown_accuracy           numeric(5,4),
  takedown_defense            numeric(5,4),
  avg_sub_attempts_per15      numeric(6,3),
  control_time_per15          numeric(7,2),
  -- Durability
  ko_penalty                  numeric(4,1),
  knockdowns_received         smallint,
  -- Cardio
  cardio_rating               numeric(4,1),
  -- Physical
  reach_inches                numeric(5,1),
  height_inches               numeric(5,1),
  age                         smallint,
  -- Activity
  inactivity_months           numeric(5,1),
  short_notice                boolean NOT NULL DEFAULT false,
  -- Competition quality
  opponent_quality_score      numeric(5,2),
  recent_wins                 smallint,
  recent_fights               smallint,
  -- Model scores at prediction time (for audit / feature importance)
  style_score                 numeric(7,5),
  striking_score              numeric(7,5),
  grappling_score             numeric(7,5),
  cardio_score                numeric(7,5),
  durability_score            numeric(7,5),
  physical_score              numeric(7,5),
  quality_score               numeric(7,5),
  activity_score              numeric(7,5),
  age_curve_score             numeric(7,5),
  checkpoint_stage            text NOT NULL DEFAULT 'pregame',
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mma_fighter_features_fight
  ON mma_fighter_features (fight_id, fighter_name);

-- ── Row Level Security ───────────────────────────────────���────────────────────

ALTER TABLE predictions_master          ENABLE ROW LEVEL SECURITY;
ALTER TABLE prediction_features         ENABLE ROW LEVEL SECURITY;
ALTER TABLE prediction_results          ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_versions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE prediction_learning_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_importance          ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_outputs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE parlay_evaluations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE parlay_legs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_prediction_updates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE nba_team_features           ENABLE ROW LEVEL SECURITY;
ALTER TABLE nba_player_features         ENABLE ROW LEVEL SECURITY;
ALTER TABLE nfl_team_features           ENABLE ROW LEVEL SECURITY;
ALTER TABLE nfl_player_features         ENABLE ROW LEVEL SECURITY;
ALTER TABLE mlb_pitcher_features        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mlb_team_features           ENABLE ROW LEVEL SECURITY;
ALTER TABLE boxing_fighter_features     ENABLE ROW LEVEL SECURITY;
ALTER TABLE mma_fighter_features        ENABLE ROW LEVEL SECURITY;

-- Public read for all ML tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'predictions_master','prediction_features','prediction_results',
    'model_versions','prediction_learning_log','feature_importance',
    'model_outputs','parlay_evaluations','parlay_legs','live_prediction_updates',
    'nba_team_features','nba_player_features',
    'nfl_team_features','nfl_player_features',
    'mlb_pitcher_features','mlb_team_features',
    'boxing_fighter_features','mma_fighter_features'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY IF NOT EXISTS "%s_public_read" ON %s FOR SELECT USING (true)',
      t, t
    );
  END LOOP;
END$$;

-- Service role write
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'predictions_master','prediction_features','prediction_results',
    'model_versions','prediction_learning_log','feature_importance',
    'model_outputs','parlay_evaluations','parlay_legs','live_prediction_updates',
    'nba_team_features','nba_player_features',
    'nfl_team_features','nfl_player_features',
    'mlb_pitcher_features','mlb_team_features',
    'boxing_fighter_features','mma_fighter_features'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY IF NOT EXISTS "%s_service_write" ON %s FOR ALL TO service_role USING (true) WITH CHECK (true)',
      t, t
    );
  END LOOP;
END$$;

-- ── Seed default feature importance rows for MMA (v2 weights) ─────────────────

INSERT INTO feature_importance (sport, market_type, checkpoint_stage, feature_name, current_weight, baseline_weight)
VALUES
  ('mma','moneyline','pregame','style_matchup',       0.20, 0.20),
  ('mma','moneyline','pregame','opponent_quality',     0.15, 0.15),
  ('mma','moneyline','pregame','striking_efficiency',  0.12, 0.12),
  ('mma','moneyline','pregame','grappling_control',    0.15, 0.15),
  ('mma','moneyline','pregame','cardio_pace',          0.10, 0.10),
  ('mma','moneyline','pregame','durability',           0.08, 0.08),
  ('mma','moneyline','pregame','physical_advantage',   0.07, 0.07),
  ('mma','moneyline','pregame','activity_layoff',      0.06, 0.06),
  ('mma','moneyline','pregame','age_curve',            0.04, 0.04),
  ('mma','moneyline','pregame','market_movement',      0.03, 0.03),
  ('mma','goes_distance','pregame','goes_distance_base', 1.00, 1.00),
  ('boxing','moneyline','pregame','opponent_quality',  0.20, 0.20),
  ('boxing','moneyline','pregame','style_matchup',     0.18, 0.18),
  ('boxing','moneyline','pregame','recent_form',       0.12, 0.12),
  ('boxing','moneyline','pregame','ko_power_durability', 0.12, 0.12),
  ('boxing','moneyline','pregame','reach_height',      0.10, 0.10),
  ('boxing','moneyline','pregame','activity_inactivity', 0.08, 0.08),
  ('boxing','moneyline','pregame','age_curve',         0.08, 0.08),
  ('boxing','moneyline','pregame','defense_efficiency', 0.07, 0.07),
  ('boxing','moneyline','pregame','market_movement',   0.05, 0.05)
ON CONFLICT (sport, market_type, checkpoint_stage, feature_name) DO NOTHING;

-- ── Accuracy view across all sports ──────────────────────────────────────────

CREATE OR REPLACE VIEW ml_prediction_accuracy AS
SELECT
  pm.sport,
  pm.market_type,
  pm.checkpoint_stage,
  pm.confidence,
  pm.model_version,
  COUNT(*)                                              AS total_predictions,
  SUM(CASE WHEN pr.correct_prediction THEN 1 ELSE 0 END) AS correct_count,
  ROUND(
    AVG(CASE WHEN pr.correct_prediction THEN 1.0 ELSE 0.0 END) * 100, 2
  )                                                     AS accuracy_pct,
  ROUND(AVG(pr.clv) * 100, 3)                           AS avg_clv_pct,
  MIN(pm.created_at)                                    AS window_start,
  MAX(pm.created_at)                                    AS window_end
FROM predictions_master pm
JOIN prediction_results pr ON pr.prediction_id = pm.id
WHERE
  pr.correct_prediction IS NOT NULL
  AND pm.created_at >= now() - interval '180 days'
GROUP BY pm.sport, pm.market_type, pm.checkpoint_stage, pm.confidence, pm.model_version;
