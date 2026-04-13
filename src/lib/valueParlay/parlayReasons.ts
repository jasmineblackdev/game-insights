/**
 * Reason engine for parlays.
 *
 * Produces human-readable explanations at two levels:
 *   legReason(leg)      — primary signal driving a single leg's inclusion
 *   parlayReasons(result) — 2–3 parlay-level rationale strings
 *
 * Rules:
 *   - legReason checks signals in priority order; first match wins
 *   - parlayReasons describes the combination, not individual legs
 *   - All output is short (≤60 chars) — designed for inline display
 *   - No marketing language — just what the model actually scored
 */

import type { SmartParlayResult, ValueBetCandidate } from "./types";

// ── Leg reason ────────────────────────────────────────────────────────────────

/**
 * Returns the primary signal that drove this leg's inclusion.
 * Checked in priority order: timing → calibration → edge → confidence
 * → stability → model variant → base case.
 */
export function legReason(leg: ValueBetCandidate): string {
  const edgePct = (leg.edge * 100).toFixed(1);
  const calAdj  = leg.confidenceCalibrationAdjustment ?? 0;
  const stab    = leg.stabilityScore ?? 0;

  // 1. Timing is the most time-sensitive signal
  if (leg.timingUrgency === "now" && leg.edge >= 0.06) {
    return `Optimal timing window — +${edgePct}% edge`;
  }

  // 2. Calibration-boosted confidence (market reliability confirmed)
  if (calAdj > 0.02 && leg.confidence === "high") {
    return `Calibration-boosted — confidence reliable for this market`;
  }

  // 3. Strong raw edge
  if (leg.edge >= 0.10) {
    return `Strong edge vs market (+${edgePct}%)`;
  }

  // 4. High confidence + solid edge
  if (leg.confidence === "high" && leg.edge >= 0.06) {
    return `High confidence + solid edge (+${edgePct}%)`;
  }

  // 5. Role stability signal
  if (stab >= 0.70 && leg.edge >= 0.04) {
    return `High role stability (${stab.toFixed(2)}) — consistent baseline`;
  }

  // 6. ML blend active
  if (leg.modelVariant === "ml_blended" && leg.edge >= 0.05) {
    return `ML model blended — +${edgePct}% vs market implied`;
  }

  // 7. Base case
  return `Positive edge vs market (+${edgePct}%)`;
}

// ── Parlay reasons ────────────────────────────────────────────────────────────

/**
 * Returns up to 3 parlay-level reasons explaining the combination.
 * Covers: sport diversity, correlation, confidence profile, timing quality.
 */
export function parlayReasons(result: SmartParlayResult): string[] {
  const legs    = result.legs;
  const reasons: string[] = [];

  // Sport diversity
  const sports = [...new Set(legs.map((l) => String(l.sport).toUpperCase()))];
  if (sports.length >= 3) {
    reasons.push(`${sports.length}-sport spread (${sports.join(", ")})`);
  } else if (sports.length === 2) {
    reasons.push(`Cross-sport: ${sports.join(" + ")} — less correlated`);
  }

  // Correlation
  if (result.correlationPenalty <= 2) {
    reasons.push("Low correlation — legs are mostly independent");
  } else if (result.correlationPenalty >= 7) {
    reasons.push("Elevated correlation — some same-game dependency");
  }

  // Confidence profile
  const highN   = legs.filter((l) => l.confidence === "high").length;
  const confRatio = highN / legs.length;
  if (confRatio === 1) {
    reasons.push("All legs high confidence");
  } else if (confRatio >= 0.5) {
    reasons.push(`${highN}/${legs.length} legs high confidence`);
  }

  // Timing — only surfaces if genuinely useful
  const nowN = legs.filter((l) => l.timingUrgency === "now").length;
  if (nowN >= 2) {
    reasons.push(`${nowN} legs in optimal timing window`);
  }

  return reasons.slice(0, 3);
}
