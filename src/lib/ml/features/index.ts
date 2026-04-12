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
}): PropFeatureVector {
  const confToStability: Record<"HIGH" | "MED" | "LOW", number> = {
    HIGH: 0.80,
    MED: 0.55,
    LOW: 0.30,
  };

  return {
    type: "prop",
    sport: params.sport,
    context: "pregame",
    capturedAt: new Date().toISOString(),
    avg_last5: params.projected_value,      // Proxy: use projection as best-guess avg
    avg_last10: params.projected_value,
    season_avg: params.projected_value,
    opponent_rank: 15,                      // Neutral (middle of the range)
    usage_rate: 0.5,                        // Unknown
    minutes_projection: 0,
    pace_factor: 0,
    line_movement: 0,
    line_value: params.line_value,
    market_probability: params.market_probability,
    data_quality: 0.35,                     // Low quality — minimal features
    has_injury_flag: false,
    extra: {
      confidence_stability: confToStability[params.confidence],
      rules_edge: params.edge,
    },
  };
}
