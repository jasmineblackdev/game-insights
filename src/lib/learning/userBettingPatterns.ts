/**
 * User betting pattern coach.
 *
 * Reads settled rows from prediction_history (the bridged learning
 * table — see parlayLegBridge.ts) and aggregates them into per-bucket
 * win rates. A "strong bucket" is one where the user has hit ≥58%
 * over ≥10 settled samples in a (sport, market_type, odds_range)
 * combo.
 *
 * The value-score path imports patternBoostForLeg() and adds the
 * returned multiplier to the raw score so the next pick the engine
 * surfaces is biased toward buckets where the user has demonstrated
 * profitability — explicitly turning bet history into selection
 * pressure.
 *
 * Cached per-session: loaded once on first call, refreshed when the
 * caller passes { force: true }.
 */

import { supabase } from "@/lib/supabase";

export type OddsRange =
  | "heavy_favorite"  // ≤ -250
  | "favorite"        // -250 to -150
  | "pick_em_fav"     // -150 to -110
  | "pick_em_dog"     // -110 to +150
  | "underdog"        // +150 to +250
  | "longshot"        // > +250
  | "unknown";

export interface UserPatternBucket {
  sport: string;
  market_type: string;
  odds_range: OddsRange;
  wins: number;
  losses: number;
  pushes: number;
  total_settled: number;
  win_rate: number;
  /** True when total_settled >= MIN_SAMPLES and win_rate >= STRONG_THRESHOLD. */
  is_strong: boolean;
}

export interface UserPatternMap {
  buckets: Map<string, UserPatternBucket>;
  loaded_at: number;
  total_samples: number;
}

const MIN_SAMPLES       = 10;
const STRONG_THRESHOLD  = 0.58;
const DEFAULT_WINDOW_DAYS = 180;
const MAX_BOOST           = 0.05;

export function oddsRange(american: number | null | undefined): OddsRange {
  if (american == null || !Number.isFinite(american)) return "unknown";
  if (american <= -250) return "heavy_favorite";
  if (american <= -150) return "favorite";
  if (american <= -110) return "pick_em_fav";
  if (american < 150)   return "pick_em_dog";
  if (american < 250)   return "underdog";
  return "longshot";
}

export function bucketKey(sport: string, marketType: string, range: OddsRange): string {
  return `${sport.toLowerCase()}|${marketType}|${range}`;
}

let _cached: UserPatternMap | null = null;
let _inflight: Promise<UserPatternMap> | null = null;

async function fetchAndAggregate(windowDays: number): Promise<UserPatternMap> {
  if (!supabase) {
    return { buckets: new Map(), loaded_at: Date.now(), total_samples: 0 };
  }
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from("prediction_history")
    .select("sport, market_type, american_odds, outcome")
    .gte("settled_at", since)
    .in("outcome", ["win", "loss", "push"])
    .limit(10_000);

  if (error || !data) {
    return { buckets: new Map(), loaded_at: Date.now(), total_samples: 0 };
  }

  const tmp = new Map<string, { wins: number; losses: number; pushes: number; sport: string; market_type: string; odds_range: OddsRange }>();
  for (const r of data as Array<{ sport: string; market_type: string; american_odds: number | null; outcome: "win" | "loss" | "push" }>) {
    const sport = String(r.sport).toLowerCase();
    const market = String(r.market_type);
    const range = oddsRange(r.american_odds);
    const key = bucketKey(sport, market, range);
    let entry = tmp.get(key);
    if (!entry) {
      entry = { wins: 0, losses: 0, pushes: 0, sport, market_type: market, odds_range: range };
      tmp.set(key, entry);
    }
    if (r.outcome === "win")       entry.wins++;
    else if (r.outcome === "loss") entry.losses++;
    else if (r.outcome === "push") entry.pushes++;
  }

  const buckets = new Map<string, UserPatternBucket>();
  for (const [key, e] of tmp.entries()) {
    const settled = e.wins + e.losses + e.pushes;
    const decided = e.wins + e.losses;
    const winRate = decided > 0 ? e.wins / decided : 0;
    buckets.set(key, {
      sport: e.sport,
      market_type: e.market_type,
      odds_range: e.odds_range,
      wins: e.wins,
      losses: e.losses,
      pushes: e.pushes,
      total_settled: settled,
      win_rate: Math.round(winRate * 1000) / 1000,
      is_strong: settled >= MIN_SAMPLES && winRate >= STRONG_THRESHOLD,
    });
  }

  return { buckets, loaded_at: Date.now(), total_samples: data.length };
}

