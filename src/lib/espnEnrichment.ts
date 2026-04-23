import type { GamePrediction, InjuryStatus, League, PlayerInjury, TeamData } from "@/data/mockGames";
import {
  fetchNbaAdvancedRatings,
  type NbaAdvancedRatingsPayload,
} from "@/lib/nbaStatsProxy";
import { isoToEasternYmd, previousCalendarYmd } from "@/lib/espnShared";

function clampWinPct(n: number): number {
  return Math.max(5, Math.min(95, Math.round(n)));
}

/** Positive delta boosts home win% (away drops), then renormalizes to sum 100. */
export function shiftWinProbabilityTwoWay(
  wp: { home: number; away: number },
  homeDeltaPp: number
): { home: number; away: number } {
  let h = clampWinPct(wp.home + homeDeltaPp);
  let a = clampWinPct(wp.away - homeDeltaPp);
  const sum = h + a;
  if (sum !== 100) {
    h = Math.round((h / sum) * 100);
    a = 100 - h;
  }
  return { home: h, away: a };
}

export function shiftThreeWayProb(
  tw: { home: number; away: number; draw: number },
  homeDelta: number
): { home: number; away: number; draw: number } {
  let h = tw.home + homeDelta;
  let a = tw.away - homeDelta * 0.55;
  let d = tw.draw - homeDelta * 0.45;
  h = Math.max(4, Math.min(90, h));
  a = Math.max(4, Math.min(90, a));
  d = Math.max(4, Math.min(90, d));
  const s = h + a + d;
  const nh = Math.round((h / s) * 100);
  const na = Math.round((a / s) * 100);
  return { home: nh, away: na, draw: 100 - nh - na };
}

function isKickoffThursdayET(sortTime: number): boolean {
  const w = new Date(sortTime).toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" });
  return w === "Thu";
}

function ymdDaysBefore(ymd: string, days: number): string {
  let d = ymd;
  for (let i = 0; i < days; i++) d = previousCalendarYmd(d);
  return d;
}

function countCompletedGamesInWindow(scheduleDates: Set<string>, gameYmd: string, windowDays: number): number {
  const start = ymdDaysBefore(gameYmd, windowDays);
  let n = 0;
  for (const g of scheduleDates) {
    if (g >= start && g < gameYmd) n++;
  }
  return n;
}

/** NBA season-series text → rough home win-probability shift in percentage points. */
function nbaH2hHomeShiftFromSummary(summary: Record<string, unknown>, homeAbbr: string, awayAbbr: string): number {
  const ss = summary.seasonseries ?? summary.seasonSeries;
  if (!Array.isArray(ss) || !ss.length) return 0;
  const entry = ss[0] as { series?: { summary?: string }[] };
  const text = entry?.series?.[0]?.summary ?? "";
  if (!text) return 0;
  const h = homeAbbr.toUpperCase();
  const a = awayAbbr.toUpperCase();
  const leadMatch = text.match(new RegExp(`(${h}|${a})\\s+leads?\\s+(\\d+)\\s*[-–]\\s*(\\d+)`, "i"));
  if (leadMatch) {
    const leader = leadMatch[1].toUpperCase();
    const w = Number(leadMatch[2]);
    const l = Number(leadMatch[3]);
    if (!Number.isFinite(w) || !Number.isFinite(l) || w + l === 0) return 0;
    const leadGames = Math.abs(w - l);
    if (leadGames === 0) return 0;
    const towardHome = leader === h ? 1 : leader === a ? -1 : 0;
    if (towardHome === 0) return 0;
    return towardHome * Math.min(2, Math.round(leadGames * 0.7));
  }
  return 0;
}
import { MLB_OUTDOOR_PARKS } from "@/lib/mlbConstants";

const INJURY_URLS: Record<"nba" | "nfl" | "mlb", string> = {
  nba: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries",
  nfl: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries",
  mlb: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/injuries",
};

function summaryUrl(league: League, eventId: string, soccerLeagueSlug?: string): string | null {
  if (league === "nba") {
    return `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`;
  }
  if (league === "nfl") {
    return `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${eventId}`;
  }
  if (league === "mlb") {
    return `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${eventId}`;
  }
  return null;
}

