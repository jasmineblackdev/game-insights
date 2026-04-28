/**
 * Sharp Mode — strict, edge-only betting filter.
 *
 * Composes the existing safety gates (statTypeBans.passesQualityGates,
 * propRiskLevels.getPropRiskLevel) with much tighter thresholds. The
 * goal is a disciplined "wait for a real edge" mode: fewer bets, only
 * the highest-quality opportunities surface.
 *
 * Filter pipeline — a leg passes Sharp Mode only when ALL of:
 *   1. Edge ≥ EDGE_THRESHOLD (default +3pp)
 *   2. EV ≥ EV_THRESHOLD (default 0.02)
 *   3. Existing passesQualityGates (impl prob ∈ [0.30, 0.85], volatility,
 *      recent_hit_rate floor)
 *   4. Sample-size minimum (≥ MIN_SAMPLES) per (sport × market)
 *      — pulled from mlReadiness; rejects buckets with <25 settled
 *   5. Risk band ≠ HIGH (or strict-only-LOW when very strict)
 *   6. Not in stat-type ban list
 *   7. matchup_quality !== "tough" (when present on the leg)
 *   8. timing_urgency !== "wait"
 *
 * Sharp Mode also constrains the OPTIMIZER:
 *   - Max 1 HIGH-risk leg in any parlay
 *   - No 4+ leg parlays
 *   - No Upside tier — only Primary or Balanced
 *   - Block correlated legs (same game / team)
 *
 * Empty result is valid: Sharp Mode can return zero qualifying picks
 * for the day. The UI surfaces a "No sharp bets today" empty state
 * rather than degrading the filter.
 */

import type { ValueBetCandidate } from "@/lib/valueParlay/types";
import { isBannedStatTypeForPrimary, passesQualityGates } from "@/lib/valueParlay/statTypeBans";
import { getPropRiskLevel } from "@/lib/valueParlay/propRiskLevels";
import { getMlReadinessSync } from "@/lib/learning/mlReadiness";

// ── Tunable thresholds (defaults; configurable via SharpModeContext) ─

export interface SharpThresholds {
  edgeThreshold: number;     // model_prob - implied_prob, additive (e.g. 0.03 = +3pp)
  evThreshold: number;       // expected value floor on a $1 stake (≥0.02)
  minSampleCount: number;    // require this many resolved samples in bucket
  maxLegs: number;           // max legs allowed in a Sharp parlay
  maxHighRiskLegs: number;   // max HIGH-risk legs allowed
  blockTough: boolean;       // reject matchup_quality === "tough"
  blockWait: boolean;        // reject timing_urgency === "wait"
}

export const SHARP_DEFAULTS: SharpThresholds = {
  edgeThreshold: 0.03,
  evThreshold: 0.02,
  minSampleCount: 25,
  maxLegs: 3,
  maxHighRiskLegs: 1,
  blockTough: true,
  blockWait: true,
};

// ── Expected Value ────────────────────────────────────────────────────

/**
 * EV per $1 stake. Positive = profitable in expectation.
 * EV = p_win * profit - (1-p_win) * stake
 *    = (p_win * (decimalOdds - 1)) - (1 - p_win) * 1
 */
export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american)) return 1;
  return american >= 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

export function computeEV(modelProb: number, american: number): number {
  if (!Number.isFinite(modelProb) || modelProb <= 0 || modelProb >= 1) return 0;
  const decimal = americanToDecimal(american);
  if (decimal <= 1) return 0;
  return modelProb * (decimal - 1) - (1 - modelProb);
}

// ── Filter pipeline ───────────────────────────────────────────────────

export interface SharpRejectionReason {
  code:
    | "below_edge_threshold"
    | "below_ev_threshold"
    | "below_sample_size"
    | "fails_quality_gate"
    | "high_risk"
    | "banned_stat"
    | "tough_matchup"
    | "wait_timing";
  detail: string;
}

export interface SharpEvaluation {
  passes: boolean;
  ev: number;
  edge: number;
  reasons: SharpRejectionReason[];
}