/**
 * Loads (or returns cached) user pattern aggregation. Pass force=true
 * after a new parlay settles to refresh.
 */
export async function loadUserBettingPatterns(opts?: {
  force?: boolean;
  windowDays?: number;
}): Promise<UserPatternMap> {
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  if (!opts?.force && _cached && Date.now() - _cached.loaded_at < 5 * 60 * 1000) {
    return _cached;
  }
  if (_inflight && !opts?.force) return _inflight;
  _inflight = fetchAndAggregate(windowDays).then((m) => {
    _cached = m;
    _inflight = null;
    return m;
  });
  return _inflight;
}

/**
 * Pattern boost for a single leg. Returns a value in [0, MAX_BOOST]
 * that callers add to the raw value score before clamping. Bucket key
 * + bucket are returned so callers can surface "matches your X bucket"
 * tooltips.
 */
export function patternBoostForLeg(
  patterns: UserPatternMap,
  leg: { sport: string; marketType: string; americanOdds: number | null | undefined },
): { boost: number; bucketKey: string; bucket: UserPatternBucket | null } {
  const range = oddsRange(leg.americanOdds);
  const key = bucketKey(leg.sport, leg.marketType, range);
  const bucket = patterns.buckets.get(key) ?? null;
  if (!bucket || !bucket.is_strong) return { boost: 0, bucketKey: key, bucket };
  // Linear ramp from 58% (boost 0) to 75% (boost MAX_BOOST). Caps at
  // MAX_BOOST above 75% so a single hot streak in a 10-sample bucket
  // doesn't drown out other signals.
  const above = Math.max(0, bucket.win_rate - STRONG_THRESHOLD);
  const ramp = Math.min(1, above / (0.75 - STRONG_THRESHOLD));
  const boost = Math.round(ramp * MAX_BOOST * 1000) / 1000;
  return { boost, bucketKey: key, bucket };
}

/**
 * Sync convenience for value-score call sites: returns the boost
 * (0–MAX_BOOST) for a leg using the cached patterns. Returns 0 when
 * the cache hasn't loaded yet — callers don't need an await.
 */
export function computePatternBoostSync(leg: {
  sport: string;
  marketType: string;
  americanOdds: number | null | undefined;
}): number {
  const cached = _cached;
  if (!cached) return 0;
  return patternBoostForLeg(cached, leg).boost;
}

/** Sorted strongest-first list of strong buckets — for UI display. */
export function strongBuckets(patterns: UserPatternMap): UserPatternBucket[] {
  return [...patterns.buckets.values()]
    .filter((b) => b.is_strong)
    .sort((a, b) => b.win_rate - a.win_rate || b.total_settled - a.total_settled);
}

/**
 * Synchronous accessor for callers that can't await — returns null
 * until loadUserBettingPatterns() has resolved at least once. The
 * idea: the page that renders picks fires loadUserBettingPatterns()
 * on mount, then computeValueScore call sites read this and pass
 * the boost through synchronously without per-leg awaits.
 */
export function getCachedPatterns(): UserPatternMap | null {
  return _cached;
}

/** Test/debug — clear the in-process cache. */
export function _resetUserPatternCache(): void {
  _cached = null;
  _inflight = null;
}
