import type { GamePrediction } from "@/data/mockGames";

const apiKey = import.meta.env.VITE_THE_ODDS_API_KEY as string | undefined;

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

export async function mergeTheOddsApiNotes(
  predictions: GamePrediction[],
  sportKey: "basketball_nba" | "americanfootball_nfl" | "baseball_mlb" | "soccer_epl"
): Promise<GamePrediction[]> {
  if (!apiKey) return predictions;
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?regions=us&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
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
      if (parts.length < 2) return p;
      const line = parts.join(" · ");
      const notes = [...(p.enrichmentNotes ?? [])];
      if (!notes.some((n) => n.includes("Odds API"))) notes.push(line);
      return { ...p, enrichmentNotes: notes };
    });
  } catch {
    return predictions;
  }
}
