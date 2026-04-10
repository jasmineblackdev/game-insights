/**
 * Per-game ranked live player props after sport checkpoints (mirrors team live pick gates).
 */
import type { GamePrediction, League } from "@/data/mockGames";
import {
  LIVE_PICK_RANK_MAX,
  mainScreenCheckpointLabel,
  passesMainScreenLivePickGate,
  selectLiveCheckpointRow,
} from "@/lib/livePickRanking";
import { buildPlayerPropProjectionsForGame } from "@/lib/valueParlay/playerPropEngine";
import type { PlayerPropModelRow } from "@/lib/valueParlay/types";
import { defaultMinEdgeForRecommend } from "@/lib/sportEdgeThresholds";

export type LiveRankedProp = {
  rank: number;
  checkpointLabel: string;
  badgeLine: string;
  playerName: string;
  statType: string;
  lineValue: number;
  recommendedSide: "OVER" | "UNDER";
  edgePct: number;
  confidenceLabel: string;
  liveSignalReason: string;
};

type Conf = PlayerPropModelRow["confidence"];

function confScore(c: Conf): number {
  if (c === "high") return 22;
  if (c === "medium") return 14;
  return 7;
}

function confLabel(c: Conf): string {
  if (c === "high") return "High";
  if (c === "medium") return "Medium";
  return "Low";
}

function margin(game: GamePrediction): number {
  const ls = game._meta?.liveState;
  if (!ls) return 0;
  return Math.abs(ls.homeScore - ls.awayScore);
}

function blowoutRiskPenalty(league: League, m: number): number {
  let tier = 0;
  switch (league) {
    case "nba":
      if (m >= 22) tier = 3;
      else if (m >= 14) tier = 2;
      else if (m >= 8) tier = 1;
      break;
    case "nfl":
      if (m >= 21) tier = 3;
      else if (m >= 14) tier = 2;
      else if (m >= 10) tier = 1;
      break;
    case "mlb":
      if (m >= 7) tier = 3;
      else if (m >= 5) tier = 2;
      else if (m >= 3) tier = 1;
      break;
    case "soccer":
      if (m >= 3) tier = 3;
      else if (m >= 2) tier = 2;
      else if (m >= 1) tier = 1;
      break;
    default:
      break;
  }
  return tier * 5.5;
}

function nbaPaceHeuristic(game: GamePrediction): { factor: number; label: string } {
  const ls = game._meta?.liveState;
  if (!ls) return { factor: 1, label: "" };
  const q = Math.max(0.5, ls.periodNum - (ls.isHalftime ? 0.4 : 0));
  const minutes = q * 12;
  const ppm = (ls.homeScore + ls.awayScore) / minutes;
  if (ppm >= 4.25) return { factor: 1.045, label: "Minutes pace elevated — counting stats trending up." };
  if (ppm <= 3.15) return { factor: 0.965, label: "Slow half-court pace — volume compressed." };
  return { factor: 1, label: "Pace neutral vs expectation." };
}

function nflScriptHeuristic(
  game: GamePrediction,
  row: PlayerPropModelRow
): { edgeBump: number; label: string; matchupBump: number } {
  const ls = game._meta?.liveState;
  if (!ls) return { edgeBump: 0, label: "", matchupBump: 0 };
  const homeLead = ls.homeScore - ls.awayScore;
  const trailing = row.teamAbbr === game.homeTeam.abbreviation ? homeLead < 0 : homeLead > 0;
  const leading = !trailing && homeLead !== 0;
  const passStat = row.statType.includes("pass") || row.statType === "points";
  const rushStat = row.statType.includes("rush");
  let edgeBump = 0;
  let matchupBump = 0;
  let label = "Game script balanced for usage.";
  if (trailing && passStat) {
    edgeBump = 0.012;
    matchupBump = 0.08;
    label = "Trailing script — pass / target share bias (heuristic).";
  } else if (leading && rushStat) {
    edgeBump = 0.008;
    matchupBump = 0.06;
    label = "Leading script — run volume bias (heuristic).";
  }
  return { edgeBump, label, matchupBump };
}

function mlbLiveHeuristic(game: GamePrediction, row: PlayerPropModelRow): { edgeBump: number; label: string } {
  const ls = game._meta?.liveState;
  if (!ls || game.league !== "mlb") return { edgeBump: 0, label: "" };
  const inn = ls.periodNum;
  let label = "Bullpen state stable for prop window.";
  let edgeBump = 0;
  if (inn >= 7) {
    edgeBump = row.statType === "hits" || row.statType === "runs" ? -0.006 : 0.004;
    label = "Late innings — fewer remaining PA; K pace & contact quality weigh more.";
  } else if (inn >= 5) {
    edgeBump = 0.004;
    label = "F5+ checkpoint — pitch count & strikeout pace inform rest-of-game.";
  }
  return { edgeBump, label };
}

