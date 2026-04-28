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

/** "home" / "away" / "any" — "any" means the bucket sums across both. */
export type HomeAwayDim = "home" | "away" | "any";

export interface UserPatternBucket {
  sport: string;
  market_type: string;
  odds_range: OddsRange;
  /** "any" buckets aggregate across home and away — coarse fallback. */
  home_away: HomeAwayDim;
  wins: number;
  losses: number;
  pushes: number;
  total_settled: number;
  /** Raw observed win rate (wins / decided). */
  win_rate: number;
  /**
   * Empirical-Bayes shrunk win rate. Pulls small samples toward 50%:
   *   shrunk = (wins + k*0.5) / (decided + k)   with k = SHRINKAGE_K
   * 2/2 reads as 0.56, not 1.00. Used for is_strong / is_cold.
   */
  shrunk_win_rate: number;
  /** True when total_settled >= MIN_SAMPLES and shrunk_win_rate >= STRONG_THRESHOLD. */
  is_strong: boolean;
  /** True when total_settled >= MIN_SAMPLES and shrunk_win_rate <= COLD_THRESHOLD. */
  is_cold: boolean;
}

export interface UserPatternMap {
  buckets: Map<string, UserPatternBucket>;
  loaded_at: number;
  total_samples: number;
}

const MIN_SAMPLES       = 10;
const STRONG_THRESHOLD  = 0.58;
const COLD_THRESHOLD    = 0.42;
const DEFAULT_WINDOW_DAYS = 180;
const MAX_BOOST           = 0.05;
const MAX_PENALTY         = 0.05;
/** Empirical-Bayes shrinkage strength — pulls small-sample win rates
 *  toward the 50% prior. Larger k = more skepticism. */
const SHRINKAGE_K         = 15;

function shrinkWinRate(wins: number, decided: number): number {
  return (wins + SHRINKAGE_K * 0.5) / (decided + SHRINKAGE_K);
}

export function oddsRange(american: number | null | undefined): OddsRange {
  if (american == null || !Number.isFinite(american)) return "unknown";
  if (american <= -250) return "heavy_favorite";
  if (american <= -150) return "favorite";
  if (american <= -110) return "pick_em_fav";
  if (american < 150)   return "pick_em_dog";
  if (american < 250)   return "underdog";
  return "longshot";
}

