import type {
  ConfidenceLevel,
  GameDate,
  GameLines,
  GamePrediction,
  League,
  MarketMlSnapshot,
  MatchupEdge,
  TeamData,
} from "@/data/mockGames";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { parseScoreboardResourceFromBaseUrl, resolveEspnProxyUrl } from "@/lib/espnProxy";

/** YYYY-MM-DD in America/New_York for a given instant */
export function easternYmd(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function nextCalendarYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const ud = new Date(Date.UTC(y, m - 1, d));
  ud.setUTCDate(ud.getUTCDate() + 1);
  return `${ud.getUTCFullYear()}-${String(ud.getUTCMonth() + 1).padStart(2, "0")}-${String(ud.getUTCDate()).padStart(2, "0")}`;
}

export function previousCalendarYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const ud = new Date(Date.UTC(y, m - 1, d));
  ud.setUTCDate(ud.getUTCDate() - 1);
  return `${ud.getUTCFullYear()}-${String(ud.getUTCMonth() + 1).padStart(2, "0")}-${String(ud.getUTCDate()).padStart(2, "0")}`;
}

/** Add signed day delta to YYYY-MM-DD (calendar math in UTC components). */
export function addCalendarDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const ud = new Date(Date.UTC(y, m - 1, d));
  ud.setUTCDate(ud.getUTCDate() + delta);
  return `${ud.getUTCFullYear()}-${String(ud.getUTCMonth() + 1).padStart(2, "0")}-${String(ud.getUTCDate()).padStart(2, "0")}`;
}

export function ymdToParam(ymd: string): string {
  return ymd.replace(/-/g, "");
}

/**
 * Kickoff instant → calendar date in America/New_York (fixture bucketing for Today / Tomorrow / Week).
 * Treats timezone-less ESPN datetimes as UTC so browsers in any local TZ agree with ET labels.
 */
/** Normalize ESPN kickoff strings so `Date` parsing is consistent across client timezones. */
export function normalizeEspnIso(iso: string): string {
  const t = iso.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(t) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) {
    return `${t}Z`;
  }
  return t;
}

export function isoToEasternYmd(iso: string): string {
  const normalized = normalizeEspnIso(iso);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(normalized));
}

export function parseEspnIsoToUtcMs(iso: string): number {
  return new Date(normalizeEspnIso(iso)).getTime();
}

export function parseRecord(summary: string | undefined): { w: number; l: number; pct: number } {
  if (!summary) return { w: 0, l: 0, pct: 0.5 };
  const m = summary.match(/^(\d+)-(\d+)$/);
  if (!m) return { w: 0, l: 0, pct: 0.5 };
  const w = Number(m[1]);
  const l = Number(m[2]);
  const t = w + l;
  return { w, l, pct: t === 0 ? 0.5 : w / t };
}

export function americanToImplied(american: string | undefined): number | null {
  if (!american) return null;
  const n = Number.parseInt(american.replace("+", ""), 10);
  if (Number.isNaN(n)) return null;
  if (n > 0) return 100 / (n + 100);
  const abs = Math.abs(n);
  return abs / (abs + 100);
}

export function winProbFromOdds(
  homeAmerican: string | undefined,
  awayAmerican: string | undefined
): { home: number; away: number } | null {
  const ph = americanToImplied(homeAmerican);
  const pa = americanToImplied(awayAmerican);
  if (ph == null || pa == null) return null;
  const sum = ph + pa;
  if (sum <= 0) return null;
  return {
    home: Math.round((ph / sum) * 100),
    away: Math.round((pa / sum) * 100),
  };
}

/**
 * Home advantage by sport (historical win-rate premium over neutral-site):
 *   NBA ~57% home → +6pp   NFL ~57% → +5.5pp   MLB ~53% → +3pp   Soccer ~45% → +2pp
 * Using these vs the old flat 4% avoids over-stating home edge in MLB/Soccer
 * and under-stating it in NBA/NFL.
 */
const HOME_BOOST: Record<League, number> = {
  nba: 0.06,
  nfl: 0.055,
  mlb: 0.03,
  boxing: 0, // boxing has no home/away venue advantage
};

