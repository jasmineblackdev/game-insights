/**
 * Player Edge types, filters, and utilities.
 * Mock data has been removed — all predictions are sourced live from ESPN.
 * See src/lib/espnPlayerStats.ts for the live data fetcher.
 */

import type { PlayerPropInput } from "@/lib/edgeCardScoring";

export type PlayerEdgeSportFilter = "all" | "NBA" | "NFL" | "MLB" | "Soccer";

export type PlayerEdgeStatFilter =
  | "all"
  | "points"
  | "rebounds"
  | "assists"
  | "passing_yards"
  | "rushing_yards"
  | "receiving_yards"
  | "strikeouts"
  | "hits"
  | "total_bases"
  | "shots"
  | "shots_on_target";

export type PlayerRiskTier = "safe" | "balanced" | "high_upside" | "longshot";

export type PlayerConsistencyLabel = "stable" | "medium" | "volatile";

export type PlayerEdgePrediction = PlayerPropInput & {
  game_sort: number;
  confidence_score_0_100?: number;
  explanations?: string[];
  risk_tier?: PlayerRiskTier;
  consistency_label?: PlayerConsistencyLabel;
  trend_note?: string;
};

const CONF_RANK = { HIGH: 0, MED: 1, LOW: 2 } as const;

export function statFilterLabel(f: PlayerEdgeStatFilter): string {
  const labels: Record<PlayerEdgeStatFilter, string> = {
    all: "All",
    points: "Points",
    rebounds: "Rebounds",
    assists: "Assists",
    passing_yards: "Passing Yards",
    rushing_yards: "Rushing Yards",
    receiving_yards: "Receiving Yards",
    strikeouts: "Strikeouts",
    hits: "Hits",
    total_bases: "Total Bases",
    shots: "Shots",
    shots_on_target: "Shots on Target",
  };
  return labels[f];
}

export function sortPlayerEdgePredictions(list: PlayerEdgePrediction[]): PlayerEdgePrediction[] {
  return [...list].sort((a, b) => {
    const cr = CONF_RANK[a.confidence] - CONF_RANK[b.confidence];
    if (cr !== 0) return cr;
    const ae = Math.abs(a.edge);
    const be = Math.abs(b.edge);
    if (ae !== be) return be - ae;
    return a.game_sort - b.game_sort;
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

/** No-op kept for backwards compat — mock data removed, always returns undefined. */
export function getPlayerEdgeById(_id: string): PlayerEdgePrediction | undefined {
  return undefined;
}
