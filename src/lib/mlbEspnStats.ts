/**
 * MLB Pitcher Stats — ESPN Athlete API
 *
 * Fetches ERA, WHIP, K/9 and sample-size (IP) for a given athlete.
 * Used by the MLB prediction model to score starting pitcher quality.
 *
 * API: site.api.espn.com/apis/site/v2/sports/baseball/mlb/athletes/{id}/stats
 * Applies a 4-second AbortController so it never blocks the prediction pipeline.
 */

const ATHLETE_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/athletes";

export interface PitcherStats {
  athleteId: string;
  era: number | null;
  whip: number | null;
  k9: number | null;    // Strikeouts per 9 IP
  bb9: number | null;   // Walks per 9 IP — command quality signal
  hr9: number | null;   // Home runs allowed per 9 IP — power-suppression signal
  kbb: number | null;   // K/BB ratio — compound command indicator (higher = sharper)
  ip: number | null;    // Innings pitched (sample-size guard)
}

type RawStat = { name?: string; value?: number; displayValue?: string };

function findStat(stats: RawStat[] | undefined, ...names: string[]): number | null {
  for (const n of names) {
    const entry = stats?.find((s) => s.name?.toLowerCase() === n.toLowerCase());
    const v = entry?.value;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

export async function fetchPitcherStats(athleteId: string): Promise<PitcherStats> {
  const url = `${ATHLETE_BASE}/${athleteId}/stats`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { athleteId, era: null, whip: null, k9: null, bb9: null, hr9: null, kbb: null, ip: null };

    const json = (await res.json()) as {
      splits?: {
        categories?: { name?: string; stats?: RawStat[] }[];
      };
    };

    const cats = json.splits?.categories ?? [];
    const pitching = cats.find((c) => /pitch/i.test(c.name ?? ""));
    const stats = pitching?.stats;

    const era  = findStat(stats, "ERA", "earnedRunAverage");
    const whip = findStat(stats, "WHIP");
    const ip   = findStat(stats, "inningsPitched", "IP");
    const k9   = findStat(stats, "strikeoutsPerNineInnings", "K/9", "kPer9");
    const bb9  = findStat(stats, "walksPerNineInnings", "BB/9", "bbPer9", "walksAllowed");
    const hr9  = findStat(stats, "homeRunsPerNineInnings", "HR/9", "hrPer9");
    const kbb  = k9 != null && bb9 != null && bb9 > 0 ? Math.round((k9 / bb9) * 100) / 100 : null;

    return { athleteId, era, whip, k9, bb9, hr9, kbb, ip };
  } catch {
    clearTimeout(timer);
    return { athleteId, era: null, whip: null, k9: null, bb9: null, hr9: null, kbb: null, ip: null };
  }
}

/**
 * Fetches the number of rest days since the pitcher's last appearance.
 * Uses the ESPN athlete gamelog endpoint to find the most recent game date.
 * Returns null on API failure or when no appearances found.
 *
 * Short rest (<3 days): ERA typically rises ~0.8 runs/game.
 * Long rest (5+ days): Small bonus (~-0.15 ERA effective).
 */
export async function fetchPitcherRestDays(athleteId: string): Promise<number | null> {
  const url = `${ATHLETE_BASE}/${athleteId}/gamelog`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const json = (await res.json()) as {
      events?: Record<string, { date?: string; atVs?: string }>;
    };
    // events is a map of eventId → event object
    const events = json.events ? Object.values(json.events) : [];
    const dates = events
      .map((e) => e.date)
      .filter((d): d is string => !!d)
      .map((d) => new Date(d).getTime())
      .filter((t) => !Number.isNaN(t))
      .sort((a, b) => b - a); // descending

    if (!dates.length) return null;
    const lastMs = dates[0];
    const restDays = Math.floor((Date.now() - lastMs) / 86_400_000);
    // Sanity guard: ignore stale data (>30 days = off-season or injured list gap)
    return restDays >= 0 && restDays <= 30 ? restDays : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Fetches pitcher stats for both starters in parallel.
 * Returns null when the athlete ID is unavailable (pitcher not confirmed).
 */
export async function fetchMatchupPitcherStats(
  homeAthleteId: string | undefined,
  awayAthleteId: string | undefined
): Promise<{ home: PitcherStats | null; away: PitcherStats | null }> {
  const [home, away] = await Promise.all([
    homeAthleteId ? fetchPitcherStats(homeAthleteId) : Promise.resolve(null),
    awayAthleteId ? fetchPitcherStats(awayAthleteId) : Promise.resolve(null),
  ]);
  return { home, away };
}

/** In-memory cache for one page load — avoids duplicate search calls per pitcher. */
const mlbAthleteSearchCache = new Map<string, string | undefined>();

/**
 * Resolve ESPN MLB athlete id from display name when probables came from MLB Stats API
 * (no ESPN athlete id on the scoreboard yet). Uses ESPN site search.
 */
export async function resolveEspnMlbAthleteIdByDisplayName(displayName: string): Promise<string | undefined> {
  const q = displayName.trim();
  if (!q) return undefined;
  const key = q.toLowerCase();
  if (mlbAthleteSearchCache.has(key)) return mlbAthleteSearchCache.get(key);

  const url = `https://site.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(q)}&limit=12`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      mlbAthleteSearchCache.set(key, undefined);
      return undefined;
    }
    const json = (await res.json()) as {
      results?: { type?: string; athletes?: { id?: string; league?: { abbreviation?: string } }[] }[];
    };
    for (const block of json.results ?? []) {
      if (block.type !== "athlete" && block.type !== "player") continue;
      for (const a of block.athletes ?? []) {
        const id = a.id != null ? String(a.id) : "";
        if (!id) continue;
        const lg = (a.league?.abbreviation ?? "").toUpperCase();
        if (lg === "MLB" || lg === "") {
          mlbAthleteSearchCache.set(key, id);
          return id;
        }
      }
    }
    mlbAthleteSearchCache.set(key, undefined);
    return undefined;
  } catch {
    clearTimeout(timer);
    mlbAthleteSearchCache.set(key, undefined);
    return undefined;
  }
}
