import type { GamePrediction } from "@/data/mockGames";
import { buildLivePickOverlays, passesMainScreenLivePickGate } from "@/lib/livePickRanking";
import { computePickFlags, getFavoredSide, type EdgeSide } from "@/lib/edgeCardScoring";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import { buildAllValueCandidates } from "@/lib/valueParlay/buildCandidates";
import { optimizeFixedLegCount } from "@/lib/valueParlay/parlayOptimizer";
import type { SmartParlayResult, ValueBetCandidate } from "@/lib/valueParlay/types";

function primarySide(game: GamePrediction): EdgeSide {
  const ps = game._meta?.bettingIntel?.pickSide;
  if (ps === "home" || ps === "away") return ps;
  return getFavoredSide(game);
}

function passesLiveComboFilters(game: GamePrediction, c: ValueBetCandidate): boolean {
  if (!passesMainScreenLivePickGate(game)) return false;
  const side = primarySide(game);
  const flags = computePickFlags(game, side);
  if (game.league === "mlb" && flags.pitcherUnconfirmed) return false;
  if (game._meta?.quality?.market?.sharp_move_hint) return false;
  const mss = game._meta?.quality?.market?.market_signal_strength;
  if (typeof mss === "number" && mss >= 78) return false;
  if (c.volatilityScore >= 58 && c.edge <= 0.08) return false;
  return true;
}

function moneylinesForGame(game: GamePrediction, candidates: ValueBetCandidate[]): ValueBetCandidate[] {
  return candidates.filter(
    (x) => x.gameId === game.id && x.pickType === "team_pick" && x.marketType === "moneyline"
  );
}

function pickCandidateForRankedGame(
  game: GamePrediction,
  candidates: ValueBetCandidate[]
): ValueBetCandidate | null {
  const mls = moneylinesForGame(game, candidates);
  if (!mls.length) return null;

  const ps = game._meta?.bettingIntel?.pickSide;
  let c: ValueBetCandidate | undefined;
  if (ps === "home" || ps === "away") {
    const abbr = ps === "home" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
    c = mls.find((x) => x.teamId === abbr);
  } else if (ps === "draw") {
    c = mls.reduce((a, b) => (b.edge > a.edge ? b : a));
  } else {
    const side = getFavoredSide(game);
    const abbr = side === "home" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
    c = mls.find((x) => x.teamId === abbr);
  }
  if (!c || !passesLiveComboFilters(game, c)) return null;
  return c;
}

/** Ordered moneyline legs aligned with main-screen Pick 1–6 (live + checkpoint met). */
export function buildRankedLiveMoneylinePool(
  games: GamePrediction[],
  oddsMap: Map<string, GameOddsBundle>
): ValueBetCandidate[] {
  const live = games.filter((g) => g.status === "live");
  const overlays = buildLivePickOverlays(live);
  const ranked = [...overlays.entries()]
    .flatMap(([id, o]) => (o.kind === "ranked" ? [{ id, rank: o.rank }] : []))
    .sort((a, b) => a.rank - b.rank);

  const all = buildAllValueCandidates(games, oddsMap);
  const pool: ValueBetCandidate[] = [];
  const seen = new Set<string>();
  for (const { id: gid } of ranked) {
    const g = games.find((x) => x.id === gid);
    if (!g) continue;
    const c = pickCandidateForRankedGame(g, all);
    if (!c || seen.has(c.id)) continue;
    pool.push(c);
    seen.add(c.id);
  }
  return pool;
}

export function rankedLiveOptimizedCombos(
  games: GamePrediction[],
  oddsMap: Map<string, GameOddsBundle>
): { n: 3 | 4 | 6; result: SmartParlayResult | null }[] {
  const pool = buildRankedLiveMoneylinePool(games, oddsMap);
  return [
    { n: 3 as const, result: optimizeFixedLegCount(pool, 3, 4) },
    { n: 4 as const, result: optimizeFixedLegCount(pool, 4, 4) },
    { n: 6 as const, result: optimizeFixedLegCount(pool, 6, 4) },
  ];
}

export type LegSwapHints = {
  lowerRiskAlternative: ValueBetCandidate | null;
  higherValueAlternative: ValueBetCandidate | null;
};

/** Same-game ML alternatives for swap copy / actions. */
export function legSwapHints(
  leg: ValueBetCandidate,
  allCandidates: ValueBetCandidate[]
): LegSwapHints {
  const siblings = allCandidates.filter(
    (c) =>
      c.gameId === leg.gameId &&
      c.id !== leg.id &&
      c.pickType === "team_pick" &&
      c.marketType === "moneyline" &&
      c.edge > 0 &&
      c.confidence !== "low"
  );
  if (!siblings.length) return { lowerRiskAlternative: null, higherValueAlternative: null };

  const lowerRiskAlternative =
    siblings
      .filter((c) => c.riskScore < leg.riskScore - 2)
      .sort((a, b) => a.riskScore - b.riskScore)[0] ?? null;

  const higherValueAlternative =
    siblings
      .filter((c) => c.valueScore > leg.valueScore + 0.04)
      .sort((a, b) => b.valueScore - a.valueScore)[0] ?? null;

  return { lowerRiskAlternative, higherValueAlternative };
}
