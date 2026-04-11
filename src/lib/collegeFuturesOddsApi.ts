/**
 * College championship / tournament futures via The Odds API outrights.
 * Independent of ESPN scoreboards — uses existing oddsApiFetch proxy path.
 */

import {
  COLLEGE_FUTURES_SPORTS,
  COLLEGE_FUTURES_V1_MARKET,
  resolveOddsSportKey,
  type CollegeFuturesSportConfig,
} from "@/lib/collegeFuturesConfig";
import type { CollegeSportId, RawFuturesOutcome, CollegeFuturesBoardMeta } from "@/lib/collegeFuturesTypes";
import { fetchOddsForSport, isOddsApiAvailable } from "@/lib/oddsApiFetch";
import { americanToImpliedProb } from "@/lib/valueParlay/oddsMath";

type Outcome = { name?: string; description?: string; price?: number };
type Market = { key?: string; outcomes?: Outcome[] };
type Bookmaker = { key?: string; title?: string; markets?: Market[] };
type OddsEvent = {
  id?: string;
  sport_key?: string;
  sport_title?: string;
  commence_time?: string;
  home_team?: string;
  away_team?: string;
  bookmakers?: Bookmaker[];
};

const OPENING_STORAGE = "gamelens-college-futures-opening-v1";

function pickUsBook(bms: Bookmaker[] | undefined): Bookmaker | undefined {
  if (!bms?.length) return undefined;
  const prefer = (k: string) =>
    bms!.find((b) => (b.key ?? "").toLowerCase() === k) ??
    bms!.find((b) => (b.key ?? "").toLowerCase().includes(k));
  return (
    prefer("draftkings") ??
    prefer("fanduel") ??
    bms.find((b) => (b.title ?? "").toLowerCase().includes("draftkings")) ??
    bms[0]
  );
}

function outcomeLabel(o: Outcome): string {
  const d = (o.description ?? "").trim();
  const n = (o.name ?? "").trim();
  if (d && n && n !== "Yes" && n !== "No") return `${n} · ${d}`;
  if (d) return d;
  return n || "—";
}

function readOpeningMap(sportKey: string): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(`${OPENING_STORAGE}:${sportKey}`);
    if (!raw) return {};
    const o = JSON.parse(raw) as Record<string, number>;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function persistOpeningMap(sportKey: string, map: Record<string, number>): void {
  try {
    sessionStorage.setItem(`${OPENING_STORAGE}:${sportKey}`, JSON.stringify(map));
  } catch {
    /* quota */
  }
}

function mergeOpenings(sportKey: string, rows: { name: string; odds: number }[]): Record<string, number> {
  const map = { ...readOpeningMap(sportKey) };
  let changed = false;
  for (const r of rows) {
    if (map[r.name] == null) {
      map[r.name] = r.odds;
      changed = true;
    }
  }
  if (changed) persistOpeningMap(sportKey, map);
  return map;
}

export type CollegeFuturesFetchResult = {
  meta: CollegeFuturesBoardMeta;
  outcomes: RawFuturesOutcome[];
};

