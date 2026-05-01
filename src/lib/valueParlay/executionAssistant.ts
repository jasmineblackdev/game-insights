/**
 * Execution Assistant — deterministic decision engine
 *
 * Runs structured analyses on the user's slip and the candidate pool
 * without depending on the LLM gateway. Used by DkExecutionAssistant
 * for quick-action buttons (Audit, Build SAFE, Build CASH-OUT, Find
 * weakest, Improve payout). Freeform chat still routes through the
 * Lovable AI Gateway — this engine is what keeps the assistant useful
 * even when the gateway is down or the API key is missing.
 *
 * Reuses existing helpers — does NOT re-implement scoring:
 *   - optimizeSmartParlays — for SAFE / CASH-OUT builds (already
 *     applies edge floor, longshot stat bans, correlation guards,
 *     fragility rejection, vig-aware EV check, etc.)
 *   - computeLegScore       — for "weakest leg" identification
 *   - ValueBetCandidate flags (staleLineFlag, lateChangeInvalidated,
 *     correlationGroupId, edge, americanOdds, recentHitRate, etc.)
 *
 * Output shape mirrors the format the user asked for:
 *   { verdict, weakestLeg, actions, risk, draftKingsInstruction, warnings }
 */

import type { ValueBetCandidate, AnalyticsWeights, SmartParlayResult } from "./types";
import { optimizeSmartParlays, computeLegScore } from "./parlayOptimizer";

export type Verdict = "PLACE" | "MODIFY" | "AVOID" | "BUILD" | "INSUFFICIENT_DATA";
export type Risk = "Low" | "Medium" | "High";

export interface AssistantWarning {
  level: "warn" | "block";
  message: string;
}

export interface AssistantAction {
  /** "remove" | "keep" | "replace" | "build_safe" | "build_cashout" | "swap" */
  kind: "remove" | "keep" | "replace" | "build_safe" | "build_cashout" | "swap" | "rebuild";
  text: string;
  /** Optional candidate to add when kind === "replace" or "swap". */
  replacement?: ValueBetCandidate;
  /** Optional leg to act on (for remove / replace / swap). */
  legId?: string;
}

export interface AssistantResponse {
  verdict: Verdict;
  /** Title shown at the top of the structured response. */
  title: string;
  /** Short one-line summary used as the response subtitle. */
  summary: string;
  weakestLeg?: { legId: string; label: string; reason: string };
  actions: AssistantAction[];
  risk: Risk;
  /** Short manual instruction the user copies to their second device. */
  draftKingsInstruction: string;
  warnings: AssistantWarning[];
  /** Optional: a fully built parlay to surface in the response card. */
  builtParlay?: SmartParlayResult;
}

// ── Pool / slip safety scans ─────────────────────────────────────────

/**
 * Surface red flags that should block or qualify recommendations:
 * stale lines, late roster changes, longshot legs in safe contexts,
 * same-game correlations, missing recent-hit-rate samples, empty
 * pool, etc. Returns warnings ordered by severity.
 */
