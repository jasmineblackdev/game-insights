/**
 * ML readiness state for picks. The honest answer to "is this pick
 * really ML-calibrated, or are we just stamping a badge on rules
 * output?"
 *
 * Three states, derived from real measurements:
 *   - "rules"      — fewer than 25 resolved prediction_history samples
 *                    in this (sport × market_type) bucket. Picks are
 *                    pure rules-engine output.
 *   - "learning"   — 25–99 resolved samples. ML is collecting data,
 *                    weights may have nudged, but no Platt params
 *                    yet (or sample_size below the 100 threshold).
 *   - "calibrated" — ≥100 resolved samples AND Platt params are
 *                    actually loaded for the (sport, market) so
 *                    calibrateProbability() does something.
 *
 * The previous `model_status === "ml_active"` badge fired off a
 * heuristic that didn't check whether calibration was actually being
 * applied — this module is the truth source.
 *
 * Usage:
 *   await loadMlReadiness();           // fire on app mount
 *   getMlReadinessSync(sport, market); // sync read from cache
 */

import { supabase } from "@/lib/supabase";
import { plattParamsFor } from "@/lib/ml/plattCalibration";

export type MlReadinessState = "rules" | "learning" | "calibrated";

export interface MlReadinessSample {
  sport: string;
  market_type: string;
  resolved_count: number;
  has_platt: boolean;
  state: MlReadinessState;
}

const LEARNING_MIN  = 25;
const CALIBRATED_MIN = 100;
const CACHE_TTL_MS  = 5 * 60_000;

let cache: Map<string, MlReadinessSample> | null = null;
let loadedAt = 0;
let inflight: Promise<Map<string, MlReadinessSample>> | null = null;

function key(sport: string, marketType: string): string {
  return `${sport.toLowerCase()}|${marketType.toLowerCase()}`;
}

function deriveState(resolved: number, hasPlatt: boolean): MlReadinessState {
  if (resolved >= CALIBRATED_MIN && hasPlatt) return "calibrated";
  if (resolved >= LEARNING_MIN) return "learning";
  return "rules";
}

async function fetchCounts(): Promise<Map<string, MlReadinessSample>> {
  const out = new Map<string, MlReadinessSample>();
  if (!supabase) return out;

  // Aggregate count of resolved rows per (sport, market_type). Postgrest
  // can't group server-side via SDK; we pull a slim projection and count
  // client-side. Capped at 20k rows — generous, fast to scan.
  const { data, error } = await supabase
    .from("prediction_history")
    .select("sport, market_type")
    .in("outcome", ["win", "loss", "push"])
    .limit(20_000);
  if (error || !data) return out;

  const counts = new Map<string, { sport: string; market_type: string; n: number }>();
  for (const r of data as Array<{ sport: string; market_type: string }>) {
    const k = key(r.sport, r.market_type);
    let entry = counts.get(k);
    if (!entry) { entry = { sport: r.sport.toLowerCase(), market_type: r.market_type.toLowerCase(), n: 0 }; counts.set(k, entry); }
    entry.n++;
  }
  for (const [k, v] of counts.entries()) {
    // plattParamsFor returns the cached object loaded by loadPlattParams.
    // hasPlatt = there's *some* fitted params for this (sport, market).
    const hasPlatt = plattParamsFor(v.sport, v.market_type, "ALL") != null;
    out.set(k, {
      sport: v.sport,
      market_type: v.market_type,
      resolved_count: v.n,
      has_platt: hasPlatt,
      state: deriveState(v.n, hasPlatt),
    });
  }
  return out;
}

/** Loads (or returns cached) ML readiness map. 5-min TTL. */
export async function loadMlReadiness(opts?: { force?: boolean }): Promise<Map<string, MlReadinessSample>> {
  if (!opts?.force && cache && Date.now() - loadedAt < CACHE_TTL_MS) return cache;
  if (inflight && !opts?.force) return inflight;
  inflight = fetchCounts().then((m) => {
    cache = m;
    loadedAt = Date.now();
    inflight = null;
    return m;
  });
  return inflight;
}

/**
 * Sync getter — returns the state from the cache, or { state: "rules", count: 0 }
 * when the cache hasn't loaded yet (callers don't need an await; the badge
 * just shows "RULES" until data lands and rerenders).
 */
export function getMlReadinessSync(sport: string, marketType: string): MlReadinessSample {
  const fallback: MlReadinessSample = {
    sport: sport.toLowerCase(),
    market_type: marketType.toLowerCase(),
    resolved_count: 0,
    has_platt: false,
    state: "rules",
  };
  if (!cache) return fallback;
  return cache.get(key(sport, marketType)) ?? fallback;
}

/** Test/debug — clear the cache so the next call refetches. */
export function _resetMlReadinessCache(): void {
  cache = null;
  loadedAt = 0;
  inflight = null;
}
