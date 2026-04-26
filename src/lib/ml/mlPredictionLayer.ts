/**
 * ML Prediction Layer — bucket-based hit-probability lookup.
 *
 * Approach:
 *   1. Each resolved bet gets bucketed by (sport, bet_type, market,
 *      confidence). The Supabase RPC analytics_ml_hit_rate_by_bucket
 *      computes the observed hit rate per bucket.
 *   2. A bucket is "active" once resolved_count ≥ 25. Below that
 *      threshold we don't trust the rate and fall back to the rules
 *      engine's projection.
 *   3. For an active bucket, the bucket hit_rate is the BASE prior.
 *      We then blend it with the rules engine's per-leg score and
 *      apply Platt calibration (already in plattCalibration.ts).
 *
 * Why bucket lookup instead of full logistic regression on the
 * client: the feature space is small (sport × bet_type × market ×
 * confidence ≈ 100 buckets), and we don't have enough training data
 * yet to support coefficient fits with a meaningful signal-to-noise
 * ratio. Bucket lookup is robust at low sample counts and matches
 * how Platt scaling is already wired downstream.
 */

import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { calibrateProbability } from "@/lib/ml/plattCalibration";

export interface MlBucketStats {
  sport: string;
  betType: string;
  market: string;
  confidence: string;
  resolvedCount: number;
  winCount: number;
  lossCount: number;
  pushCount: number;
  hitRate: number | null;
  active: boolean;
}

const BUCKET_KEY = (sport: string, betType: string, market: string, confidence: string): string =>
  `${sport.toUpperCase()}|${betType}|${market}|${confidence}`;

let bucketCache: Map<string, MlBucketStats> | null = null;
let lastFetched = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Refresh the bucket cache from Supabase. Idempotent — returns
 * immediately when the cache is fresh enough. Fire-and-forget; the
 * sync getter falls back to nulls when the cache hasn't populated.
 */
export async function refreshMlBuckets(): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  const now = Date.now();
  if (bucketCache && now - lastFetched < CACHE_TTL_MS) return true;
  try {
    const { data, error } = await supabase.rpc("analytics_ml_hit_rate_by_bucket");
    if (error || !data) return false;
    const next = new Map<string, MlBucketStats>();
    for (const row of data as Array<{
      sport: string;
      bet_type: string;
      market: string;
      confidence: string;
      resolved_count: number;
      win_count: number;
      loss_count: number;
      push_count: number;
      hit_rate: number | null;
      active: boolean;
    }>) {
      const stats: MlBucketStats = {
        sport:         row.sport,
        betType:       row.bet_type,
        market:        row.market,
        confidence:    row.confidence,
        resolvedCount: row.resolved_count,
        winCount:      row.win_count,
        lossCount:     row.loss_count,
        pushCount:     row.push_count,
        hitRate:       row.hit_rate,
        active:        row.active,
      };
      next.set(BUCKET_KEY(stats.sport, stats.betType, stats.market, stats.confidence), stats);
    }
    bucketCache = next;
    lastFetched = now;
    return true;
  } catch {
    return false;
  }
}

/**
 * Look up the bucket stats for a (sport, bet_type, market, confidence)
 * combination. Returns null when the bucket has no resolved samples
 * yet or the cache hasn't populated. Falls back to the (any)-market
 * row when an exact match isn't found.
 */
export function getBucketStats(
  sport: string | undefined,
  betType: string | undefined,
  market: string | undefined,
  confidence: string | undefined,
): MlBucketStats | null {
  if (!bucketCache || !sport || !betType) return null;
  const conf = confidence ?? "unknown";
  // Try exact match first.
  if (market) {
    const exact = bucketCache.get(BUCKET_KEY(sport, betType, market, conf));
    if (exact) return exact;
  }
  // Fall back to "(any)" market — the RPC emits this when a bet_type
  // has no market discriminator (team picks).
  const any = bucketCache.get(BUCKET_KEY(sport, betType, "(any)", conf));
  if (any) return any;
  return null;
}

/**
 * Predict a hit probability for a single pick. Returns null when the
 * bucket isn't active, signaling callers to fall back to the rules
 * engine. When active, the returned value is:
 *
 *   1. Bucket hit_rate (observed win rate at this bucket)
 *   2. Blended 60/40 with the rules-engine raw probability so a
 *      hot bucket doesn't override a strong rules signal entirely
 *   3. Platt-calibrated using existing per-(sport, market, confidence)
 *      params (loaded async by syncPlattParamsFromSupabase)
 */
export function predictHitProbability(args: {
  sport: string | undefined;
  betType: string | undefined;
  market: string | undefined;
  confidence: string | undefined;
  rulesProbability: number;
}): { hitProbability: number; bucket: MlBucketStats; sampleSize: number } | null {
  const stats = getBucketStats(args.sport, args.betType, args.market, args.confidence);
  if (!stats || !stats.active || stats.hitRate == null) return null;

  // 60% bucket prior, 40% rules signal — keeps both honest.
  const blended = stats.hitRate * 0.6 + args.rulesProbability * 0.4;
  const calibrated = calibrateProbability(
    Math.max(0.02, Math.min(0.98, blended)),
    args.sport,
    args.market,
    args.confidence,
  );
  return {
    hitProbability: Math.round(calibrated * 1000) / 1000,
    bucket: stats,
    sampleSize: stats.resolvedCount,
  };
}

/** Convenience boolean for activation gates. */
export function isBucketActive(stats: MlBucketStats | null): boolean {
  return !!stats?.active;
}

/** Test/debug — clear cache so the next call refetches. */
export function _clearBucketCache(): void {
  bucketCache = null;
  lastFetched = 0;
}