function soccerHtHeuristic(game: GamePrediction, row: PlayerPropModelRow): { edgeBump: number; label: string } {
  if (game.league !== "soccer" || !game._meta?.liveState?.isHalftime) {
    return { edgeBump: 0, label: "" };
  }
  const shots = row.statType === "shots" || row.statType === "shots_on_target";
  return {
    edgeBump: shots ? 0.006 : 0.003,
    label: "Halftime — second-half shots / xG involvement & set-piece role repriced.",
  };
}

function findPlayerTrend(game: GamePrediction, row: PlayerPropModelRow): "hot" | "cold" | "steady" {
  const pool = [...game.playerTrends.home, ...game.playerTrends.away];
  const hit = pool.find((p) => p.name === row.playerName);
  return hit?.trend ?? "steady";
}

function recomputeEdgeFromProjected(
  projected: number,
  line: number,
  side: "OVER" | "UNDER"
): number {
  const z = (projected - line) / Math.max(1.2, projected * 0.18);
  const sig = 1 / (1 + Math.exp(-z * 1.4));
  const sideP = side === "OVER" ? sig : 1 - sig;
  const bookImplied = 0.524;
  return sideP - bookImplied;
}

function roleStability01(
  game: GamePrediction,
  row: PlayerPropModelRow,
  trend: "hot" | "cold" | "steady",
  blowoutTier: number
): number {
  let s = 0.52;
  if (trend === "steady") s += 0.12;
  if (trend === "hot") s += 0.06;
  if (row.volatilityScore < 38) s += 0.1;
  else if (row.volatilityScore > 48) s -= 0.08;
  const inj = [...game.injuries.home, ...game.injuries.away];
  if (inj.some((i) => i.status === "QUESTIONABLE" || i.status === "GTD")) s -= 0.1;
  if (game.league === "mlb" && game.mlb?.pitcherCertainty !== "confirmed") s -= 0.08;
  if (blowoutTier >= 2) s -= 0.12;
  if (game.league === "soccer" && game._meta?.liveState?.isHalftime) s -= 0.04;
  return Math.min(0.95, Math.max(0.18, s));
}

function matchupAdvantage01(
  game: GamePrediction,
  row: PlayerPropModelRow,
  league: League,
  nflExtra: number,
  nbaPaceF: number
): number {
  let m = 0.45;
  const hp = game.homeTeam.pace;
  const ap = game.awayTeam.pace;
  const avgP = (hp + ap) / 2;
  if (league === "nba" || league === "nfl") {
    if (avgP > 102) m += 0.12 * (nbaPaceF > 1 ? 1.2 : 1);
    else if (avgP < 98) m -= 0.06;
  }
  m += nflExtra;
  if (league === "soccer") m += 0.06;
  return Math.min(0.92, Math.max(0.2, m));
}

/**
 * live_prop_score =
 *   live_edge_score + confidence_score + role_stability_score + matchup_advantage_score
 *   - volatility_penalty - blowout_risk_penalty
 */
export function computeLivePropScore(args: {
  edge: number;
  propConfidence: Conf;
  volatilityScore: number;
  roleStability01: number;
  matchupAdvantage01: number;
  blowoutPenalty: number;
}): number {
  const live_edge_score = args.edge * 100;
  const confidence_score = confScore(args.propConfidence);
  const role_stability_score = args.roleStability01 * 20;
  const matchup_advantage_score = args.matchupAdvantage01 * 18;
  const volatility_penalty = args.volatilityScore * 0.12;
  const blowout_risk_penalty = args.blowoutPenalty;
  return (
    live_edge_score +
    confidence_score +
    role_stability_score +
    matchup_advantage_score -
    volatility_penalty -
    blowout_risk_penalty
  );
}

