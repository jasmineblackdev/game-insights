/**
 * MLB feature extraction for the ML layer.
 *
 * MLB is the most data-sensitive sport in the system:
 *  - Confirmed starter is gating: unconfirmed pitcher makes strikeout/hit props unreliable
 *  - FIP (Fielding Independent Pitching) is stronger than ERA for projection
 *  - Handedness (batter vs pitcher L/R matchup) meaningfully shifts hit/K rates
 *  - Park factors vary significantly (Coors Field vs Oracle Park)
 *  - Bullpen fatigue affects live totals (available after 5th inning)
 *  - Lineup drops ~3–4h before first pitch are the primary freshness event
 *
 * From oddsProviderConfig.ts: maxStaleMs = 10min for MLB (lineup sensitivity).
 */

import type { PropFeatureVector } from "@/lib/ml/types";

export interface MlbPropRawData {
  player_name: string;
  stat_type: string;              // "strikeouts" | "hits" | "total_bases" | "pitching_outs"
  is_pitcher: boolean;
  line_value: number;
  projected_value: number;
  avg_last5: number;
  avg_last10: number;
  season_avg: number;
  // Starter confidence (critical gate)
  confirmed_starter: boolean;     // True only when confirmed in ESPN lineup
  // Pitching quality
  fip: number | null;             // Fielding Independent Pitching (lower = better)
  k_rate: number;                 // Strikeout rate (K/9 or K%)
  bb_rate: number;                // Walk rate (BB/9 or BB%)
  // Batter quality
  batting_avg: number | null;
  ops: number | null;             // On-base + slugging
  // Handedness
  pitcher_hand: "L" | "R" | null;
  batter_hand: "L" | "R" | "S" | null; // Switch hitter
  // Park and environment
  park_factor: number;            // 1.0 = neutral; Coors ≈ 1.15; Oracle ≈ 0.88
  temp_f: number;
  wind_mph: number;
  wind_direction: "in" | "out" | "cross" | null; // Out = more HRs
  // Lineup context
  batting_order_position: number | null;  // 1–9; lower = more PA
  bullpen_fatigue: number;        // 0–1 (high = tired bullpen, more hits in late innings)
  team_ops_vs_hand: number;       // Team OPS against this pitcher handedness
  // Market
  opening_line: number;
  current_line: number;
  market_probability: number;
  // Context
  has_injury_flag: boolean;
}

/** Handedness advantage: L vs R, R vs L is slightly advantageous. */
function handednessEdge(pitcherHand: "L" | "R" | null, batterHand: "L" | "R" | "S" | null): number {
  if (!pitcherHand || !batterHand || batterHand === "S") return 0;
  // Same hand = pitcher advantage (platoon disadvantage for batter)
  return pitcherHand === batterHand ? -0.05 : 0.03;
}

/** Park factor adjustment relative to neutral. */
function parkAdjustment(parkFactor: number): number {
  return parkFactor - 1.0; // Centered: 0 = neutral, positive = hitter-friendly
}

/** Wind effect on offense: wind blowing out increases scoring. */
function windEffect(windMph: number, direction: "in" | "out" | "cross" | null): number {
  if (!direction) return 0;
  if (direction === "out" && windMph >= 10) return Math.min(0.08, windMph / 200);
  if (direction === "in" && windMph >= 10) return -Math.min(0.06, windMph / 250);
  return 0;
}

export function extractMlbFeatures(raw: MlbPropRawData): PropFeatureVector {
  const lineDelta = raw.current_line - raw.opening_line;
  const lineMoveNorm = Math.max(-2, Math.min(2, lineDelta)) / 2;

  // FIP normalized (typical range 2.5–5.5, lower = better pitcher)
  const fipNorm = raw.fip != null ? (raw.fip - 4.0) / 1.5 : 0; // Centered at 4.0

  // Handedness edge
  const handEdge = handednessEdge(raw.pitcher_hand, raw.batter_hand);

  // Park + wind environment
  const parkAdj = parkAdjustment(raw.park_factor);
  const windAdj = windEffect(raw.wind_mph, raw.wind_direction);

  // Batting order PA opportunity (1-3 = most; 7-9 = fewest)
  const paOpportunity = raw.batting_order_position != null
    ? 1.0 - (raw.batting_order_position - 1) / 8 * 0.25
    : 0.7; // Unknown = conservative

  // Data quality — confirmation is gating
  const hasConfirmedStarter = raw.confirmed_starter ? 1 : 0;
  const dataQualityChecks = [
    hasConfirmedStarter === 1,
    raw.avg_last5 > 0,
    raw.season_avg > 0,
    raw.fip != null,
    raw.market_probability > 0,
  ];
  // Unconfirmed starter heavily penalizes data quality
  const rawDataQuality = dataQualityChecks.filter(Boolean).length / dataQualityChecks.length;
  const dataQuality = raw.confirmed_starter ? rawDataQuality : rawDataQuality * 0.50;

  return {
    type: "prop",
    sport: "mlb",
    context: "pregame",
    capturedAt: new Date().toISOString(),
    avg_last5: raw.avg_last5,
    avg_last10: raw.avg_last10,
    season_avg: raw.season_avg,
    opponent_rank: 16, // MLB uses pitcher-specific context, not team rank
    usage_rate: paOpportunity, // PA opportunity as proxy for usage
    minutes_projection: paOpportunity * 4.5, // Expected plate appearances
    pace_factor: parkAdj + windAdj,
    line_movement: lineMoveNorm,
    line_value: raw.line_value,
    market_probability: raw.market_probability,
    data_quality: dataQuality,
    has_injury_flag: raw.has_injury_flag,
    extra: {
      confirmed_starter: hasConfirmedStarter,
      fip_normalized: fipNorm,
      k_rate: raw.k_rate,
      handedness_edge: handEdge,
      park_adjustment: parkAdj,
      wind_adjustment: windAdj,
      bullpen_fatigue: raw.bullpen_fatigue,
      team_ops_vs_hand: raw.team_ops_vs_hand,
    },
  };
}
