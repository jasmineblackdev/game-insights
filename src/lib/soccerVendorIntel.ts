import type { ConfidenceLevel, GamePrediction, SoccerIntel } from "@/data/mockGames";
import {
  easternYmd,
  fetchEspnScoreboardEvents,
  previousCalendarYmd,
  sortCompetitors,
  type EspnEvent,
  ymdToParam,
} from "@/lib/espnShared";

const EPL_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard";

const token = import.meta.env.VITE_FOOTBALL_DATA_API_TOKEN as string | undefined;

function fdApiBase(): string {
  return import.meta.env.DEV ? "/football-data-api" : "https://api.football-data.org/v4";
}

function downConfidence(c: ConfidenceLevel): ConfidenceLevel {
  if (c === "high") return "medium";
  return "low";
}

function mergeSoccerBase(intel: SoccerIntel, patch: Partial<SoccerIntel>): SoccerIntel {
  return {
    ...intel,
    ...patch,
    modelNotes: intel.modelNotes,
    dataGaps: patch.dataGaps ?? intel.dataGaps,
  };
}

function filterDataGaps(gaps: string[], hasFd: boolean): string[] {
  if (!hasFd) return gaps;
  return gaps.filter((g) => !g.includes("football-data.org (token) or SportsDataIO"));
}

interface FDTeam {
  id: number;
  name?: string;
  shortName?: string;
  tla?: string;
}

interface FDTableRow {
  position?: number;
  points?: number;
  team?: { id?: number; name?: string; tla?: string };
}

interface FDMatch {
  utcDate?: string;
  status?: string;
  homeTeam?: { id?: number; tla?: string };
  awayTeam?: { id?: number; tla?: string };
}

async function fdFetchJson(path: string): Promise<unknown> {
  const base = fdApiBase();
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {};
  if (!import.meta.env.DEV) {
    if (!token) throw new Error("VITE_FOOTBALL_DATA_API_TOKEN required outside dev proxy");
    headers["X-Auth-Token"] = token;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`football-data ${res.status}`);
  return res.json();
}

function buildAbbrToTeamId(teams: FDTeam[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of teams) {
    if (t.tla && t.id != null) m.set(t.tla.toUpperCase(), t.id);
  }
  return m;
}

function resolveTeamId(abbr: string, abbrToId: Map<string, number>): number | undefined {
  const u = abbr.toUpperCase();
  return abbrToId.get(u);
}

function countFinishedMatches(
  matches: FDMatch[],
  teamId: number,
  afterMs: number,
  beforeMs: number
): number {
  let n = 0;
  for (const m of matches) {
    if ((m.status ?? "").toUpperCase() !== "FINISHED") continue;
    const t = m.utcDate ? new Date(m.utcDate).getTime() : NaN;
    if (!Number.isFinite(t) || t < afterMs || t > beforeMs) continue;
    const hid = m.homeTeam?.id;
    const aid = m.awayTeam?.id;
    if (hid === teamId || aid === teamId) n++;
  }
  return n;
}

