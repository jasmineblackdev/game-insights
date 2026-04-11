/**
 * The Odds API integration for MMA/UFC.
 * Sport key: "mma_mixed_martial_arts"
 *
 * Called client-side as part of mmaFetch.ts — backend ingestion supplements
 * with snapshot history stored in mma_odds_snapshots.
 */

import { fetchOddsForSport, isOddsApiAvailable } from "@/lib/oddsApiFetch";

export const MMA_ODDS_SPORT_KEY = "mma_mixed_martial_arts";

export interface MmaOddsLine {
  fightId: string;        // matches mma_fights.fight_id
  oddsEventId: string;    // The Odds API event id (for in-play refresh)
  homeMoneyline: number;  // American odds
  awayMoneyline: number;
  drawMoneyline?: number;
  overRounds?: number;    // over/under rounds line
  overOdds?: number;
  underOdds?: number;
  sportsbook: string;
  fetchedAt: string;
  // Opening line (from snapshot table when available)
  homeMoneylineOpen?: number;
  awayMoneylineOpen?: number;
}

interface OddsEvent {
  id?: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: {
    key?: string;
    title?: string;
    last_update?: string;
    markets?: { key?: string; outcomes?: { name?: string; price?: number; point?: number }[] }[];
  }[];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function nameMatch(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = na.split(" ").filter((x) => x.length > 2);
  const wb = nb.split(" ").filter((x) => x.length > 2);
  return wa.some((x) => nb.includes(x)) || wb.some((x) => na.includes(x));
}

const US_BOOKS = ["draftkings", "fanduel", "betmgm", "caesars", "pointsbetus", "betrivers"];

function pickBook(books: OddsEvent["bookmakers"]): OddsEvent["bookmakers"][0] | undefined {
  if (!books?.length) return undefined;
  for (const key of US_BOOKS) {
    const b = books.find((x) => (x.key ?? "").includes(key));
    if (b) return b;
  }
  return books[0];
}

function extractMoneyline(
  book: OddsEvent["bookmakers"][0] | undefined,
  homeName: string,
  awayName: string,
): { home: number; away: number; draw?: number } | null {
  const m = book?.markets?.find((x) => x.key === "h2h");
  if (!m?.outcomes?.length) return null;
  let home: number | undefined;
  let away: number | undefined;
  let draw: number | undefined;
  for (const o of m.outcomes) {
    const p = o.price;
    if (typeof p !== "number") continue;
    const nl = (o.name ?? "").toLowerCase();
    if (nl.includes("draw")) { draw = p; continue; }
    if (nameMatch(o.name ?? "", homeName)) home = p;
    else if (nameMatch(o.name ?? "", awayName)) away = p;
  }
  if (home == null || away == null) return null;
  return { home, away, ...(draw != null ? { draw } : {}) };
}

function extractTotals(
  book: OddsEvent["bookmakers"][0] | undefined,
): { over: number; under: number; point: number } | null {
  const m = book?.markets?.find((x) => x.key === "totals");
  if (!m?.outcomes?.length) return null;
  let over: number | undefined;
  let under: number | undefined;
  let point: number | undefined;
  for (const o of m.outcomes) {
    const p = o.price;
    if (typeof p !== "number") continue;
    const nl = (o.name ?? "").toLowerCase();
    if (nl.includes("over")) { over = p; if (o.point != null) point = o.point; }
    else if (nl.includes("under")) { under = p; if (o.point != null && point == null) point = o.point; }
  }
  if (over == null || under == null) return null;
  return { over, under, point: point ?? 2.5 };
}

export function americanToImplied(american: number): number {
  if (american > 0) return 100 / (american + 100);
  return Math.abs(american) / (Math.abs(american) + 100);
}

export function deVigTwoWay(p1: number, p2: number): { p1: number; p2: number } {
  const total = p1 + p2;
  return { p1: p1 / total, p2: p2 / total };
}

/**
 * Fetch MMA moneylines + totals from The Odds API.
 * Returns lines keyed by the Odds API event ID (matched to fight records by caller).
 */
export async function fetchMmaOdds(): Promise<MmaOddsLine[]> {
  if (!isOddsApiAvailable()) return [];
  try {
    const res = await fetchOddsForSport({
      sportKey: MMA_ODDS_SPORT_KEY,
      markets: "h2h,totals",
      regions: "us",
      oddsFormat: "american",
    });
    if (!res.ok) return [];
    const events = (await res.json()) as OddsEvent[];
    if (!Array.isArray(events)) return [];

    const lines: MmaOddsLine[] = [];
    const now = new Date().toISOString();

    for (const ev of events) {
      if (!ev.id) continue;
      const book = pickBook(ev.bookmakers);
      const ml = extractMoneyline(book, ev.home_team, ev.away_team);
      if (!ml) continue;
      const tot = extractTotals(book);
      lines.push({
        fightId: ev.id,    // caller replaces with DB fight_id after name-matching
        oddsEventId: ev.id,
        homeMoneyline: ml.home,
        awayMoneyline: ml.away,
        ...(ml.draw != null ? { drawMoneyline: ml.draw } : {}),
        ...(tot != null ? { overRounds: tot.point, overOdds: tot.over, underOdds: tot.under } : {}),
        sportsbook: book?.key ?? "unknown",
        fetchedAt: now,
      });
    }
    return lines;
  } catch {
    return [];
  }
}

// ─── Full event fetch (primary data source) ──────────────────────
// Returns one entry per event with fighter names + odds bundled.
// mmaFetch.ts uses this when Supabase fight tables are empty.

export interface MmaCombatEvent {
  eventId: string;
  commenceTime: string;   // ISO UTC (e.g. "2026-04-20T22:00:00Z")
  homeName: string;
  awayName: string;
  line: MmaOddsLine | null;
}

export async function fetchMmaEvents(): Promise<MmaCombatEvent[]> {
  if (!isOddsApiAvailable()) return [];
  try {
    const res = await fetchOddsForSport({
      sportKey: MMA_ODDS_SPORT_KEY,
      markets: "h2h,totals",
      regions: "us",
      oddsFormat: "american",
    });
    if (!res.ok) return [];
    const events = (await res.json()) as OddsEvent[];
    if (!Array.isArray(events)) return [];
    const now = new Date().toISOString();
    const out: MmaCombatEvent[] = [];
    for (const ev of events) {
      if (!ev.id || !ev.home_team || !ev.away_team) continue;
      const book = pickBook(ev.bookmakers);
      const ml   = extractMoneyline(book, ev.home_team, ev.away_team);
      const tot  = extractTotals(book);
      const line: MmaOddsLine | null = ml
        ? {
            fightId: ev.id,
            oddsEventId: ev.id,
            homeMoneyline: ml.home,
            awayMoneyline: ml.away,
            ...(ml.draw != null ? { drawMoneyline: ml.draw } : {}),
            ...(tot != null ? { overRounds: tot.point, overOdds: tot.over, underOdds: tot.under } : {}),
            sportsbook: book?.key ?? "unknown",
            fetchedAt: now,
          }
        : null;
      out.push({ eventId: ev.id, commenceTime: ev.commence_time, homeName: ev.home_team, awayName: ev.away_team, line });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Given a fight's home/away names, find the best matching odds line from a list.
 */
export function matchMmaOddsLine(
  homeName: string,
  awayName: string,
  commenceMs: number,
  lines: MmaOddsLine[],
  allEvents: OddsEvent[],
): MmaOddsLine | undefined {
  // Find the matching event by team name + time proximity (±5h)
  const ev = allEvents.find((e) => {
    const t = new Date(e.commence_time).getTime();
    if (!Number.isFinite(t) || Math.abs(t - commenceMs) > 5 * 3600 * 1000) return false;
    return nameMatch(e.home_team, homeName) && nameMatch(e.away_team, awayName);
  });
  if (!ev?.id) return undefined;
  return lines.find((l) => l.oddsEventId === ev.id);
}