export function winProbFromRecords(
  homePct: number,
  awayPct: number,
  league: League = "nba"
): { home: number; away: number } {
  const boost = HOME_BOOST[league] ?? 0.04;
  const hStrength = homePct + boost;
  const aStrength = awayPct;
  const t = hStrength + aStrength;
  let h = t === 0 ? 0.5 : hStrength / t;
  h = Math.min(0.9, Math.max(0.1, h));
  return { home: Math.round(h * 100), away: Math.round((1 - h) * 100) };
}

/** 0–1 strength: NBA/NFL/MLB uses win%; soccer uses (3W+D)/(3·games) from W-D-L tables. */
export function seasonStrengthFromRecord(summary: string | undefined, league: League): number {
  if (!summary) return 0.5;
  const soccer = summary.match(/^(\d+)-(\d+)-(\d+)$/);
  if (league === "soccer" && soccer) {
    const w = Number(soccer[1]);
    const d = Number(soccer[2]);
    const l = Number(soccer[3]);
    const n = w + d + l;
    if (n === 0) return 0.5;
    return (3 * w + d) / (3 * n);
  }
  return parseRecord(summary).pct;
}

/** De-vig DraftKings 1X2 American odds to integer % (sum 100). */
export function probThreeWayFromAmerican(
  homeAmerican: string | undefined,
  awayAmerican: string | undefined,
  drawAmerican: string | undefined
): { home: number; away: number; draw: number } | null {
  const ph = americanToImplied(homeAmerican);
  const pa = americanToImplied(awayAmerican);
  const pd = americanToImplied(drawAmerican);
  if (ph == null || pa == null || pd == null) return null;
  const sum = ph + pa + pd;
  if (sum <= 0) return null;
  const h = (ph / sum) * 100;
  const a = (pa / sum) * 100;
  const d = (pd / sum) * 100;
  let rh = Math.floor(h);
  let ra = Math.floor(a);
  let rd = Math.floor(d);
  let rem = 100 - (rh + ra + rd);
  const order = [
    { i: 0 as const, frac: h - rh },
    { i: 1 as const, frac: a - ra },
    { i: 2 as const, frac: d - rd },
  ].sort((x, y) => y.frac - x.frac);
  for (let k = 0; k < rem; k++) {
    const which = order[k % 3].i;
    if (which === 0) rh++;
    else if (which === 1) ra++;
    else rd++;
  }
  return { home: rh, away: ra, draw: rd };
}

/** Fallback 1X2 when odds missing: table-strength gap + home boost; draw peaks when teams are even. */
export function probThreeWayFromSoccerRecords(
  homeRecord: string | undefined,
  awayRecord: string | undefined
): { home: number; away: number; draw: number } {
  const hs = seasonStrengthFromRecord(homeRecord, "soccer") + 0.045;
  const as = seasonStrengthFromRecord(awayRecord, "soccer");
  const diff = hs - as;
  const pDraw = Math.min(0.36, Math.max(0.2, 0.29 - Math.abs(diff) * 0.55));
  const rem = 1 - pDraw;
  const eh = Math.exp(4 * diff);
  const ea = Math.exp(-4 * diff);
  const ph = (rem * eh) / (eh + ea);
  const pa = rem - ph;
  const h100 = ph * 100;
  const a100 = pa * 100;
  const d100 = pDraw * 100;
  let rh = Math.floor(h100);
  let ra = Math.floor(a100);
  let rd = Math.floor(d100);
  let remInt = 100 - (rh + ra + rd);
  const order = [
    { i: 0 as const, frac: h100 - rh },
    { i: 1 as const, frac: a100 - ra },
    { i: 2 as const, frac: d100 - rd },
  ].sort((x, y) => y.frac - x.frac);
  for (let k = 0; k < remInt; k++) {
    const which = order[k % 3].i;
    if (which === 0) rh++;
    else if (which === 1) ra++;
    else rd++;
  }
  return { home: rh, away: ra, draw: rd };
}

/**
 * NBA confidence — tightened thresholds vs original.
 * Historical: NBA favorites of 8.5+ win ~65% SU; 6-8.5 favs win ~59%.
 * Below 5pt spread, outcomes are close to coin-flip territory.
 */
