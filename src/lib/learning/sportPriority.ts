/**
 * Sport Priority Engine — picks which sports get bet first based on
 * recent rolling performance. Foundation for Pro Mode's daily decision
 * pipeline.
 *
 * Reads settled prediction_history rows from the last N days, computes
 * an Empirical-Bayes shrunk win rate per sport, and assigns each sport
 * a priority tier:
 *
 *   topSport       single sport with the highest shrunk win rate (≥ 25 samples)
 *   secondarySport second-best (≥ 15 samples)
 *   hotSports      all sports w/ shrunk win rate ≥ HOT_THRESHOLD (0.55)
 *   coldSports     all sports w/ shrunk win rate ≤ COLD_THRESHOLD (0.45)
 *   avoidSports    all sports w/ shrunk win rate ≤ AVOID_THRESHOLD (0.40)
 *                  AND ≥ 25 samples (so we only bench sports we've
 *                  measured enough of to trust the bad signal)
 *
 * The sample-size shrinkage matches the pattern coach (k=15 toward
 * 0.5). 2/2 in WNBA doesn't make WNBA the topSport.
 */

import { supabase } from "@/lib/supabase";

export type SportPriorityTier = "top" | "secondary" | "hot" | "neutral" | "cold" | "avoid";

export interface SportPriorityEntry {
  sport: string;
  wins: number;
  losses: number;
  total: number;
  raw_win_rate: number;
  shrunk_win_rate: number;
  tier: SportPriorityTier;
}

export interface SportPriorityMap {
  bySport: Map<string, SportPriorityEntry>;
  topSport: string | null;
  secondarySport: string | null;
  hotSports: string[];
  coldSports: string[];
  avoidSports: string[];
  loaded_at: number;
}

const HOT_THRESHOLD     = 0.55;
const COLD_THRESHOLD    = 0.45;
const AVOID_THRESHOLD   = 0.40;
const MIN_SAMPLES_TOP   = 25;
const MIN_SAMPLES_SECONDARY = 15;
const MIN_SAMPLES_AVOID = 25;
const SHRINK_K          = 15;
const DEFAULT_WINDOW_DAYS = 30;
const CACHE_TTL_MS      = 5 * 60_000;

function shrinkWinRate(wins: number, decided: number): number {
  return (wins + SHRINK_K * 0.5) / (decided + SHRINK_K);
}

let cache: SportPriorityMap | null = null;
let inflight: Promise<SportPriorityMap> | null = null;

function emptyMap(): SportPriorityMap {
  return {
    bySport: new Map(),
    topSport: null,
    secondarySport: null,
    hotSports: [],
    coldSports: [],
    avoidSports: [],
    loaded_at: Date.now(),
  };
}

function deriveTier(entry: Omit<SportPriorityEntry, "tier">, isTop: boolean, isSecondary: boolean): SportPriorityTier {
  if (isTop) return "top";
  if (isSecondary) return "secondary";
  if (entry.total >= MIN_SAMPLES_AVOID && entry.shrunk_win_rate <= AVOID_THRESHOLD) return "avoid";
  if (entry.shrunk_win_rate <= COLD_THRESHOLD) return "cold";
  if (entry.shrunk_win_rate >= HOT_THRESHOLD) return "hot";
  return "neutral";
}

async function fetchAndAggregate(windowDays: number): Promise<SportPriorityMap> {
  if (!supabase) return emptyMap();
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from("prediction_history")
    .select("sport, outcome")
    .gte("settled_at", since)
    .in("outcome", ["win", "loss", "push"])
    .limit(20_000);
  if (error || !data) return emptyMap();

  const counts = new Map<string, { wins: number; losses: number; pushes: number }>();
  for (const r of data as Array<{ sport: string; outcome: "win" | "loss" | "push" }>) {
    const sport = String(r.sport).toLowerCase();
    let entry = counts.get(sport);
    if (!entry) { entry = { wins: 0, losses: 0, pushes: 0 }; counts.set(sport, entry); }
    if (r.outcome === "win")       entry.wins++;
    else if (r.outcome === "loss") entry.losses++;
    else                            entry.pushes++;
  }

  // Build entries (without tier yet) so we can pick top/secondary first.
  const entries: Array<Omit<SportPriorityEntry, "tier">> = [];
  for (const [sport, c] of counts.entries()) {
    const decided = c.wins + c.losses;
    const total = decided + c.pushes;
    const raw = decided ? c.wins / decided : 0;
    const shrunk = shrinkWinRate(c.wins, decided);
    entries.push({
      sport,
      wins: c.wins,
      losses: c.losses,
      total,
      raw_win_rate: Math.round(raw * 1000) / 1000,
      shrunk_win_rate: Math.round(shrunk * 1000) / 1000,
    });
  }

  // Sort by shrunk win rate desc to identify top + secondary.
  const sorted = [...entries].sort((a, b) => b.shrunk_win_rate - a.shrunk_win_rate);
  const top = sorted.find((e) => e.total >= MIN_SAMPLES_TOP) ?? null;
  const secondary = top
    ? sorted.find((e) => e !== top && e.total >= MIN_SAMPLES_SECONDARY) ?? null
    : null;

  const bySport = new Map<string, SportPriorityEntry>();
  const hotSports: string[] = [];
  const coldSports: string[] = [];
  const avoidSports: string[] = [];

  for (const e of entries) {
    const tier = deriveTier(e, e === top, e === secondary);
    bySport.set(e.sport, { ...e, tier });
    if (tier === "hot")   hotSports.push(e.sport);
    if (tier === "cold")  coldSports.push(e.sport);
    if (tier === "avoid") avoidSports.push(e.sport);
  }

  return {
    bySport,
    topSport: top?.sport ?? null,
    secondarySport: secondary?.sport ?? null,
    hotSports,
    coldSports,
    avoidSports,
    loaded_at: Date.now(),
  };
}

export async function loadSportPriority(opts?: { force?: boolean; windowDays?: number }): Promise<SportPriorityMap> {
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  if (!opts?.force && cache && Date.now() - cache.loaded_at < CACHE_TTL_MS) return cache;
  if (inflight && !opts?.force) return inflight;
  inflight = fetchAndAggregate(windowDays).then((m) => {
    cache = m;
    inflight = null;
    return m;
  });
  return inflight;
}

export function getCachedSportPriority(): SportPriorityMap | null {
  return cache;
}

/**
 * Sync helper for filter pipelines: should this sport be excluded
 * from disciplined surfaces? Returns true when the cache flags it
 * as `avoid`. Returns false when the cache hasn't loaded yet — we
 * default to permissive (don't surprise the user with empty surfaces
 * before data lands).
 */
export function isSportAvoided(sport: string): boolean {
  if (!cache) return false;
  return cache.bySport.get(sport.toLowerCase())?.tier === "avoid";
}

/** Test/debug — clear the cache so the next call refetches. */
export function _resetSportPriorityCache(): void {
  cache = null;
  inflight = null;
}
