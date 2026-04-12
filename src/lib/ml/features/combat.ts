/**
 * Combat sports feature extraction (Boxing + UFC/MMA) for the ML layer.
 *
 * Combat sports have unique characteristics vs team sports:
 *  - No usage rate or minutes — fights are binary outcome events
 *  - Style matchup is the strongest predictive signal
 *  - Inactivity (time since last fight) degrades prediction confidence
 *  - Physical attributes (reach, height, age curve) are stable but real
 *  - Grappling edge (UFC) and KO power (Boxing) are primary method-of-victory drivers
 *  - Opponent quality (step up / step down) strongly affects outcome probability
 *
 * UFC-specific:
 *   - Style matchup: striker vs grappler, wrestler vs BJJ
 *   - Grappling differential: takedown success rate difference
 *   - Striking differential: significant strikes landed per minute difference
 *   - Cardio (significant activity in rounds 4-5) — durability signal
 *
 * Boxing-specific:
 *   - KO probability: based on past KO rate and opponent chin
 *   - Decision probability: complementary to KO
 *   - Reach advantage: meaningful beyond 4-5 inch difference
 *   - Age curve: fighters peak ~28-32, decline accelerates after 35
 */

import type { PropFeatureVector } from "@/lib/ml/types";
import type { MLSport } from "@/lib/ml/types";

export interface CombatPropRawData {
  fighter_name: string;
  opponent_name: string;
  sport: "mma" | "boxing";
  stat_type: string;          // "fight_winner" | "ko_tko" | "decision" | "total_rounds" | etc.
  line_value: number;
  projected_value: number;    // Win probability % for fight_winner, rounds for total_rounds
  // Fighter attributes
  age: number;
  reach_inches: number;
  height_inches: number;
  // Fight history
  wins: number;
  losses: number;
  ko_rate: number;            // 0–1 fraction of wins by KO/TKO
  decision_rate: number;      // 0–1 fraction of wins by decision
  avg_fight_time_rounds: number; // Average rounds to finish
  // Recent form
  avg_last3_score: number;    // Normalized recent performance score (0–1)
  streak: number;             // Positive = win streak, negative = loss streak
  inactivity_days: number;    // Days since last fight
  // Opponent
  opponent_age: number;
  opponent_reach_inches: number;
  opponent_wins: number;
  opponent_losses: number;
  opponent_ko_rate: number;
  opponent_quality_percentile: number; // 0–1 (1 = elite, 0 = weak)
  // UFC-specific (nullable for Boxing)
  grappling_edge: number | null;       // Takedown diff per 15min: positive = fighter advantage
  striking_differential: number | null; // SLpM diff: positive = fighter lands more
  cardio_score: number | null;         // 0–1 based on late-round activity %
  // Boxing-specific (nullable for UFC)
  power_punches_pct: number | null;    // % of punches that are power shots
  jab_accuracy: number | null;         // 0–1
  // Market
  opening_line: number;
  current_line: number;
  market_probability: number;          // Fighter win probability from odds
  // Context
  is_title_fight: boolean;
  is_main_event: boolean;
  has_injury_flag: boolean;
}

/** Age curve penalty: performance decline accelerates after peak (28-32). */
function ageCurveMultiplier(age: number): number {
  if (age < 22) return 0.94; // Inexperienced but physically prime
  if (age <= 28) return 1.02; // Rising/peak
  if (age <= 32) return 1.00; // Peak
  if (age <= 35) return 0.97; // Early decline
  if (age <= 38) return 0.92; // Clear decline
  return 0.85;                // Late career
}

/** Reach advantage converted to a small multiplier. */
function reachEdgeMultiplier(fightReach: number, oppReach: number): number {
  const diff = fightReach - oppReach;
  // 4+ inch advantage = meaningful; capped
  return 1.0 + Math.max(-0.04, Math.min(0.06, diff / 80));
}

/** Inactivity penalty (ring rust). */
function inactivityPenalty(daysSinceLastFight: number): number {
  if (daysSinceLastFight <= 365) return 0;          // < 1 year: no penalty
  if (daysSinceLastFight <= 548) return 0.03;       // 1–1.5 years: small
  if (daysSinceLastFight <= 730) return 0.07;       // 1.5–2 years: moderate
  return 0.12;                                       // 2+ years: significant
}

export function extractCombatFeatures(raw: CombatPropRawData): PropFeatureVector {
  const sport: MLSport = raw.sport === "mma" ? "mma" : "boxing";

  const lineDelta = raw.current_line - raw.opening_line;
  // Combat odds use American format — normalize line delta
  const lineMoveNorm = Math.max(-1, Math.min(1, lineDelta / 50));

  const ageMult = ageCurveMultiplier(raw.age);
  const reachMult = reachEdgeMultiplier(raw.reach_inches, raw.opponent_reach_inches);
  const inactPenalty = inactivityPenalty(raw.inactivity_days);

  // Style matchup composite (UFC-specific; Boxing uses power metrics instead)
  let styleEdge = 0;
  if (raw.grappling_edge != null && raw.striking_differential != null) {
    styleEdge = (raw.grappling_edge * 0.4 + raw.striking_differential * 0.6) / 5;
    styleEdge = Math.max(-1, Math.min(1, styleEdge));
  }

  // Opponent quality adjustment: higher quality = harder fight
  const opponentQualityAdj = 0.9 + raw.opponent_quality_percentile * 0.2;

  // Win probability from recent form + record
  const totalFights = raw.wins + raw.losses || 1;
  const winRate = raw.wins / totalFights;

  // Streak signal
  const streakSignal = Math.max(-1, Math.min(1, raw.streak / 3));

  const dataQualityChecks = [
    raw.avg_last3_score > 0,
    raw.market_probability > 0,
    raw.opponent_quality_percentile >= 0,
    raw.wins + raw.losses > 3,
    raw.inactivity_days > 0,
  ];
  const dataQuality = dataQualityChecks.filter(Boolean).length / dataQualityChecks.length;

  return {
    type: "prop",
    sport,
    context: "pregame",
    capturedAt: new Date().toISOString(),
    // Use win-rate proxies for these slots
    avg_last5: raw.avg_last3_score,
    avg_last10: winRate,
    season_avg: winRate,
    opponent_rank: Math.round(raw.opponent_quality_percentile * 30) || 15,
    usage_rate: 1.0, // Fighters are always "in" for the full fight
    minutes_projection: raw.avg_fight_time_rounds * 5, // Minutes per round
    pace_factor: styleEdge,
    line_movement: lineMoveNorm,
    line_value: raw.line_value,
    market_probability: raw.market_probability,
    data_quality: dataQuality,
    has_injury_flag: raw.has_injury_flag,
    extra: {
      age_multiplier: ageMult,
      reach_edge: reachMult,
      inactivity_penalty: inactPenalty,
      style_edge: styleEdge,
      opponent_quality: opponentQualityAdj,
      streak_signal: streakSignal,
      ko_rate: raw.ko_rate,
      decision_rate: raw.decision_rate,
      cardio_score: raw.cardio_score ?? 0.7,
      title_fight_factor: raw.is_title_fight ? 1.05 : 1.0,
    },
  };
}