export function scanWarnings(args: {
  slipLegs: ValueBetCandidate[];
  pool: ValueBetCandidate[];
  /** Treat this set as the legs to audit (slip-only or slip+candidates). */
  context: "slip" | "pool" | "both";
}): AssistantWarning[] {
  const { slipLegs, pool, context } = args;
  const out: AssistantWarning[] = [];

  // Empty-input warnings drive what's even possible.
  if (context === "slip" && slipLegs.length === 0) {
    out.push({ level: "block", message: "No legs on your slip — add picks before audit." });
  }
  if ((context === "pool" || context === "both") && pool.length === 0) {
    out.push({ level: "block", message: "Candidate pool is empty — open the parlay builder so candidates load." });
  }

  // Inspect slip legs first (anything the user has actively chosen).
  const stale = slipLegs.filter((c) => c.staleLineFlag);
  if (stale.length) {
    out.push({
      level: "warn",
      message: `${stale.length} slip leg${stale.length === 1 ? "" : "s"} on a stale price — refresh odds before placing.`,
    });
  }
  const lateChange = slipLegs.filter((c) => c.lateChangeInvalidated);
  if (lateChange.length) {
    out.push({
      level: "block",
      message: `${lateChange.length} slip leg${lateChange.length === 1 ? "" : "s"} invalidated by late roster / lineup change — remove.`,
    });
  }

  // Same-game correlation: two or more legs sharing correlationGroupId.
  const corrCounts = new Map<string, number>();
  for (const c of slipLegs) {
    if (!c.correlationGroupId) continue;
    corrCounts.set(c.correlationGroupId, (corrCounts.get(c.correlationGroupId) ?? 0) + 1);
  }
  for (const [, n] of corrCounts) {
    if (n >= 2) {
      out.push({
        level: "warn",
        message: "Same-game correlation detected — two slip legs move together; books don't pay full parlay odds.",
      });
      break;
    }
  }

  // Longshot leg surfaced in a slip with safe-leaning intent
  // (americanOdds > +200 = ~33% implied; in SAFE/CASHOUT context
  // anything above +180 is unusual).
  const longshotsOnSlip = slipLegs.filter((c) => Number.isFinite(c.americanOdds) && c.americanOdds >= 200);
  if (longshotsOnSlip.length) {
    out.push({
      level: "warn",
      message: `${longshotsOnSlip.length} longshot${longshotsOnSlip.length === 1 ? "" : "s"} on slip (${longshotsOnSlip.map((c) => c.selectionLabel).join(", ")}) — risky in SAFE/CASHOUT framings.`,
    });
  }

  // Injury / lineup uncertainty flags from upstream.
  const uncertain = slipLegs.filter((c) =>
    (c.exclusionReason ?? "").toLowerCase().includes("pitcher") ||
    (c.exclusionReason ?? "").toLowerCase().includes("inactive") ||
    (c.exclusionReason ?? "").toLowerCase().includes("injury")
  );
  if (uncertain.length) {
    out.push({
      level: "warn",
      message: `Injury / lineup uncertainty on ${uncertain.length} slip leg${uncertain.length === 1 ? "" : "s"} — confirm before placing.`,
    });
  }

  // Pool-side: warn if the pool lacks any safe candidates.
  if (context !== "slip" && pool.length) {
    const safeCount = pool.filter(
      (c) => c.isRecommended && c.confidence === "high" && (c.volatilityScore ?? 0) < 55,
    ).length;
    if (safeCount === 0) {
      out.push({
        level: "warn",
        message: "No high-confidence / low-volatility legs in today's pool — SAFE builds may be thin.",
      });
    }
  }

  return out;
}

// ── Audit slip ───────────────────────────────────────────────────────

export function auditSlip(args: {
  slipLegs: ValueBetCandidate[];
  weights?: AnalyticsWeights;
}): AssistantResponse {
  const { slipLegs, weights = {} } = args;
  const warnings = scanWarnings({ slipLegs, pool: [], context: "slip" });

  if (slipLegs.length === 0) {
    return {
      verdict: "INSUFFICIENT_DATA",
      title: "Audit my slip",
      summary: "No legs to analyze.",
      actions: [],
      risk: "Low",
      draftKingsInstruction: "Add picks to your slip first.",
      warnings,
    };
  }

  // Score every leg, identify weakest.
  const scored = slipLegs.map((l) => ({ l, s: computeLegScore(l, weights) }));
  scored.sort((a, b) => a.s - b.s);
  const weakest = scored[0];
  const weakestReasons: string[] = [];
  if (weakest.l.staleLineFlag) weakestReasons.push("stale price");
  if (weakest.l.lateChangeInvalidated) weakestReasons.push("late lineup change");
  if (weakest.l.confidence === "low") weakestReasons.push("low confidence");
  if ((weakest.l.volatilityScore ?? 0) >= 70) weakestReasons.push("very high volatility");
  if (Number.isFinite(weakest.l.americanOdds) && weakest.l.americanOdds >= 200) weakestReasons.push("longshot odds");
  if ((weakest.l.edge ?? 0) < 0.04) weakestReasons.push(`thin edge (${((weakest.l.edge ?? 0) * 100).toFixed(1)}%)`);
  const weakestReason = weakestReasons.length ? weakestReasons.join(" + ") : `lowest composite score (${weakest.s.toFixed(2)})`;

  const blockers = warnings.filter((w) => w.level === "block");
  const warnCount = warnings.filter((w) => w.level === "warn").length;

  // Verdict logic — block-level warnings → AVOID; warn-level → MODIFY;
  // otherwise PLACE (subject to weakest leg quality).
  let verdict: Verdict = "PLACE";
  if (blockers.length) verdict = "AVOID";
  else if (warnCount > 0 || weakest.s < 0.35) verdict = "MODIFY";

  // Risk derived from worst-case fragility signals.
  const avgVol = slipLegs.reduce((s, c) => s + (c.volatilityScore ?? 0), 0) / slipLegs.length;
  const risk: Risk =
    blockers.length || avgVol >= 70 ? "High"
    : warnCount > 0 || avgVol >= 50 ? "Medium"
    : "Low";

  const actions: AssistantAction[] = [];
  if (verdict === "AVOID") {
    actions.push({ kind: "rebuild", text: "Rebuild from candidate pool — current slip has integrity issues." });
  } else if (verdict === "MODIFY") {
    actions.push({
      kind: "remove",
      legId: weakest.l.id,
      text: `Remove ${weakest.l.selectionLabel} — ${weakestReason}.`,
    });
    actions.push({ kind: "build_safe", text: "Build a SAFE 2-leg from the pool as a fallback." });
  } else {
    actions.push({ kind: "keep", text: `Keep all ${slipLegs.length} legs — slip passes integrity checks.` });
  }

  const odds = slipLegs.reduce((acc, c) => acc * americanToDecimal(c.americanOdds), 1);
  const americanCombined = decimalToAmerican(odds);
  const draftKingsInstruction =
    verdict === "AVOID" ? "Do not place this slip on DraftKings — see warnings above."
    : verdict === "MODIFY" ? `On DraftKings: remove ${weakest.l.selectionLabel}, then place the remaining ${slipLegs.length - 1}-leg parlay (target ${formatAmerican(americanCombined)}).`
    : `On DraftKings: place this ${slipLegs.length}-leg parlay (target ${formatAmerican(americanCombined)}).`;

  return {
    verdict,
    title: "Slip audit",
    summary: `${slipLegs.length} legs · weakest score ${weakest.s.toFixed(2)} · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`,
    weakestLeg: { legId: weakest.l.id, label: weakest.l.selectionLabel, reason: weakestReason },
    actions,
    risk,
    draftKingsInstruction,
    warnings,
  };
}

