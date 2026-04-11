/**
 * Player Edge types, filters, and utilities.
 * All predictions are sourced live from ESPN (NBA/MLB) and The Odds API (Boxing/MMA).
 */

import type { PlayerPropInput } from "@/lib/edgeCardScoring";

export type PlayerEdgeSportFilter = "all" | "NBA" | "NFL" | "MLB" | "Boxing" | "MMA";

export type PlayerEdgeStatFilter =
  | "all"
  // NBA
  | "points" | "rebounds" | "assists" | "pra" | "threes"
  // NFL
  | "passing_yards" | "rushing_yards" | "receiving_yards" | "receptions"
  // MLB
  | "strikeouts" | "hits" | "total_bases"
  // Combat sports
  | "fight_winner" | "ko_tko" | "decision" | "total_rounds" | "goes_distance";

export type PlayerRiskTier = "safe" | "balanced" | "high_upside" | "longshot";

export type PlayerConsistencyLabel = "stable" | "medium" | "volatile";

export type PlayerEdgePrediction = PlayerPropInput & {
  game_sort: number;
  confidence_score_0_100?: number;
  explanations?: string[];
  risk_tier?: PlayerRiskTier;
  consistency_label?: PlayerConsistencyLabel;
  trend_note?: string;
  /** "Pregame" | "After Q1" | "After 5th" | "After R1" */
  timing_note?: string;
  /** Composite AI ranking score 0–100 */
  player_edge_score?: number;
};

const CONF_RANK = { HIGH: 0, MED: 1, LOW: 2 } as const;

export function statFilterLabel(f: PlayerEdgeStatFilter): string {
  const labels: Record<PlayerEdgeStatFilter, string> = {
    all: "All",
    points: "Points",
    rebounds: "Rebounds",
    assists: "Assists",
    pra: "PRA",
    threes: "3-Pointers",
    passing_yards: "Passing Yards",
    rushing_yards: "Rushing Yards",
    receiving_yards: "Receiving Yards",
    receptions: "Receptions",
    strikeouts: "Strikeouts",
    hits: "Hits",
    total_bases: "Total Bases",
    fight_winner: "Fight Winner",
    ko_tko: "KO/TKO",
    decision: "Decision",
    total_rounds: "Total Rounds",
    goes_distance: "Goes Distance",
  };
  return labels[f];
}

/**
 * Compute composite player edge score from available fields.
 * player_edge_score = (model_edge * 0.30) + (projection_confidence * 0.20)
 *   + (matchup_advantage * 0.15) + (role_stability * 0.10)
 *   + (recent_form * 0.10) + (market_value * 0.10) - (volatility_penalty * 0.05)
 */
export function computePlayerEdgeScore(pred: PlayerEdgePrediction): number {
  if (pred.player_edge_score != null) return pred.player_edge_score;

  // Normalize edge to 0–1 by sport
  const maxEdge = pred.sport === "NBA" ? 8 : pred.sport === "NFL" ? 30 : pred.sport === "MLB" ? 3 : 15;
  const model_edge = Math.min(1, Math.abs(pred.edge) / maxEdge);

  const rawConf = pred.confidence_score_0_100
    ?? (pred.confidence === "HIGH" ? 72 : pred.confidence === "MED" ? 58 : 44);
  const projection_confidence = rawConf / 100;

  const matchup_advantage =
    pred.confidence === "HIGH" ? 1.0 : pred.confidence === "MED" ? 0.6 : 0.3;

  const role_stability =
    pred.consistency_label === "stable" ? 1.0
    : pred.consistency_label === "medium" ? 0.6
    : 0.2;

  const recent_form = pred.trend_note ? 0.8 : 0.5;

  const market_value =
    pred.risk_tier === "safe" ? 0.7
    : pred.risk_tier === "high_upside" ? 1.0
    : pred.risk_tier === "longshot" ? 0.9
    : 0.6;

  const volatility_penalty =
    pred.consistency_label === "volatile" ? 1.0
    : pred.consistency_label === "medium" ? 0.5
    : 0;

  return (
    model_edge * 0.30
    + projection_confidence * 0.20
    + matchup_advantage * 0.15
    + role_stability * 0.10
    + recent_form * 0.10
    + market_value * 0.10
    - volatility_penalty * 0.05
  ) * 100;
}

export function sortPlayerEdgePredictions(list: PlayerEdgePrediction[]): PlayerEdgePrediction[] {
  return [...list].sort((a, b) => {
    const as = computePlayerEdgeScore(a);
    const bs = computePlayerEdgeScore(b);
    if (Math.abs(as - bs) > 0.5) return bs - as;
    const cr = CONF_RANK[a.confidence] - CONF_RANK[b.confidence];
    if (cr !== 0) return cr;
    return Math.abs(b.edge) - Math.abs(a.edge);
  });
}

export function filterPlayerEdgePredictions(
  list: PlayerEdgePrediction[],
  sport: PlayerEdgeSportFilter,
  stat: PlayerEdgeStatFilter
): PlayerEdgePrediction[] {
  return list.filter((p) => {
    if (sport !== "all" && p.sport !== sport) return false;
    if (stat !== "all" && p.stat_type !== stat) return false;
    return true;
  });
}

/** No-op kept for backwards compat. */
export function getPlayerEdgeById(_id: string): PlayerEdgePrediction | undefined {
  return undefined;
}
