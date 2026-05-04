import type { GamePrediction } from "@/data/mockGames";
import { fetchOddsForSport, isOddsApiAvailable } from "@/lib/oddsApiFetch";
import {
  ODDS_API_MLB_LEG_MARKETS,
  ODDS_API_SOCCER_KEY_BY_ESPN_SLUG,
} from "@/lib/oddsSportKeys";

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

export type MergeOddsOptions = {
  /**
   * Comma-separated Odds API market keys appended to h2h,spreads,totals.
   * Used for MLB first-5 innings (F5-style legs).
   */
  extraMarkets?: string;
};

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

function findEvent(pred: GamePrediction, events: OddsEvent[]): OddsEvent | undefined {
  const pt = pred._meta?.sortTime ?? 0;
  return events.find((e) => {
    const t = new Date(e.commence_time).getTime();
    if (!Number.isFinite(t) || Math.abs(t - pt) > 5 * 3600 * 1000) return false;
    return (
      looseMatch(e.home_team, pred.homeTeam.name) &&
      looseMatch(e.away_team, pred.awayTeam.name)
    );
  });
}

function spreadLine(b: Bookmaker | undefined): string | null {
  const m = b?.markets?.find((x) => x.key === "spreads");
  const outs = m?.outcomes;
  if (!outs?.length) return null;
  return outs
    .map((o) => `${o.name ?? "?"} ${o.price ?? ""}`)
    .join(" / ");
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

// ── Cross-book line shopping (#124) ──────────────────────────────────
//
// "Best line" = highest payout (best for the user) on a given side.
// For favorites (negative odds) higher = closer to zero (lose less).
// For dogs (positive odds) higher = bigger payout. Either way, the
// max of the American-odds value is the best price.
//
// "Consensus" = median across books' prices per outcome. Median (not
// mean) is robust to one book being way off — common when a small
// book hasn't moved with the market. With 4-6 US books in the typical
// response, the median is a solid no-vig-ish anchor without paying
// for sharp data like Pinnacle.
//
// Visibility-only — these helpers feed enrichmentNotes. No optimizer
// or scoring path consumes the consensus value (yet); the next step
// after we observe how often best-line beats DK is to push these into
// the value-edge calculation. Holding scope tight here: surface only.

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function bookShortName(b: Bookmaker): string {
  const k = (b.key ?? "").toLowerCase();
  if (k.includes("draftkings")) return "DK";
  if (k.includes("fanduel"))    return "FD";
  if (k.includes("betmgm"))     return "MGM";
  if (k.includes("caesars"))    return "Caesars";
  if (k.includes("pointsbet"))  return "PB";
  if (k.includes("wynnbet"))    return "Wynn";
  if (k.includes("betrivers"))  return "BR";
  if (k.includes("twinspires")) return "TS";
  if (k.includes("pinnacle"))   return "Pin";
  return b.title ?? b.key ?? "?";
}

interface BestQuote {
  /** Outcome name as the book reports it (team name / "Over" / "Under"). */
  outcome: string;
  /** Best (highest) American-odds price for this outcome across all books. */
  bestPrice: number;
  /** Short name of the book offering the best price. */
  bestBook: string;
  /** Median price across books for this outcome (vig-included). */
  consensusPrice: number | null;
  /** How many books quoted this outcome. */
  bookCount: number;
}

function compareBooksOnMarket(
  books: Bookmaker[] | undefined,
  marketKey: string,
): BestQuote[] {
  if (!books?.length) return [];
  // Group all (outcome → [{ price, book }]) across books.
  const byOutcome = new Map<string, Array<{ price: number; book: Bookmaker }>>();
  for (const b of books) {
    const m = b.markets?.find((x) => x.key === marketKey);
    if (!m?.outcomes?.length) continue;
    for (const o of m.outcomes) {
      const name = (o.name ?? "").trim();
      if (!name || o.price == null || !Number.isFinite(o.price)) continue;
      if (!byOutcome.has(name)) byOutcome.set(name, []);
      byOutcome.get(name)!.push({ price: Number(o.price), book: b });
    }
  }
  const out: BestQuote[] = [];
  for (const [outcome, entries] of byOutcome.entries()) {
    if (!entries.length) continue;
    let best = entries[0];
    for (const e of entries) {
      if (e.price > best.price) best = e;
    }
    out.push({
      outcome,
      bestPrice:      best.price,
      bestBook:       bookShortName(best.book),
      consensusPrice: median(entries.map((e) => e.price)),
      bookCount:      entries.length,
    });
  }
  return out;
}

function fmtAmerican(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const r = Math.round(n);
  return r > 0 ? `+${r}` : `${r}`;
}

/**
 * Format the cross-book ML / spread / total best-line summary as a
 * single enrichmentNotes line. Returns null when fewer than 2 books
 * quoted the market (best-line "shopping" requires at least two
 * candidates to be meaningful).
 */
function bestLineNote(books: Bookmaker[] | undefined, marketKey: string, label: string): string | null {
  const quotes = compareBooksOnMarket(books, marketKey);
  // Demand at least one outcome with ≥2 books — otherwise we'd just
  // be reporting the single book's price as "best", which is noise.
  const anyMulti = quotes.some((q) => q.bookCount >= 2);
  if (!anyMulti) return null;
  const parts = quotes.map((q) =>
    `${q.outcome} ${fmtAmerican(q.bestPrice)} (${q.bestBook}; cons ${fmtAmerican(q.consensusPrice)}, n=${q.bookCount})`,
  );
  return `Best ${label}: ${parts.join(" · ")}`;
}

/** Format moneyline-style outcomes for a single market (e.g. F5 h2h). */
function marketOutcomesLine(b: Bookmaker | undefined, marketKey: string): string | null {
  const m = b?.markets?.find((x) => x.key === marketKey);
  const outs = m?.outcomes;
  if (!outs?.length) return null;
  return outs.map((o) => `${o.name ?? "?"} ${o.price ?? "—"}`).join(" · ");
}

function mlbFirstFiveNote(ev: OddsEvent): string | null {
  const b = pickUsBook(ev.bookmakers);
  const h2h = marketOutcomesLine(b, "h2h_1st_5_innings");
  const spr = marketOutcomesLine(b, "spreads_1st_5_innings");
  const tot = marketOutcomesLine(b, "totals_1st_5_innings");
  const parts: string[] = [];
  if (h2h) parts.push(`F5 ML ${h2h}`);
  if (spr) parts.push(`F5 spread ${spr}`);
  if (tot) parts.push(`F5 total ${tot}`);
  if (!parts.length) return null;
  return `Legs / F5 (1st 5 inn, Odds API): ${parts.join(" · ")}`;
}

/**
 * Merge cross-book spread notes + optional extra markets (MLB F5) into `enrichmentNotes`.
 */
export async function mergeTheOddsApiNotes(
  predictions: GamePrediction[],
  sportKey: string,
  options?: MergeOddsOptions
): Promise<GamePrediction[]> {
  if (!isOddsApiAvailable()) return predictions;
  const markets = options?.extraMarkets
    ? `h2h,spreads,totals,${options.extraMarkets}`
    : "h2h,spreads,totals";
  try {
    const res = await fetchOddsForSport({
      sportKey,
      markets,
      regions: "us",
      oddsFormat: "american",
    });
    if (!res.ok) return predictions;
    const events = (await res.json()) as OddsEvent[];
    if (!Array.isArray(events)) return predictions;

    return predictions.map((p) => {
      const ev = findEvent(p, events);
      if (!ev?.bookmakers?.length) return p;
      const dk = ev.bookmakers.find((b) => (b.key ?? "").includes("draftkings") || (b.title ?? "").includes("DraftKings"));
      const fd = ev.bookmakers.find((b) => (b.key ?? "").includes("fanduel") || (b.title ?? "").includes("FanDuel"));
      const mgm = ev.bookmakers.find((b) => (b.key ?? "").includes("betmgm") || (b.title ?? "").includes("BetMGM"));
      const parts: string[] = ["The Odds API (US books):"];
      const ds = spreadLine(dk);
      const fs = spreadLine(fd);
      const ms = spreadLine(mgm);
      if (ds) parts.push(`DK spread ${ds}`);
      if (fs) parts.push(`FD spread ${fs}`);
      if (ms) parts.push(`MGM spread ${ms}`);
      const f5 = p.league === "mlb" ? mlbFirstFiveNote(ev) : null;
      const hasSpreadNote = parts.length >= 2;
      if (!hasSpreadNote && !f5) return p;
      const line =
        hasSpreadNote && f5
          ? `${parts.join(" · ")} · ${f5}`
          : hasSpreadNote
            ? parts.join(" · ")
            : f5!;
      const notes = [...(p.enrichmentNotes ?? [])];
      if (!notes.some((n) => n.includes("Odds API"))) notes.push(line);
      else if (f5 && !notes.some((n) => n.includes("F5"))) {
        const idx = notes.findIndex((n) => n.includes("Odds API"));
        if (idx >= 0) notes[idx] = `${notes[idx]} · ${f5}`;
        else notes.push(line);
      }
      // Cross-book best-line / consensus (#124). Visibility-only —
      // fires once per market where ≥2 books quoted, surfaces as a
      // separate note so existing UIs render it without changes.
      const bestNotes: string[] = [];
      const ml  = bestLineNote(ev.bookmakers, "h2h",     "ML");
      const sp  = bestLineNote(ev.bookmakers, "spreads", "spread");
      const tot = bestLineNote(ev.bookmakers, "totals",  "total");
      if (ml)  bestNotes.push(ml);
      if (sp)  bestNotes.push(sp);
      if (tot) bestNotes.push(tot);
      let outNotes = notes;
      if (bestNotes.length && !outNotes.some((n) => n.startsWith("Best "))) {
        outNotes = [...outNotes, bestNotes.join(" · ")];
      }
      return { ...p, enrichmentNotes: outNotes };
    });
  } catch {
    return predictions;
  }
}

/** Deprecated soccer odds merger — no-op now that soccer is no longer supported. */
export async function mergeSoccerOddsFromTheOddsApi(predictions: GamePrediction[]): Promise<GamePrediction[]> {
  return predictions;
}
