/**
 * ESPN box-score lookup for player-prop leg resolution.
 *
 * Why this exists: picksLog.ts already resolves picks via ESPN's
 * summary endpoint, but its stat-extraction logic uses hardcoded
 * array indices (NBA points=13, MLB hits=1, etc.) that need a code
 * change every time we want to support a new stat. This module uses
 * ESPN's "labels" array — the in-response column-headers — so any
 * stat ESPN emits can be looked up by name.
 *
 * Used by recommendedParlayResolver to settle player_prop legs in
 * app_recommended parlays. Same pattern can replace the hardcoded
 * indices in picksLog whenever someone wants to refactor.
 *
 * Endpoint format:
 *   https://site.api.espn.com/apis/site/v2/sports/{leaguePath}/summary?event={gameId}
 *
 * Response shape (relevant subset):
 *   boxscore.players[].statistics[].labels: ["AB","R","H","RBI",...]
 *   boxscore.players[].statistics[].athletes[].athlete.id, displayName
 *   boxscore.players[].statistics[].athletes[].stats: ["4","1","2","1",...]
 *
 * One game's box score may contain multiple "statistics" entries —
 * batting / pitching for MLB, normal stats for NBA. We scan all of
 * them looking for the requested label, so e.g. "K" finds the
 * pitcher's strikeouts and "H" finds a hitter's hits.
 */

export type Sport = "nba" | "nfl" | "mlb" | "soccer";

/** Per-sport league path segment for ESPN's summary endpoint. */
export function leaguePathFor(sport: string): string | null {
  const s = sport.toLowerCase();
  if (s === "nba") return "basketball/nba";
  if (s === "wnba") return "basketball/wnba";
  if (s === "nfl") return "football/nfl";
  if (s === "mlb") return "baseball/mlb";
  if (s === "soccer") return "soccer/usa.1";
  return null;
}

/**
 * Map a leg's stat_type (lowercase, possibly plural) to one or more
 * ESPN label tokens. When more than one token is returned, the values
 * at those positions are summed (combined props like "points + assists").
 */
const STAT_KEY_TO_ESPN_LABELS: Record<string, string[]> = {
  // MLB batter
  hits:           ["H"],
  rbi:            ["RBI"],
  rbis:           ["RBI"],
  runs:           ["R"],
  home_runs:      ["HR"],
  total_bases:    ["TB"],
  walks:          ["BB"],
  // MLB pitcher
  strikeouts:     ["K"],
  pitcher_ks:     ["K"],
  innings:        ["IP"],
  earned_runs:    ["ER"],
  // NBA / WNBA
  points:         ["PTS"],
  rebounds:       ["REB"],
  assists:        ["AST"],
  steals:         ["STL"],
  blocks:         ["BLK"],
  three_pointers: ["3PT"], // ESPN labels 3-point makes as "3PT" (made-attempted format)
  points_assists:           ["PTS", "AST"],
  points_rebounds:          ["PTS", "REB"],
  rebounds_assists:         ["REB", "AST"],
  pts_ast:                  ["PTS", "AST"],
  pts_reb:                  ["PTS", "REB"],
  reb_ast:                  ["REB", "AST"],
  points_rebounds_assists:  ["PTS", "REB", "AST"],
  pra:                      ["PTS", "REB", "AST"],
};

export function espnLabelsForStat(statType: string | null | undefined): string[] | null {
  if (!statType) return null;
  const key = statType.toLowerCase().replace(/\s+/g, "_");
  return STAT_KEY_TO_ESPN_LABELS[key] ?? null;
}

interface BoxAthlete {
  athlete?: { id?: string; displayName?: string };
  stats?: string[];
}
interface BoxStatGroup {
  name?: string;
  labels?: string[];
  athletes?: BoxAthlete[];
}
interface BoxPlayersGroup {
  statistics?: BoxStatGroup[];
}
interface BoxResponse {
  boxscore?: { players?: BoxPlayersGroup[] };
}

