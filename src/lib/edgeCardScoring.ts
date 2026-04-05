import type { ConfidenceLevel, GamePrediction, League } from "@/data/mockGames";

export type EdgeSide = "home" | "away";
export type EdgeCardSize = 3 | 4 | 6;

export interface EdgeHubFilters {
  leagues: League[] | "all";
  minConfidence: "any" | ConfidenceLevel;
  excludeQuestionableInjuries: boolean;
  excludeUnconfirmedPitchers: boolean;
  excludeHighVolatility: boolean;
}

export const defaultEdgeHubFilters: EdgeHubFilters = {
  leagues: "all",
  minConfidence: "any",
  excludeQuestionableInjuries: false,
  excludeUnconfirmedPitchers: false,
  excludeHighVolatility: false,
};

export interface EdgePickFlags {
  injuryUncertainty: boolean;
  pitcherUnconfirmed: boolean;
  highVolatility: boolean;
  soccerDrawHeavy: boolean;
}

export interface EdgeSlipSnapshot {
  homeAbbr: string;
  awayAbbr: string;
  pickedAbbr: string;
  opponentAbbr: string;
  winProb: number;
  confidence: ConfidenceLevel;
  pickScore: number;
  topReason: string;
  topRisk: string;
  keyEdge: string;
  lastUpdated: string;
}

export interface EdgeSlipItem {
  gameId: string;
  league: League;
  side: EdgeSide;
  addedAt: string;
  snapshot: EdgeSlipSnapshot;
}

export interface EdgeHistoryEntry {
  id: string;
  savedAt: string;
  size: EdgeCardSize;
  items: EdgeSlipItem[];
  aggregateConfidence: ConfidenceLevel;
  riskLabel: string;
}

export interface EdgeCandidate {
  game: GamePrediction;
  side: EdgeSide;
  pickScore: number;
  winProbability: number;
  flags: EdgePickFlags;
}

export function getWinProbForSide(game: GamePrediction, side: EdgeSide): number {
  if (game.threeWay) {
    return side === "home" ? game.threeWay.home : game.threeWay.away;
  }
  return side === "home" ? game.winProbability.home : game.winProbability.away;
}

export function getFavoredSide(game: GamePrediction): EdgeSide {
  if (game.threeWay) {
    return game.threeWay.home >= game.threeWay.away ? "home" : "away";
  }
  return game.winProbability.home >= game.winProbability.away ? "home" : "away";
}

function confidenceStability(conf: ConfidenceLevel): number {
  if (conf === "high") return 14;
  if (conf === "medium") return 7;
  return 2;
}

/** Higher = more certain lineup / starter situation for the picked side. */
function lineupCertaintyBonus(game: GamePrediction, side: EdgeSide): number {
  if (game.league === "mlb" && game.mlb) {
    const pc = game.mlb.pitcherCertainty;
    if (pc === "confirmed") return 10;
    if (pc === "probable") return 5;
    return 0;
  }
  const inj = side === "home" ? game.injuries.home : game.injuries.away;
  const bad = inj.filter((i) => i.status === "QUESTIONABLE" || i.status === "GTD" || i.status === "OUT");
  const q = bad.filter((i) => i.status !== "OUT").length;
  const out = bad.filter((i) => i.status === "OUT").length;
  return Math.max(0, 6 - q * 2 - out * 3);
}

function injuryVolatilityPenalty(game: GamePrediction, side: EdgeSide): number {
  const inj = side === "home" ? game.injuries.home : game.injuries.away;
  let p = 0;
  for (const i of inj) {
    if (i.status === "OUT" && i.impactScore >= 6) p += 8;
    else if (i.status === "OUT") p += 4;
    else if (i.status === "QUESTIONABLE" || i.status === "GTD") p += 6;
    else if (i.status === "PROBABLE") p += 1;
  }
  return Math.min(p, 22);
}

function marketVolatility(game: GamePrediction, side: EdgeSide): number {
  let v = 0;
  if (game.confidence === "low") v += 10;
  else if (game.confidence === "medium") v += 3;

  const p = getWinProbForSide(game, side);
  if (p >= 38 && p <= 58) v += 8;

  const sp = game.lines?.spreadNum;
  if (sp != null && Math.abs(sp) <= 1.5) v += 5;

  if (game.league === "soccer" && game.threeWay) {
    v += game.threeWay.draw * 0.12;
    if (game.threeWay.draw >= 28) v += 6;
  }

  if (game.soccer?.congestion) {
    const { homeLast7, awayLast7 } = game.soccer.congestion;
    const d = Math.abs(homeLast7 - awayLast7);
    if (d >= 2) v += 5;
  }

  return v;
}

export function computePickFlags(game: GamePrediction, side: EdgeSide): EdgePickFlags {
  const inj = side === "home" ? game.injuries.home : game.injuries.away;
  const injuryUncertainty = inj.some((i) => i.status === "QUESTIONABLE" || i.status === "GTD");
  const pitcherUnconfirmed =
    game.league === "mlb" && game.mlb != null && game.mlb.pitcherCertainty !== "confirmed";
  const vol = marketVolatility(game, side);
  const highVolatility = vol >= 18;
  const soccerDrawHeavy = Boolean(game.threeWay && game.threeWay.draw >= 28);
  return { injuryUncertainty, pitcherUnconfirmed, highVolatility, soccerDrawHeavy };
}

/**
 * Internal ranking: win% + confidence stability + lineup certainty − injury noise − market volatility.
 */
