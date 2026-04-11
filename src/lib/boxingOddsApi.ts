/**
 * Boxing odds via The Odds API.
 * Sport key: "boxing" (fight winner, method of victory, over/under rounds).
 * Called from boxingFetch.ts after Supabase fight data is loaded.
 * NO direct client calls — this module is imported by boxingFetch.ts (server/edge context).
 */

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

/** The Odds API sport key for boxing moneylines (fight winner). */
export const BOXING_ODDS_SPORT_KEY = "boxing";
/** Method of victory (KO/TKO, decision, draw) when available. */
export const BOXING_ODDS_PROP_KEY = "boxing_fight_result";

export interface BoxingOddsLine {
  fightId: string;      // Odds API event ID
  homeMoneyline?: number;
  awayMoneyline?: number;
  /** Over/under scheduled rounds */
  overUnderRounds?: number;
  overOdds?: number;
  underOdds?: number;
  sportsbookKey?: string;
}

interface OddsApiOutcome {
  name: string;
  price: number;
}

interface OddsApiBookmaker {
  key: string;
  markets: { key: string; outcomes: OddsApiOutcome[] }[];
}

interface OddsApiEvent {
  id: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

const PREFERRED_BOOKS = ["draftkings", "fanduel", "betmgm", "caesars", "pointsbetus"];

function pickBestBook(bookmakers: OddsApiBookmaker[]): OddsApiBookmaker | null {
  for (const key of PREFERRED_BOOKS) {
    const bm = bookmakers.find((b) => b.key === key);
    if (bm) return bm;
  }
  return bookmakers[0] ?? null;
}

export async function fetchBoxingOdds(): Promise<BoxingOddsLine[]> {
  const apiKey = (import.meta as unknown as Record<string, Record<string, string>>).env?.VITE_ODDS_API_KEY;
  if (!apiKey) return [];

  const url = `${ODDS_API_BASE}/sports/${BOXING_ODDS_SPORT_KEY}/odds?apiKey=${apiKey}&regions=us&markets=h2h&oddsFormat=american`;

  let events: OddsApiEvent[] = [];
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    events = await res.json();
  } catch {
    return [];
  }

  const lines: BoxingOddsLine[] = [];

  for (const ev of events) {
    const book = pickBestBook(ev.bookmakers);
    if (!book) continue;

    const h2h = book.markets.find((m) => m.key === "h2h");
    if (!h2h) continue;

    const homeOutcome = h2h.outcomes.find((o) => o.name === ev.home_team);
    const awayOutcome = h2h.outcomes.find((o) => o.name === ev.away_team);

    const line: BoxingOddsLine = {
      fightId: ev.id,
      homeMoneyline: homeOutcome?.price,
      awayMoneyline: awayOutcome?.price,
      sportsbookKey: book.key,
    };

    // Check for totals (rounds over/under) if available
    const totals = book.markets.find((m) => m.key === "totals");
    if (totals) {
      const over = totals.outcomes.find((o) => o.name.toLowerCase() === "over");
      const under = totals.outcomes.find((o) => o.name.toLowerCase() === "under");
      if (over) line.overOdds = over.price;
      if (under) line.underOdds = under.price;
    }

    lines.push(line);
  }

  return lines;
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
