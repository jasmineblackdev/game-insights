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
  k9: number | null;   // Strikeouts per 9 IP
  ip: number | null;   // Innings pitched (sample-size guard)
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
    if (!res.ok) return { athleteId, era: null, whip: null, k9: null, ip: null };

    const json = (await res.json()) as {
      splits?: {
        categories?: { name?: string; stats?: RawStat[] }[];
      };
    };

    const cats = json.splits?.categories ?? [];
    const pitching = cats.find((c) => /pitch/i.test(c.name ?? ""));
    const stats = pitching?.stats;

    const era = findStat(stats, "ERA", "earnedRunAverage");
    const whip = findStat(stats, "WHIP");
    const ip = findStat(stats, "inningsPitched", "IP");
    const k9 = findStat(stats, "strikeoutsPerNineInnings", "K/9", "kPer9");

    return { athleteId, era, whip, k9, ip };
  } catch {
    clearTimeout(timer);
    return { athleteId, era: null, whip: null, k9: null, ip: null };
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