function adjustRowForLive(game: GamePrediction, row: PlayerPropModelRow): {
  adjustedEdge: number;
  adjustedConf: Conf;
  volatilityScore: number;
  roleStability01: number;
  matchupAdvantage01: number;
  blowoutPenalty: number;
  liveSignalReason: string;
} {
  const m = margin(game);
  const blowPen = blowoutRiskPenalty(game.league, m);
  const blowTier = blowPen >= 16 ? 3 : blowPen >= 11 ? 2 : blowPen > 0 ? 1 : 0;
  const trend = findPlayerTrend(game, row);

  let edge = row.edge;
  let projected = row.projectedValue;
  const reasons: string[] = [];
  let vol = row.volatilityScore;
  let nflMatchBump = 0;
  let nbaPaceF = 1;

  switch (game.league) {
    case "nba": {
      const { factor, label } = nbaPaceHeuristic(game);
      nbaPaceF = factor;
      if (label) reasons.push(label);
      projected *= factor;
      edge = recomputeEdgeFromProjected(projected, row.lineValue, row.recommendedSide);
      if (row.statType === "assists" && factor > 1)
        reasons.push("Assist opportunities track pace & usage (heuristic).");
      if (row.statType === "points" && blowTier >= 2)
        reasons.push("Blowout risk — rotation & foul trouble can cap minutes.");
      vol += blowTier >= 2 ? 7 : 0;
      if (blowTier >= 2 && row.recommendedSide === "OVER") vol += 6;
      break;
    }
    case "nfl": {
      const scr = nflScriptHeuristic(game, row);
      edge += scr.edgeBump;
      nflMatchBump = scr.matchupBump;
      reasons.push(scr.label);
      vol += blowTier >= 2 && row.statType.includes("rush") ? 6 : 0;
      if (blowTier >= 2 && row.recommendedSide === "OVER") vol += 5;
      break;
    }
    case "mlb": {
      const ml = mlbLiveHeuristic(game, row);
      edge += ml.edgeBump;
      if (ml.label) reasons.push(ml.label);
      if (row.statType === "home_runs")
        reasons.push("Contact quality & pitch count drive HR prop (heuristic).");
      vol += blowTier >= 1 ? 4 : 0;
      break;
    }
    case "soccer": {
      const sc = soccerHtHeuristic(game, row);
      edge += sc.edgeBump;
      if (sc.label) reasons.push(sc.label);
      reasons.push("Touches in box & sub risk modeled lightly until event feeds land.");
      vol += 4;
      break;
    }
    default:
      break;
  }

  let conf = row.confidence;
  if (edge < 0.04) conf = conf === "high" ? "medium" : "low";

  const rs = roleStability01(game, row, trend, blowTier);
  const ma = matchupAdvantage01(game, row, game.league, nflMatchBump, nbaPaceF);

  const defaults: Record<League, string> = {
    nba:
      row.statType === "assists"
        ? "Usage & assist opportunities follow live pace (heuristic)."
        : "Shot attempts & foul risk reflected in live repricing (heuristic).",
    nfl: "Snap share, target share & game script direction (heuristic).",
    mlb: "Pitch count, K pace & remaining AB context (heuristic).",
    soccer: "Shots / xG involvement & set-piece role at HT (heuristic).",
  };

  return {
    adjustedEdge: edge,
    adjustedConf: conf,
    volatilityScore: vol,
    roleStability01: rs,
    matchupAdvantage01: ma,
    blowoutPenalty: blowPen,
    liveSignalReason: reasons[0] ?? defaults[game.league],
  };
}

/**
 * Rank up to LIVE_PICK_RANK_MAX props for one game after checkpoint + min edge.
 */
export function buildLivePropRankingsForGame(game: GamePrediction): LiveRankedProp[] {
  if (!passesMainScreenLivePickGate(game)) return [];
  const cpRow = selectLiveCheckpointRow(game);
  if (!cpRow) return [];

  const minE =
    game._meta?.quality?.predictionIntel?.optimal_edge_threshold ?? defaultMinEdgeForRecommend(game.league);

  const base = buildPlayerPropProjectionsForGame(game);
  type Scored = { score: number; adj: ReturnType<typeof adjustRowForLive>; row: PlayerPropModelRow };
  const scored: Scored[] = [];

  for (const row of base) {
    const adj = adjustRowForLive(game, row);
    if (adj.adjustedEdge < minE) continue;
    const score = computeLivePropScore({
      edge: adj.adjustedEdge,
      propConfidence: adj.adjustedConf,
      volatilityScore: adj.volatilityScore,
      roleStability01: adj.roleStability01,
      matchupAdvantage01: adj.matchupAdvantage01,
      blowoutPenalty: adj.blowoutPenalty,
    });
    scored.push({ score, adj, row });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, LIVE_PICK_RANK_MAX);
  const checkpointLabel = mainScreenCheckpointLabel(game, cpRow);
  const badgeLine = `Live Edge • ${checkpointLabel}`;

  return top.map((s, i) => ({
    rank: i + 1,
    checkpointLabel,
    badgeLine,
    playerName: s.row.playerName,
    statType: s.row.statType,
    lineValue: s.row.lineValue,
    recommendedSide: s.row.recommendedSide,
    edgePct: Math.round(s.adj.adjustedEdge * 1000) / 10,
    confidenceLabel: confLabel(s.adj.adjustedConf),
    liveSignalReason: s.adj.liveSignalReason,
  }));
}
