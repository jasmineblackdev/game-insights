/**
 * NBA advanced team ratings (ORtg, DRtg, Pace).
 *
 * Primary source: ESPN byteam statistics endpoint — no backend required.
 * Fallback: Supabase nba-stats-proxy edge function (optional, only used
 *           when VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are set and ESPN fails).
 */

import { isSupabaseConfigured } from "@/lib/supabase";

export type NbaAdvancedRatingsPayload = {
  season: string;
  seasonType?: string;
  source: string;
  ratings: Record<string, { offRtg: number; defRtg: number; pace: number }>;
};

// ── Direct ESPN byteam statistics ─────────────────────────────────────────────

/**
 * ESPN's league-wide team statistics endpoint.
 * Returns all 30 teams in one response — far cheaper than 30 individual calls.
 * Seasontype 2 = regular season.
 */
function espnByTeamUrl(season: number): string {
  return `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?limit=100&season=${season}&seasontype=2`;
}

interface EspnStatCategory {
  name: string;
  displayName?: string;
  abbreviation?: string;
  /** Stat label definitions — parallel array with the values in EspnTeamRow.stats[categoryIndex] */
  stats?: { name?: string; displayName?: string; abbreviation?: string }[];
}

interface EspnTeamRow {
  team?: { id?: string; abbreviation?: string; displayName?: string };
  /** Outer array = categories (parallel to root categories[]); inner array = stat values */
  stats?: (number | string)[][];
}

interface EspnByTeamResponse {
  categories?: EspnStatCategory[];
  teams?: EspnTeamRow[];
}

function currentNbaSeason(): number {
  const now = new Date();
  const year = now.getFullYear();
  // NBA season ending in year X has seasonYear X (e.g. 2025–26 → 2026)
  // Before August, we're still in the season that ends this calendar year
  return now.getMonth() < 7 ? year : year + 1;
}

/**
 * Fetch ORtg, DRtg, and Pace for all NBA teams directly from ESPN.
 * Returns null if the endpoint is unreachable or has no efficiency stats.
 */
export async function fetchNbaAdvancedRatingsFromEspn(): Promise<NbaAdvancedRatingsPayload | null> {
  const season = currentNbaSeason();
  const url = espnByTeamUrl(season);

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as EspnByTeamResponse;

    const categories = body.categories ?? [];
    const teams = body.teams ?? [];
    if (!categories.length || !teams.length) return null;

    // Build a lookup: categoryIndex → { statName → statIndex }
    const catStatIndex: Array<Map<string, number>> = categories.map((cat) => {
      const m = new Map<string, number>();
      (cat.stats ?? []).forEach((s, i) => {
        if (s.name) m.set(s.name.toLowerCase(), i);
        if (s.abbreviation) m.set(s.abbreviation.toLowerCase(), i);
      });
      return m;
    });

    // Find which category+index has offensiveRating, defensiveRating, pace
    function findStat(names: string[]): { catIdx: number; statIdx: number } | null {
      for (const name of names) {
        for (let ci = 0; ci < categories.length; ci++) {
          const si = catStatIndex[ci]?.get(name.toLowerCase());
          if (si !== undefined) return { catIdx: ci, statIdx: si };
        }
      }
      return null;
    }

    const offLoc = findStat(["offensiverating", "ortg", "offrtg", "offensiveppp", "pts"]);
    const defLoc = findStat(["defensiverating", "drtg", "defrtg", "defensiveppp", "opppts", "opponentpoints"]);
    const paceLoc = findStat(["pace", "possessions", "poss"]);

    if (!offLoc && !defLoc) return null; // no efficiency stats available in this response

    const ratings: Record<string, { offRtg: number; defRtg: number; pace: number }> = {};

    for (const row of teams) {
      const abbr = row.team?.abbreviation?.toUpperCase();
      if (!abbr) continue;

      const getVal = (loc: { catIdx: number; statIdx: number } | null): number | null => {
        if (!loc) return null;
        const v = row.stats?.[loc.catIdx]?.[loc.statIdx];
        const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
        return Number.isFinite(n) ? n : null;
      };

      const offRtg = getVal(offLoc);
      const defRtg = getVal(defLoc);
      const pace = getVal(paceLoc);

      if (offRtg == null && defRtg == null) continue;

      ratings[abbr] = {
        offRtg: offRtg ?? 0,
        defRtg: defRtg ?? 0,
        pace: pace ?? 100,
      };
    }

    if (!Object.keys(ratings).length) return null;

    return { season: String(season), source: "espn", ratings };
  } catch (e) {
    console.warn("[GameLens] ESPN byteam stats unavailable:", e);
    return null;
  }
}

// ── Per-team statistics fallback (used when byteam doesn't have efficiency stats) ──

/**
 * Fetch ORtg, DRtg, Pace for a single team from ESPN's per-team statistics endpoint.
 * URL: /apis/site/v2/sports/basketball/nba/teams/{teamId}/statistics
 */