// ── Find single weakest leg ──────────────────────────────────────────

export function findWeakestLeg(args: {
  slipLegs: ValueBetCandidate[];
  weights?: AnalyticsWeights;
}): AssistantResponse {
  const { slipLegs, weights = {} } = args;
  if (slipLegs.length === 0) {
    return {
      verdict: "INSUFFICIENT_DATA",
      title: "Find weakest leg",
      summary: "Slip is empty.",
      actions: [],
      risk: "Low",
      draftKingsInstruction: "Add picks to your slip first.",
      warnings: [{ level: "block", message: "No legs on slip." }],
    };
  }
  const scored = slipLegs.map((l) => ({ l, s: computeLegScore(l, weights) }));
  scored.sort((a, b) => a.s - b.s);
  const w = scored[0];
  const reasonBits: string[] = [];
  if (w.l.staleLineFlag) reasonBits.push("stale price");
  if (w.l.lateChangeInvalidated) reasonBits.push("late lineup change");
  if (w.l.confidence === "low") reasonBits.push("low confidence");
  if ((w.l.volatilityScore ?? 0) >= 70) reasonBits.push("high volatility");
  if (Number.isFinite(w.l.americanOdds) && w.l.americanOdds >= 200) reasonBits.push("longshot odds");
  if ((w.l.edge ?? 0) < 0.04) reasonBits.push(`thin edge ${((w.l.edge ?? 0) * 100).toFixed(1)}%`);
  const reason = reasonBits.length ? reasonBits.join(" + ") : `lowest composite score ${w.s.toFixed(2)}`;
  return {
    verdict: "MODIFY",
    title: "Weakest leg",
    summary: `${w.l.selectionLabel} — ${reason}.`,
    weakestLeg: { legId: w.l.id, label: w.l.selectionLabel, reason },
    actions: [
      { kind: "remove", legId: w.l.id, text: `Remove ${w.l.selectionLabel}.` },
      { kind: "build_safe", text: "Build a SAFE 2-leg from the pool to replace it." },
    ],
    risk: w.s < 0.30 ? "High" : w.s < 0.50 ? "Medium" : "Low",
    draftKingsInstruction: `On DraftKings: remove ${w.l.selectionLabel}.`,
    warnings: scanWarnings({ slipLegs, pool: [], context: "slip" }),
  };
}

// ── Build SAFE 2-leg ─────────────────────────────────────────────────

