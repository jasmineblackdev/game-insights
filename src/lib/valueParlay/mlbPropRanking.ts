/**
 * MLB Player Intelligence Layer — prop ranking utilities.
 *
 * Baseball player props can be more precise than full-game team outcomes
 * because team bets carry: bullpen variance, lineup-change risk, sequencing
 * luck, and park/weather noise that individual player props don't.
 *
 * This module classifies MLB market types and provides priority adjustments
 * that allow strong player props to outrank weaker team bets in the scoring
 * pipeline — without removing team bets or changing any other sport.
 *
 * Priority order (highest value → lowest):
 *   1. Pitcher strikeouts    — most predictable; driven by measurable rate stats
 *   2. Hitter total bases    — stable with platoon splits + hard-hit data
 *   3. Hitter hits           — moderate variance; BABIP/lineup position signal
 *   4. F5 team bets          — isolates starter, removes back-end bullpen noise
 *   5. Full-game team bets   — highest variance; last resort when props are weak
 *
 * High-volatility props (HR, SB, RBI) are kept at baseline — neither promoted
 * nor penalised unless edge is genuinely weak.
 *
 * Usage:
 *   - buildEnrichedPropCandidates  → volatility floor overrides per stat type
 *   - computeLegScore              → mlbPropPriorityAdjustment added to score
 *   - propDisplayScore (Tomorrow)  → MLB prop boost/penalty in sort ranking
 *   - correlationGroupId           → pitcher vs hitter isolation reduces penalty
 */

import type { ValueBetCandidate } from "./types";

// ── Prop category ─────────────────────────────────────────────────────────────

export type MlbPropCategory =
  | "pitcher_strikeouts"   // K total / K/9 — most reliable pitcher prop
  | "pitcher_other"        // outs, ER, walks — pitcher but secondary
  | "hitter_total_bases"   // xBA + hard-hit blend — stable pregame
  | "hitter_hits"          // batting average signal — moderate variance
  | "hitter_high_vol"      // HR, SB, RBI, R — noise-prone; avoid promoting
  | "f5_team"              // first-5-innings team bet — starter-focused
  | "fullgame_team"        // full-game ML / spread / total
  | "other";               // non-MLB, unknown, or uncategorised

const PITCHER_K_STATS     = new Set(["strikeouts", "k", "strikeouts_pitched", "ks"]);
const PITCHER_OTHER_STATS = new Set(["outs", "outs_pitched", "earned_runs", "er",
                                     "walks", "bb", "innings_pitched", "ip"]);
const HITTER_TB_STATS     = new Set(["total_bases", "tb"]);
const HITTER_HIT_STATS    = new Set(["hits", "h"]);
const HITTER_HIGH_VOL     = new Set(["home_runs", "hr", "stolen_bases", "sb",
                                     "rbi", "runs", "r", "home_run"]);

/**
 * Classify an MLB prop by stat type and pick type.
 *
 * @param statType   - ValueBetCandidate.statType or PlayerEdgePrediction.stat_type
 * @param pickType   - "player_prop" | "team_pick" | "spread" | "total"
 * @param matchupLabel - optional, used to detect F5 team bets
 */
export function mlbPropCategory(
  statType: string | undefined,
  pickType: ValueBetCandidate["pickType"],
  matchupLabel = "",
): MlbPropCategory {
  if (pickType !== "player_prop") {
    const lower = matchupLabel.toLowerCase();
    const isF5  = lower.includes("f5") || lower.includes("first 5") || lower.includes("first five");
    return isF5 ? "f5_team" : "fullgame_team";
  }

  const s = (statType ?? "").toLowerCase().trim();
  if (PITCHER_K_STATS.has(s))     return "pitcher_strikeouts";
  if (PITCHER_OTHER_STATS.has(s)) return "pitcher_other";
  if (HITTER_TB_STATS.has(s))     return "hitter_total_bases";
  if (HITTER_HIT_STATS.has(s))    return "hitter_hits";
  if (HITTER_HIGH_VOL.has(s))     return "hitter_high_vol";
  return "other";
}