export function confidenceFromSpreadNba(spread: number | undefined, probHome: number): ConfidenceLevel {
  const mag = spread != null ? Math.abs(spread) : Math.abs(probHome - 50) / 2;
  const gap = Math.abs(probHome - 50);
  if (mag >= 8.5 || gap >= 14) return "high";
  if (mag >= 5 || gap >= 8) return "medium";
  return "low";
}

/**
 * NFL confidence — each point more predictive than NBA due to lower-scoring game.
 * Historical: NFL favorites of 7+ win ~63% SU; below 3.5 is near coin-flip.
 */
export function confidenceFromSpreadNfl(spread: number | undefined, probHome: number): ConfidenceLevel {
  const mag = spread != null ? Math.abs(spread) : Math.abs(probHome - 50) / 2;
  const gap = Math.abs(probHome - 50);
  if (mag >= 7 || gap >= 13) return "high";
  if (mag >= 3.5 || gap >= 7) return "medium";
  return "low";
}

/**
 * MLB confidence — runline is almost always 1.5 so it's not a sliding signal.
 * Drive entirely off moneyline-implied prob gap.
 * Historical: MLB favourites at -150+ (60% implied) hit ~58% — tight market.
 * Require a larger prob gap than NBA/NFL to award HIGH.
 */
export function confidenceFromSpreadMlb(spread: number | undefined, probHome: number): ConfidenceLevel {
  const gap = Math.abs(probHome - 50);
  // Runline only used as a secondary signal — MLB spread is almost always ±1.5
  const mag = spread != null && Math.abs(spread) !== 1.5 ? Math.abs(spread) : 0;
  if (gap >= 14 || mag >= 2) return "high";
  if (gap >= 8) return "medium";
  return "low";
}

/** Soccer: draws and low scores add variance — never label “high” when draw is a major branch. */
export function confidenceFromSoccerThreeWay(
  tw: { home: number; away: number; draw: number },
  spreadMag: number | undefined
): ConfidenceLevel {
  const top = Math.max(tw.home, tw.away, tw.draw);
  const second = [tw.home, tw.away, tw.draw].sort((a, b) => b - a)[1];
  const tight = top - second <= 8;
  if (tw.draw >= 30 || tight) return "low";
  if (tw.draw >= 24 || (spreadMag != null && spreadMag <= 0.25) || top < 48) return "medium";
  if (top >= 58 && tw.draw < 22 && (spreadMag == null || spreadMag >= 0.5)) return "high";
  return "medium";
}

export interface EspnCompetitor {
  homeAway: "home" | "away";
  score?: string;
  records?: { name?: string; type?: string; summary?: string }[];
  team: {
    id: string;
    displayName: string;
    abbreviation: string;
    logo?: string;
  };
  leaders?: {
    name: string;
    leaders?: {
      displayValue: string;
      value?: number;
      athlete?: { fullName: string; position?: { abbreviation?: string } };
    }[];
  }[];
}

export interface EspnOdds {
  details?: string;
  spread?: number;
  overUnder?: number;
  moneyline?: {
    home?: { close?: { odds?: string }; open?: { odds?: string } };
    away?: { close?: { odds?: string }; open?: { odds?: string } };
    draw?: { close?: { odds?: string }; open?: { odds?: string } };
  };
}

/** Opening vs closing ML for market-intelligence / CLV support (ESPN book feed). */
export function marketMlSnapshot(odd: EspnOdds | undefined): MarketMlSnapshot | undefined {
  if (!odd?.moneyline) return undefined;
  const h = odd.moneyline.home;
  const a = odd.moneyline.away;
  const d = odd.moneyline.draw;
  const out: MarketMlSnapshot = {};
  if (h?.open?.odds) out.homeOpen = h.open.odds;
  if (h?.close?.odds) out.homeClose = h.close.odds;
  if (a?.open?.odds) out.awayOpen = a.open.odds;
  if (a?.close?.odds) out.awayClose = a.close.odds;
  if (d?.open?.odds) out.drawOpen = d.open.odds;
  if (d?.close?.odds) out.drawClose = d.close.odds;
  return Object.keys(out).length ? out : undefined;
}

export interface EspnCompetition {
  date: string;
  venue?: { id?: string; fullName?: string; address?: { city?: string; country?: string } };
  odds?: EspnOdds[];
  status: {
    /** Current period/quarter/inning (1-based). Present when state === "in". */
    period?: number;
    /** Remaining clock for timed sports e.g. "5:32". */
    displayClock?: string;
    type: { state: string; completed?: boolean; shortDetail?: string; detail?: string };
  };
  competitors: EspnCompetitor[];
}

