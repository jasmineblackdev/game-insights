/**
 * Correlation overrides — learned ρ values from the
 * analytics_parlay_pair_correlation RPC.
 *
 * The hard-coded PAIR_RHO table in correlatedParlayProbability.ts
 * carries reasonable defaults derived from research, but every market
 * has its own dynamics — same-team props in NBA correlate harder
 * than in MLB, same-game team picks are tighter in NFL than in
 * basketball, etc. Once enough resolved parlays accumulate, this
 * module learns the actual ρ from outcome data and overrides the
 * defaults bucket-by-bucket.
 *
 * Activation rule: a learned ρ is only used when its bucket has
 * sample_size ≥ MIN_SAMPLE. Below that, the hard-coded fallback
 * stays in effect — random variance dominates small samples.
 *
 * Cache TTL: 30 minutes. The backfit job is nightly; refreshing
 * faster than that just burns network budget.
 */

import { isSupabaseConfigured, supabase } from "@/lib/supabase";

export interface PairCorrelationOverride {
  pairKey: string;
  correlation: number;
  sampleSize: number;
  bothWonRate: number | null;
  bothLostRate: number | null;
}

const MIN_SAMPLE = 30;
const CACHE_TTL_MS = 30 * 60 * 1000;

let overrides: Map<string, PairCorrelationOverride> | null = null;
let lastFetched = 0;
let inflight: Promise<boolean> | null = null;

/**
 * Refresh the overrides cache. Idempotent — returns immediately when
 * the cache is fresh enough. Coalesces concurrent calls so a render
 * burst doesn't fan out N RPCs.
 */
export async function refreshCorrelationOverrides(): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  const now = Date.now();
  if (overrides && now - lastFetched < CACHE_TTL_MS) return true;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { data, error } = await supabase.rpc("analytics_parlay_pair_correlation");
      if (error || !data) {
        // Mark as fetched even on failure so we don't spam retries.
        // Next refresh attempt waits the full TTL.
        overrides = overrides ?? new Map();
        lastFetched = now;
        return false;
      }
      const next = new Map<string, PairCorrelationOverride>();
      for (const row of data as Array<{
        pair_key: string;
        correlation_score: number | null;
        sample_size: number;
        both_won_rate: number | null;
        both_lost_rate: number | null;
      }>) {
        if (!row.pair_key) continue;
        if (row.correlation_score == null) continue;
        next.set(row.pair_key, {
          pairKey:      row.pair_key,
          correlation:  row.correlation_score,
          sampleSize:   row.sample_size,
          bothWonRate:  row.both_won_rate,
          bothLostRate: row.both_lost_rate,
        });
      }
      overrides = next;
      lastFetched = now;
      return true;
    } catch {
      overrides = overrides ?? new Map();
      lastFetched = now;
      return false;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Look up a learned ρ override for a pair key. Returns null when no
 * sufficient sample exists yet — caller falls through to PAIR_RHO.
 *
 * Synchronous — assumes refreshCorrelationOverrides() has been
 * called at least once. If it hasn't, returns null.
 */
export function getCorrelationOverride(pairKey: string): number | null {
  if (!overrides) return null;
  const row = overrides.get(pairKey);
  if (!row) return null;
  if (row.sampleSize < MIN_SAMPLE) return null;
  if (!Number.isFinite(row.correlation)) return null;
  return row.correlation;
}

/** All overrides — useful for dashboards / debugging. */
export function listCorrelationOverrides(): PairCorrelationOverride[] {
  if (!overrides) return [];
  return [...overrides.values()];
}

/** Test/debug — clear the cache so the next call refetches. */
export function _clearCorrelationOverridesCache(): void {
  overrides = null;
  lastFetched = 0;
}

export { MIN_SAMPLE as CORRELATION_MIN_SAMPLE };
