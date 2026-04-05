/**
 * NFL draft / futures lines via the-odds-api.com (outrights markets).
 * DraftKings-style boards are not guaranteed to exist in the catalog year-round;
 * set VITE_THE_ODDS_API_NFL_DRAFT_SPORT_KEY if discovery fails.
 */

const BASE = "https://api.the-odds-api.com/v4";

export type DraftOddsRow = { label: string; american: number };

export type DraftOddsSection = {
  title: string;
  book: string;
  rows: DraftOddsRow[];
};

export type DraftOddsFetchResult = {
  sections: DraftOddsSection[];
  sportKey?: string;
  note?: string;
};

type SportRow = { key?: string; title?: string; active?: boolean; has_outrights?: boolean };

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

function getKey(): string | null {
  const k = (import.meta.env.VITE_THE_ODDS_API_KEY as string | undefined)?.trim();
  return k || null;
}

/** True when the app was built with a The Odds API key (NFL draft strip uses this). */
export function hasTheOddsApiKey(): boolean {
  return Boolean(getKey());
}

function envDraftSportKey(): string | null {
  const k = (import.meta.env.VITE_THE_ODDS_API_NFL_DRAFT_SPORT_KEY as string | undefined)?.trim();
  return k || null;
}

function pickDraftKings(bms: Bookmaker[] | undefined): Bookmaker | undefined {
  if (!bms?.length) return undefined;
  return (
    bms.find((b) => (b.key ?? "").toLowerCase().includes("draftkings")) ??
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

function eventTitle(ev: OddsEvent, i: number): string {
  const h = (ev.home_team ?? "").trim();
  const a = (ev.away_team ?? "").trim();
  if (h && a) return `${h} / ${a}`;
  if (h) return h;
  if (a) return a;
  return ev.sport_title?.trim() || `Draft market ${i + 1}`;
}

function parseEventToSection(ev: OddsEvent, index: number): DraftOddsSection | null {
  const bm = pickDraftKings(ev.bookmakers);
  if (!bm?.markets?.length) return null;

  const outright =
    bm.markets.find((m) => (m.key ?? "").toLowerCase() === "outrights") ?? bm.markets[0];
  const outs = outright.outcomes;
  if (!outs?.length) return null;

  const rows: DraftOddsRow[] = outs
    .map((o) => {
      const label = outcomeLabel(o);
      const american = Number(o.price);
      if (!label || label === "—" || !Number.isFinite(american)) return null;
      return { label, american };
    })
    .filter((x): x is DraftOddsRow => x != null);

  if (!rows.length) return null;

  return {
    title: eventTitle(ev, index),
    book: bm.title ?? bm.key ?? "Sportsbook",
    rows,
  };
}

/**
 * Discover sport key: explicit env first, then /sports?all=true match nfl+draft.
 */
export async function resolveNflDraftSportKey(apiKey: string): Promise<string | null> {
  const fixed = envDraftSportKey();
  if (fixed) return fixed;

  const res = await fetch(`${BASE}/sports/?all=true&apiKey=${encodeURIComponent(apiKey)}`);
  if (!res.ok) return null;
  const list = (await res.json()) as SportRow[];
  if (!Array.isArray(list)) return null;

  const match = list.find((s) => {
    if (s.active === false) return false;
    const key = (s.key ?? "").toLowerCase();
    const title = (s.title ?? "").toLowerCase();
    const combined = `${key} ${title}`;
    if (!combined.includes("nfl") && !key.includes("americanfootball_nfl")) return false;
    if (!combined.includes("draft")) return false;
    return true;
  });

  return match?.key ?? null;
}

/**
 * Fetch outrights-style odds for the given sport (NFL draft when available).
 */
export async function fetchNflDraftOddsBoard(): Promise<DraftOddsFetchResult> {
  const apiKey = getKey();
  if (!apiKey) {
    return { sections: [], note: "no_api_key" };
  }

  try {
    const sportKey = await resolveNflDraftSportKey(apiKey);
    if (!sportKey) {
      return {
        sections: [],
        note: "no_sport",
      };
    }

    const url = `${BASE}/sports/${encodeURIComponent(sportKey)}/odds?regions=us&markets=outrights&oddsFormat=american&apiKey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) {
      return { sections: [], sportKey, note: `http_${res.status}` };
    }

    const events = (await res.json()) as OddsEvent[];
    if (!Array.isArray(events) || !events.length) {
      return { sections: [], sportKey, note: "empty" };
    }

    const sections: DraftOddsSection[] = [];
    events.forEach((ev, i) => {
      const sec = parseEventToSection(ev, i);
      if (sec) sections.push(sec);
    });

    if (!sections.length) {
      return { sections: [], sportKey, note: "no_outcomes" };
    }

    return { sections, sportKey };
  } catch {
    return { sections: [], note: "error" };
  }
}

export function formatAmericanOdds(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n > 0) return `+${Math.round(n)}`;
  return String(Math.round(n));
}
