/**
 * React Query hooks for the five analytics RPCs.
 *
 * All queries use a 10-minute staleTime — analytics data is not real-time.
 * Returns empty arrays when Supabase is unavailable rather than throwing.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

// ── Row types ────────────────────────────────────────────────────────────────

export interface TimingBucketRow {
  timing_bucket:        string;
  total_predictions:    number;
  resolved_predictions: number;
  wins:                 number;
  losses:               number;
  /** null until at least one resolved prediction exists */
  hit_rate_pct:         number | null;
  /** null until at least one resolved prediction exists */
  roi_pct:              number | null;
  avg_edge:             number;
  avg_hit_prob:         number;
}

export interface StabilityRow {
  stability_bucket:    string;
  total:               number;
  win_count:           number;
  hit_rate_pct:        number | null;
  avg_stability_score: number | null;
  avg_edge:            number;
}

export interface ExclusionFrequencyRow {
  exclusion_reason: string;
  exclusion_count:  number;
  pct_of_excluded:  number;
}

export interface SafePoolDepthRow {
  day:              string;  // ISO date
  sport:            string;
  safe_eligible:    number;
  total_candidates: number;
  safe_pct:         number;
}

export interface RecommendedVsExcludedRow {
  is_recommended:  boolean;
  total_matched:   number;
  resolved_count:  number;
  win_count:       number;
  loss_count:      number;
  hit_rate_pct:    number | null;
  roi_pct:         number | null;
  avg_edge:        number;
}

export interface RoiBySportRow {
  sport:            string;
  total_predictions: number;
  resolved_count:   number;
  win_count:        number;
  hit_rate_pct:     number | null;
  roi_pct:          number | null;
  avg_edge:         number;
  avg_hit_prob:     number;
}

export interface RoiByRiskBandRow {
  risk_band:       string;
  total_matched:   number;
  resolved_count:  number;
  win_count:       number;
  hit_rate_pct:    number | null;
  roi_pct:         number | null;
  avg_edge:        number;
}

export interface TimingBySportRow {
  sport:            string;
  timing_bucket:    string;
  total_predictions: number;
  resolved_count:   number;
  win_count:        number;
  hit_rate_pct:     number | null;
  roi_pct:          number | null;
  avg_edge:         number;
}

export interface RecommendedVsExcludedBySportRow {
  sport:           string;
  is_recommended:  boolean;
  total_matched:   number;
  resolved_count:  number;
  win_count:       number;
  hit_rate_pct:    number | null;
  roi_pct:         number | null;
  avg_edge:        number;
}

export interface RoiByMarketTypeRow {
  sport:            string;
  stat_type:        string;
  total_predictions: number;
  resolved_count:   number;
  win_count:        number;
  hit_rate_pct:     number | null;
  roi_pct:          number | null;
  avg_edge:         number;
}

export interface ResolutionCompletenessRow {
  sport:            string;
  total_surfaced:   number;
  resolved_count:   number;
  pending_count:    number;
  resolution_pct:   number;
  stale_pending:    number;
}

export interface ConfidenceCalibrationRow {
  confidence:       string;
  total_predictions: number;
  resolved_count:   number;
  win_count:        number;
  hit_rate_pct:     number | null;
  roi_pct:          number | null;
  avg_edge:         number;
  avg_hit_prob?:    number;
}

export interface ConfidenceCalibrationBySportRow {
  sport:            string;
  confidence:       string;
  total_predictions: number;
  resolved_count:   number;
  win_count:        number;
  hit_rate_pct:     number | null;
  roi_pct:          number | null;
  avg_edge:         number;
}

export interface ConfidenceCalibrationByMarketRow {
  sport:             string;
  stat_type:         string;
  confidence:        string;
  total_predictions: number;
  resolved_count:    number;
  win_count:         number;
  hit_rate_pct:      number | null;
  roi_pct:           number | null;
  avg_edge:          number;
}

