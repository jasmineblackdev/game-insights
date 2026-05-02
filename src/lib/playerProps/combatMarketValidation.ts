/**
 * Combat-sports market validation + label formatting.
 *
 * Boxing and MMA produce six prop shapes upstream
 * (see `src/lib/combatPlayerEdge.ts`):
 *
 *   BINARY (no Over/Under, no numeric line):
 *     • fight_winner   — "Fighter X to win"
 *     • ko_tko         — "Fighter X by KO/TKO"
 *     • submission     — "Fighter X by submission"
 *     • decision       — "Fighter X by decision"
 *     • draw           — "Fight to end in draw"
 *
 *   TOTALS (legitimate Over/Under):
 *     • total_rounds   — "Over/Under X.X rounds"
 *
 * Upstream `combatPlayerEdge.ts` stores an implied-probability % in
 * `line_value` and a model-direction in `prediction_direction` for
 * the binary props. Passing those straight through the generic
 * "Over/Under {line} {stat_type}" label composer in
 * `buildEnrichedPropCandidates` was producing nonsense like
 * "Under 89.5 fight winner". This module is the single source of
 * truth for which combat shapes are renderable and how.
 *
 * Validation rules (applied in priority order):
 *   1. statType in BINARY_COMBAT_STATS:
 *        - direction must be "MORE" (we don't render fade-side bets)
 *        - direction "LESS" → INVALID (no sportsbook market for the
 *          inverse of a binary outcome)
 *   2. statType === "total_rounds":
 *        - must have a numeric line_value
 *        - direction must be "MORE" or "LESS" (Over/Under)
 *   3. statType not in either set → INVALID (unknown combat market)
 *
 * Used by:
 *   - topPropsRanker (filter at ranker level + ScanStats counter)
 *   - buildEnrichedPropCandidates (label formatter + drop)
 *   - BetCard (final UI safeguard)
 */

import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";

export const BINARY_COMBAT_STATS: ReadonlySet<string> = new Set([
  "fight_winner",
  "ko_tko",
  "submission",
  "decision",
  "draw",
]);

export const TOTALS_COMBAT_STATS: ReadonlySet<string> = new Set([
  "total_rounds",
]);

export function isCombatSport(sport: string | undefined): boolean {
  return sport === "Boxing" || sport === "MMA";
}

export type CombatValidation =
  | { valid: true; kind: "binary" | "totals" }
  | { valid: false; reason: string };

/**
 * Validate a combat-sports prop's shape. Non-combat sports are
 * always considered valid by this function — caller checks
 * `isCombatSport` first.
 */
export function validateCombatProp(pred: PlayerEdgePrediction): CombatValidation {
  if (!isCombatSport(pred.sport)) return { valid: true, kind: "binary" };

  const statType = pred.stat_type;
  const direction = pred.prediction_direction;

  if (BINARY_COMBAT_STATS.has(statType)) {
    if (direction !== "MORE") {
      return {
        valid: false,
        reason: `${statType} is binary; LESS-direction has no sportsbook market`,
      };
    }
    return { valid: true, kind: "binary" };
  }

  if (TOTALS_COMBAT_STATS.has(statType)) {
    if (!Number.isFinite(pred.line_value)) {
      return {
        valid: false,
        reason: `${statType} requires a numeric line_value`,
      };
    }
    if (direction !== "MORE" && direction !== "LESS") {
      return {
        valid: false,
        reason: `${statType} requires Over/Under direction`,
      };
    }
    return { valid: true, kind: "totals" };
  }

  return {
    valid: false,
    reason: `unknown combat stat_type: ${statType}`,
  };
}

/**
 * Build the human-readable selection label for a combat prop.
 * Caller must have validated first — passing an invalid shape
 * returns a fallback "Invalid combat market" string the UI
 * safeguard catches.
 */
export function formatCombatLabel(pred: PlayerEdgePrediction): string {
  const v = validateCombatProp(pred);
  if (!v.valid) return "Invalid combat market";

  const name = pred.player_name;
  const stat = pred.stat_type;

  if (v.kind === "binary") {
    if (stat === "fight_winner") return `${name} to win`;
    if (stat === "ko_tko")        return `${name} by KO/TKO`;
    if (stat === "submission")    return `${name} by submission`;
    if (stat === "decision")      return `${name} by decision`;
    if (stat === "draw")          return "Fight to end in draw";
  }

  if (v.kind === "totals" && stat === "total_rounds") {
    const direction = pred.prediction_direction === "MORE" ? "Over" : "Under";
    return `${direction} ${pred.line_value} rounds`;
  }

  return "Invalid combat market";
}

/**
 * Cheap predicate for the BetCard UI safeguard. Detects a candidate
 * whose selectionLabel still has the old "Over/Under {n} fight_winner"
 * shape — happens only if a stale build slipped past every filter.
 * Used as a final render-time guard so we never display a malformed
 * combat market to the user even if upstream regresses.
 */
export function isLikelyMalformedCombatLabel(
  sport: string | undefined,
  selectionLabel: string,
  statType: string | undefined,
): boolean {
  if (!isCombatSport(sport)) return false;
  if (!statType || !BINARY_COMBAT_STATS.has(statType)) return false;
  // Binary stat with an Over/Under prefix or a "stat_with_underscores"
  // tail that wasn't normalized through formatCombatLabel.
  return /\b(over|under)\b/i.test(selectionLabel)
    || /fight[_\s]winner|ko[_\s]tko/i.test(selectionLabel);
}