export function buildSafeParlay(args: {
  pool: ValueBetCandidate[];
  weights?: AnalyticsWeights;
}): AssistantResponse {
  const { pool, weights = {} } = args;
  const warnings = scanWarnings({ slipLegs: [], pool, context: "pool" });
  if (pool.length === 0) {
    return {
      verdict: "INSUFFICIENT_DATA",
      title: "Build SAFE 2-leg",
      summary: "Candidate pool is empty.",
      actions: [],
      risk: "Low",
      draftKingsInstruction: "Open the parlay builder so candidates load, then retry.",
      warnings,
    };
  }
  const triple = optimizeSmartParlays(pool, "safe", weights);
  const safe = triple.bestValue;
  if (!safe.legs.length) {
    return {
      verdict: "AVOID",
      title: "Build SAFE 2-leg",
      summary: "No legs in today's pool clear the SAFE filters.",
      actions: [{ kind: "build_cashout", text: "Try a CASH-OUT 3-leg instead — looser filters." }],
      risk: "Low",
      draftKingsInstruction: "No SAFE parlay available — wait for fresh edges or skip the day.",
      warnings,
    };
  }
  return {
    verdict: "BUILD",
    title: `SAFE ${safe.legs.length}-leg`,
    summary: `Hit ${(safe.projectedHitProbability * 100).toFixed(1)}% · payout ${safe.projectedPayoutMultiplier.toFixed(2)}x · ${formatAmerican(safe.combinedAmericanOdds)}.`,
    actions: [
      { kind: "build_safe", text: `Apply this SAFE ${safe.legs.length}-leg to your slip.` },
    ],
    risk: safeRiskFromCard(safe),
    draftKingsInstruction: `On DraftKings: place this ${safe.legs.length}-leg parlay (${formatAmerican(safe.combinedAmericanOdds)}). ${legsInstruction(safe.legs)}`,
    warnings,
    builtParlay: safe,
  };
}

// ── Build CASH-OUT 3-leg ─────────────────────────────────────────────

export function buildCashoutParlay(args: {
  pool: ValueBetCandidate[];
  weights?: AnalyticsWeights;
}): AssistantResponse {
  const { pool, weights = {} } = args;
  const warnings = scanWarnings({ slipLegs: [], pool, context: "pool" });
  if (pool.length === 0) {
    return {
      verdict: "INSUFFICIENT_DATA",
      title: "Build CASH-OUT 3-leg",
      summary: "Candidate pool is empty.",
      actions: [],
      risk: "Low",
      draftKingsInstruction: "Open the parlay builder so candidates load, then retry.",
      warnings,
    };
  }
  const triple = optimizeSmartParlays(pool, "cashout", weights);
  const cash = triple.bestValue;
  if (!cash.legs.length) {
    return {
      verdict: "AVOID",
      title: "Build CASH-OUT 3-leg",
      summary: "No combination clears the CASH-OUT structure (staggered starts + diversified).",
      actions: [{ kind: "build_safe", text: "Try a SAFE 2-leg instead." }],
      risk: "Low",
      draftKingsInstruction: "No CASH-OUT parlay available right now.",
      warnings,
    };
  }
  return {
    verdict: "BUILD",
    title: `CASH-OUT ${cash.legs.length}-leg`,
    summary: `Hit ${(cash.projectedHitProbability * 100).toFixed(1)}% · payout ${cash.projectedPayoutMultiplier.toFixed(2)}x · ${formatAmerican(cash.combinedAmericanOdds)}.`,
    actions: [
      { kind: "build_cashout", text: `Apply this CASH-OUT ${cash.legs.length}-leg to your slip.` },
    ],
    risk: safeRiskFromCard(cash),
    draftKingsInstruction: `On DraftKings: place this ${cash.legs.length}-leg parlay. After the first leg settles, watch the cash-out price; take it when ≥ 60% of full payout. Legs in order: ${legsInstruction(cash.legs)}`,
    warnings,
    builtParlay: cash,
  };
}

// ── Improve payout without longshots ─────────────────────────────────