async function mergeWithFootballDataOrg(predictions: GamePrediction[]): Promise<GamePrediction[]> {
  const now = Date.now();
  const d7 = now - 7 * 86400000;
  const d14 = now - 14 * 86400000;
  const yToday = easternYmd();
  let yFrom = yToday;
  for (let i = 0; i < 14; i++) yFrom = previousCalendarYmd(yFrom);

  const [teamsJson, standingsJson, matchesJson] = await Promise.all([
    fdFetchJson("/competitions/PL/teams") as Promise<{ teams?: FDTeam[] }>,
    fdFetchJson("/competitions/PL/standings") as Promise<{ standings?: { table?: FDTableRow[] }[] }>,
    fdFetchJson(
      `/competitions/PL/matches?dateFrom=${yFrom}&dateTo=${yToday}&status=FINISHED`
    ) as Promise<{ matches?: FDMatch[] }>,
  ]);

  const teams = teamsJson.teams ?? [];
  const abbrToId = buildAbbrToTeamId(teams);
  const table = standingsJson.standings?.[0]?.table ?? [];
  const posById = new Map<number, { position: number; points: number }>();
  for (const row of table) {
    const id = row.team?.id;
    if (id == null || row.position == null) continue;
    posById.set(id, { position: row.position, points: row.points ?? 0 });
  }
  const matches = matchesJson.matches ?? [];

  return predictions.map((p) => {
    if (p.league !== "soccer" || !p.soccer) return p;

    const hid = resolveTeamId(p.homeTeam.abbreviation, abbrToId);
    const aid = resolveTeamId(p.awayTeam.abbreviation, abbrToId);
    const congestion =
      hid != null || aid != null
        ? {
            homeLast7: hid != null ? countFinishedMatches(matches, hid, d7, now) : 0,
            awayLast7: aid != null ? countFinishedMatches(matches, aid, d7, now) : 0,
            homeLast14: hid != null ? countFinishedMatches(matches, hid, d14, now) : 0,
            awayLast14: aid != null ? countFinishedMatches(matches, aid, d14, now) : 0,
          }
        : undefined;

    const th = hid != null ? posById.get(hid) : undefined;
    const ta = aid != null ? posById.get(aid) : undefined;
    const tablePatch =
      th || ta
        ? {
            homePosition: th?.position,
            awayPosition: ta?.position,
            homePoints: th?.points,
            awayPoints: ta?.points,
          }
        : undefined;

    const intel = mergeSoccerBase(p.soccer, {
      congestion,
      table: tablePatch,
      scheduleSource: "football-data.org",
      dataGaps: filterDataGaps(p.soccer.dataGaps, true),
    });

    let confidence = p.confidence;
    if (congestion && Math.abs(congestion.homeLast7 - congestion.awayLast7) >= 2) {
      confidence = downConfidence(confidence);
    }

    const congNote =
      congestion != null
        ? `Fixture load (PL, finished): ${p.homeTeam.abbreviation} ${congestion.homeLast7} in 7d / ${congestion.homeLast14} in 14d · ${p.awayTeam.abbreviation} ${congestion.awayLast7} in 7d / ${congestion.awayLast14} in 14d (football-data.org).`
        : null;
    const tableNote =
      th && ta
        ? `Table: ${p.homeTeam.abbreviation} ${th.position}th (${th.points} pts) vs ${p.awayTeam.abbreviation} ${ta.position}th (${ta.points} pts).`
        : null;

    const topReasons = [...p.topReasons];
    if (tableNote && !topReasons.some((r) => r.includes("Table:"))) topReasons.splice(1, 0, tableNote);
    if (congNote && !topReasons.some((r) => r.includes("Fixture load"))) topReasons.splice(2, 0, congNote);

    const riskFactors = [...p.riskFactors];
    if (congestion && Math.abs(congestion.homeLast7 - congestion.awayLast7) >= 2) {
      const heavier =
        congestion.homeLast7 > congestion.awayLast7 ? p.homeTeam.abbreviation : p.awayTeam.abbreviation;
      riskFactors.unshift(
        `${heavier} played more league games in the last 7 days — rotation / legs risk vs fresher opponent.`
      );
    }

    return {
      ...p,
      soccer: intel,
      confidence,
      topReasons: topReasons.slice(0, 8),
      riskFactors: riskFactors.slice(0, 8),
    };
  });
}

async function fetchEspnEventsForPastDays(numDays: number): Promise<EspnEvent[]> {
  const seen = new Map<string, EspnEvent>();
  let y = easternYmd();
  const dates: string[] = [y];
  for (let i = 1; i < numDays; i++) {
    y = previousCalendarYmd(y);
    dates.push(y);
  }
  const batch = 4;
  for (let i = 0; i < dates.length; i += batch) {
    const chunk = dates.slice(i, i + batch);
    const arrs = await Promise.all(
      chunk.map((d) => fetchEspnScoreboardEvents(EPL_SCOREBOARD, ymdToParam(d)))
    );
    for (const events of arrs) {
      for (const e of events) seen.set(e.id, e);
    }
  }
  return [...seen.values()];
}

