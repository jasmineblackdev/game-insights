/**
 * Feature extraction dispatcher.
 * Routes to the correct sport-specific extractor based on the sport field.
 *
 * Each sport extractor accepts raw data from the existing ESPN/odds API
 * pipeline and normalizes it into a PropFeatureVector for the ML models.
 *
 * Usage:
 *   const features = extractFeatures("nba", rawData);
 *
 * Raw data comes from:
 *  - NBA: espnPlayerStats.ts (player stat lines)
 *  - NFL: nflEspn.ts (snap/target share from boxscore)
 *  - MLB: mlbEspn.ts + mlbHistoricalFeatures.ts (pitcher rows, batting splits)
 *  - Boxing/MMA: boxingFetch.ts / mmaFetch.ts (fighter profiles + odds)
 */

export { extractNbaFeatures, type NbaPropRawData } from "@/lib/ml/features/nba";
export { extractNflFeatures, type NflPropRawData } from "@/lib/ml/features/nfl";
export { extractMlbFeatures, type MlbPropRawData } from "@/lib/ml/features/mlb";
export { extractCombatFeatures, type CombatPropRawData } from "@/lib/ml/features/combat";

import type { PropFeatureVector } from "@/lib/ml/types";
import type { MLSport } from "@/lib/ml/types";

/**
 * Minimal feature vector for when full raw data isn't available.
 * Uses the data already present on a PlayerEdgePrediction.
 *
 * This is the lightweight path used when the system has a prediction
 * but not full feature data — populates what it can and marks
 * data_quality accordingly.
 */
export function extractMinimalPropFeatures(params: {
  sport: MLSport;
  stat_type: string;
  line_value: number;
  projected_value: number;
  edge: number;
  confidence: "HIGH" | "MED" | "LOW";
  market_probability: number;
  /** Optional game-state features — populate when the fetcher has them. */
  is_home?: boolean;
  opponent_win_pct?: number;
  opponent_defensive_rating?: number;
  recent_form?: "hot" | "cold" | "steady";
  has_injury_flag?: boolean;
}): PropFeatureVector {
  const confToStability: Record<"HIGH" | "MED" | "LOW", number> = {
    HIGH: 0.80,
    MED: 0.55,
    LOW: 0.30,
  };

  // Opponent rank derived from win pct: 1 = best, 30 = worst.
  // 60%+ win pct → top tier (rank ~5); 50% → middle (15); 35% → bottom (25).
  const opponentRank = params.opponent_win_pct != null
    ? Math.max(1, Math.min(30, Math.round(30 - params.opponent_win_pct * 30)))
    : 15;

  // Recent form maps to a usage-rate proxy until a real model lands.
  // Hot players see more touches → higher usage; cold the opposite.
  const formUsage = params.recent_form === "hot"   ? 0.62
                  : params.recent_form === "cold"  ? 0.42
                  : 0.50;

  // Data quality grows with each available game-state field.
  let dq = 0.35;
  if (params.is_home != null)          dq += 0.05;
  if (params.opponent_win_pct != null) dq += 0.10;
  if (params.recent_form != null)      dq += 0.05;
  if (params.opponent_defensive_rating != null) dq += 0.05;

  return {
    type: "prop",
    sport: params.sport,
    context: "pregame",
    capturedAt: new Date().toISOString(),
    avg_last5: params.projected_value,
    avg_last10: params.projected_value,
    season_avg: params.projected_value,
    opponent_rank: opponentRank,
    usage_rate: formUsage,
    minutes_projection: 0,
    pace_factor: 0,
    line_movement: 0,
    line_value: params.line_value,
    market_probability: params.market_probability,
    data_quality: Math.min(0.85, dq),
    has_injury_flag: params.has_injury_flag ?? false,
    extra: {
      confidence_stability: confToStability[params.confidence],
      rules_edge: params.edge,
      // Pass through raw signals so models can use them when wired
      is_home: params.is_home ? 1 : 0,
      opponent_win_pct: params.opponent_win_pct ?? 0.5,
      opponent_defensive_rating: params.opponent_defensive_rating ?? 0,
      recent_form_score: params.recent_form === "hot"  ? 1
                       : params.recent_form === "cold" ? -1 : 0,
    },
  };
}