// ── Volatility floors ─────────────────────────────────────────────────────────

/**
 * Stat-type-specific volatility floor for MLB.
 *
 * The generic pipeline derives volatility from consistency_label + volatility_flag,
 * which gives the same floor to all MLB stat types. These overrides apply
 * baseball-specific knowledge: pitcher Ks are rate-driven and predictable,
 * home runs are highly park-and-matchup dependent.
 *
 * Scale: 0–100. Lower = more predictable.
 * Applied as a MINIMUM — never lowers existing volatility below this value.
 * High-vol stats set a high floor to prevent them being mistakenly treated as reliable.
 */
export const MLB_STAT_VOLATILITY_FLOOR: Record<string, number> = {
  strikeouts:   18,   // K rate is measurable; most predictable MLB prop
  total_bases:  26,   // xBA + hard-hit data; reliable with platoon split
  hits:         30,   // moderate; BABIP variance + lineup position matters
  outs:         28,
  walks:        34,   // pitcher command signal; reasonably stable
  innings_pitched: 30,
  earned_runs:  44,   // park/luck factors introduce noise
  home_runs:    68,   // high variance even with barrel/launch-angle data
  home_run:     68,
  stolen_bases: 72,   // game-state + catcher dependent; very noisy
  rbi:          60,   // team-run environment dependent
  runs:         58,
};

/**
 * Returns the MLB stat volatility floor (0–100), or null for non-MLB stats.
 * When non-null, apply as: `Math.max(existingVolatility, floor)` for high-vol types
 * and `Math.min(existingVolatility, floor + 10)` for predictable types.
 */
export function mlbStatVolatilityFloor(statType: string | undefined): number | null {
  if (!statType) return null;
  return MLB_STAT_VOLATILITY_FLOOR[statType.toLowerCase()] ?? null;
}

// ── Priority adjustment ───────────────────────────────────────────────────────

/**
 * Additive legScore adjustment for MLB market type.
 *
 * Applied only when sport === "mlb". Range: −0.04 to +0.05.
 * Designed to be smaller than live edge and model probability signals,
 * but large enough to reorder candidates when edge is comparable.
 *
 * Effect: strong pitcher/hitter props surface above mediocre team bets.
 * Team bets with strong edge are unaffected — the penalty only triggers
 * when edge is weak (< 4%), which is the scenario where props should win.
 *
 * @param category - from mlbPropCategory()
 * @param edge     - decimal edge, e.g. 0.08 = 8% (ValueBetCandidate scale)
 */
export function mlbPropPriorityAdjustment(
  category: MlbPropCategory,
  edge: number,
): number {
  switch (category) {
    case "pitcher_strikeouts":
      // K props get the strongest boost — most reliable MLB market
      if (edge >= 0.07) return  0.05;
      if (edge >= 0.05) return  0.03;
      if (edge >= 0.03) return  0.01;
      return 0;

    case "hitter_total_bases":
      // Second-best hitter prop; stable with platoon data
      if (edge >= 0.07) return  0.04;
      if (edge >= 0.05) return  0.02;
      return 0;

    case "hitter_hits":
      // Moderate boost when edge is meaningful
      if (edge >= 0.07) return  0.02;
      if (edge >= 0.05) return  0.01;
      return 0;

    case "pitcher_other":
    case "f5_team":
      // No boost, no penalty — allowed to rank on natural signals
      return 0;

    case "fullgame_team":
      // Mild penalty when edge is weak — prefer any player prop over a low-edge team bet
      if (edge < 0.04) return -0.03;
      if (edge < 0.03) return -0.04;
      return 0;

    case "hitter_high_vol":
      // Small penalty — volatile stats shouldn't displace predictable ones
      if (edge < 0.08) return -0.02;
      return 0;  // strong edge clears the penalty

    default:
      return 0;
  }
}