/** Snapshot of an in-progress game — parsed once from ESPN competition data. */
export interface LiveGameState {
  periodNum: number;
  periodLabel: string;
  homeScore: number;
  awayScore: number;
  isHalftime: boolean;
}

/**
 * Parses live period/score data from an ESPN competition object.
 * Returns undefined when the game is not in progress.
 */
export function parseLiveState(comp: EspnCompetition): LiveGameState | undefined {
  if (comp.status.type.state !== "in") return undefined;
  const [awayC, homeC] = sortCompetitors(comp.competitors);
  const homeScore = Number(homeC.score ?? 0);
  const awayScore = Number(awayC.score ?? 0);
  const periodNum = comp.status.period ?? 1;
  const detail = comp.status.type.shortDetail ?? "";
  const isHalftime = detail.toLowerCase().includes("half");
  // shortDetail for live games: "Q2 5:32", "2nd 8:42", "Top 5th", "72'"
  const periodLabel = detail.replace(/\s+\d+:\d+$/, "").trim() || `Period ${periodNum}`;
  return { periodNum, periodLabel, homeScore, awayScore, isHalftime };
}

/**
 * Derives real situational tags from game/team data available at parse time.
 * These are the base tags — enrichment (B2B detection, etc.) appends more later.
 */
export function buildSituationalTags(
  status: GamePrediction["status"],
  league: League,
  homeRecord: string,
  awayRecord: string,
  prob: { home: number; away: number },
  spread: number | undefined,
  threeWay?: { home: number; away: number; draw: number },
  /** Soccer list badge (UCL, EPL, MLS, …) — avoids mislabeling all fixtures as EPL. */
  soccerListTag?: string
): string[] {
  const tags: string[] = [];

  // Status tag
  if (status === "live") tags.push("LIVE");
  else if (status === "final") tags.push("FINAL");
  else tags.push(league === "soccer" ? soccerListTag ?? "SOC" : league.toUpperCase());

  // Toss-up — spread within 1.5 pts or prob near 50/50
  const probGap = Math.abs(prob.home - prob.away);
  if (!threeWay && spread != null && Math.abs(spread) <= 1.5 && probGap <= 8) {
    tags.push("TOSS-UP");
  }

  // Heavy favorite — one side is dominant
  const topProb = threeWay ? Math.max(threeWay.home, threeWay.away) : Math.max(prob.home, prob.away);
  if (topProb >= 72) tags.push("HEAVY FAV");

  // Both teams below .500 — variance-heavy matchup
  const { pct: homePct } = parseRecord(homeRecord);
  const { pct: awayPct } = parseRecord(awayRecord);
  if (homePct < 0.45 && awayPct < 0.45) tags.push("BELOW .500");

  return tags;
}

export interface EspnEvent {
  id: string;
  date: string;
  name: string;
  competitions: EspnCompetition[];
}

export interface EspnScoreboard {
  events?: EspnEvent[];
}

export function overallRecord(c: EspnCompetitor): string {
  const r = c.records?.find((x) => x.type === "total" || x.name === "overall");
  return r?.summary ?? "0-0";
}

/** ESPN often exposes a separate row for last-10 (name/type varies by sport). */
export function lastTenRecordSummary(c: EspnCompetitor): string | undefined {
  for (const x of c.records ?? []) {
    const name = (x.name ?? "").toLowerCase();
    const type = (x.type ?? "").toLowerCase();
    if (
      type === "lastten" ||
      type === "last_ten" ||
      type.includes("last10") ||
      (name.includes("last") && (name.includes("10") || name.includes("ten")))
    ) {
      const s = x.summary?.trim();
      if (s && /\d/.test(s)) return s;
    }
  }
  return undefined;
}

export function sortCompetitors(competitors: EspnCompetitor[]): [EspnCompetitor, EspnCompetitor] {
  const away = competitors.find((c) => c.homeAway === "away")!;
  const home = competitors.find((c) => c.homeAway === "home")!;
  return [away, home];
}

export function mapStatus(state: string): GamePrediction["status"] {
  if (state === "in") return "live";
  if (state === "post") return "final";
  return "upcoming";
}

