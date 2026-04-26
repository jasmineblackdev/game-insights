import type { League } from "@/data/mockGames";
import { getLearnedEdgeFloor, getSportEngineLearningState } from "@/lib/predictionLearningStorage";

/** Sport floors for “value still alive” / ranking / recommendations (GameLens v2). */
export const VALUE_GONE_EDGE_BY_SPORT: Record<League, number> = {
  nba: 0.03,
  wnba: 0.03,
  nfl: 0.03,
  mlb: 0.02,
  boxing: 0.04,
  mma: 0.04,
};

/** Dynamic band ceilings when calibration lifts floors. */
const EDGE_CEILING: Record<League, number> = {
  nba: 0.05,
  wnba: 0.05,
  nfl: 0.05,
  mlb: 0.04,
  boxing: 0.06,
  mma: 0.06,
};

const UNDERPERFORM_MIN_N: Record<League, number> = {
  nba: 42,
  wnba: 30,
  nfl: 42,
  mlb: 30,
  boxing: 20,
  mma: 20,
};

const UNDERPERFORM_BOOST: Record<League, number> = {
  nba: 0.0035,
  wnba: 0.0035,
  nfl: 0.0035,
  mlb: 0.005,
  boxing: 0.005,
  mma: 0.005,
};

/** Hit-rate ceiling before we ask for extra edge (MLB/combat lines are noisier). */
const UNDERPERFORM_HIT_EMA: Record<League, number> = {
  nba: 0.501,
  wnba: 0.501,
  nfl: 0.501,
  mlb: 0.508,
  boxing: 0.51,
  mma: 0.51,
};

export function defaultMinEdgeForRecommend(league: League): number {
  const base = VALUE_GONE_EDGE_BY_SPORT[league];
  const ceil = EDGE_CEILING[league];
  const learned = getLearnedEdgeFloor(league);
  const eng = getSportEngineLearningState(league);
  const minN = UNDERPERFORM_MIN_N[league];
  const hitCeil = UNDERPERFORM_HIT_EMA[league];
  const underperformBoost =
    eng.n >= minN && eng.hitEma < hitCeil ? UNDERPERFORM_BOOST[league] : 0;
  let overperformTrim = eng.n >= 80 && eng.hitEma > 0.585 ? -0.0015 : 0;
  if (league === "nba" && eng.n >= 44 && eng.hitEma > 0.568) {
    overperformTrim = Math.min(overperformTrim, -0.0022);
  }
  return Math.min(ceil, Math.max(base, learned + underperformBoost + overperformTrim));
}

/** True when edge is below sport floor — treat as value gone for ranking / parlay. */
export function isEdgeBelowSportFloor(league: League, edge: number): boolean {
  return edge < VALUE_GONE_EDGE_BY_SPORT[league];
}