async function fetchNbaTeamEfficiencyStats(
  teamId: string
): Promise<{ offRtg: number; defRtg: number; pace: number } | null> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/statistics`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      team?: {
        statistics?: {
          splits?: {
            categories?: Array<{
              name?: string;
              stats?: Array<{ name?: string; value?: number }>;
            }>;
          };
        };
      };
    };

    const cats = body.team?.statistics?.splits?.categories ?? [];
    const all: Array<{ name: string; value: number }> = [];
    for (const cat of cats) {
      for (const s of cat.stats ?? []) {
        if (s.name && typeof s.value === "number") all.push({ name: s.name.toLowerCase(), value: s.value });
      }
    }

    function pick(...names: string[]): number | null {
      for (const n of names) {
        const found = all.find((s) => s.name === n);
        if (found && Number.isFinite(found.value)) return found.value;
      }
      return null;
    }

    const offRtg = pick("offensiverating", "ortg", "offrtg", "avgpoints", "avgpointsfor");
    const defRtg = pick("defensiverating", "drtg", "defrtg", "avgpointsallowed", "avgpointsagainst");
    const pace = pick("pace", "possessions");

    if (offRtg == null && defRtg == null) return null;
    return { offRtg: offRtg ?? 0, defRtg: defRtg ?? 0, pace: pace ?? 100 };
  } catch {
    return null;
  }
}

/**
 * Build an advanced ratings payload for just the teams in this game,
 * using the per-team /statistics endpoint. Used as fallback when byteam fails.
 */
export async function fetchNbaAdvancedRatingsForTeams(
  teams: Array<{ teamId: string; abbreviation: string }>
): Promise<NbaAdvancedRatingsPayload | null> {
  const entries = await Promise.all(
    teams.map(async (t) => {
      const r = await fetchNbaTeamEfficiencyStats(t.teamId);
      return r ? { abbr: t.abbreviation.toUpperCase(), r } : null;
    })
  );
  const ratings: Record<string, { offRtg: number; defRtg: number; pace: number }> = {};
  for (const e of entries) {
    if (e) ratings[e.abbr] = e.r;
  }
  if (!Object.keys(ratings).length) return null;
  const season = String(currentNbaSeason());
  return { season, source: "espn-perteam", ratings };
}

// ── Supabase proxy (optional legacy path) ─────────────────────────────────────

function resolveNbaStatsProxyUrl(): string | null {
  const custom = (import.meta.env.VITE_NBA_STATS_PROXY_URL as string | undefined)?.trim();
  if (custom) return custom;
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
  if (url && key) {
    return `${url.replace(/\/$/, "")}/functions/v1/nba-stats-proxy`;
  }
  return null;
}

function shouldAttachSupabaseAnonKey(targetUrl: string): boolean {
  const sup = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  if (!sup) return false;
  try {
    return new URL(targetUrl).origin === new URL(sup).origin;
  } catch {
    return false;
  }
}

async function fetchNbaAdvancedRatingsViaProxy(): Promise<NbaAdvancedRatingsPayload | null> {
  if (!isSupabaseConfigured) return null;
  const base = resolveNbaStatsProxyUrl();
  if (!base) return null;
  try {
    const url = new URL(base);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (shouldAttachSupabaseAnonKey(url.toString())) {
      const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
      if (key) {
        headers.Authorization = `Bearer ${key}`;
        headers.apikey = key;
      }
    }
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as NbaAdvancedRatingsPayload & { error?: string };
    if (body.error || !body.ratings || typeof body.ratings !== "object") return null;
    return body;
  } catch (e) {
    console.warn("[GameLens] nba-stats-proxy unavailable:", e);
    return null;
  }
}

// ── Public entry point ─────────────────────────────────────────────────────────

/**
 * Fetch NBA advanced ratings (ORtg, DRtg, Pace).
 * Tries ESPN byteam → Supabase proxy → null.
 * The caller decides whether to fall back to PPG-based estimates.
 */
export async function fetchNbaAdvancedRatings(): Promise<NbaAdvancedRatingsPayload | null> {
  // 1. ESPN direct (no backend required)
  const espn = await fetchNbaAdvancedRatingsFromEspn();
  if (espn) return espn;

  // 2. Supabase proxy (optional)
  return fetchNbaAdvancedRatingsViaProxy();
}

/** @deprecated Use fetchNbaAdvancedRatings() — kept for backwards compat. */
export { fetchNbaAdvancedRatingsViaProxy };

/** ESPN abbreviations that differ from stats.nba.com TEAM_ABBREVIATION. */
const ESPN_TO_NBA_ABBR: Record<string, string> = {
  GS: "GSW",
  NY: "NYK",
  NO: "NOP",
  SA: "SAS",
  PHO: "PHX",
  WSH: "WAS",
  CHO: "CHA",
};

export function normalizeEspnToNbaStatsAbbr(espnAbbr: string): string {
  const u = espnAbbr.trim().toUpperCase();
  return ESPN_TO_NBA_ABBR[u] ?? u;
}
