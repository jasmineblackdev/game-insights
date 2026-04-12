-- Model contribution tracking + parlay build history schema + analytics RPCs.
--
-- Adds:
--   1. prediction_history.model_variant column
--   2. parlay_build_history table
--   3. parlay_build_legs table
--   4. parlay_results table (populated when legs resolve)
--   5. analytics_model_contribution RPC
--   6. analytics_parlay_model_mix RPC
--   7. analytics_edge_bucket_performance RPC
--   8. analytics_timing_edge_quality RPC
--   9. analytics_stability_edge_quality RPC

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. model_variant column on prediction_history
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE prediction_history
  ADD COLUMN IF NOT EXISTS model_variant text DEFAULT 'rules'
  CHECK (model_variant IN ('rules', 'ml_blended', 'ml_full'));

CREATE INDEX IF NOT EXISTS idx_prediction_history_model_variant
  ON prediction_history (model_variant)
  WHERE model_variant IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. parlay_build_history
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parlay_build_history (
  id                        uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                timestamptz  NOT NULL DEFAULT now(),
  tier                      text         NOT NULL CHECK (tier IN ('safe', 'balanced', 'aggressive')),
  leg_count                 integer      NOT NULL,
  sport_mix                 jsonb        NOT NULL DEFAULT '{}',
  market_mix                jsonb        NOT NULL DEFAULT '{}',
  avg_leg_score             numeric(6,4),
  avg_ml_probability        numeric(6,4),
  avg_confidence            numeric(6,4),
  avg_timing_score          numeric(6,4),
  avg_stability_score       numeric(6,4),
  correlation_penalty       numeric(6,2),
  volatility_score          numeric(6,2),
  combined_edge             numeric(8,4),
  projected_hit_probability numeric(6,4),
  model_variant_mix         jsonb        NOT NULL DEFAULT '{}',
  timing_quality            text,
  parlay_score              numeric(8,4)
);

CREATE INDEX IF NOT EXISTS idx_parlay_build_tier
  ON parlay_build_history (tier);