export function improvePayout(args: {
  slipLegs: ValueBetCandidate[];
  pool: ValueBetCandidate[];
  weights?: AnalyticsWeights;
}): AssistantResponse {
  const { slipLegs, pool, weights = {} } = args;
  const warnings = scanWarnings({ slipLegs, pool, context: "both" });
  if (pool.length === 0) {
    return {
      verdict: "INSUFFICIENT_DATA",
      title: "Improve payout",
      summary: "Candidate pool is empty.",
      actions: [],
      risk: "Low",
      draftKingsInstruction: "Open the parlay builder so candidates load.",
      warnings,
    };
  }
  // Use the optimizer's higherPayout slot in safe/balanced framings to
  // get a payout-leaning build that still respects edge floors and
  // longshot bans.
  const mode = slipLegs.length === 0 ? "balanced" : "balanced";
  const triple = optimizeSmartParlays(pool, mode, weights);
  const better = triple.higherPayout.legs.length ? triple.higherPayout : triple.bestValue;
  if (!better.legs.length) {
    return {
      verdict: "AVOID",
      title: "Improve payout",
      summary: "No higher-payout build clears the longshot bans.",
      actions: [],
      risk: "Low",
      draftKingsInstruction: "No upside-leaning parlay available without longshots.",
      warnings,
    };
  }
  const slipPayout = slipLegs.length ? slipLegs.reduce((m, c) => m * americanToDecimal(c.americanOdds), 1) : 1;
  const slipMult = slipPayout;
  const lift = better.projectedPayoutMultiplier - slipMult;
  return {
    verdict: lift > 0.2 ? "MODIFY" : "PLACE",
    title: "Higher-payout alternative",
    summary: lift > 0
      ? `Pool yields ${better.projectedPayoutMultiplier.toFixed(2)}x at ${(better.projectedHitProbability * 100).toFixed(1)}% (vs slip ${slipMult.toFixed(2)}x). No longshots used.`
      : `Pool's best alternative pays ${better.projectedPayoutMultiplier.toFixed(2)}x — not better than current slip.`,
    actions: lift > 0.2 ? [
      { kind: "rebuild", text: `Replace slip with ${better.legs.length}-leg ${mode} build.` },
    ] : [
      { kind: "keep", text: "Keep current slip — payout already competitive." },
    ],
    risk: safeRiskFromCard(better),
    draftKingsInstruction: lift > 0.2
      ? `On DraftKings: clear the slip and place this ${better.legs.length}-leg parlay (${formatAmerican(better.combinedAmericanOdds)}). Legs: ${legsInstruction(better.legs)}`
      : "Keep the current slip on DraftKings — alternative doesn't materially improve payout.",
    warnings,
    builtParlay: better,
  };
}

// ── Compare slip vs pool (BOTH mode) ─────────────────────────────────

export function compareSlipVsPool(args: {
  slipLegs: ValueBetCandidate[];
  pool: ValueBetCandidate[];
  weights?: AnalyticsWeights;
}): AssistantResponse {
  const { slipLegs, pool, weights = {} } = args;
  if (slipLegs.length === 0) {
    return buildSafeParlay({ pool, weights });
  }
  if (pool.length === 0) {
    return auditSlip({ slipLegs, weights });
  }

  const slipAudit = auditSlip({ slipLegs, weights });
  const safeBuild = buildSafeParlay({ pool, weights });

  // If slip is fine and SAFE alternative isn't dramatically better, keep.
  // If slip has blockers, recommend rebuild.
  // Otherwise compare hit-prob × payout (rough EV proxy) and pick.
  const slipDecimal = slipLegs.reduce((m, c) => m * americanToDecimal(c.americanOdds), 1);
  const slipHitProxy = slipLegs.reduce(
    (m, c) => m * Math.max(0.01, Math.min(0.99, c.modelProbability ?? c.impliedProbability ?? 0.5)),
    1,
  );
  const slipEv = slipHitProxy * slipDecimal;
  const safeEv = safeBuild.builtParlay
    ? safeBuild.builtParlay.projectedHitProbability * safeBuild.builtParlay.projectedPayoutMultiplier
    : 0;

  const blockerOnSlip = slipAudit.warnings.some((w) => w.level === "block");
  let verdict: Verdict;
  let summary: string;
  let actions: AssistantAction[];
  let dkInstruction: string;

  if (blockerOnSlip || slipAudit.verdict === "AVOID") {
    verdict = "AVOID";
    summary = `Slip has integrity issues. Pool's SAFE build is the cleaner play (${safeBuild.summary})`;
    actions = [{ kind: "rebuild", text: "Replace slip with the SAFE build from the pool." }];
    dkInstruction = `On DraftKings: clear the slip and place the SAFE alternative. ${safeBuild.draftKingsInstruction.replace(/^On DraftKings:\s*/, "")}`;
  } else if (safeEv > slipEv * 1.2 && safeBuild.builtParlay) {
    verdict = "MODIFY";
    summary = `Pool's SAFE build offers ~${Math.round(((safeEv / Math.max(0.01, slipEv)) - 1) * 100)}% better EV. Switch.`;
    actions = [{ kind: "rebuild", text: "Replace slip with the SAFE build." }];
    dkInstruction = safeBuild.draftKingsInstruction;
  } else {
    verdict = slipAudit.verdict === "PLACE" ? "PLACE" : "MODIFY";
    summary = slipAudit.verdict === "PLACE"
      ? "Current slip is the better play — pool alternatives don't improve EV materially."
      : `Trim slip per audit (${slipAudit.weakestLeg?.label ?? "weakest leg"}); pool isn't dramatically better.`;
    actions = slipAudit.actions;
    dkInstruction = slipAudit.draftKingsInstruction;
  }

  return {
    verdict,
    title: "Slip vs pool",
    summary,
    weakestLeg: slipAudit.weakestLeg,
    actions,
    risk: slipAudit.risk,
    draftKingsInstruction: dkInstruction,
    warnings: [...slipAudit.warnings, ...safeBuild.warnings.filter((w) => w.level === "block")],
    builtParlay: safeBuild.builtParlay,
  };
}

