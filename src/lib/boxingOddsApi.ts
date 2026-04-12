/**
 * Boxing odds via The Odds API.
 * Sport key: "boxing" (fight winner, over/under rounds).
 *
 * Uses the shared fetchOddsForSport proxy so local dev proxy,
 * Supabase Edge proxy, and legacy VITE_THE_ODDS_API_KEY all work.
 */

import { fetchOddsForSport, isOddsApiAvailable } from "@/lib/oddsApiFetch";

/** The Odds API sport key for boxing moneylines. */
export const BOXING_ODDS_SPORT_KEY = "boxing";

export interface BoxingOddsLine {
  fightId: string;      // Odds API event ID
  homeMoneyline?: number;
  awayMoneyline?: number;
  overUnderRounds?: number;
  overOdds?: number;
  underOdds?: number;
  sportsbookKey?: string;
}

/** Full event with fighter names + odds — primary data source when DB tables are empty. */
export interface BoxingCombatEvent {
  eventId: string;
  commenceTime: string;  // ISO UTC
  homeName: string;
  awayName: string;
  line: BoxingOddsLine | null;
}

interface OddsEvent {
  id?: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: {
    key?: string;
    title?: string;
    markets?: { key?: string; outcomes?: { name?: string; price?: number; point?: number }[] }[];
  }[];
}

const PREFERRED_BOOKS = ["draftkings", "fanduel", "betmgm", "caesars", "pointsbetus", "betrivers"];

function pickBestBook(bookmakers: OddsEvent["bookmakers"]): OddsEvent["bookmakers"][0] | undefined {
  if (!bookmakers?.length) return undefined;
  for (const key of PREFERRED_BOOKS) {
    const bm = bookmakers.find((b) => (b.key ?? "").includes(key));
    if (bm) return bm;
  }
  return bookmakers[0];
}

function extractMoneyline(
  book: OddsEvent["bookmakers"][0] | undefined,
  homeName: string,
  awayName: string,
): { home: number; away: number } | null {
  const m = book?.markets?.find((x) => x.key === "h2h");
  if (!m?.outcomes?.length) return null;
  let home: number | undefined;
  let away: number | undefined;
  for (const o of m.outcomes) {
    if (typeof o.price !== "number") continue;
    const nl = (o.name ?? "").toLowerCase();
    const hn = homeName.toLowerCase();
    const an = awayName.toLowerCase();
    if (nl.includes(hn.split(" ").pop() ?? hn)) home = o.price;
    else if (nl.includes(an.split(" ").pop() ?? an)) away = o.price;
    else if (!home) home = o.price;
    else if (!away) away = o.price;
  }
  if (home == null || away == null) return null;
  return { home, away };
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
    if (typeof o.price !== "number") continue;
    const nl = (o.name ?? "").toLowerCase();
    if (nl.includes("over")) { over = o.price; if (o.point != null) point = o.point; }
    else if (nl.includes("under")) { under = o.price; if (o.point != null && point == null) point = o.point; }
  }
  if (over == null || under == null) return null;
  return { over, under, point: point ?? 9.5 };
}

// ─── fetchBoxingEvents (primary — for when DB tables are empty) ──

export async function fetchBoxingEvents(): Promise<BoxingCombatEvent[]> {
  if (!isOddsApiAvailable()) return [];
  try {
    const res = await fetchOddsForSport({
      sportKey: BOXING_ODDS_SPORT_KEY,
      markets: "h2h,totals",
      regions: "us",
      oddsFormat: "american",
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 402 || res.status === 429) {
        const body = await res.json().catch(() => ({})) as { error_code?: string };
        throw new Error(body.error_code === "OUT_OF_USAGE_CREDITS"
          ? "Odds API quota exhausted — update your API key to restore Boxing data."
          : `Odds API error ${res.status}`);
      }
      return [];
    }
    const events = (await res.json()) as OddsEvent[];
    if (!Array.isArray(events)) return [];

    const out: BoxingCombatEvent[] = [];
    for (const ev of events) {
      if (!ev.id || !ev.home_team || !ev.away_team) continue;
      const book = pickBestBook(ev.bookmakers);
      const ml   = extractMoneyline(book, ev.home_team, ev.away_team);
      const tot  = extractTotals(book);
      const line: BoxingOddsLine | null = ml
        ? {
            fightId: ev.id,
            homeMoneyline: ml.home,
            awayMoneyline: ml.away,
            ...(tot != null ? { overUnderRounds: tot.point, overOdds: tot.over, underOdds: tot.under } : {}),
            sportsbookKey: book?.key ?? "unknown",
          }
        : null;
      out.push({ eventId: ev.id, commenceTime: ev.commence_time, homeName: ev.home_team, awayName: ev.away_team, line });
    }
    return out;
  } catch {
    return [];
  }
}

// ─── fetchBoxingOdds (legacy — used when DB fights have odds_event_id) ──

export async function fetchBoxingOdds(): Promise<BoxingOddsLine[]> {
  const events = await fetchBoxingEvents();
  return events.filter((e) => e.line != null).map((e) => e.line!);
}

/** Convert American moneyline to implied probability (with vig). */
export function americanToImplied(ml: number): number {
  if (ml > 0) return 100 / (ml + 100);
  return Math.abs(ml) / (Math.abs(ml) + 100);
}

/** De-vig two-outcome market (standard vig removal). */
export function deVigTwoWay(p1Raw: number, p2Raw: number): { p1: number; p2: number } {
  const total = p1Raw + p2Raw;
  return { p1: p1Raw / total, p2: p2Raw / total };
}