export interface ModelContributionRow {
  model_variant:    string;
  resolved_count:   number;
  win_count:        number;
  hit_rate_pct:     number | null;
  roi_pct:          number | null;
  avg_edge:         number;
  avg_timing_score: number;
}

export interface ParlayModelMixRow {
  tier:             string;
  ml_ratio_bucket:  string;
  parlay_count:     number;
  resolved_count:   number;
  hit_rate_pct:     number | null;
  roi_pct:          number | null;
  avg_leg_score:    number;
  avg_timing_score: number;
}

export interface EdgeBucketPerformanceRow {
  sport:          string;
  market_type:    string;
  edge_bucket:    string;
  resolved_count: number;
  win_count:      number;
  hit_rate_pct:   number | null;
  roi_pct:        number | null;
}

export interface TimingEdgeQualityRow {
  timing_bucket:  string;
  edge_bucket:    string;
  resolved_count: number;
  win_count:      number;
  hit_rate_pct:   number | null;
  roi_pct:        number | null;
}

export interface StabilityEdgeQualityRow {
  stability_bucket: string;
  edge_bucket:      string;
  resolved_count:   number;
  win_count:        number;
  hit_rate_pct:     number | null;
  roi_pct:          number | null;
}

export interface CalibrationImpactRow {
  /** "boosted" | "neutral" | "penalized" | "no_data" */
  adj_bucket:     string;
  leg_count:      number;
  parlay_count:   number;
  resolved_count: number;
  win_count:      number;
  hit_rate_pct:   number | null;
  roi_pct:        number | null;
  /** Average conf_cal_adj within the bucket (null for no_data bucket). */
  avg_adj:        number | null;
  avg_edge:       number;
}

export interface CalibrationImpactBySportRow {
  sport:          string;
  adj_bucket:     string;
  leg_count:      number;
  resolved_count: number;
  win_count:      number;
  hit_rate_pct:   number | null;
  roi_pct:        number | null;
  avg_adj:        number | null;
  /** Fraction (0–1) of this sport's total legs with no calibration data. */
  no_data_pct:    number;
}

// ── Fetchers ────────────────────────────────────────────────────────────────

async function rpc<T>(fn: string, params: Record<string, unknown>): Promise<T[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc(fn, params);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return (data as T[]) ?? [];
}

// ── Hooks ────────────────────────────────────────────────────────────────────

const STALE = 10 * 60 * 1000;
const GC    = 30 * 60 * 1000;

