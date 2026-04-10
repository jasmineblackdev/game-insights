import type { GamePrediction, League } from "@/data/mockGames";
import { fetchOddsForSport, isOddsApiAvailable } from "@/lib/oddsApiFetch";
import { ODDS_API_SOCCER_KEY_BY_ESPN_SLUG } from "@/lib/oddsSportKeys";
import type { OddsH2hRow } from "@/lib/valueParlay/types";

interface Bookmaker {
  key?: string;
  title?: string;
  markets?: { key?: string; outcomes?: { name?: string; price?: number }[] }[];
}

interface OddsEvent {
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: Bookmaker[];
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function looseMatch(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = na.split(" ").filter(Boolean);
  const wb = nb.split(" ").filter(Boolean);
  return wa.some((x) => x.length > 3 && nb.includes(x)) || wb.some((x) => x.length > 3 && na.includes(x));
}

function pickUsBook(books: Bookmaker[] | undefined): Bookmaker | undefined {
  if (!books?.length) return undefined;
  return (
    books.find((b) => (b.key ?? "").includes("draftkings") || (b.title ?? "").includes("DraftKings")) ??
    books.find((b) => (b.key ?? "").includes("fanduel") || (b.title ?? "").includes("FanDuel")) ??
    books.find((b) => (b.key ?? "").includes("betmgm") || (b.title ?? "").includes("BetMGM")) ??
    books[0]
  );
}

function extractH2h(book: Bookmaker | undefined, homeName: string, awayName: string): OddsH2hRow | null {
  const m = book?.markets?.find((x) => x.key === "h2h");
  const outs = m?.outcomes;
  if (!outs?.length) return null;
  let homePrice: number | undefined;
  let awayPrice: number | undefined;
  let drawPrice: number | undefined;
  for (const o of outs) {
    const n = o.name ?? "";
    const p = o.price;
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    const nl = n.toLowerCase();
    if (nl.includes("draw") || nl === "tie") {
      drawPrice = p;
      continue;
    }
    if (looseMatch(n, homeName)) homePrice = p;
    else if (looseMatch(n, awayName)) awayPrice = p;
  }
  if (homePrice == null || awayPrice == null) return null;
  return {
    homeAmerican: homePrice,
    awayAmerican: awayPrice,
    ...(drawPrice != null ? { drawAmerican: drawPrice } : {}),
    bookKey: book?.key ?? "book",
  };
}

function spreadPrices(book: Bookmaker | undefined, homeName: string, awayName: string): { home: number; away: number } | null {
  const m = book?.markets?.find((x) => x.key === "spreads");
  const outs = m?.outcomes;
  if (!outs?.length) return null;
  let homeP: number | undefined;
  let awayP: number | undefined;
  for (const o of outs) {
    const p = o.price;
    if (typeof p !== "number") continue;
    const n = o.name ?? "";
    if (looseMatch(n, homeName)) homeP = p;
    else if (looseMatch(n, awayName)) awayP = p;
  }
  if (homeP == null || awayP == null) return null;
  return { home: homeP, away: awayP };
}

function totalPrices(book: Bookmaker | undefined): { over: number; under: number; point?: number } | null {
  const m = book?.markets?.find((x) => x.key === "totals");
  const outs = m?.outcomes;
  if (!outs?.length) return null;
  let over: number | undefined;
  let under: number | undefined;
  let point: number | undefined;
  for (const o of outs) {
    const p = o.price;
    if (typeof p !== "number") continue;
    const n = (o.name ?? "").toLowerCase();
    if (n.includes("over")) {
      over = p;
      const pt = (o as { point?: number }).point;
      if (typeof pt === "number") point = pt;
    } else if (n.includes("under")) {
      under = p;
      const pt = (o as { point?: number }).point;
      if (typeof pt === "number" && point == null) point = pt;
    }
  }
  if (over == null || under == null) return null;
  return { over, under, point };
}

export type GameOddsBundle = {
  gameId: string;
  h2h?: OddsH2hRow;
  spread?: { home: number; away: number };
  total?: { over: number; under: number; point?: number };
};

async function fetchJsonForSport(sportKey: string): Promise<OddsEvent[]> {
  const res = await fetchOddsForSport({
    sportKey,
    markets: "h2h,spreads,totals",
    regions: "us",
    oddsFormat: "american",
  });
  if (!res.ok) return [];
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as OddsEvent[]) : [];
}

function matchEvent(pred: GamePrediction, events: OddsEvent[]): OddsEvent | undefined {
  const pt = pred._meta?.sortTime ?? 0;
  return events.find((e) => {
    const t = new Date(e.commence_time).getTime();
    if (!Number.isFinite(t) || Math.abs(t - pt) > 5 * 3600 * 1000) return false;
    return looseMatch(e.home_team, pred.homeTeam.name) && looseMatch(e.away_team, pred.awayTeam.name);
  });
}

function bundleForPred(pred: GamePrediction, ev: OddsEvent | undefined): GameOddsBundle {
  const b = pickUsBook(ev?.bookmakers);
  const h2h = ev ? extractH2h(b, pred.homeTeam.name, pred.awayTeam.name) : null;
  const sp = ev ? spreadPrices(b, pred.homeTeam.name, pred.awayTeam.name) : null;
  const tot = ev ? totalPrices(b) : null;
  return {
    gameId: pred.id,
    ...(h2h ? { h2h } : {}),
    ...(sp ? { spread: sp } : {}),
    ...(tot ? { total: tot } : {}),
  };
}

/** Map game id → odds bundle for all predictions in a league batch. */
export async function fetchOddsBundlesForLeague(
  league: League,
  predictions: GamePrediction[]
): Promise<Map<string, GameOddsBundle>> {
  const map = new Map<string, GameOddsBundle>();
  if (!isOddsApiAvailable() || predictions.length === 0) {
    for (const p of predictions) map.set(p.id, { gameId: p.id });
    return map;
  }

  if (league === "soccer") {
    const byKey = new Map<string, GamePrediction[]>();
    for (const p of predictions) {
      const slug = p._meta?.soccerLeagueSlug ?? "eng.1";
      const key = ODDS_API_SOCCER_KEY_BY_ESPN_SLUG[slug] ?? "soccer_epl";
      const arr = byKey.get(key) ?? [];
      arr.push(p);
      byKey.set(key, arr);
    }
    for (const [sportKey, preds] of byKey) {
      const events = await fetchJsonForSport(sportKey);
      for (const p of preds) {
        const ev = matchEvent(p, events);
        map.set(p.id, bundleForPred(p, ev));
      }
    }
    return map;
  }

  const sportKey =
    league === "nba"
      ? "basketball_nba"
      : league === "nfl"
        ? "americanfootball_nfl"
        : "baseball_mlb";
  const events = await fetchJsonForSport(sportKey);
  for (const p of predictions) {
    const ev = matchEvent(p, events);
    map.set(p.id, bundleForPred(p, ev));
  }
  return map;
}

export async function fetchAllOddsBundles(
  predictions: GamePrediction[]
): Promise<Map<string, GameOddsBundle>> {
  const merged = new Map<string, GameOddsBundle>();
  const byLeague = new Map<League, GamePrediction[]>();
  for (const p of predictions) {
    const arr = byLeague.get(p.league) ?? [];
    arr.push(p);
    byLeague.set(p.league, arr);
  }
  for (const [league, preds] of byLeague) {
    const m = await fetchOddsBundlesForLeague(league, preds);
    for (const [k, v] of m) merged.set(k, v);
  }
  return merged;
}
