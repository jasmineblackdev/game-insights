/**
 * Today's Decision — single source of truth for the Home card.
 *
 * Pulls one verdict (BET / SKIP / MODIFY) from the existing daily-plan
 * pipeline so Home can answer "what should I do right now?" in one
 * line. This is a UI-layer aggregation only — it does not change any
 * scoring, optimizer, or correlation logic. It picks an existing
 * pipeline output and labels it.
 *
 * Verdict mapping:
 *   BET     — Primary anchor exists (high confidence, low/medium
 *             risk, passes quality gates).
 *   MODIFY  — Primary missing but Balanced has legs. Caller treats
 *             this as a "softer" recommendation (smaller stake or
 *             lower-confidence alternative).
 *   SKIP    — Neither tier produced legs. The disciplined call is
 *             not to bet today; the UI surfaces a "View best
 *             available anyway" fallback for users who want to
 *             override.
 *
 * Reasoning, confidence, and risk are pulled from the chosen plan
 * card so the surfaces stay consistent (same words on Home as on the
 * Builder slip).
 */

import type { ValueBetCandidate } from "@/lib/valueParlay/types";
import {
  generateDailyPlan,
  type DailyPlanCard,
} from "@/lib/dailyPlan/dailyPlanGenerator";

export type DecisionVerdict = "BET" | "MODIFY" | "SKIP";

export interface TodaysDecision {
  verdict: DecisionVerdict;
  /** Underlying plan card when verdict is BET or MODIFY; null on SKIP. */
  card: DailyPlanCard | null;
  /** One-liner the UI renders as the headline reason. */
  headline: string;
  /** Bulleted "why this pick" lines. Empty array on SKIP. */
  reasons: string[];
  /** Coarse confidence label for the badge. */
  confidence: "HIGH" | "MED" | "LOW" | "—";
  /** Coarse risk label for the badge. */
  risk: "Low" | "Medium" | "High" | "—";
  /**
   * Did the candidate pool actually have material to work with? When
   * false, the SKIP is a "no slate today" — there's nothing to
   * fall-back-to either, so the UI suppresses "View best available".
   */
  poolHadCandidates: boolean;
}

interface Args {
  candidates: ValueBetCandidate[];
  sharpMode?: boolean;
}

export function selectTodaysDecision({ candidates, sharpMode }: Args): TodaysDecision {
  const poolHadCandidates = candidates.length > 0;

  // Sharp mode flows untouched — the generator already enforces the
  // strict gates; we just label the output.
  const cards = generateDailyPlan({ candidates, sharpMode });
  const primary = cards.find((c) => c.tier === "primary" && c.legs.length > 0) ?? null;
  const balanced = cards.find((c) => c.tier === "balanced" && c.legs.length > 0) ?? null;

  if (primary) {
    return formatDecision("BET", primary, poolHadCandidates);
  }
  if (balanced) {
    return formatDecision("MODIFY", balanced, poolHadCandidates);
  }
  return {
    verdict: "SKIP",
    card: null,
    headline: poolHadCandidates
      ? "No bet today — no anchor met the discipline gates."
      : "No bet today — slate is empty or still loading.",
    reasons: [],
    confidence: "—",
    risk: "—",
    poolHadCandidates,
  };
}

function formatDecision(
  verdict: "BET" | "MODIFY",
  card: DailyPlanCard,
  poolHadCandidates: boolean,
): TodaysDecision {
  const lead = card.legs[0];
  const headline = card.legs.length === 1
    ? `${verdict} — ${lead?.selectionLabel ?? "Top single"}`
    : `${verdict} — ${card.legs.length}-leg ${card.tier} parlay`;

  const conf = lead?.confidence === "high" ? "HIGH"
    : lead?.confidence === "medium" ? "MED"
    : lead?.confidence === "low" ? "LOW"
    : "—";

  const risk = card.stakeRisk === "low" ? "Low"
    : card.stakeRisk === "medium" ? "Medium"
    : card.stakeRisk === "high" ? "High"
    : "—";

  return {
    verdict,
    card,
    headline,
    reasons: card.whyThisBet ?? [],
    confidence: conf,
    risk,
    poolHadCandidates,
  };
}
