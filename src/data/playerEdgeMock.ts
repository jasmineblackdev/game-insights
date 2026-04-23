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
  | "fight_winner" | "ko_tko" | "submission" | "decision" | "draw" | "total_rounds" | "goes_distance";

export type PlayerRiskTier = "safe" | "balanced" | "high_upside" | "longshot";

export type PlayerConsistencyLabel = "stable" | "medium" | "volatile";

/** Internal ML debug snapshot — logged to prediction_history, not shown in UI. */
export interface MLDebugSnapshot {
  rules_projection:     number;
  ml_projection:        number;
  blended_projection:   number;
  implied_probability:  number;
  edge_rules:           number;
  edge_blended:         number;
  confidence_rules:     string;
  confidence_blended:   string;
  timing_urgency:       string;
  volatility_flag:      boolean;
  alpha:                number;
  ml_sample_size:       number;
  ml_active:            boolean;
  stability_score:      number;
}

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
  /** First-seen line this session (sessionStorage) */
  opening_line_value?: number;
  /** line_value − opening_line_value. Positive = line moved up (worse for Over). */
  line_delta?: number;

  // ── ML-enriched fields (added by playerEdgeEnrichment.ts) ────────────────
  /** Whether the ML layer had ≥25 resolved outcomes and is actively contributing. */
  ml_active?: boolean;
  /** Blended P(bet wins) from hitProbability model + rules engine. Range: [0.05, 0.95]. */
  ml_hit_probability?: number;
  /** Timing urgency from ML timing model. "now" → rank higher. */
  timing_urgency?: "now" | "wait" | "monitor";
  /** Human-readable timing recommendation (e.g. "Bet now", "After Q1"). */
  best_time_to_bet?: string | null;
  /** True when stat variance is high — confidence model flags this as unreliable. */
  volatility_flag?: boolean;
  /** NFL-only: true when a relevant injury flag was detected for this player. */
  has_injury_flag?: boolean;
  /**
   * American odds for the prop when known (from sportsbook feed). Lets the
   * enricher compute real implied probability instead of the confidence-tier
   * proxy. Missing → fall back to marketProbProxy().
   */
  american_odds?: number;
  /** 80% confidence interval lower bound from propProjection model. */
  projection_ci_low?: number;
  /** 80% confidence interval upper bound from propProjection model. */
  projection_ci_high?: number;
  /** Internal debug snapshot — not surfaced in the UI, used for logging only. */
  ml_debug?: MLDebugSnapshot;
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
    submission: "Submission",
    decision: "Decision",
    draw: "Draw",
    total_rounds: "Total Rounds",
    goes_distance: "Goes Distance",
  };
  return labels[f];
}

/**
 * Timing urgency multiplier for ranking.
 * "now" props rank higher; "wait" props rank lower.
 * Conservative range — never inverts a strong vs weak prediction.
 */
function timingMultiplier(urgency: PlayerEdgePrediction["timing_urgency"]): number {
  if (urgency === "now")     return 1.12;
  if (urgency === "wait")    return 0.90;
  return 1.00; // "monitor" or undefined
}

/**
 * Compute composite player edge score from available fields.
 *
 * When ML fields are present, the score incorporates:
 *  - ml_hit_probability (replaces rules-only confidence component)
 *  - timing_urgency     (multiplier on total score)
 *  - volatility_flag    (additional penalty when ML flags high variance)
 *
 * Rules engine fields remain primary; ML fields are a conservative modifier.
 *
 * player_edge_score = (model_edge * 0.30) + (projection_confidence * 0.20)
 *   + (matchup_advantage * 0.15) + (role_stability * 0.10)
 *   + (recent_form * 0.10) + (market_value * 0.10) - (volatility_penalty * 0.05)
 *   * timing_multiplier
 */
export function computePlayerEdgeScore(pred: PlayerEdgePrediction): number {
  if (pred.player_edge_score != null) return pred.player_edge_score;

  // Normalize edge to 0–1 by sport
  const maxEdge = pred.sport === "NBA" ? 8 : pred.sport === "NFL" ? 30 : pred.sport === "MLB" ? 3 : 15;
  const model_edge = Math.min(1, Math.abs(pred.edge) / maxEdge);

  // When ML hit probability is available, blend it with rules confidence signal
  // ml_hit_probability is in [0.05, 0.95] — scale to [0, 1] from the 0.5 midpoint
  const mlHitSignal = pred.ml_hit_probability != null
    ? (pred.ml_hit_probability - 0.50) * 2  // Centered: 0.5→0, 0.75→0.5, 0.95→0.9
    : null;

  const rawConf = pred.confidence_score_0_100
    ?? (pred.confidence === "HIGH" ? 72 : pred.confidence === "MED" ? 58 : 44);
  const rulesConfSignal = rawConf / 100;

  // Blend rules confidence with ML hit probability (ML only when active)
  const projection_confidence = mlHitSignal != null && pred.ml_active
    ? rulesConfSignal * 0.60 + Math.max(0, mlHitSignal) * 0.40
    : rulesConfSignal;

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

  // ML volatility flag adds to penalty when present
  const mlVolatilityExtra = pred.volatility_flag ? 0.5 : 0;
  const volatility_penalty =
    pred.consistency_label === "volatile" ? 1.0 + mlVolatilityExtra
    : pred.consistency_label === "medium" ? 0.5 + mlVolatilityExtra * 0.5
    : mlVolatilityExtra * 0.5;

  const rawScore = (
    model_edge * 0.30
    + projection_confidence * 0.20
    + matchup_advantage * 0.15
    + role_stability * 0.10
    + recent_form * 0.10
    + market_value * 0.10
    - volatility_penalty * 0.05
  ) * 100;

  // Timing urgency adjusts the raw score post-computation
  return rawScore * timingMultiplier(pred.timing_urgency);
}

/**
 * Continuous timing contribution for ranking.
 * Consistent with the parlay engine's timingScore concept (0–1).
 * Used as an additive bonus so "now" props surface reliably over "monitor"
 * even when their raw scores are close — not just as a binary rank bucket.
 */
function timingRankBonus(urgency: PlayerEdgePrediction["timing_urgency"]): number {
  if (urgency === "now")     return 2.5;
  if (urgency === "monitor") return 0.0;
  if (urgency === "wait")    return -2.0;
  return 0.0;
}

/**
 * Sort predictions by composite score with ML-aware tiebreakers.
 *
 * Primary sort: computePlayerEdgeScore() (which already multiplies by timingMultiplier).
 * Tie-breaking: continuous timingRankBonus blended into a composite rank score,
 * so ordering is smooth rather than a cliff at the 0.5 gap threshold.
 */
export function sortPlayerEdgePredictions(list: PlayerEdgePrediction[]): PlayerEdgePrediction[] {
  return [...list].sort((a, b) => {
    const as = computePlayerEdgeScore(a) + timingRankBonus(a.timing_urgency);
    const bs = computePlayerEdgeScore(b) + timingRankBonus(b.timing_urgency);
    if (Math.abs(as - bs) > 0.5) return bs - as;

    // Confidence tiebreaker
    const cr = CONF_RANK[a.confidence] - CONF_RANK[b.confidence];
    if (cr !== 0) return cr;

    // Edge tiebreaker
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
