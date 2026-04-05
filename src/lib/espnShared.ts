import type {
  ConfidenceLevel,
  GameDate,
  GameLines,
  GamePrediction,
  MatchupEdge,
  TeamData,
} from "@/data/mockGames";

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

export function ymdToParam(ymd: string): string {
  return ymd.replace(/-/g, "");
}

export function isoToEasternYmd(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
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

export function winProbFromRecords(homePct: number, awayPct: number): { home: number; away: number } {
  const hStrength = homePct + 0.04;
  const aStrength = awayPct;
  const t = hStrength + aStrength;
  let h = t === 0 ? 0.5 : hStrength / t;
  h = Math.min(0.9, Math.max(0.1, h));
  return { home: Math.round(h * 100), away: Math.round((1 - h) * 100) };
}

/** NBA-style spreads (smaller numbers). */
export function confidenceFromSpreadNba(spread: number | undefined, probHome: number): ConfidenceLevel {
  const mag = spread != null ? Math.abs(spread) : Math.abs(probHome - 50) / 2;
  if (mag >= 7 || Math.abs(probHome - 50) >= 12) return "high";
  if (mag >= 4 || Math.abs(probHome - 50) >= 6) return "medium";
  return "low";
}

/** NFL spreads are wider — scale thresholds. */
export function confidenceFromSpreadNfl(spread: number | undefined, probHome: number): ConfidenceLevel {
  const mag = spread != null ? Math.abs(spread) : Math.abs(probHome - 50) / 2;
  if (mag >= 7 || Math.abs(probHome - 50) >= 12) return "high";
  if (mag >= 3.5 || Math.abs(probHome - 50) >= 6) return "medium";
  return "low";
}

/** MLB runlines are tight (often 1.5). */
export function confidenceFromSpreadMlb(spread: number | undefined, probHome: number): ConfidenceLevel {
  const mag = spread != null ? Math.abs(spread) : Math.abs(probHome - 50) / 2;
  if (mag >= 2 || Math.abs(probHome - 50) >= 12) return "high";
  if (mag >= 1.25 || Math.abs(probHome - 50) >= 6) return "medium";
  return "low";
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
  };
}

export interface EspnCompetition {
  date: string;
  odds?: EspnOdds[];
  status: {
    type: { state: string; completed?: boolean; shortDetail?: string; detail?: string };
  };
  competitors: EspnCompetitor[];
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
  const t = new Date(comp.date);
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
  prob: { home: number; away: number }
): MatchupEdge[] {
  const edges: MatchupEdge[] = [];
  const fav = prob.home >= prob.away ? home : away;
  edges.push({
    label: "Win probability lean",
    team: prob.home >= prob.away ? "home" : "away",
    description: `${fav.abbreviation} implied ~${Math.max(prob.home, prob.away)}% via market & records`,
  });
  if (details) {
    edges.push({
      label: "Spread (DK)",
      team: spread != null && spread < 0 ? "home" : "away",
      description: details,
    });
  }
  const hp = parseRecord(away.record).pct;
  const ap = parseRecord(home.record).pct;
  edges.push({
    label: "Season record",
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

  if (!spreadStr && total == null && !homeMl && !awayMl) return undefined;

  return {
    spread: spreadStr,
    spreadNum: spread,
    total: total ?? undefined,
    homeMl: homeMl ?? undefined,
    awayMl: awayMl ?? undefined,
  };
}

export async function fetchEspnScoreboardEvents(baseUrl: string, datesParam?: string): Promise<EspnEvent[]> {
  const url = datesParam ? `${baseUrl}?dates=${datesParam}` : baseUrl;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
  const data = (await res.json()) as EspnScoreboard;
  return data.events ?? [];
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
