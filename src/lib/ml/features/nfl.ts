/**
 * NFL feature extraction for the ML layer.
 *
 * NFL prop features are heavily role-based:
 *  - Passing props: QB efficiency, pressure rate, team pass rate, target matchup
 *  - Rushing props: carry share, team run-pass ratio, line matchup
 *  - Receiving props: target share, routes run, slot vs boundary, coverage matchup
 *  - Weather: wind, cold, precipitation affect passing volume
 */

import type { PropFeatureVector } from "@/lib/ml/types";

export interface NflPropRawData {
  player_name: string;
  stat_type: string;             // "passing_yards" | "rushing_yards" | "receiving_yards" | etc.
  position: string;              // QB | RB | WR | TE
  line_value: number;
  projected_value: number;
  avg_last5: number;
  avg_last10: number;
  season_avg: number;
  // Opportunity
  snap_share: number;            // 0–1
  target_share?: number;         // WR/TE/RB receiving (0–1)
  carry_share?: number;          // RB rushing (0–1)
  team_pass_rate: number;        // 0–1 (fraction of plays that are passes)
  // Matchup
  opponent_defense_rank: number; // 1–32
  pressure_rate_allowed?: number;// QB-specific: OL pressure rate (0–1, high = worse for QB)
  // Environment
  wind_mph: number;
  temp_f: number;
  precipitation: boolean;
  // Market
  opening_line: number;
  current_line: number;
  market_probability: number;
  // Context
  is_short_week: boolean;
  has_injury_flag: boolean;
  game_total: number;           // Over/under for the game (high total = passing game)
}

/** Weather impact on passing volume. Wind > 15mph meaningfully reduces pass yards. */
function weatherPassPenalty(windMph: number, tempF: number, precipitation: boolean): number {
  let penalty = 1.0;
  if (windMph >= 20) penalty *= 0.88;
  else if (windMph >= 15) penalty *= 0.94;
  if (tempF < 30) penalty *= 0.95;
  if (precipitation) penalty *= 0.96;
  return penalty;
}

export function extractNflFeatures(raw: NflPropRawData): PropFeatureVector {
  const lineDelta = raw.current_line - raw.opening_line;
  const lineMoveNorm = Math.max(-5, Math.min(5, lineDelta)) / 5;

  // Role opportunity score (0–1)
  let opportunityScore = raw.snap_share;
  if (raw.stat_type.includes("receiv") && raw.target_share != null) {
    opportunityScore = (raw.snap_share * 0.4) + (raw.target_share * 0.6);
  }
  if (raw.stat_type.includes("rush") && raw.carry_share != null) {
    opportunityScore = (raw.snap_share * 0.3) + (raw.carry_share * 0.7);
  }

  // Matchup multiplier (same linear mapping as NBA: 1→0.85, 32→1.15)
  const matchupMult = 0.85 + (raw.opponent_defense_rank - 1) / 31 * 0.30;

  // Weather factor for pass-dependent stats
  const isPassStat = raw.stat_type === "passing_yards" || raw.stat_type === "receiving_yards";
  const weatherFactor = isPassStat
    ? weatherPassPenalty(raw.wind_mph, raw.temp_f, raw.precipitation)
    : 1.0;

  // QB pressure penalty
  const pressurePenalty =
    raw.stat_type === "passing_yards" && raw.pressure_rate_allowed != null
      ? 1.0 - raw.pressure_rate_allowed * 0.20
      : 1.0;

  // Short week penalty
  const shortWeekFactor = raw.is_short_week ? 0.95 : 1.0;

  // Game total as environment signal (high total = more passing)
  const gameEnvFactor = Math.max(0.9, Math.min(1.1, raw.game_total / 45));

  const dataQualityChecks = [
    raw.avg_last5 > 0,
    raw.avg_last10 > 0,
    raw.season_avg > 0,
    raw.snap_share > 0,
    raw.market_probability > 0,
    raw.opponent_defense_rank > 0,
  ];
  const dataQuality = dataQualityChecks.filter(Boolean).length / dataQualityChecks.length;

  return {
    type: "prop",
    sport: "nfl",
    context: "pregame",
    capturedAt: new Date().toISOString(),
    avg_last5: raw.avg_last5,
    avg_last10: raw.avg_last10,
    season_avg: raw.season_avg,
    opponent_rank: raw.opponent_defense_rank,
    usage_rate: opportunityScore,
    minutes_projection: raw.snap_share * 70, // NFL snaps proxy (avg ~65-70 per game)
    pace_factor: gameEnvFactor - 1.0,        // Centered around 0
    line_movement: lineMoveNorm,
    line_value: raw.line_value,
    market_probability: raw.market_probability,
    data_quality: dataQuality,
    has_injury_flag: raw.has_injury_flag,
    extra: {
      weather_factor: weatherFactor,
      pressure_penalty: pressurePenalty,
      short_week_factor: shortWeekFactor,
      matchup_multiplier: matchupMult,
      opportunity_score: opportunityScore,
    },
  };
}