export function formatGameTime(comp: EspnCompetition, status: GamePrediction["status"]): string {
  if (status === "final") {
    const [awayC, homeC] = sortCompetitors(comp.competitors);
    const as = awayC.score ?? "—";
    const hs = homeC.score ?? "—";
    return `Final · ${as}–${hs}`;
  }
  if (status === "live") {
    return comp.status.type.shortDetail ?? comp.status.type.detail ?? "Live";
  }
  const t = new Date(normalizeEspnIso(comp.date));
  return (
    t.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    }) + " ET"
  );
}

export function buildEdges(
  away: TeamData,
  home: TeamData,
  spread: number | undefined,
  details: string | undefined,
  prob: { home: number; away: number },
  league: League = "nba",
  threeWay?: { home: number; away: number; draw: number }
): MatchupEdge[] {
  const edges: MatchupEdge[] = [];
  const fav = prob.home >= prob.away ? home : away;
  if (threeWay) {
    const top = Math.max(threeWay.home, threeWay.away, threeWay.draw);
    const haFav = threeWay.home >= threeWay.away ? ("home" as const) : ("away" as const);
    const isDrawLargest = top === threeWay.draw;
    const label = isDrawLargest ? "1X2 — draw leads" : "1X2 implied lean";
    edges.push({
      label,
      team: isDrawLargest ? haFav : threeWay.home >= threeWay.away ? "home" : "away",
      description: isDrawLargest
        ? `Draw ~${threeWay.draw}% (de-vig) is the largest branch · ${away.abbreviation} ${threeWay.away}% · ${home.abbreviation} ${threeWay.home}%`
        : `${fav.abbreviation} ~${Math.max(threeWay.home, threeWay.away)}% · draw ~${threeWay.draw}%`,
    });
    // Surface draw explicitly as a separate edge when it's a material outcome (≥28%)
    // This prevents it from being buried as a footnote when it's actually the best value.
    if (threeWay.draw >= 28 && !isDrawLargest) {
      edges.push({
        label: "Draw — notable branch",
        team: haFav,
        description: `Draw at ~${threeWay.draw}% (de-vig) — 1-in-${Math.round(100 / threeWay.draw)} probability. Check draw ML pricing for value.`,
      });
    }
  } else {
    edges.push({
      label: "Win probability lean",
      team: prob.home >= prob.away ? "home" : "away",
      description: `${fav.abbreviation} implied ~${Math.max(prob.home, prob.away)}% via market & records`,
    });
  }
  if (details) {
    edges.push({
      label: league === "soccer" ? "Line (DK)" : "Spread (DK)",
      team: spread != null && spread < 0 ? "home" : "away",
      description: details,
    });
  }
  const hp = seasonStrengthFromRecord(away.record, league);
  const ap = seasonStrengthFromRecord(home.record, league);
  edges.push({
    label: league === "soccer" ? "Table / form (W-D-L)" : "Season record",
    team: hp > ap ? "away" : "home",
    description: `${away.abbreviation} ${away.record} vs ${home.abbreviation} ${home.record}`,
  });
  return edges.slice(0, 4);
}

export function buildLines(
  odd: EspnOdds,
  awayAbbr: string,
  homeAbbr: string,
): GameLines | undefined {
  const spread = odd?.spread;
  const total = odd?.overUnder;
  const homeMl = odd?.moneyline?.home?.close?.odds ?? odd?.moneyline?.home?.open?.odds;
  const awayMl = odd?.moneyline?.away?.close?.odds ?? odd?.moneyline?.away?.open?.odds;
  const drawMl = odd?.moneyline?.draw?.close?.odds ?? odd?.moneyline?.draw?.open?.odds;

  // Build a human-readable spread string like "BOS -6.5" or "MIL +6.5"
  let spreadStr: string | undefined;
  if (odd?.details) {
    spreadStr = odd.details;
  } else if (spread != null) {
    // spread is from home team's perspective: negative = home is favorite
    if (spread < 0) {
      spreadStr = `${homeAbbr} ${spread}`;
    } else {
      spreadStr = `${awayAbbr} -${spread}`;
    }
  }

  if (!spreadStr && total == null && !homeMl && !awayMl && !drawMl) return undefined;

  return {
    spread: spreadStr,
    spreadNum: spread,
    total: total ?? undefined,
    homeMl: homeMl ?? undefined,
    awayMl: awayMl ?? undefined,
    drawMl: drawMl ?? undefined,
  };
}

