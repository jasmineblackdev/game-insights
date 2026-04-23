/**
 * Client-side consumer of nightly-fitted Platt calibration parameters.
 *
 * Shape:
 *   p_calibrated = 1 / (1 + exp(A * logit(p_raw) + B))
 *
 * A, B come from platt_calibration_params (filled by the ml-recalibrate
 * edge function). When no params exist for a (sport, market_type,
 * confidence) combination, we fall back to the raw probability — never
 * worse than today.
 *
 * The params table only updates nightly, so this is fetched once per
 * session and cached aggressively.
 */

import { supabase } from "@/lib/supabase";

export interface PlattParam {
  a: number;
  b: number;
  sample_size: number;
  brier: number | null;
}

/** Cache loaded once per page session. Key = "sport|market|conf". */
const cache = new Map<string, PlattParam>();
let loaded = false;
let loadPromise: Promise<void> | null = null;

/** Keys: normalised lowercase for sport/market, uppercase for confidence. */
function paramKey(sport: string, market: string, confidence: string): string {
  return `${sport.toLowerCase()}|${market.toLowerCase()}|${confidence.toUpperCase()}`;
}

/** Load all Platt params once. Safe to call repeatedly; dedupes in-flight. */
export async function loadPlattParams(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  if (!supabase) { loaded = true; return; }

  loadPromise = (async () => {
    try {
      const { data, error } = await supabase
        .from("platt_calibration_params")
        .select("sport, market_type, confidence_bucket, a_param, b_param, sample_size, brier_score");
      if (error || !data) return;
      for (const row of data) {
        cache.set(
          paramKey(row.sport, row.market_type, row.confidence_bucket),
          {
            a:           Number(row.a_param),
            b:           Number(row.b_param),
            sample_size: Number(row.sample_size),
            brier:       row.brier_score != null ? Number(row.brier_score) : null,
          },
        );
      }
    } catch {
      // silent — fall back to raw probs
    } finally {
      loaded = true;
    }
  })();
  return loadPromise;
}

/**
 * Return Platt params for the given (sport, market, confidence), preferring
 * the tight bucket and falling back to the per-sport "ALL" bucket.
 */
export function plattParamsFor(
  sport: string | undefined,
  market: string | undefined,
  confidence: string | undefined,
): PlattParam | null {
  if (!sport || !market) return null;
  const conf = (confidence ?? "ALL").toUpperCase();
  return (
    cache.get(paramKey(sport, market, conf)) ??
    cache.get(paramKey(sport, market, "ALL")) ??
    null
  );
}

/**
 * Applies Platt scaling to a raw probability. Returns the raw probability
 * unchanged when no params are available or the raw is out of [0, 1].
 *
 * Requires params to be loaded via loadPlattParams() first; synchronous.
 */
export function calibrateProbability(
  rawProb: number,
  sport: string | undefined,
  market: string | undefined,
  confidence: string | undefined,
): number {
  if (!Number.isFinite(rawProb)) return rawProb;
  if (rawProb <= 0 || rawProb >= 1) return rawProb;
  const params = plattParamsFor(sport, market, confidence);
  if (!params) return rawProb;
  // Require ≥ 30 samples before we trust the fit
  if (params.sample_size < 30) return rawProb;
  const logit = Math.log(rawProb / (1 - rawProb));
  const z = params.a * logit + params.b;
  return 1 / (1 + Math.exp(z));
}

/** Exposed for testing / dashboards. */
export function plattCacheSize(): number {
  return cache.size;
}
