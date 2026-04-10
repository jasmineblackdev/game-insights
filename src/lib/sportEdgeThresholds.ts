import type { League } from "@/data/mockGames";
import { getLearnedEdgeFloor } from "@/lib/predictionLearningStorage";

/** Sport floors for “value still alive” / ranking / recommendations (GameLens v2). */
export const VALUE_GONE_EDGE_BY_SPORT: Record<League, number> = {
  nba: 0.03,
  nfl: 0.03,
  mlb: 0.02,
  soccer: 0.02,
};

/** Dynamic band ceilings when calibration lifts floors. */
const EDGE_CEILING: Record<League, number> = {
  nba: 0.05,
  nfl: 0.05,
  mlb: 0.04,
  soccer: 0.04,
};

export function defaultMinEdgeForRecommend(league: League): number {
  const base = VALUE_GONE_EDGE_BY_SPORT[league];
  const ceil = EDGE_CEILING[league];
  const learned = getLearnedEdgeFloor(league);
  return Math.min(ceil, Math.max(base, learned));
}

/** True when edge is below sport floor — treat as value gone for ranking / parlay. */
export function isEdgeBelowSportFloor(league: League, edge: number): boolean {
  return edge < VALUE_GONE_EDGE_BY_SPORT[league];
}