function teamUrl(league: League, teamId: string, soccerLeagueSlug?: string): string | null {
  if (league === "nba") {
    return `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}`;
  }
  if (league === "nfl") {
    return `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}`;
  }
  if (league === "mlb") {
    return `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${teamId}`;
  }
  return null;
}

function scheduleUrl(league: League, teamId: string, soccerLeagueSlug?: string): string | null {
  if (league === "nba") {
    return `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/schedule`;
  }
  if (league === "nfl") {
    return `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/schedule`;
  }
  if (league === "mlb") {
    return `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${teamId}/schedule`;
  }
  return null;
}

/** Returns the set of Eastern YYYY-MM-DD dates on which a team played this season. */
async function fetchTeamGameDates(league: League, teamId: string, soccerLeagueSlug?: string): Promise<Set<string>> {
  const url = scheduleUrl(league, teamId, soccerLeagueSlug);
  if (!url) return new Set();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return new Set();
    const json = (await res.json()) as { events?: { competitions?: { date?: string }[] }[] };
    const dates = new Set<string>();
    for (const ev of json.events ?? []) {
      const d = ev.competitions?.[0]?.date;
      if (d) dates.add(isoToEasternYmd(d));
    }
    return dates;
  } catch {
    clearTimeout(timer);
    return new Set();
  }
}

async function fetchTeamScheduleMap(
  league: League,
  teamIds: string[],
  soccerSlugForTeam?: (teamId: string) => string | undefined
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const unique = [...new Set(teamIds)].filter(Boolean);
  if (!scheduleUrl(league, unique[0] ?? "")) return out;
  const batch = 4;
  for (let i = 0; i < unique.length; i += batch) {
    const slice = unique.slice(i, i + batch);
    const results = await Promise.all(
      slice.map((id) => fetchTeamGameDates(league, id))
    );
    slice.forEach((id, j) => out.set(id, results[j] ?? new Set()));
  }
  return out;
}

// ── Position multipliers (per-sport) ─────────────────────────────────────────

const POSITION_MULTIPLIER: Record<string, Record<string, number>> = {
  nfl: { QB: 2.5, RB: 1.2, FB: 1.1, WR: 1.1, TE: 1.0, OL: 1.0, OG: 1.0, OT: 1.0, C: 1.0, DE: 1.3, DT: 1.2, LB: 1.1, CB: 1.1, S: 1.1, SS: 1.1, FS: 1.1, K: 0.9, P: 0.7 },
  mlb: { SP: 2.0, CP: 1.5, RP: 1.2, C: 1.2, SS: 1.3, "2B": 1.1, "3B": 1.1, "1B": 1.0, LF: 1.0, RF: 1.0, CF: 1.1, DH: 0.9 },
  nba: { PG: 1.5, SG: 1.2, SF: 1.2, PF: 1.2, C: 1.3, G: 1.3, F: 1.2 },
};

function applyPositionWeighting(injuries: PlayerInjury[], league: League): PlayerInjury[] {
  const map = POSITION_MULTIPLIER[league];
  if (!map) return injuries;
  return injuries.map((i) => ({
    ...i,
    impactScore: Math.round(i.impactScore * (map[i.position.toUpperCase()] ?? 1.0)),
  }));
}

/** Sum impactScore for OUT players only — GTD/QUESTIONABLE are too uncertain to shift win probability. */
function computeInjuryPenalty(injuries: PlayerInjury[]): number {
  return injuries.filter((i) => i.status === "OUT").reduce((sum, i) => sum + i.impactScore, 0);
}

export function mapEspnInjuryStatus(raw: string | undefined): InjuryStatus {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("out") || s === "o") return "OUT";
  if (s.includes("doubt")) return "QUESTIONABLE";
  if (s.includes("question")) return "QUESTIONABLE";
  if (s.includes("day-to-day") || s.includes("day to day")) return "GTD";
  if (s.includes("probable")) return "PROBABLE";
  return "QUESTIONABLE";
}

function impactForStatus(st: InjuryStatus): number {
  if (st === "OUT") return 8;
  if (st === "GTD") return 5;
  if (st === "QUESTIONABLE") return 5;
  if (st === "PROBABLE") return 2;
  return 3;
}