CREATE INDEX IF NOT EXISTS idx_parlay_build_created
  ON parlay_build_history (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. parlay_build_legs
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parlay_build_legs (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  parlay_id            uuid        NOT NULL REFERENCES parlay_build_history(id) ON DELETE CASCADE,
  prediction_id        text,
  sport                text        NOT NULL,
  market_type          text,
  selection            text,
  odds                 integer,
  edge                 numeric(8,4),
  ml_hit_probability   numeric(6,4),
  confidence           text,
  timing_urgency       text,
  timing_score         numeric(6,4),
  stability_score      numeric(6,4),
  volatility_score     numeric(6,2),
  correlation_group_id text,
  model_variant        text        DEFAULT 'rules',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parlay_build_legs_parlay
  ON parlay_build_legs (parlay_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. parlay_results (populated when all legs resolve)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parlay_results (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  parlay_id         uuid        NOT NULL REFERENCES parlay_build_history(id) ON DELETE CASCADE,
  resolved_at       timestamptz,
  hit               boolean,
  roi_pct           numeric(8,2),
  failed_leg_count  integer,
  failure_summary   jsonb       DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parlay_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. analytics_model_contribution
-- ─────────────────────────────────────────────────────────────────────────────
-- Compares rules vs ml_blended prediction performance.
-- n >= 10 resolved required to surface a variant.
CREATE OR REPLACE FUNCTION analytics_model_contribution(
  lookback_days integer DEFAULT 30
)
RETURNS TABLE (
  model_variant     text,
  resolved_count    bigint,
  win_count         bigint,
  hit_rate_pct      numeric,
  roi_pct           numeric,
  avg_edge          numeric,
  avg_timing_score  numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    COALESCE(model_variant, 'rules')                             AS model_variant,
    COUNT(*) FILTER (WHERE outcome IS NOT NULL)                  AS resolved_count,
    COUNT(*) FILTER (WHERE outcome = 'win')                      AS win_count,
    ROUND(
      COUNT(*) FILTER (WHERE outcome = 'win')::numeric
      / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                         AS hit_rate_pct,
    ROUND(
      SUM(CASE
        WHEN outcome = 'win'  THEN (1.0 / NULLIF((feature_snapshot->>'market_probability_proxy')::numeric, 0)) - 1
        WHEN outcome = 'loss' THEN -1.0
        ELSE 0
      END) / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                         AS roi_pct,
    ROUND(AVG(edge_at_prediction)::numeric, 4)                   AS avg_edge,
    ROUND(AVG(
      CASE COALESCE(feature_snapshot->>'timing_bucket', 'monitor')
        WHEN 'now'  THEN 0.85
        WHEN 'wait' THEN 0.15
        ELSE 0.55
      END
    )::numeric, 3)                                               AS avg_timing_score
  FROM prediction_history
  WHERE predicted_at >= NOW() - (lookback_days || ' days')::interval
  GROUP BY 1
  HAVING COUNT(*) FILTER (WHERE outcome IS NOT NULL) >= 10
  ORDER BY
    CASE COALESCE(model_variant, 'rules')
      WHEN 'rules'      THEN 1
      WHEN 'ml_blended' THEN 2
      WHEN 'ml_full'    THEN 3
      ELSE 4
    END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. analytics_parlay_model_mix
-- ─────────────────────────────────────────────────────────────────────────────
-- Groups parlays by ML-leg ratio bucket and shows hit rate / ROI per bucket.
-- Requires parlay_results to be populated for meaningful hit_rate / roi_pct.
CREATE OR REPLACE FUNCTION analytics_parlay_model_mix(
  lookback_days integer DEFAULT 30
)
RETURNS TABLE (
  tier              text,
  ml_ratio_bucket   text,
  parlay_count      bigint,
  resolved_count    bigint,
  hit_rate_pct      numeric,
  roi_pct           numeric,
  avg_leg_score     numeric,
  avg_timing_score  numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    pbh.tier,
    CASE
      WHEN (COALESCE((pbh.model_variant_mix->>'ml_blended')::integer, 0)
          + COALESCE((pbh.model_variant_mix->>'ml_full')::integer, 0))::numeric
           / NULLIF(pbh.leg_count, 0) < 0.25  THEN '0–25% ML legs'
      WHEN (COALESCE((pbh.model_variant_mix->>'ml_blended')::integer, 0)
          + COALESCE((pbh.model_variant_mix->>'ml_full')::integer, 0))::numeric
           / NULLIF(pbh.leg_count, 0) < 0.50  THEN '25–50% ML legs'
      WHEN (COALESCE((pbh.model_variant_mix->>'ml_blended')::integer, 0)
          + COALESCE((pbh.model_variant_mix->>'ml_full')::integer, 0))::numeric
           / NULLIF(pbh.leg_count, 0) < 0.75  THEN '50–75% ML legs'
      ELSE '75–100% ML legs'
    END                                                            AS ml_ratio_bucket,
    COUNT(pbh.id)                                                  AS parlay_count,
    COUNT(pr.id) FILTER (WHERE pr.hit IS NOT NULL)                 AS resolved_count,
    ROUND(
      COUNT(pr.id) FILTER (WHERE pr.hit = true)::numeric
      / NULLIF(COUNT(pr.id) FILTER (WHERE pr.hit IS NOT NULL), 0) * 100
    , 1)                                                           AS hit_rate_pct,
    ROUND(AVG(pr.roi_pct) FILTER (WHERE pr.roi_pct IS NOT NULL), 1) AS roi_pct,
    ROUND(AVG(pbh.avg_leg_score)::numeric, 4)                     AS avg_leg_score,
    ROUND(AVG(pbh.avg_timing_score)::numeric, 3)                  AS avg_timing_score
  FROM parlay_build_history pbh
  LEFT JOIN parlay_results pr ON pr.parlay_id = pbh.id
  WHERE pbh.created_at >= NOW() - (lookback_days || ' days')::interval
  GROUP BY 1, 2
  ORDER BY 1,
    CASE
      WHEN CASE
        WHEN (COALESCE((pbh.model_variant_mix->>'ml_blended')::integer, 0)
            + COALESCE((pbh.model_variant_mix->>'ml_full')::integer, 0))::numeric
             / NULLIF(pbh.leg_count, 0) < 0.25  THEN '0–25% ML legs'
        WHEN (COALESCE((pbh.model_variant_mix->>'ml_blended')::integer, 0)
            + COALESCE((pbh.model_variant_mix->>'ml_full')::integer, 0))::numeric
             / NULLIF(pbh.leg_count, 0) < 0.50  THEN '25–50% ML legs'
        WHEN (COALESCE((pbh.model_variant_mix->>'ml_blended')::integer, 0)
            + COALESCE((pbh.model_variant_mix->>'ml_full')::integer, 0))::numeric
             / NULLIF(pbh.leg_count, 0) < 0.75  THEN '50–75% ML legs'
        ELSE '75–100% ML legs'
      END = '0–25% ML legs'     THEN 1
      WHEN CASE
        WHEN (COALESCE((pbh.model_variant_mix->>'ml_blended')::integer, 0)
            + COALESCE((pbh.model_variant_mix->>'ml_full')::integer, 0))::numeric
             / NULLIF(pbh.leg_count, 0) < 0.25  THEN '0–25% ML legs'
        WHEN (COALESCE((pbh.model_variant_mix->>'ml_blended')::integer, 0)
            + COALESCE((pbh.model_variant_mix->>'ml_full')::integer, 0))::numeric
             / NULLIF(pbh.leg_count, 0) < 0.50  THEN '25–50% ML legs'
        WHEN (COALESCE((pbh.model_variant_mix->>'ml_blended')::integer, 0)
            + COALESCE((pbh.model_variant_mix->>'ml_full')::integer, 0))::numeric
             / NULLIF(pbh.leg_count, 0) < 0.75  THEN '50–75% ML legs'
        ELSE '75–100% ML legs'
      END = '25–50% ML legs'    THEN 2
      WHEN CASE
        WHEN (COALESCE((pbh.model_variant_mix->>'ml_blended')::integer, 0)
            + COALESCE((pbh.model_variant_mix->>'ml_full')::integer, 0))::numeric
             / NULLIF(pbh.leg_count, 0) < 0.25  THEN '0–25% ML legs'
        WHEN (COALESCE((pbh.model_variant_mix->>'ml_blended')::integer, 0)
            + COALESCE((pbh.model_variant_mix->>'ml_full')::integer, 0))::numeric
             / NULLIF(pbh.leg_count, 0) < 0.50  THEN '25–50% ML legs'
        WHEN (COALESCE((pbh.model_variant_mix->>'ml_blended')::integer, 0)
            + COALESCE((pbh.model_variant_mix->>'ml_full')::integer, 0))::numeric
             / NULLIF(pbh.leg_count, 0) < 0.75  THEN '50–75% ML legs'
        ELSE '75–100% ML legs'
      END = '50–75% ML legs'    THEN 3
      ELSE 4
    END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. analytics_edge_bucket_performance
-- ─────────────────────────────────────────────────────────────────────────────
-- Reveals which edge ranges actually outperform per sport/market.
CREATE OR REPLACE FUNCTION analytics_edge_bucket_performance(
  lookback_days integer DEFAULT 30,
  min_resolved  integer DEFAULT 5
)
RETURNS TABLE (
  sport         text,
  market_type   text,
  edge_bucket   text,
  resolved_count bigint,
  win_count     bigint,
  hit_rate_pct  numeric,
  roi_pct       numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    upper(sport)                                                   AS sport,
    COALESCE(stat_type, 'unknown')                                 AS market_type,
    CASE
      WHEN edge_at_prediction < 0.02 THEN '0–2%'
      WHEN edge_at_prediction < 0.05 THEN '2–5%'
      WHEN edge_at_prediction < 0.08 THEN '5–8%'
      ELSE '8%+'
    END                                                            AS edge_bucket,
    COUNT(*) FILTER (WHERE outcome IS NOT NULL)                    AS resolved_count,
    COUNT(*) FILTER (WHERE outcome = 'win')                        AS win_count,
    ROUND(
      COUNT(*) FILTER (WHERE outcome = 'win')::numeric
      / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                           AS hit_rate_pct,
    ROUND(
      SUM(CASE
        WHEN outcome = 'win'  THEN (1.0 / NULLIF((feature_snapshot->>'market_probability_proxy')::numeric, 0)) - 1
        WHEN outcome = 'loss' THEN -1.0
        ELSE 0
      END) / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                           AS roi_pct
  FROM prediction_history
  WHERE predicted_at >= NOW() - (lookback_days || ' days')::interval
  GROUP BY 1, 2, 3
  HAVING COUNT(*) FILTER (WHERE outcome IS NOT NULL) >= min_resolved
  ORDER BY roi_pct DESC NULLS LAST;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. analytics_timing_edge_quality
-- ─────────────────────────────────────────────────────────────────────────────
-- Does "now" timing realize edge better than "wait" timing within the same edge bucket?
CREATE OR REPLACE FUNCTION analytics_timing_edge_quality(
  lookback_days integer DEFAULT 30,
  min_resolved  integer DEFAULT 5
)
RETURNS TABLE (
  timing_bucket text,
  edge_bucket   text,
  resolved_count bigint,
  win_count     bigint,
  hit_rate_pct  numeric,
  roi_pct       numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    COALESCE(feature_snapshot->>'timing_bucket', 'monitor')         AS timing_bucket,
    CASE
      WHEN edge_at_prediction < 0.02 THEN '0–2%'
      WHEN edge_at_prediction < 0.05 THEN '2–5%'
      WHEN edge_at_prediction < 0.08 THEN '5–8%'
      ELSE '8%+'
    END                                                             AS edge_bucket,
    COUNT(*) FILTER (WHERE outcome IS NOT NULL)                     AS resolved_count,
    COUNT(*) FILTER (WHERE outcome = 'win')                         AS win_count,
    ROUND(
      COUNT(*) FILTER (WHERE outcome = 'win')::numeric
      / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                            AS hit_rate_pct,
    ROUND(
      SUM(CASE
        WHEN outcome = 'win'  THEN (1.0 / NULLIF((feature_snapshot->>'market_probability_proxy')::numeric, 0)) - 1
        WHEN outcome = 'loss' THEN -1.0
        ELSE 0
      END) / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                            AS roi_pct
  FROM prediction_history
  WHERE predicted_at >= NOW() - (lookback_days || ' days')::interval
  GROUP BY 1, 2
  HAVING COUNT(*) FILTER (WHERE outcome IS NOT NULL) >= min_resolved
  ORDER BY
    CASE COALESCE(feature_snapshot->>'timing_bucket', 'monitor')
      WHEN 'now'     THEN 1
      WHEN 'monitor' THEN 2
      WHEN 'wait'    THEN 3
      ELSE 4
    END,
    CASE
      WHEN edge_at_prediction < 0.02 THEN 1
      WHEN edge_at_prediction < 0.05 THEN 2
      WHEN edge_at_prediction < 0.08 THEN 3
      ELSE 4
    END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. analytics_stability_edge_quality
-- ─────────────────────────────────────────────────────────────────────────────
-- Does high stability improve edge realization?
CREATE OR REPLACE FUNCTION analytics_stability_edge_quality(
  lookback_days integer DEFAULT 30,
  min_resolved  integer DEFAULT 5
)
RETURNS TABLE (
  stability_bucket text,
  edge_bucket      text,
  resolved_count   bigint,
  win_count        bigint,
  hit_rate_pct     numeric,
  roi_pct          numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    CASE
      WHEN (feature_snapshot->>'stability_score')::numeric >= 0.70 THEN 'high (≥0.70)'
      WHEN (feature_snapshot->>'stability_score')::numeric >= 0.45 THEN 'medium (0.45–0.70)'
      WHEN (feature_snapshot->>'stability_score') IS NOT NULL       THEN 'low (<0.45)'
      ELSE 'unknown'
    END                                                             AS stability_bucket,
    CASE
      WHEN edge_at_prediction < 0.02 THEN '0–2%'
      WHEN edge_at_prediction < 0.05 THEN '2–5%'
      WHEN edge_at_prediction < 0.08 THEN '5–8%'
      ELSE '8%+'
    END                                                             AS edge_bucket,
    COUNT(*) FILTER (WHERE outcome IS NOT NULL)                     AS resolved_count,
    COUNT(*) FILTER (WHERE outcome = 'win')                         AS win_count,
    ROUND(
      COUNT(*) FILTER (WHERE outcome = 'win')::numeric
      / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                            AS hit_rate_pct,
    ROUND(
      SUM(CASE
        WHEN outcome = 'win'  THEN (1.0 / NULLIF((feature_snapshot->>'market_probability_proxy')::numeric, 0)) - 1
        WHEN outcome = 'loss' THEN -1.0
        ELSE 0
      END) / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100
    , 1)                                                            AS roi_pct
  FROM prediction_history
  WHERE predicted_at >= NOW() - (lookback_days || ' days')::interval
    AND (feature_snapshot->>'stability_score') IS NOT NULL
  GROUP BY 1, 2
  HAVING COUNT(*) FILTER (WHERE outcome IS NOT NULL) >= min_resolved
  ORDER BY 1, 2;
$$;