// ── Per-leg audit ─────────────────────────────────────────────────────
// Single leg → {verdict, reason}. Pure derivation from existing fields.
// Used by DecisionPill on every prop / parlay-leg card so the same
// thresholds the slip-level auditSlip uses apply to each leg in
// isolation. NEVER overrides the optimizer's isRecommended logic —
// this is a display layer, not a gate.

export function legAudit(c: ValueBetCandidate): {
  verdict: "PLACE" | "MODIFY" | "AVOID";
  reason: string;
} {
  // Hard blockers first — these never become PLACE / MODIFY no matter
  // how good the other signals look.
  if (c.staleLineFlag) return { verdict: "AVOID", reason: "Stale price" };
  if (c.lateChangeInvalidated) return { verdict: "AVOID", reason: "Late lineup change" };
  if (c.exclusionReason) return { verdict: "AVOID", reason: c.exclusionReason };
  if ((c.edge ?? 0) < 0.03) return { verdict: "AVOID", reason: "Edge below floor (3%)" };
  if (c.confidence === "low") return { verdict: "AVOID", reason: "Low confidence" };

  // Modify zone — playable but flagged.
  if (Number.isFinite(c.americanOdds) && c.americanOdds >= 250) {
    return { verdict: "MODIFY", reason: "Longshot odds — pair with stable leg" };
  }
  if ((c.volatilityScore ?? 0) >= 70) {
    return { verdict: "MODIFY", reason: "High variance — pair with stable leg" };
  }
  // Hit rate: only flag when the sample is large enough to mean something.
  const hr = c.hitRates;
  if (hr?.last10 != null && hr.samples.last10 >= 8 && hr.last10 < 0.40) {
    const wins = Math.round(hr.last10 * hr.samples.last10);
    return { verdict: "MODIFY", reason: `L10 only ${wins}/${hr.samples.last10}` };
  }
  if ((c.stabilityScore ?? 1) < 0.35) {
    return { verdict: "MODIFY", reason: "Low-stability prop — manage exposure" };
  }

  // PLACE — green across the board.
  return { verdict: "PLACE", reason: "Edge + form + stability all clear" };
}

// ── Helpers ───────────────────────────────────────────────────────────

function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 1;
  if (american > 0) return 1 + american / 100;
  return 1 + 100 / Math.abs(american);
}

function decimalToAmerican(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) return 0;
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return Math.round(-100 / (decimal - 1));
}

function formatAmerican(o: number): string {
  if (!Number.isFinite(o) || o === 0) return "—";
  return o > 0 ? `+${o}` : `${o}`;
}

function legsInstruction(legs: ValueBetCandidate[]): string {
  return legs
    .map((l, i) => `${i + 1}) ${l.selectionLabel} ${formatAmerican(l.americanOdds)}`)
    .join("; ");
}

function safeRiskFromCard(card: SmartParlayResult): Risk {
  if (card.cardConfidence === "high") return "Low";
  if (card.cardConfidence === "medium") return "Medium";
  return "High";
}
