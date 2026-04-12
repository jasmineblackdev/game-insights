/**
 * NBA feature extraction for the ML layer.
 *
 * Features for NBA player prop predictions:
 *   - Expected minutes (primary driver)
 *   - Usage rate (how much of team offense flows through this player)
 *   - Team pace (possessions per 48 minutes)
 *   - Blowout risk (blowouts reduce minutes/usage for starters)
 *   - Injury context (teammate out = usage boost)
 *   - Recent form vs season average
 *   - Matchup defense (opponent defensive rating for the stat type)
 */

import type { PropFeatureVector } from "@/lib/ml/types";

export interface NbaPropRawData {
  player_name: string;
  stat_type: string;          // "points" | "rebounds" | "assists" | etc.
  line_value: number;
  projected_value: number;
  avg_last5: number;
  avg_last10: number;
  season_avg: number;
  // Opportunity
  minutes_projection: number; // Expected minutes this game
  usage_rate: number;         // 0–1 fraction of team possessions used
  team_pace: number;          // Possessions per 48 min (league avg ≈ 100)
  // Defense
  opponent_defensive_rank: number; // 1 (best defense) → 30 (worst)
  // Market
  opening_line: number;
  current_line: number;
  market_probability: number; // Juice-removed probability from sportsbook
  // Context
  blowout_risk: number;       // 0–1 from prediction model (high = garbage time risk)
  teammate_injury_boost: boolean; // Key teammate out = usage boost
  has_injury_flag: boolean;
  is_back_to_back: boolean;
}

/**
 * Opponent defense rank (1–30) → matchup difficulty multiplier.
 * Rank 1 = best defense (opponent_rank=1) → 0.85x (harder)
 * Rank 30 = worst defense → 1.15x (easier)
 */
function defRankToMultiplier(rank: number): number {
  // Linear interpolation: rank 1 → 0.85, rank 30 → 1.15
  return 0.85 + (rank - 1) / 29 * 0.30;
}

/**
 * Minutes projection adjustment for blowout risk.
 * High blowout risk reduces projected value (garbage time).
 */
function blowoutPenalty(blowoutRisk: number, statType: string): number {
  // Points/minutes affected more than rebounds/assists in blowouts
  const sensitivity = statType === "points" ? 1.0 : statType === "assists" ? 0.7 : 0.5;
  return blowoutRisk * 0.15 * sensitivity;
}

export function extractNbaFeatures(raw: NbaPropRawData): PropFeatureVector {
  // Usage rate as 0–1 (may already be in decimal or percent)
  const usage = raw.usage_rate > 1 ? raw.usage_rate / 100 : raw.usage_rate;

  // Normalize pace: league avg ≈ 100, range roughly 95–115
  const paceNorm = (raw.team_pace - 100) / 10; // Centered, roughly -0.5 to +1.5

  // Line movement signal: positive = line moved up (harder to hit Over)
  const lineDelta = raw.current_line - raw.opening_line;
  const lineMoveNorm = Math.max(-3, Math.min(3, lineDelta)) / 3;

  // Back-to-back penalty (fatigued)
  const b2bPenalty = raw.is_back_to_back ? 0.93 : 1.0;

  // Teammate injury usage boost
  const injuryBoost = raw.teammate_injury_boost ? 1.10 : 1.0;

  // Opponent matchup multiplier
  const matchupMult = defRankToMultiplier(raw.opponent_defensive_rank);

  // Blowout risk
  const blowout = blowoutPenalty(raw.blowout_risk, raw.stat_type);

  // Data quality: how many features we actually have meaningful values for
  const dataQualityChecks = [
    raw.minutes_projection > 0,
    raw.usage_rate > 0,
    raw.avg_last5 > 0,
    raw.avg_last10 > 0,
    raw.season_avg > 0,
    raw.opponent_defensive_rank > 0,
    raw.market_probability > 0,
  ];
  const dataQuality = dataQualityChecks.filter(Boolean).length / dataQualityChecks.length;

  return {
    type: "prop",
    sport: "nba",
    context: "pregame",
    capturedAt: new Date().toISOString(),
    avg_last5: raw.avg_last5,
    avg_last10: raw.avg_last10,
    season_avg: raw.season_avg,
    opponent_rank: raw.opponent_defensive_rank,
    usage_rate: usage,
    minutes_projection: raw.minutes_projection,
    pace_factor: paceNorm,
    line_movement: lineMoveNorm,
    line_value: raw.line_value,
    market_probability: raw.market_probability,
    data_quality: dataQuality,
    has_injury_flag: raw.has_injury_flag,
    extra: {
      blowout_risk: blowout,
      b2b_factor: b2bPenalty,
      injury_boost: injuryBoost,
      matchup_multiplier: matchupMult,
      pace_possessions: raw.team_pace,
    },
  };
}
