/**
 * Timing model — when to act on a prediction.
 *
 * Determines whether a bet is best placed pregame or at a live checkpoint,
 * and how urgently the user should act given current market conditions.
 *
 * Signal sources:
 *  - Line movement direction (sharp money typically moves early)
 *  - Context field from feature vector (pregame vs live)
 *  - Sport-specific live checkpoints (NBA: after Q1; MLB: after 5th inning; etc.)
 *  - Injury flag (act fast — line will move when news spreads)
 *  - Data quality (low quality → wait for more info before acting)
 *
 * Output urgency:
 *  - "now" — act immediately, signal is strong and conditions may change
 *  - "wait" — line or context is expected to improve; hold for better value
 *  - "monitor" — watch but no clear edge yet; check back near game time
 */

import type { PropFeatureVector } from "@/lib/ml/types";
import type { TimingOutput, MLContext } from "@/lib/ml/types";

/** Sport-specific live checkpoints for re-evaluation. */
const LIVE_CHECKPOINTS: Record<string, string> = {
  nba:    "after Q1",
  nfl:    "after Q1",
  mlb:    "after 5th inning",
  mma:    "between rounds",
  boxing: "between rounds",
};

/**
 * Detect if line movement suggests sharp early money (act fast)
 * vs late public steam (may fade or stabilize).
 *
 * Large positive line movement means the Over got bet up — line is now harder.
 * Large negative means the Under got hammered.
 * Either direction = the market has already moved; urgency depends on size.
 */
function lineMovementUrgency(lineMovement: number): "now" | "wait" | "monitor" {
  const abs = Math.abs(lineMovement);
  if (abs >= 0.5) return "now";     // Line has moved significantly — act before it moves more
  if (abs >= 0.2) return "monitor"; // Moderate movement — watch for confirmation
  return "monitor";                  // Stable line — no urgency from market
}

/**
 * Whether the current context is pregame (most props) vs live.
 * Live context → urgency driven by checkpoint, not time-based.
 */
function bestContext(
  fv: PropFeatureVector,
  dataQuality: number,
): MLContext {
  if (fv.context === "live") return "live";
  // If data quality is poor pregame, we'd rather wait until live has more info
  if (dataQuality < 0.30) return "live";
  return "pregame";
}

/**
 * Injury flag → urgent because the line hasn't fully adjusted yet.
 */
function injuryUrgency(hasInjuryFlag: boolean): "now" | null {
  return hasInjuryFlag ? "now" : null;
}

/**
 * Combine all urgency signals into final recommendation.
 * Injury overrides everything (line moving fast when news drops).
 * Then line movement. Then data quality.
 */
function resolveUrgency(
  fv: PropFeatureVector,
  dataQuality: number,
): "now" | "wait" | "monitor" {
  // Injury: act immediately (line not yet adjusted)
  if (injuryUrgency(fv.has_injury_flag)) return "now";

  // Very low data quality: don't act yet
  if (dataQuality < 0.25) return "wait";

  // Line movement signal
  const movUrgency = lineMovementUrgency(fv.line_movement);
  if (movUrgency === "now") return "now";

  // Market probability far from 50% and line stable: solid pregame play
  const marketStrength = Math.abs(fv.market_probability - 0.5);
  if (marketStrength > 0.15 && dataQuality >= 0.60) return "now";

  return movUrgency;
}

export function computeTiming(fv: PropFeatureVector): TimingOutput {
  const sport = fv.sport as string;
  const liveCheckpoint = LIVE_CHECKPOINTS[sport] ?? null;

  const context = bestContext(fv, fv.data_quality);
  const urgency = resolveUrgency(fv, fv.data_quality);

  // Pregame multiplier: how strong is the signal right now vs baseline?
  // Strong market probability + good data quality = strong pregame signal
  const marketStrength = Math.abs(fv.market_probability - 0.5) * 2; // 0–1
  const pregameMultiplier = fv.context === "pregame"
    ? 0.85 + fv.data_quality * 0.15 + marketStrength * 0.10
    : 1.0; // Live context: use 1.0 baseline

  return {
    best_context: context,
    pregame_multiplier: Math.max(0.80, Math.min(1.15, pregameMultiplier)),
    live_checkpoint: liveCheckpoint,
    urgency,
  };
}