// ── Correlation group ID ──────────────────────────────────────────────────────

/**
 * Returns a correlation group ID for an MLB ML-enriched prop that separates
 * pitcher props from hitter props within the same game.
 *
 * The parlay optimizer uses the first 3 hyphen-delimited segments of
 * correlationGroupId to group legs for penalty scoring. By splitting
 * pitcher and hitter props into different prefixes, a pitcher K + hitter TB
 * combination from the same game avoids the extra same-group penalty (−8),
 * while still receiving the base same-game penalty (−22) from the gameId check.
 *
 * Format: "mlb-{category}-{gameId}-{statType}"
 * Prefix: "mlb-{category}-{gameId}"  (3 segments after split)
 *
 * Non-MLB props continue using the existing "ml-prop-{gameId}" prefix.
 */
export function mlbCorrelationGroup(
  gameId: string,
  statType: string | undefined,
  category: MlbPropCategory,
): string {
  const catKey =
    category === "pitcher_strikeouts" || category === "pitcher_other" ? "pitcher"
    : "hitter";
  return `mlb-${catKey}-${gameId}-${statType ?? "prop"}`;
}

// ── Same-team hitter stacking penalty ─────────────────────────────────────────

/**
 * Parlay-time dampener for stacking multiple MLB hitters from the same team.
 *
 * Orthogonal to `mlbPropPriorityAdjustment` (which is per-leg and stateless):
 * this penalty depends on which legs have already been picked, so it lives in
 * the greedy selector and is applied at the same additive scale as the
 * priority adjustment (±0.05 range). Pitcher strikeouts and opposing-team
 * hitters are exempt — only same-team hitter stacks pay.
 */
export type HitterStackContext = {
  hitterCountByTeam: Map<string, number>;
};

export function newHitterStackContext(): HitterStackContext {
  return { hitterCountByTeam: new Map() };
}

const SAME_TEAM_HITTER_STEP = -0.02;

function isMlbHitterCategory(cat: MlbPropCategory): boolean {
  return (
    cat === "hitter_total_bases" ||
    cat === "hitter_hits" ||
    cat === "hitter_high_vol"
  );
}

/**
 * Returns a negative adjustment when this candidate would add another hitter
 * from a team that is already represented on the slip. First hitter from a
 * team pays 0; each subsequent hitter from the same team pays the step
 * multiplied by the prior count (1 prior → −0.02, 2 priors → −0.04, …).
 */
export function sameTeamHitterPenaltyFor(
  candidate: ValueBetCandidate,
  ctx: HitterStackContext,
): number {
  if ((candidate.sport ?? "").toLowerCase() !== "mlb") return 0;
  if (candidate.pickType !== "player_prop") return 0;
  const cat = mlbPropCategory(candidate.statType, candidate.pickType, candidate.matchupLabel ?? "");
  if (!isMlbHitterCategory(cat)) return 0;
  const team = candidate.teamId;
  if (!team) return 0;
  const prior = ctx.hitterCountByTeam.get(team) ?? 0;
  if (prior < 1) return 0;
  return SAME_TEAM_HITTER_STEP * prior;
}

/** Record a selected MLB hitter so subsequent legs see the stack-penalty growth. */
export function recordHitterPick(
  candidate: ValueBetCandidate,
  ctx: HitterStackContext,
): void {
  if ((candidate.sport ?? "").toLowerCase() !== "mlb") return;
  if (candidate.pickType !== "player_prop") return;
  const cat = mlbPropCategory(candidate.statType, candidate.pickType, candidate.matchupLabel ?? "");
  if (!isMlbHitterCategory(cat)) return;
  const team = candidate.teamId;
  if (!team) return;
  ctx.hitterCountByTeam.set(team, (ctx.hitterCountByTeam.get(team) ?? 0) + 1);
}