export function computePickScore(game: GamePrediction, side: EdgeSide): number {
  const win = getWinProbForSide(game, side);
  const conf = confidenceStability(game.confidence);
  const lineup = lineupCertaintyBonus(game, side);
  const injPen = injuryVolatilityPenalty(game, side);
  const vol = marketVolatility(game, side);
  const raw = win + conf + lineup - injPen * 0.45 - vol * 0.55;
  return Math.round(raw * 10) / 10;
}

export function buildCandidate(game: GamePrediction, side?: EdgeSide): EdgeCandidate {
  const s = side ?? getFavoredSide(game);
  return {
    game,
    side: s,
    pickScore: computePickScore(game, s),
    winProbability: getWinProbForSide(game, s),
    flags: computePickFlags(game, s),
  };
}

export function candidateToSlipItem(c: EdgeCandidate): EdgeSlipItem {
  const { game, side } = c;
  const picked = side === "home" ? game.homeTeam : game.awayTeam;
  const opp = side === "home" ? game.awayTeam : game.homeTeam;
  return {
    gameId: game.id,
    league: game.league,
    side,
    addedAt: new Date().toISOString(),
    snapshot: {
      homeAbbr: game.homeTeam.abbreviation,
      awayAbbr: game.awayTeam.abbreviation,
      pickedAbbr: picked.abbreviation,
      opponentAbbr: opp.abbreviation,
      winProb: c.winProbability,
      confidence: game.confidence,
      pickScore: c.pickScore,
      topReason: game.topReasons[0] ?? "",
      topRisk: game.riskFactors[0] ?? "",
      keyEdge: game.matchupEdges[0]?.description ?? game.keyMatchup,
      lastUpdated: game.lastUpdated,
    },
  };
}

function passesConfidence(game: GamePrediction, min: EdgeHubFilters["minConfidence"]): boolean {
  if (min === "any") return true;
  const order: ConfidenceLevel[] = ["low", "medium", "high"];
  return order.indexOf(game.confidence) >= order.indexOf(min);
}

function passesFilters(c: EdgeCandidate, f: EdgeHubFilters): boolean {
  const { game, side, flags } = c;
  if (f.leagues !== "all" && !f.leagues.includes(game.league)) return false;
  if (!passesConfidence(game, f.minConfidence)) return false;
  if (f.excludeQuestionableInjuries && flags.injuryUncertainty) return false;
  if (f.excludeUnconfirmedPitchers && flags.pitcherUnconfirmed) return false;
  if (f.excludeHighVolatility && flags.highVolatility) return false;
  return true;
}

export function rankCandidatesForHub(games: GamePrediction[], filters: EdgeHubFilters): EdgeCandidate[] {
  const out: EdgeCandidate[] = [];
  for (const g of games) {
    if (g.status !== "upcoming") continue;
    const c = buildCandidate(g);
    if (passesFilters(c, filters)) out.push(c);
  }
  return out.sort((a, b) => b.pickScore - a.pickScore);
}

const LEAGUE_ORDER: League[] = ["nba", "nfl", "mlb", "soccer"];

export function groupCandidatesByLeague(candidates: EdgeCandidate[]): Record<League, EdgeCandidate[]> {
  const acc: Record<League, EdgeCandidate[]> = {
    nba: [],
    nfl: [],
    mlb: [],
    soccer: [],
  };
  for (const c of candidates) {
    acc[c.game.league].push(c);
  }
  for (const l of LEAGUE_ORDER) {
    acc[l].sort((a, b) => b.pickScore - a.pickScore);
  }
  return acc;
}

/**
 * Auto-build with diversification: cap picks per league, then relax if under-filled.
 */
export function autoBuildEdgeSlip(candidates: EdgeCandidate[], size: EdgeCardSize): EdgeCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.pickScore - a.pickScore);
  const maxPerLeague = size >= 4 ? 2 : 3;
  const picked: EdgeCandidate[] = [];
  const leagueCount = new Map<League, number>();

  const tryAdd = (c: EdgeCandidate) => {
    if (picked.some((p) => p.game.id === c.game.id)) return false;
    const cnt = leagueCount.get(c.game.league) ?? 0;
    if (cnt >= maxPerLeague) return false;
    picked.push(c);
    leagueCount.set(c.game.league, cnt + 1);
    return true;
  };

  for (const c of sorted) {
    if (picked.length >= size) break;
    tryAdd(c);
  }

  if (picked.length < size) {
    for (const c of sorted) {
      if (picked.length >= size) break;
      if (picked.some((p) => p.game.id === c.game.id)) continue;
      picked.push(c);
    }
  }

  return picked.slice(0, size);
}

export function slipAggregateConfidence(items: { confidence: ConfidenceLevel }[]): ConfidenceLevel {
  if (!items.length) return "low";
  if (items.some((i) => i.confidence === "low")) return "low";
  if (items.some((i) => i.confidence === "medium")) return "medium";
  return "high";
}

export function slipRiskLabel(items: { flags: EdgePickFlags }[]): "elevated" | "moderate" | "controlled" {
  const anyPitch = items.some((i) => i.flags.pitcherUnconfirmed);
  const anyInj = items.some((i) => i.flags.injuryUncertainty);
  const anyVol = items.some((i) => i.flags.highVolatility || i.flags.soccerDrawHeavy);
  const n = [anyPitch, anyInj, anyVol].filter(Boolean).length;
  if (n >= 2) return "elevated";
  if (n === 1) return "moderate";
  return "controlled";
}

/** Next best candidate not already on the slip (excludeIds includes all occupied game IDs). */
export function suggestReplacement(candidates: EdgeCandidate[], excludeIds: Set<string>): EdgeCandidate | null {
  const sorted = [...candidates].sort((a, b) => b.pickScore - a.pickScore);
  for (const c of sorted) {
    if (excludeIds.has(c.game.id)) continue;
    return c;
  }
  return null;
}