/**
 * Parse an ESPN stat string into a number. Handles "3-7" (made-attempted)
 * by returning the first part (makes). Returns null on unparseable values.
 */
function parseStatValue(raw: string | undefined): number | null {
  if (!raw) return null;
  const dashIdx = raw.indexOf("-");
  const piece = dashIdx > 0 ? raw.slice(0, dashIdx) : raw;
  const n = parseFloat(piece);
  return Number.isFinite(n) ? n : null;
}

export interface AthleteStatLookup {
  /** Numeric stat (or sum across labels). null when not found / not parseable. */
  value: number | null;
  /** Athlete display name from ESPN — useful for error messages. */
  displayName: string | null;
  /** Which labels we summed to produce the value, e.g. ["PTS","AST"]. */
  labelsHit: string[];
}

/**
 * Fetch + extract a numeric stat for one athlete in one game. Tries
 * athleteId first, falls back to a case-insensitive displayName match.
 *
 * Returns { value: null, ... } when the player wasn't found, the stat
 * label wasn't present, or the value didn't parse — caller should
 * treat that as "still pending" rather than guessing.
 */
export async function lookupAthleteStat(args: {
  sport: string;
  gameId: string;
  /** ESPN athlete id (numeric string). When absent, falls back to playerName. */
  athleteId?: string | null;
  playerName?: string | null;
  /** stat_type from the leg (e.g. "rbis", "pts_ast"). */
  statType: string;
}): Promise<AthleteStatLookup> {
  const empty: AthleteStatLookup = { value: null, displayName: null, labelsHit: [] };

  const path = leaguePathFor(args.sport);
  if (!path) return empty;
  const labels = espnLabelsForStat(args.statType);
  if (!labels) return empty;

  let json: BoxResponse;
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${encodeURIComponent(args.gameId)}`
    );
    if (!res.ok) return empty;
    json = await res.json() as BoxResponse;
  } catch {
    return empty;
  }

  const groups = json.boxscore?.players?.flatMap((p) => p.statistics ?? []) ?? [];

  // Find the athlete entry — prefer athleteId match, fall back to displayName.
  let foundAthleteName: string | null = null;
  let summed: number | null = null;
  const labelsHit: string[] = [];

  for (const group of groups) {
    const groupLabels = group.labels ?? [];
    if (!group.athletes?.length) continue;

    // Build label → index map for this group.
    const labelIndex = new Map<string, number>();
    for (let i = 0; i < groupLabels.length; i++) labelIndex.set(groupLabels[i], i);

    // Some legs need multiple labels (combined props). Skip group when
    // not all labels are present in this stat group.
    const indices = labels.map((l) => labelIndex.get(l));
    if (indices.some((i) => i == null)) continue;

    for (const a of group.athletes) {
      const matches = args.athleteId && a.athlete?.id === args.athleteId
        || (args.playerName && a.athlete?.displayName?.toLowerCase() === args.playerName.toLowerCase());
      if (!matches) continue;

      let groupSum = 0;
      let allParsed = true;
      for (let i = 0; i < indices.length; i++) {
        const v = parseStatValue(a.stats?.[indices[i]!]);
        if (v == null) { allParsed = false; break; }
        groupSum += v;
        labelsHit.push(labels[i]);
      }
      if (!allParsed) continue;
      summed = groupSum;
      foundAthleteName = a.athlete?.displayName ?? null;
      break;
    }
    if (summed != null) break;
  }

  return { value: summed, displayName: foundAthleteName, labelsHit };
}

/**
 * Compare an actual stat value against a line + direction, returning
 * the leg outcome.
 */
export function outcomeForOverUnder(
  actual: number,
  line: number,
  direction: "MORE" | "LESS" | string,
): "win" | "loss" | "push" {
  if (actual === line) return "push";
  if (direction === "MORE") return actual > line ? "win" : "loss";
  return actual < line ? "win" : "loss";
}