function rowToInjury(row: Record<string, unknown>): PlayerInjury | null {
  const athlete = row.athlete as Record<string, unknown> | undefined;
  const name = (athlete?.displayName as string) ?? "";
  if (!name) return null;
  const pos = (athlete?.position as { abbreviation?: string } | undefined)?.abbreviation ?? "—";
  const st = mapEspnInjuryStatus((row.status as string) ?? (row.type as { abbreviation?: string })?.abbreviation);
  const detail =
    (row.shortComment as string) ||
    (row.longComment as string) ||
    (row.details as { detail?: string } | undefined)?.detail ||
    "";
  return {
    name,
    position: pos,
    status: st,
    impactScore: impactForStatus(st),
    detail: detail.slice(0, 220),
  };
}

async function fetchLeagueInjuryMap(league: "nba" | "nfl" | "mlb"): Promise<Map<string, PlayerInjury[]>> {
  const map = new Map<string, PlayerInjury[]>();
  const res = await fetch(INJURY_URLS[league]);
  if (!res.ok) return map;
  const data = (await res.json()) as { injuries?: Record<string, unknown>[] };
  for (const block of data.injuries ?? []) {
    const tid = String((block as { id?: string }).id ?? "");
    if (!tid) continue;
    const rows = (block as { injuries?: Record<string, unknown>[] }).injuries ?? [];
    const parsed = rows.map(rowToInjury).filter((x): x is PlayerInjury => x != null);
    if (parsed.length) map.set(tid, parsed);
  }
  return map;
}

function mergeInjuryLists(a: PlayerInjury[], b: PlayerInjury[]): PlayerInjury[] {
  const byName = new Map<string, PlayerInjury>();
  for (const x of a) byName.set(x.name.toLowerCase(), x);
  for (const x of b) {
    const k = x.name.toLowerCase();
    const prev = byName.get(k);
    if (!prev || x.impactScore > prev.impactScore) byName.set(k, x);
  }
  return [...byName.values()].sort((p, q) => q.impactScore - p.impactScore);
}