export async function fetchEspnScoreboardEvents(baseUrl: string, datesParam?: string): Promise<EspnEvent[]> {
  const resource = parseScoreboardResourceFromBaseUrl(baseUrl);
  const proxy = resolveEspnProxyUrl();
  let res: Response;
  if (proxy && resource) {
    const u = new URL(proxy);
    u.searchParams.set("league", resource.league);
    if (resource.slug) u.searchParams.set("slug", resource.slug);
    if (datesParam) u.searchParams.set("dates", datesParam);
    res = await fetchWithTimeout(u.toString(), { timeoutMs: 20_000 });
  } else {
    const url = datesParam ? `${baseUrl}?dates=${datesParam}` : baseUrl;
    res = await fetchWithTimeout(url, { timeoutMs: 20_000 });
  }
  if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
  const data = (await res.json()) as EspnScoreboard;
  return data.events ?? [];
}

async function fetchEspnSoccerBoardJson(
  baseUrl: string,
  datesPart: string,
  limit?: string
): Promise<EspnScoreboard | null> {
  const slugMatch = /\/soccer\/([a-z0-9._-]+)\/scoreboard/i.exec(baseUrl);
  const slug = slugMatch?.[1];
  const proxy = resolveEspnProxyUrl();
  let res: Response;
  if (proxy && slug) {
    const u = new URL(proxy);
    u.searchParams.set("league", "soccer");
    u.searchParams.set("slug", slug);
    u.searchParams.set("dates", datesPart);
    if (limit) u.searchParams.set("limit", limit);
    res = await fetchWithTimeout(u.toString(), { timeoutMs: 22_000 });
  } else {
    const q = limit ? `dates=${datesPart}&limit=${limit}` : `dates=${datesPart}`;
    res = await fetchWithTimeout(`${baseUrl}?${q}`, { timeoutMs: 22_000 });
  }
  if (!res.ok) return null;
  try {
    return (await res.json()) as EspnScoreboard;
  } catch {
    return null;
  }
}

/**
 * ESPN soccer scoreboards: try `dates=start-end` (and optional limit). If empty, merge per-day
 * requests across [startYmd, endYmd] so sparse leagues still fill the week window.
 */
export async function fetchEspnSoccerScoreboardRange(
  baseUrl: string,
  startYmd: string,
  endYmd: string
): Promise<EspnEvent[]> {
  const rangeParam = `${ymdToParam(startYmd)}-${ymdToParam(endYmd)}`;
  const tryUrls = [`${baseUrl}?dates=${rangeParam}&limit=500`, `${baseUrl}?dates=${rangeParam}`];

  for (const tryUrl of tryUrls) {
    try {
      const u = new URL(tryUrl);
      const datesPart = u.searchParams.get("dates") ?? "";
      const lim = u.searchParams.get("limit") ?? undefined;
      if (!datesPart) continue;
      const data = await fetchEspnSoccerBoardJson(baseUrl, datesPart, lim);
      const ev = data?.events ?? [];
      if (ev.length > 0) return ev;
    } catch {
      /* try next */
    }
  }

  const byId = new Map<string, EspnEvent>();
  let ymd = startYmd;
  for (;;) {
    try {
      const data = await fetchEspnSoccerBoardJson(baseUrl, ymdToParam(ymd), "500");
      if (data) {
        for (const e of data.events ?? []) byId.set(e.id, e);
      }
    } catch {
      /* skip day */
    }
    if (ymd === endYmd) break;
    ymd = addCalendarDaysYmd(ymd, 1);
  }
  return [...byId.values()];
}

export function mergeScoreboardDays(a: EspnEvent[], b: EspnEvent[]): EspnEvent[] {
  const byId = new Map<string, EspnEvent>();
  for (const e of a) byId.set(e.id, e);
  for (const e of b) byId.set(e.id, e);
  return [...byId.values()];
}

export function gameDateFromEasternTip(easternGameYmd: string, todayEastern: string): GameDate {
  return easternGameYmd === todayEastern ? "today" : "tomorrow";
}
