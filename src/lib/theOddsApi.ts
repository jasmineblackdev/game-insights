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
      return { ...p, enrichmentNotes: notes };
    });
  } catch {
    return predictions;
  }
}

/** Deprecated soccer odds merger — no-op now that soccer is no longer supported. */
export async function mergeSoccerOddsFromTheOddsApi(predictions: GamePrediction[]): Promise<GamePrediction[]> {
  return predictions;
}