function statVal(stats: { name?: string; value?: number }[] | undefined, name: string): number | undefined {
  const v = stats?.find((s) => s.name === name)?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

async function fetchTeamPatch(
  league: League,
  teamId: string,
  soccerLeagueSlug?: string
): Promise<Partial<TeamData>> {
  const url = teamUrl(league, teamId, soccerLeagueSlug);
  if (!url) return {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch {
    clearTimeout(timer);
    return {};
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return {};
  const json = (await res.json()) as { team?: Record<string, unknown> };
  const team = json.team;
  if (!team) return {};
  const items = (team.record as { items?: { type?: string; summary?: string; stats?: { name?: string; value?: number }[] }[] })
    ?.items;
  const total = items?.find((x) => x.type === "total");
  const stats = total?.stats;
  const ppg = statVal(stats, "avgPointsFor");
  const papg = statVal(stats, "avgPointsAgainst");
  const streak = statVal(stats, "streak");
  const summary = total?.summary ?? "0-0";

  // True L10 record — ESPN team API exposes a "lastTen" record item alongside "total".
  // Prefer it over streak so the UI shows "7-3 L10" instead of "W2".
  const lastTenItem = items?.find(
    (x) => x.type === "lastTen" || (x as { name?: string }).name?.toLowerCase().includes("last")
  );
  const lastTenSummary = lastTenItem?.summary; // e.g. "7-3" or "5-3-2" for soccer

  let recentForm = "—";
  if (lastTenSummary) {
    recentForm = `${lastTenSummary} L10`;
  } else if (streak != null && streak !== 0) {
    recentForm = streak > 0 ? `W${streak}` : `L${Math.abs(streak)}`;
  } else if (typeof team.standingSummary === "string") {
    recentForm = team.standingSummary;
  }

  if (league === "nba") {
    return {
      record: summary,
      recentForm,
      offensiveRating: ppg != null ? Math.round(ppg * 10) / 10 : undefined,
      defensiveRating: papg != null ? Math.round(papg * 10) / 10 : undefined,
      pace:
        ppg != null && papg != null
          ? Math.round((220 - papg + ppg * 0.15) * 10) / 10
          : undefined,
    };
  }
  if (league === "nfl") {
    return {
      record: summary,
      recentForm,
      offensiveRating: ppg != null ? Math.round(ppg * 10) / 10 : undefined,
      defensiveRating: papg != null ? Math.round(papg * 10) / 10 : undefined,
      pace: 63,
    };
  }
  if (league === "mlb") {
    const homeItem = items?.find((x) => x.type === "home");
    const roadItem = items?.find((x) => x.type === "road");
    const parsePct = (s: string | undefined): number | undefined => {
      if (!s) return undefined;
      const m = s.match(/^(\d+)-(\d+)/);
      if (!m) return undefined;
      const w = Number(m[1]);
      const l = Number(m[2]);
      const n = w + l;
      return n > 0 ? Math.round((w / n) * 1000) / 1000 : undefined;
    };
    return {
      record: summary,
      recentForm,
      offensiveRating: ppg != null ? Math.round(ppg * 100) / 100 : undefined,
      defensiveRating: papg != null ? Math.round(papg * 100) / 100 : undefined,
      pace: 9,
      homeWinPct: parsePct(homeItem?.summary),
      roadWinPct: parsePct(roadItem?.summary),
    };
  }
  return {};
}

async function fetchTeamMetricsMap(
  league: League,
  teamIds: string[],
): Promise<Map<string, Partial<TeamData>>> {
  const out = new Map<string, Partial<TeamData>>();
  const unique = [...new Set(teamIds)].filter(Boolean);
  const batch = 6;
  for (let i = 0; i < unique.length; i += batch) {
    const slice = unique.slice(i, i + batch);
    const patches = await Promise.all(
      slice.map((id) => fetchTeamPatch(league, id))
    );
    slice.forEach((id, j) => out.set(id, patches[j] ?? {}));
  }
  return out;
}

function applyTeamPatch(base: TeamData, patch: Partial<TeamData>): TeamData {
  return {
    ...base,
    // Explicit null-checks so a real 0 value from ESPN doesn't get discarded by nullish coalescing.
    offensiveRating: patch.offensiveRating != null ? patch.offensiveRating : base.offensiveRating,
    defensiveRating: patch.defensiveRating != null ? patch.defensiveRating : base.defensiveRating,
    pace: patch.pace != null ? patch.pace : base.pace,
    record: patch.record ?? base.record,
    recentForm: patch.recentForm ?? base.recentForm,
    homeWinPct: patch.homeWinPct ?? base.homeWinPct,
    roadWinPct: patch.roadWinPct ?? base.roadWinPct,
  };
}

async function fetchGameSummary(
  league: League,
  eventId: string,
  soccerLeagueSlug?: string
): Promise<Record<string, unknown> | null> {
  const url = summaryUrl(league, eventId, soccerLeagueSlug);
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

function injuriesFromSummaryBlocks(
  blocks: unknown,
  homeId: string,
  awayId: string
): { home: PlayerInjury[]; away: PlayerInjury[] } {
  const home: PlayerInjury[] = [];
  const away: PlayerInjury[] = [];
  if (!Array.isArray(blocks)) return { home, away };
  for (const block of blocks) {
    const b = block as { team?: { id?: string }; injuries?: Record<string, unknown>[] };
    const tid = b.team?.id;
    const rows = b.injuries ?? [];
    const list = rows.map(rowToInjury).filter((x): x is PlayerInjury => x != null);
    if (tid === homeId) home.push(...list);
    if (tid === awayId) away.push(...list);
  }
  return { home, away };
}

function seasonSeriesNote(summary: Record<string, unknown>): string | null {
  const ss = summary.seasonseries ?? summary.seasonSeries;
  if (!Array.isArray(ss) || !ss.length) return null;
  const entry = ss[0] as { type?: string; title?: string; series?: { summary?: string }[] };
  const s = entry?.series?.[0]?.summary;
  if (s) return `Season series: ${s}`;
  const title = entry?.title;
  if (title) return `Season series: ${title}`;
  return null;
}

function pickcenterNote(summary: Record<string, unknown>): string | null {
  const pc = summary.pickcenter as Record<string, unknown>[] | undefined;
  const row = pc?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const spread = row.spread as number | undefined;
  const ou = row.overUnder as number | undefined;
  const details = row.details as string | undefined;
  if (details) return `PickCenter: ${details}${ou != null ? ` · O/U ${ou}` : ""}`;
  if (spread != null) return `PickCenter spread reference: ${spread}`;
  return null;
}

/** Fetch with a hard timeout — prevents weather enrichment from blocking the entire game load. */
async function fetchWithTimeout(url: string, ms = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function nflWeatherFromSummary(
  summary: Record<string, unknown>
): Promise<{ note: string | null; tempF: number | null; windMph: number | null }> {
  const gi = summary.gameInfo as Record<string, unknown> | undefined;
  const venue = gi?.venue as Record<string, unknown> | undefined;
  const addr = venue?.address as Record<string, unknown> | undefined;
  const city = addr?.city as string | undefined;
  const state = addr?.state as string | undefined;
  if (!city || !state) return { note: null, tempF: null, windMph: null };
  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(`${city},${state},USA`)}&count=1&language=en&format=json`;
    const gr = await fetchWithTimeout(geoUrl, 5000);
    if (!gr.ok) return { note: null, tempF: null, windMph: null };
    const gj = (await gr.json()) as { results?: { latitude: number; longitude: number }[] };
    const loc = gj.results?.[0];
    if (!loc) return { note: null, tempF: null, windMph: null };
    const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,wind_speed_10m&wind_speed_unit=mph&temperature_unit=fahrenheit`;
    const wr = await fetchWithTimeout(wUrl, 5000);
    if (!wr.ok) return { note: null, tempF: null, windMph: null };
    const wj = (await wr.json()) as {
      current?: { temperature_2m?: number; wind_speed_10m?: number };
    };
    const t = wj.current?.temperature_2m ?? null;
    const wind = wj.current?.wind_speed_10m ?? null;
    if (t == null && wind == null) return { note: null, tempF: null, windMph: null };
    const note = `Weather (${city}): ${t != null ? `${Math.round(t)}°F` : "—"}${wind != null ? `, wind ~${Math.round(wind)} mph` : ""} — strong wind/cold can lean NFL totals lower.`;
    return { note, tempF: t, windMph: wind };
  } catch {
    return { note: null, tempF: null, windMph: null };
  }
}

/** MLB outdoor park weather — wind is the main signal (>12 mph affects run totals). */
async function mlbParkWeather(
  homeAbbr: string
): Promise<{ note: string | null; tempF: number | null; windMph: number | null }> {
  const park = MLB_OUTDOOR_PARKS[homeAbbr.toUpperCase()];
  if (!park) return { note: null, tempF: null, windMph: null };
  try {
    const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${park.lat}&longitude=${park.lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=mph&temperature_unit=fahrenheit`;
    const wr = await fetchWithTimeout(wUrl, 4000);
    if (!wr.ok) return { note: null, tempF: null, windMph: null };
    const wj = (await wr.json()) as {
      current?: { temperature_2m?: number; wind_speed_10m?: number; wind_direction_10m?: number };
    };
    const t = wj.current?.temperature_2m ?? null;
    const wind = wj.current?.wind_speed_10m ?? null;
    if (t == null && wind == null) return { note: null, tempF: null, windMph: null };
    const windNote =
      wind != null && wind >= 12
        ? ` Wind ${Math.round(wind)} mph — blowing${wind >= 20 ? " strongly" : ""} at ${park.name}; outdoor totals may be impacted.`
        : "";
    const tempNote =
      t != null && t <= 45
        ? ` Cold conditions (${Math.round(t)}°F) — pitchers typically benefit, scoring leans lower.`
        : "";
    if (!windNote && !tempNote) return { note: null, tempF: t, windMph: wind };
    const note = `Weather at ${park.name}: ${t != null ? `${Math.round(t)}°F` : "—"}, wind ~${wind != null ? Math.round(wind) : "—"} mph.${windNote}${tempNote}`;
    return { note, tempF: t, windMph: wind };
  } catch {
    return { note: null, tempF: null, windMph: null };
  }
}

async function enrichOne(
  pred: GamePrediction,
  league: League,
  injuryMap: Map<string, PlayerInjury[]>,
  teamPatches: Map<string, Partial<TeamData>>,
  nbaAdvanced: NbaAdvancedRatingsPayload | null,
  scheduleMap: Map<string, Set<string>>
): Promise<GamePrediction> {
  const hid = pred._meta?.homeTeamId;
  const aid = pred._meta?.awayTeamId;
  const eid = pred._meta?.eventId;
  if (!hid || !aid || !eid) return pred;

  let mlbWeatherMeta: { tempF: number | null; windMph: number | null } | undefined;

  let homeInj = injuryMap.get(hid) ?? [];
  let awayInj = injuryMap.get(aid) ?? [];
  const notes = [...(pred.enrichmentNotes ?? [])];
  let summaryForWeather: Record<string, unknown> | null = null;

  const summary = await fetchGameSummary(league, eid);
  if (summary) {
    summaryForWeather = summary;
    const fromSum = injuriesFromSummaryBlocks(summary.injuries, hid, aid);
    homeInj = mergeInjuryLists(homeInj, fromSum.home);
    awayInj = mergeInjuryLists(awayInj, fromSum.away);
    homeInj = applyPositionWeighting(homeInj, league);
    awayInj = applyPositionWeighting(awayInj, league);

    if (league === "nba") {
      const h2h = seasonSeriesNote(summary);
      if (h2h) notes.push(h2h);
    }
    const pc = pickcenterNote(summary);
    if (pc) notes.push(pc);
  }

  const hp = teamPatches.get(hid);
  const ap = teamPatches.get(aid);
  let homeTeam = pred.homeTeam;
  let awayTeam = pred.awayTeam;
  if (hp && Object.keys(hp).length) homeTeam = applyTeamPatch(homeTeam, hp);
  if (ap && Object.keys(ap).length) awayTeam = applyTeamPatch(awayTeam, ap);

  let nbaStatsApplied = false;
  let nbaStatsSeason: string | undefined;
  if (league === "nba" && nbaAdvanced?.ratings) {
    // ESPN data is keyed by raw ESPN abbreviation — no translation needed.
    // NBA-stats-proxy data used translated keys; try both forms for compat.
    const tryKey = (abbr: string) =>
      nbaAdvanced.ratings[abbr.toUpperCase()] ??
      nbaAdvanced.ratings[{ GS: "GSW", NY: "NYK", NO: "NOP", SA: "SAS", PHO: "PHX", WSH: "WAS", CHO: "CHA" }[abbr.toUpperCase()] ?? abbr.toUpperCase()];
    const kh = homeTeam.abbreviation;
    const ka = awayTeam.abbreviation;
    const rh = tryKey(kh);
    const ra = tryKey(ka);
    if (rh) {
      homeTeam = {
        ...homeTeam,
        offensiveRating: rh.offRtg,
        defensiveRating: rh.defRtg,
        pace: rh.pace,
      };
    }
    if (ra) {
      awayTeam = {
        ...awayTeam,
        offensiveRating: ra.offRtg,
        defensiveRating: ra.defRtg,
        pace: ra.pace,
      };
    }
    if (rh && ra) {
      nbaStatsApplied = true;
      nbaStatsSeason = nbaAdvanced.season;
    }
  }

  let winProbability = pred.winProbability;
  let threeWay = pred.threeWay;

  if (
    league === "nba" &&
    nbaStatsApplied &&
    homeTeam.offensiveRating != null &&
    homeTeam.defensiveRating != null &&
    awayTeam.offensiveRating != null &&
    awayTeam.defensiveRating != null
  ) {
    const netH = homeTeam.offensiveRating - homeTeam.defensiveRating;
    const netA = awayTeam.offensiveRating - awayTeam.defensiveRating;
    const diff = netH - netA;
    const delta = Math.max(-6, Math.min(6, Math.round(diff * 0.35)));
    winProbability = shiftWinProbabilityTwoWay(winProbability, delta);
  }

  // ── Back-to-back detection (NBA + MLB only — sports where fatigue materially shifts odds) ──
  const situationalTags = [...pred.situationalTags];
  let confidence = pred.confidence;
  if ((league === "nba" || league === "mlb") && scheduleMap.size > 0) {
    const gameDate = pred._meta?.easternYmd;
    if (gameDate) {
      const yesterday = previousCalendarYmd(gameDate);
      const twoDaysAgo = previousCalendarYmd(yesterday);
      const homeB2B = scheduleMap.get(hid)?.has(yesterday) ?? false;
      const awayB2B = scheduleMap.get(aid)?.has(yesterday) ?? false;
      // 3-game series: played yesterday AND the day before (bullpen most taxed)
      const homeConsec = homeB2B && (scheduleMap.get(hid)?.has(twoDaysAgo) ?? false);
      const awayConsec = awayB2B && (scheduleMap.get(aid)?.has(twoDaysAgo) ?? false);

      if (homeB2B && !situationalTags.includes("HOME B2B")) {
        situationalTags.push("HOME B2B");
        const consecNote = homeConsec ? " (3rd consecutive game — bullpen severely taxed)" : "";
        notes.push(
          `${homeTeam.abbreviation} playing on back-to-back tonight${consecNote} — fatigue reduces effective win probability 3–5%.`
        );
        // Downgrade HIGH confidence when the fatigued team is the favorite
        if (pred.winProbability.home >= pred.winProbability.away && confidence === "high") {
          confidence = "medium";
        }
      }
      if (homeConsec && !situationalTags.includes("HOME CONSEC")) {
        situationalTags.push("HOME CONSEC");
      }
      if (awayB2B && !situationalTags.includes("AWAY B2B")) {
        situationalTags.push("AWAY B2B");
        const consecNote = awayConsec ? " (3rd straight — road bullpen severely depleted)" : "";
        notes.push(
          `${awayTeam.abbreviation} on back-to-back (road)${consecNote} — travel compounds fatigue, historically -4 to -6pp on the road.`
        );
        if (pred.winProbability.away >= pred.winProbability.home && confidence === "high") {
          confidence = "medium";
        }
      }
      if (awayConsec && !situationalTags.includes("AWAY CONSEC")) {
        situationalTags.push("AWAY CONSEC");
      }

      let b2bHomeShift = 0;
      if (awayB2B) b2bHomeShift += 3;
      if (homeB2B) b2bHomeShift -= 3;
      if (b2bHomeShift !== 0 && (league === "nba" || league === "mlb")) {
        winProbability = shiftWinProbabilityTwoWay(winProbability, b2bHomeShift);
      }
    }
  }

  if (league === "nfl" && pred.status === "upcoming" && pred._meta?.sortTime && isKickoffThursdayET(pred._meta.sortTime)) {
    if (!situationalTags.includes("SHORT WEEK")) {
      situationalTags.push("SHORT WEEK");
      notes.push("Thursday Night Football — short week; road team historically carries ~2–3pp disadvantage.");
    }
    winProbability = shiftWinProbabilityTwoWay(winProbability, 2);
  }

  if (summary && league === "nba") {
    const hShift = nbaH2hHomeShiftFromSummary(summary, homeTeam.abbreviation, awayTeam.abbreviation);
    if (hShift !== 0) winProbability = shiftWinProbabilityTwoWay(winProbability, hShift);
  }

  if (league === "nfl" && pred.status === "upcoming" && summaryForWeather) {
    const wx = await nflWeatherFromSummary(summaryForWeather);
    if (wx.note) notes.push(wx.note);
    const bad = (wx.tempF != null && wx.tempF < 35) || (wx.windMph != null && wx.windMph > 15);
    if (bad) {
      const hPapg = homeTeam.defensiveRating ?? 24;
      const aPapg = awayTeam.defensiveRating ?? 24;
      let towardHome = 0;
      if (hPapg + 2 < aPapg) towardHome = 2;
      else if (aPapg + 2 < hPapg) towardHome = -2;
      if (towardHome !== 0) winProbability = shiftWinProbabilityTwoWay(winProbability, towardHome);
    }
  }

  if (league === "mlb" && pred.status === "upcoming") {
    const wx = await mlbParkWeather(homeTeam.abbreviation);
    mlbWeatherMeta = { tempF: wx.tempF, windMph: wx.windMph };
    if (wx.note) notes.push(wx.note);
    if (wx.windMph != null && wx.windMph >= 15) {
      winProbability = shiftWinProbabilityTwoWay(winProbability, 2);
    }
  }

  const topReasons = [...pred.topReasons];
  if (notes.length) {
    const first = notes[0];
    if (first && !topReasons.some((r) => r.includes(first.slice(0, 40)))) {
      topReasons.splice(1, 0, first);
    }
  }

  {
    const homePenalty = computeInjuryPenalty(homeInj);
    const awayPenalty = computeInjuryPenalty(awayInj);
    const netPenalty = homePenalty - awayPenalty;
    if (Math.abs(netPenalty) >= 6) {
      const shift = Math.min(Math.round(netPenalty * 0.25), 8);
      winProbability = shiftWinProbabilityTwoWay(winProbability, -shift);
    }
  }

  let keyMatchup = pred.keyMatchup;
  if (
    league === "nfl" &&
    pred.keyMatchup?.includes("fill in after ESPN") &&
    homeTeam.offensiveRating != null &&
    homeTeam.defensiveRating != null &&
    awayTeam.offensiveRating != null &&
    awayTeam.defensiveRating != null
  ) {
    keyMatchup = `${awayTeam.abbreviation} offense (${awayTeam.offensiveRating.toFixed(1)} PPG) vs ${homeTeam.abbreviation} defense (${homeTeam.defensiveRating.toFixed(1)} PAPG); ${homeTeam.abbreviation} (${homeTeam.offensiveRating.toFixed(1)} PPG) vs ${awayTeam.abbreviation} (${awayTeam.defensiveRating.toFixed(1)} PAPG).`;
  }

  const nextMeta =
    pred._meta != null
      ? {
          ...pred._meta,
          ...(league === "mlb" && mlbWeatherMeta ? { mlbWeather: mlbWeatherMeta } : {}),
          ...(league === "nba" && nbaStatsApplied && nbaStatsSeason
            ? { nbaRatingsFromStats: true as const, nbaStatsSeason }
            : {}),
        }
      : pred._meta;

  return {
    ...pred,
    homeTeam,
    awayTeam,
    injuries: { home: homeInj, away: awayInj },
    enrichmentNotes: notes.length ? notes : pred.enrichmentNotes,
    topReasons: topReasons.slice(0, 6),
    situationalTags,
    confidence,
    winProbability,
    _meta: nextMeta,
  };
}

async function poolMapPredictions(
  items: GamePrediction[],
  limit: number,
  fn: (item: GamePrediction) => Promise<GamePrediction>
): Promise<GamePrediction[]> {
  const results: GamePrediction[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const done = await Promise.all(chunk.map(fn));
    results.push(...done);
  }
  return results;
}

export async function enrichGamePredictions(predictions: GamePrediction[], league: League): Promise<GamePrediction[]> {
  if (league !== "nba" && league !== "nfl" && league !== "mlb") return predictions;
  const lg = league;

  const teamIds: string[] = [];
  for (const p of predictions) {
    if (p._meta?.homeTeamId) teamIds.push(p._meta.homeTeamId);
    if (p._meta?.awayTeamId) teamIds.push(p._meta.awayTeamId);
  }

  const injuryMapPromise = fetchLeagueInjuryMap(lg);

  const wantSchedule = lg === "nba" || lg === "mlb" || lg === "nfl";

  const [teamPatches, scheduleMap, nbaAdvanced, injuryMap] = await Promise.all([
    fetchTeamMetricsMap(lg, teamIds),
    wantSchedule ? fetchTeamScheduleMap(lg, teamIds) : Promise.resolve(new Map<string, Set<string>>()),
    lg === "nba" ? fetchNbaAdvancedRatings() : Promise.resolve(null),
    injuryMapPromise,
  ]);

  return poolMapPredictions(predictions, 5, (p) => enrichOne(p, lg, injuryMap, teamPatches, nbaAdvanced, scheduleMap));
}