function configById(id: CollegeSportId): CollegeFuturesSportConfig {
  const c = COLLEGE_FUTURES_SPORTS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown college sport: ${id}`);
  return c;
}

export async function fetchCollegeFuturesBoard(sportId: CollegeSportId): Promise<CollegeFuturesFetchResult> {
  const cfg = configById(sportId);
  const sportKey = resolveOddsSportKey(cfg);

  if (!isOddsApiAvailable()) {
    return {
      meta: {
        sport: sportId,
        leagueKey: cfg.leagueKey,
        sportKeyUsed: sportKey,
        marketName: `${cfg.competitionName} (futures)`,
        competitionName: cfg.competitionName,
        sportsbookKey: "—",
        sportsbookTitle: "—",
        externalEventId: null,
        marketType: COLLEGE_FUTURES_V1_MARKET,
        note: "no_api",
      },
      outcomes: [],
    };
  }

  const res = await fetchOddsForSport({
    sportKey,
    markets: "outrights",
    regions: "us",
    oddsFormat: "american",
  });

  if (!res.ok) {
    return {
      meta: {
        sport: sportId,
        leagueKey: cfg.leagueKey,
        sportKeyUsed: sportKey,
        marketName: `${cfg.competitionName} (futures)`,
        competitionName: cfg.competitionName,
        sportsbookKey: "—",
        sportsbookTitle: "—",
        externalEventId: null,
        marketType: COLLEGE_FUTURES_V1_MARKET,
        note: `http_${res.status}`,
      },
      outcomes: [],
    };
  }

  const events = (await res.json()) as OddsEvent[];
  if (!Array.isArray(events) || !events.length) {
    return {
      meta: {
        sport: sportId,
        leagueKey: cfg.leagueKey,
        sportKeyUsed: sportKey,
        marketName: `${cfg.competitionName} (futures)`,
        competitionName: cfg.competitionName,
        sportsbookKey: "—",
        sportsbookTitle: "—",
        externalEventId: null,
        marketType: COLLEGE_FUTURES_V1_MARKET,
        note: "empty",
      },
      outcomes: [],
    };
  }

  const ev = events[0];
  const bm = pickUsBook(ev.bookmakers);
  if (!bm?.markets?.length) {
    return {
      meta: {
        sport: sportId,
        leagueKey: cfg.leagueKey,
        sportKeyUsed: sportKey,
        marketName: ev.sport_title?.trim() || cfg.competitionName,
        competitionName: cfg.competitionName,
        sportsbookKey: "—",
        sportsbookTitle: "—",
        externalEventId: ev.id ?? null,
        marketType: COLLEGE_FUTURES_V1_MARKET,
        note: "no_book",
      },
      outcomes: [],
    };
  }

  const outright =
    bm.markets.find((m) => (m.key ?? "").toLowerCase() === "outrights") ?? bm.markets[0];
  const outs = outright.outcomes;
  if (!outs?.length) {
    return {
      meta: {
        sport: sportId,
        leagueKey: cfg.leagueKey,
        sportKeyUsed: sportKey,
        marketName: ev.sport_title?.trim() || cfg.competitionName,
        competitionName: cfg.competitionName,
        sportsbookKey: bm.key ?? "unknown",
        sportsbookTitle: bm.title ?? bm.key ?? "Sportsbook",
        externalEventId: ev.id ?? null,
        marketType: COLLEGE_FUTURES_V1_MARKET,
        note: "no_outcomes",
      },
      outcomes: [],
    };
  }

  const outcomes: RawFuturesOutcome[] = [];
  for (const o of outs) {
    const selectionName = outcomeLabel(o);
    const americanOdds = Number(o.price);
    if (!selectionName || selectionName === "—" || !Number.isFinite(americanOdds)) continue;
    outcomes.push({
      selectionName,
      teamId: null,
      americanOdds,
    });
  }

  mergeOpenings(
    sportKey,
    outcomes.map((r) => ({ name: r.selectionName, odds: r.americanOdds }))
  );

  return {
    meta: {
      sport: sportId,
      leagueKey: cfg.leagueKey,
      sportKeyUsed: sportKey,
      marketName: ev.sport_title?.trim() || cfg.competitionName,
      competitionName: cfg.competitionName,
      sportsbookKey: bm.key ?? "unknown",
      sportsbookTitle: bm.title ?? bm.key ?? "Sportsbook",
      externalEventId: ev.id ?? null,
      marketType: COLLEGE_FUTURES_V1_MARKET,
    },
    outcomes,
  };
}

export function getStoredOpeningOdds(sportKey: string, selectionName: string): number | null {
  const v = readOpeningMap(sportKey)[selectionName];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function formatAmericanOdds(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n > 0) return `+${Math.round(n)}`;
  return String(Math.round(n));
}

/** Devig: normalize raw implieds so they sum to 1 (proportional). */
export function devigImpliedProbs(implieds: number[]): number[] {
  const s = implieds.reduce((a, b) => a + b, 0);
  if (s <= 1e-9) return implieds.map(() => 1 / implieds.length);
  return implieds.map((p) => p / s);
}

export function lineMovementImpliedDelta(openingAmerican: number | null, currentAmerican: number): number | null {
  if (openingAmerican == null || !Number.isFinite(openingAmerican)) return null;
  const o = americanToImpliedProb(openingAmerican);
  const c = americanToImpliedProb(currentAmerican);
  return Math.round((c - o) * 1000) / 1000;
}