export function evaluateLeg(
  c: ValueBetCandidate,
  thresholds: SharpThresholds = SHARP_DEFAULTS,
): SharpEvaluation {
  const reasons: SharpRejectionReason[] = [];
  const ev = computeEV(c.modelProbability ?? 0, c.americanOdds);
  const edge = c.edge ?? ((c.modelProbability ?? 0) - (c.impliedProbability ?? 0));

  if (edge < thresholds.edgeThreshold) {
    reasons.push({ code: "below_edge_threshold", detail: `edge ${(edge * 100).toFixed(1)}pp < ${(thresholds.edgeThreshold * 100).toFixed(0)}pp floor` });
  }
  if (ev < thresholds.evThreshold) {
    reasons.push({ code: "below_ev_threshold", detail: `EV ${ev.toFixed(3)} < ${thresholds.evThreshold} floor` });
  }
  if (!passesQualityGates(c)) {
    reasons.push({ code: "fails_quality_gate", detail: "implied prob / volatility / recent hit rate failed" });
  }
  if (isBannedStatTypeForPrimary(c)) {
    reasons.push({ code: "banned_stat", detail: `stat_type "${c.statType}" is banned from disciplined surfaces` });
  }
  if (getPropRiskLevel(c) === "high") {
    reasons.push({ code: "high_risk", detail: "leg is HIGH risk; Sharp Mode requires LOW or MEDIUM" });
  }
  // matchup_quality lives on PlayerEdgePrediction but not yet on
  // ValueBetCandidate; carry-forward is a separate change. Gated via
  // optional access so the check is a soft no-op when missing.
  const mq = (c as ValueBetCandidate & { matchupQuality?: string }).matchupQuality;
  if (thresholds.blockTough && mq === "tough") {
    reasons.push({ code: "tough_matchup", detail: "matchup quality is tough" });
  }
  if (thresholds.blockWait && c.timingUrgency === "wait") {
    reasons.push({ code: "wait_timing", detail: "timing urgency = wait" });
  }
  // Sample-size gate using mlReadiness
  const readiness = getMlReadinessSync(c.sport, c.marketType);
  if (readiness.resolved_count < thresholds.minSampleCount) {
    reasons.push({ code: "below_sample_size", detail: `bucket has ${readiness.resolved_count}/${thresholds.minSampleCount} resolved samples` });
  }

  return { passes: reasons.length === 0, ev, edge, reasons };
}

/**
 * Rank a candidate pool by EV after filtering through Sharp Mode.
 * Returns the candidates that pass + their evaluation.
 */
export interface SharpRankedCandidate {
  candidate: ValueBetCandidate;
  evaluation: SharpEvaluation;
}

export function rankBySharpEv(
  candidates: ValueBetCandidate[],
  thresholds: SharpThresholds = SHARP_DEFAULTS,
): SharpRankedCandidate[] {
  return candidates
    .map((candidate) => ({ candidate, evaluation: evaluateLeg(candidate, thresholds) }))
    .filter((x) => x.evaluation.passes)
    .sort((a, b) => b.evaluation.ev - a.evaluation.ev);
}

/**
 * Build the single best Sharp Mode pick — null when no candidate
 * passes (empty day is valid, the UI shows "No sharp bets today").
 */
export function bestSharpBet(
  candidates: ValueBetCandidate[],
  thresholds: SharpThresholds = SHARP_DEFAULTS,
): SharpRankedCandidate | null {
  const ranked = rankBySharpEv(candidates, thresholds);
  return ranked[0] ?? null;
}

// ── Per-leg badge classifications ─────────────────────────────────────

export type SharpBadgeKey = "sharp_edge" | "positive_ev" | "line_advantage";

export function badgesForLeg(c: ValueBetCandidate, thresholds: SharpThresholds = SHARP_DEFAULTS): SharpBadgeKey[] {
  const out: SharpBadgeKey[] = [];
  const ev = computeEV(c.modelProbability ?? 0, c.americanOdds);
  const edge = c.edge ?? 0;
  if (edge >= thresholds.edgeThreshold) out.push("sharp_edge");
  if (ev >= thresholds.evThreshold) out.push("positive_ev");
  // "Line advantage" = the line moved in our favor since recommendation.
  // For team picks lineMovementDeltaPp > 0 is favorable; for player props
  // line_delta < 0 means the line came down (Over got easier).
  const lineDelta = (c as ValueBetCandidate & { lineMovementDeltaPp?: number }).lineMovementDeltaPp;
  if (typeof lineDelta === "number" && lineDelta > 1) out.push("line_advantage");
  return out;
}