export function bucketKey(sport: string, marketType: string, range: OddsRange, homeAway: HomeAwayDim = "any"): string {
  return `${sport.toLowerCase()}|${marketType}|${range}|${homeAway}`;
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
    .select("sport, market_type, american_odds, outcome, extra")
    .gte("settled_at", since)
    .in("outcome", ["win", "loss", "push"])
    .limit(10_000);

  if (error || !data) {
    return { buckets: new Map(), loaded_at: Date.now(), total_samples: 0 };
  }

  type Acc = { wins: number; losses: number; pushes: number; sport: string; market_type: string; odds_range: OddsRange; home_away: HomeAwayDim };
  const tmp = new Map<string, Acc>();
  const bump = (key: string, base: Omit<Acc, "wins"|"losses"|"pushes">, outcome: "win"|"loss"|"push") => {
    let entry = tmp.get(key);
    if (!entry) {
      entry = { wins: 0, losses: 0, pushes: 0, ...base };
      tmp.set(key, entry);
    }
    if (outcome === "win")       entry.wins++;
    else if (outcome === "loss") entry.losses++;
    else if (outcome === "push") entry.pushes++;
  };

  for (const r of data as Array<{ sport: string; market_type: string; american_odds: number | null; outcome: "win" | "loss" | "push"; extra: Record<string, unknown> | null }>) {
    const sport = String(r.sport).toLowerCase();
    const market = String(r.market_type);
    const range = oddsRange(r.american_odds);
    const isHomeRaw = r.extra?.is_home;
    const homeAway: HomeAwayDim | null = isHomeRaw === true ? "home" : isHomeRaw === false ? "away" : null;

    // Coarse bucket — always counted ("any" home/away).
    bump(bucketKey(sport, market, range, "any"), { sport, market_type: market, odds_range: range, home_away: "any" }, r.outcome);
    // Fine bucket — only when is_home is known. Old rows without
    // context don't pollute the home/away breakdown.
    if (homeAway) {
      bump(bucketKey(sport, market, range, homeAway), { sport, market_type: market, odds_range: range, home_away: homeAway }, r.outcome);
    }
  }

  const buckets = new Map<string, UserPatternBucket>();
  for (const [key, e] of tmp.entries()) {
    const settled = e.wins + e.losses + e.pushes;
    const decided = e.wins + e.losses;
    const winRate = decided > 0 ? e.wins / decided : 0;
    const shrunk = shrinkWinRate(e.wins, decided);
    buckets.set(key, {
      sport: e.sport,
      market_type: e.market_type,
      odds_range: e.odds_range,
      home_away: e.home_away,
      wins: e.wins,
      losses: e.losses,
      pushes: e.pushes,
      total_settled: settled,
      win_rate: Math.round(winRate * 1000) / 1000,
      shrunk_win_rate: Math.round(shrunk * 1000) / 1000,
      is_strong: settled >= MIN_SAMPLES && shrunk >= STRONG_THRESHOLD,
      is_cold:   settled >= MIN_SAMPLES && shrunk <= COLD_THRESHOLD,
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
 * Pattern boost for a single leg. Returns a value in
 * [-MAX_PENALTY, +MAX_BOOST] that callers add to the raw value score
 * before clamping. Bucket key + bucket are returned so callers can
 * surface "matches your X bucket" / "cold bucket — penalized" hints.
 *
 * Hot bucket  (shrunk_win_rate ≥ STRONG_THRESHOLD): linear ramp from
 *   0 at 0.58 → +MAX_BOOST at 0.75
 * Cold bucket (shrunk_win_rate ≤ COLD_THRESHOLD): linear ramp from
 *   0 at 0.42 → -MAX_PENALTY at 0.25
 *
 * Both gates require ≥ MIN_SAMPLES settled rows AFTER Empirical-Bayes
 * shrinkage, so a 2/2 streak doesn't trigger a +5% boost (shrunk
 * win rate is ~0.56, below the 0.58 threshold).
 *
 * When isHome is supplied, looks up the fine (sport × market × range
 * × home/away) bucket first. Falls back to the coarse (any home/away)
 * bucket when the fine bucket isn't conclusive yet.
 */
export function patternBoostForLeg(
  patterns: UserPatternMap,
  leg: { sport: string; marketType: string; americanOdds: number | null | undefined; isHome?: boolean | null },
): { boost: number; bucketKey: string; bucket: UserPatternBucket | null } {
  const range = oddsRange(leg.americanOdds);
  const homeAway: HomeAwayDim | null = leg.isHome === true ? "home" : leg.isHome === false ? "away" : null;
  const candidates: HomeAwayDim[] = homeAway ? [homeAway, "any"] : ["any"];

  for (const ha of candidates) {
    const key = bucketKey(leg.sport, leg.marketType, range, ha);
    const bucket = patterns.buckets.get(key);
    if (!bucket) continue;

    if (bucket.is_strong) {
      const above = Math.max(0, bucket.shrunk_win_rate - STRONG_THRESHOLD);
      const ramp = Math.min(1, above / (0.75 - STRONG_THRESHOLD));
      const boost = Math.round(ramp * MAX_BOOST * 1000) / 1000;
      return { boost, bucketKey: key, bucket };
    }
    if (bucket.is_cold) {
      const below = Math.max(0, COLD_THRESHOLD - bucket.shrunk_win_rate);
      const ramp = Math.min(1, below / (COLD_THRESHOLD - 0.25));
      const penalty = Math.round(ramp * MAX_PENALTY * 1000) / 1000;
      return { boost: -penalty, bucketKey: key, bucket };
    }
    // Bucket exists but neither hot nor cold — keep looking through fallback chain.
  }
  return { boost: 0, bucketKey: bucketKey(leg.sport, leg.marketType, range, "any"), bucket: null };
}

/**
 * Sync convenience for value-score call sites: returns the boost
 * (0–MAX_BOOST) for a leg using the cached patterns. Returns 0 when
 * the cache hasn't loaded yet — callers don't need an await. Pass
 * isHome when the call site knows it (team_moneyline / spread); the
 * lookup falls back to coarse-bucket if the fine bucket isn't strong.
 */
export function computePatternBoostSync(leg: {
  sport: string;
  marketType: string;
  americanOdds: number | null | undefined;
  isHome?: boolean | null;
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
