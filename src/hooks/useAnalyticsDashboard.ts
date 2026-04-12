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
