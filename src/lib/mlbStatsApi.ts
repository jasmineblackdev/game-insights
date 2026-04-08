/**
 * MLB Stats API — Probable Pitcher Lookup
 *
 * The official MLB Stats API announces probable starters 24–48 hours before
 * first pitch, significantly earlier than ESPN's scoreboard `probables` field
 * (which often only populates day-of or a few hours out).
 *
 * Endpoint:
 *   https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=YYYY-MM-DD&hydrate=probablePitcher(note)
 *
 * No auth required. Free public API.
 *
 * Matching strategy: key on `{date}-{homeTeamAbbr}` (upper-case).
 * Both ESPN and the MLB Stats API use the same standard abbreviations for
 * the vast majority of teams. Edge cases are handled by MLB_ABBR_MAP below.
 */

const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

export interface MlbProbablePitcher {
  name: string;
  hand: "L" | "R" | undefined;
  /** MLB Stats API player ID — different from ESPN athlete ID */
  mlbId: number;
}

export interface MlbProbableMatchup {
  home: MlbProbablePitcher | null;
  away: MlbProbablePitcher | null;
}

/**
 * A handful of teams where MLB Stats API abbreviation differs from ESPN's.
 * Key = MLB Stats API abbr, Value = ESPN abbr.
 */
const MLB_ABBR_MAP: Record<string, string> = {
  AZ:  "ARI",  // Arizona Diamondbacks
  TB:  "TB",   // Tampa Bay — both use TB
  CWS: "CWS",  // Chicago White Sox — both match
  SF:  "SF",   // San Francisco — both match
};

function normalizeAbbr(abbr: string): string {
  const upper = abbr.toUpperCase();
  return MLB_ABBR_MAP[upper] ?? upper;
}

type RawPitcher = {
  id?: number;
  fullName?: string;
  pitchHand?: { code?: string };
};

type RawTeamEntry = {
  team?: { abbreviation?: string; name?: string };
  probablePitcher?: RawPitcher;
};

type RawGame = {
  gameDate?: string;  // ISO-8601
  teams?: { home?: RawTeamEntry; away?: RawTeamEntry };
  status?: { abstractGameState?: string };
};

type RawSchedule = {
  dates?: { date?: string; games?: RawGame[] }[];
};

function parsePitcher(raw: RawPitcher | undefined): MlbProbablePitcher | null {
  if (!raw?.id || !raw?.fullName) return null;
  const code = raw.pitchHand?.code?.toUpperCase();
  const hand: "L" | "R" | undefined =
    code === "L" ? "L" : code === "R" ? "R" : undefined;
  return { name: raw.fullName, hand, mlbId: raw.id };
}

/**
 * Fetch probable pitchers for one date from the MLB Stats API.
 * Returns a Map keyed by `"YYYY-MM-DD-HOMEABBR"` (ESPN-normalized abbreviation).
 * Resolves to an empty map on network error.
 */
async function fetchProbablePitchersForDate(
  date: string // YYYY-MM-DD
): Promise<Map<string, MlbProbableMatchup>> {
  const url = `${MLB_STATS_BASE}/schedule?sportId=1&date=${date}&hydrate=probablePitcher(note)`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return new Map();

    const json = (await res.json()) as RawSchedule;
    const map = new Map<string, MlbProbableMatchup>();

    for (const dateEntry of json.dates ?? []) {
      for (const game of dateEntry.games ?? []) {
        // Skip postponed / cancelled games
        const state = game.status?.abstractGameState;
        if (state === "Postponed" || state === "Cancelled") continue;

        const homeAbbr = normalizeAbbr(game.teams?.home?.team?.abbreviation ?? "");
        if (!homeAbbr || !date) continue;

        const key = `${date}-${homeAbbr}`;
        map.set(key, {
          home: parsePitcher(game.teams?.home?.probablePitcher),
          away: parsePitcher(game.teams?.away?.probablePitcher),
        });
      }
    }
    return map;
  } catch {
    clearTimeout(timer);
    return new Map();
  }
}

/**
 * Fetch probable pitchers for today and tomorrow in parallel.
 * Returns a merged map covering both days.
 */
export async function fetchMlbProbablePitchers(
  today: string,
  tomorrow: string
): Promise<Map<string, MlbProbableMatchup>> {
  const [m0, m1] = await Promise.all([
    fetchProbablePitchersForDate(today),
    fetchProbablePitchersForDate(tomorrow),
  ]);
  // Merge — today takes no precedence issue since keys include the date
  return new Map([...m0, ...m1]);
}
