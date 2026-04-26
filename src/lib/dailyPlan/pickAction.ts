/**
 * Pick-level action label — "BET NOW" / "SMALL BET" / "WAIT" / "SKIP"
 * derived from confidence, risk level, data quality, matchup quality,
 * and the user's current bankroll state (loss streak / today's
 * exposure). Same vocabulary as the Auto Profit card, applied per
 * individual pick so cards everywhere can show one clear next step.
 */

import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";
import { type AutoProfitAction } from "./autoProfit";
import { getPropRiskLevel } from "@/lib/valueParlay/propRiskLevels";

interface PickActionContext {
  /** Current consecutive-loss streak from bankroll. */
  lossStreak?: number;
  /** True when a settled bet today resolved as a loss. */
  hadLossToday?: boolean;
  /** True when today's stake exposure has hit the 8% cap. */
  exposureCapHit?: boolean;
}

/**
 * Resolve an action label for a single player-prop prediction.
 *
 * Rules (in order — first match wins):
 *   SKIP  — LOW confidence OR low_data_quality OR matchup_quality === "tough"
 *           on a stat where tough kills output (e.g. NBA points vs top D).
 *   WAIT  — exposure cap hit OR loss streak ≥ 2 OR timing_urgency === "wait".
 *   SMALL BET — MED confidence OR matchup_quality === "neutral" with
 *               edge mag below the high threshold OR loss streak ≥ 1.
 *   BET NOW — HIGH confidence + soft/neutral matchup + acceptable
 *             data quality.
 */
export function pickActionForPrediction(
  pred: PlayerEdgePrediction,
  ctx: PickActionContext = {},
): AutoProfitAction {
  // SKIP — outright bad signal
  if (pred.confidence === "LOW") return "SKIP";
  if (pred.model_status === "low_data_quality") return "SKIP";
  if (pred.matchup_quality === "tough" && pred.prediction_direction === "MORE") {
    // Tough matchup on an Over is a real fade — skip rather than caution
    return "SKIP";
  }

  // WAIT — bankroll/timing reasons
  if (ctx.exposureCapHit) return "WAIT";
  if ((ctx.lossStreak ?? 0) >= 2) return "WAIT";
  if (pred.timing_urgency === "wait") return "WAIT";

  // SMALL BET — anything not strong enough for a full bet
  if (pred.confidence === "MED") return "SMALL_BET";
  if ((ctx.lossStreak ?? 0) >= 1) return "SMALL_BET";
  if (pred.matchup_quality === "neutral" || pred.matchup_quality === "unknown") {
    return "SMALL_BET";
  }
  if (ctx.hadLossToday) return "SMALL_BET";

  // BET NOW — HIGH confidence, soft matchup, no bankroll concerns
  return "BET_NOW";
}

/**
 * Adapter that resolves the action label for a slip leg
 * (ValueBetCandidate). Slip legs have confidence + risk_band but
 * lack the model_status / matchup_quality / timing_urgency fields
 * the prop-level helper uses. We approximate from what's available:
 *
 *   SKIP   — LOW confidence OR high risk band with negative edge
 *   WAIT   — bankroll exposure cap or 2-loss streak
 *   SMALL  — MED confidence OR HIGH risk leg OR loss streak
 *   BET NOW — HIGH confidence + LOW/MED risk + clean bankroll state
 */
export function pickActionForCandidate(
  c: ValueBetCandidate,
  ctx: PickActionContext = {},
): AutoProfitAction {
  const risk = getPropRiskLevel(c);

  // SKIP — bad signal regardless of bankroll
  if (c.confidence === "low") return "SKIP";
  if (c.edge <= 0 && risk === "high") return "SKIP";

  // WAIT — bankroll constraints
  if (ctx.exposureCapHit) return "WAIT";
  if ((ctx.lossStreak ?? 0) >= 2) return "WAIT";
  if (c.timingUrgency === "wait") return "WAIT";

  // SMALL BET — anything not strong enough for a full bet
  if (c.confidence === "medium") return "SMALL_BET";
  if (risk === "high") return "SMALL_BET";
  if ((ctx.lossStreak ?? 0) >= 1) return "SMALL_BET";
  if (ctx.hadLossToday) return "SMALL_BET";

  // BET NOW
  return "BET_NOW";
}

export function pickActionLabel(a: AutoProfitAction): string {
  return a === "BET_NOW" ? "BET NOW"
    : a === "SMALL_BET" ? "SMALL BET"
    : a === "WAIT" ? "WAIT"
    : "SKIP";
}

export function pickActionClass(a: AutoProfitAction): string {
  if (a === "BET_NOW")   return "bg-emerald-500 text-white";
  if (a === "SMALL_BET") return "bg-amber-500 text-white";
  if (a === "WAIT")      return "bg-muted text-foreground border border-border";
  return "bg-red-500/80 text-white";
}