export function useTimingPerformance(days = 30) {
  return useQuery({
    queryKey: ["analytics-timing-performance", days],
    queryFn:  () => rpc<TimingBucketRow>("analytics_timing_bucket_performance", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useStabilityVsOutcome(days = 30) {
  return useQuery({
    queryKey: ["analytics-stability-vs-outcome", days],
    queryFn:  () => rpc<StabilityRow>("analytics_stability_vs_outcome", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useExclusionFrequency(days = 30) {
  return useQuery({
    queryKey: ["analytics-exclusion-frequency", days],
    queryFn:  () => rpc<ExclusionFrequencyRow>("analytics_exclusion_frequency", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useSafePoolDepth(days = 30) {
  return useQuery({
    queryKey: ["analytics-safe-pool-depth", days],
    queryFn:  () => rpc<SafePoolDepthRow>("analytics_safe_pool_depth", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useRecommendedVsExcluded(days = 30) {
  return useQuery({
    queryKey: ["analytics-recommended-vs-excluded", days],
    queryFn:  () => rpc<RecommendedVsExcludedRow>("analytics_recommended_vs_excluded", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useRoiBySport(days = 30) {
  return useQuery({
    queryKey: ["analytics-roi-by-sport", days],
    queryFn:  () => rpc<RoiBySportRow>("analytics_roi_by_sport", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useRoiByRiskBand(days = 30) {
  return useQuery({
    queryKey: ["analytics-roi-by-risk-band", days],
    queryFn:  () => rpc<RoiByRiskBandRow>("analytics_roi_by_risk_band", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useTimingBySport(days = 30) {
  return useQuery({
    queryKey: ["analytics-timing-by-sport", days],
    queryFn:  () => rpc<TimingBySportRow>("analytics_timing_by_sport", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useRecommendedVsExcludedBySport(days = 30) {
  return useQuery({
    queryKey: ["analytics-rec-vs-excl-by-sport", days],
    queryFn:  () => rpc<RecommendedVsExcludedBySportRow>("analytics_recommended_vs_excluded_by_sport", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useRoiByMarketType(days = 30) {
  return useQuery({
    queryKey: ["analytics-roi-by-market-type", days],
    queryFn:  () => rpc<RoiByMarketTypeRow>("analytics_roi_by_market_type", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useResolutionCompleteness(days = 30) {
  return useQuery({
    queryKey: ["analytics-resolution-completeness", days],
    queryFn:  () => rpc<ResolutionCompletenessRow>("analytics_resolution_completeness", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useConfidenceCalibration(days = 30) {
  return useQuery({
    queryKey: ["analytics-confidence-calibration", days],
    queryFn:  () => rpc<ConfidenceCalibrationRow>("analytics_confidence_calibration", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useConfidenceCalibrationBySport(days = 30) {
  return useQuery({
    queryKey: ["analytics-confidence-calibration-by-sport", days],
    queryFn:  () => rpc<ConfidenceCalibrationBySportRow>("analytics_confidence_calibration_by_sport", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useConfidenceCalibrationByMarket(days = 30, minResolved = 5) {
  return useQuery({
    queryKey: ["analytics-confidence-calibration-by-market", days, minResolved],
    queryFn:  () => rpc<ConfidenceCalibrationByMarketRow>("analytics_confidence_calibration_by_market", { lookback_days: days, min_resolved: minResolved }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useModelContribution(days = 30) {
  return useQuery({
    queryKey: ["analytics-model-contribution", days],
    queryFn:  () => rpc<ModelContributionRow>("analytics_model_contribution", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useParlayModelMix(days = 30) {
  return useQuery({
    queryKey: ["analytics-parlay-model-mix", days],
    queryFn:  () => rpc<ParlayModelMixRow>("analytics_parlay_model_mix", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useEdgeBucketPerformance(days = 30, minResolved = 5) {
  return useQuery({
    queryKey: ["analytics-edge-bucket-performance", days, minResolved],
    queryFn:  () => rpc<EdgeBucketPerformanceRow>("analytics_edge_bucket_performance", { lookback_days: days, min_resolved: minResolved }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useTimingEdgeQuality(days = 30, minResolved = 5) {
  return useQuery({
    queryKey: ["analytics-timing-edge-quality", days, minResolved],
    queryFn:  () => rpc<TimingEdgeQualityRow>("analytics_timing_edge_quality", { lookback_days: days, min_resolved: minResolved }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useStabilityEdgeQuality(days = 30, minResolved = 5) {
  return useQuery({
    queryKey: ["analytics-stability-edge-quality", days, minResolved],
    queryFn:  () => rpc<StabilityEdgeQualityRow>("analytics_stability_edge_quality", { lookback_days: days, min_resolved: minResolved }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useCalibrationImpact(days = 30) {
  return useQuery({
    queryKey: ["analytics-calibration-impact", days],
    queryFn:  () => rpc<CalibrationImpactRow>("analytics_calibration_impact", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}

export function useCalibrationImpactBySport(days = 30) {
  return useQuery({
    queryKey: ["analytics-calibration-impact-by-sport", days],
    queryFn:  () => rpc<CalibrationImpactBySportRow>("analytics_calibration_impact_by_sport", { lookback_days: days }),
    staleTime: STALE,
    gcTime:    GC,
  });
}