function countEspnFinalMatchesForTeam(
  events: EspnEvent[],
  abbr: string,
  afterMs: number,
  beforeMs: number
): number {
  const u = abbr.toUpperCase();
  let n = 0;
  for (const event of events) {
    const comp = event.competitions?.[0];
    if (!comp?.competitors || comp.competitors.length < 2) continue;
    if (comp.status?.type?.state !== "post") continue;
    const t = new Date(comp.date).getTime();
    if (!Number.isFinite(t) || t < afterMs || t > beforeMs) continue;
    const [awayC, homeC] = sortCompetitors(comp.competitors);
    const ha = homeC.team.abbreviation.toUpperCase();
    const aa = awayC.team.abbreviation.toUpperCase();
    if (ha === u || aa === u) n++;
  }
  return n;
}

async function mergeWithEspnCongestion(predictions: GamePrediction[]): Promise<GamePrediction[]> {
  const now = Date.now();
  const d7 = now - 7 * 86400000;
  const events = await fetchEspnEventsForPastDays(7);

  return predictions.map((p) => {
    if (p.league !== "soccer" || !p.soccer) return p;

    const ha = p.homeTeam.abbreviation;
    const aa = p.awayTeam.abbreviation;
    const h7 = countEspnFinalMatchesForTeam(events, ha, d7, now);
    const a7 = countEspnFinalMatchesForTeam(events, aa, d7, now);

    const intel = mergeSoccerBase(p.soccer, {
      congestion: {
        homeLast7: h7,
        awayLast7: a7,
        homeLast14: h7,
        awayLast14: a7,
      },
      scheduleSource: "espn-scoreboard",
    });

    let confidence = p.confidence;
    if (Math.abs(h7 - a7) >= 2) confidence = downConfidence(confidence);

    const congNote = `Fixture load (EPL finals on ESPN board, last 7d): ${ha} ${h7} · ${aa} ${a7} — add football-data.org token for 14-day + table positions.`;
    const topReasons = [...p.topReasons];
    if (!topReasons.some((r) => r.includes("Fixture load"))) topReasons.splice(2, 0, congNote);

    const riskFactors = [...p.riskFactors];
    if (Math.abs(h7 - a7) >= 2) {
      const heavier = h7 > a7 ? ha : aa;
      riskFactors.unshift(
        `${heavier} played more EPL games in the last 7 days on the ESPN calendar — possible fatigue / rotation tilt.`
      );
    }

    return {
      ...p,
      soccer: intel,
      confidence,
      topReasons: topReasons.slice(0, 8),
      riskFactors: riskFactors.slice(0, 8),
    };
  });
}

/**
 * Enriches soccer games with fixture congestion (and table via football-data.org when configured).
 * Dev: set `VITE_FOOTBALL_DATA_API_TOKEN` — Vite proxies `/football-data-api` so the token is not sent from the browser.
 * Prod: same env hits the API directly (ensure CORS allows your origin, or proxy via Supabase Edge).
 */
export async function mergeSoccerVendorIntel(predictions: GamePrediction[]): Promise<GamePrediction[]> {
  if (!predictions.some((p) => p.league === "soccer")) return predictions;

  const canTryFd =
    import.meta.env.DEV ? !!token : !!token;

  if (canTryFd) {
    try {
      return await mergeWithFootballDataOrg(predictions);
    } catch {
      /* CORS, rate limit, or missing free-tier competition */
    }
  }

  try {
    return await mergeWithEspnCongestion(predictions);
  } catch {
    return predictions;
  }
}
