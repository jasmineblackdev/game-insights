/**
 * decision_log client — fire-and-forget writes of AI-verdict
 * impressions and user-action follow-ups.
 *
 * Two entry points:
 *   logDecisionShown()    — called when a verdict surfaces on the
 *                           Home card. Idempotent per decision_id +
 *                           source within a render lifecycle.
 *   logDecisionFollowed() — called when the user clicks through to
 *                           act on the verdict (e.g. "Open in
 *                           Builder"). Same decision_id ties the
 *                           pair together.
 *
 * Fire-and-forget: failures swallowed with console.warn so a
 * Supabase outage never breaks the UI. The table is permissive RLS
 * so the anon client can write.
 *
 * Not yet wired to analytics — Phase 5+ will roll these into the
 * "AI vs user compliance" metric on Insights. For now we're just
 * starting the trail.
 */

import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import type { DecisionVerdict, TodaysDecision } from "@/lib/insights/todaysDecision";

export type DecisionSource =
  | "todays_decision"
  | "builder"
  | "paper_draft"
  | "paper_submit"
  | "manual_override";

export type DecisionAction =
  | "shown"
  | "followed"
  | "overridden"
  | "ignored";

interface LogArgs {
  decisionId: string;
  source: DecisionSource;
  verdict: DecisionVerdict;
  action: DecisionAction;
  payload?: Record<string, unknown>;
}

async function writeRow(args: LogArgs): Promise<void> {
  if (!isSupabaseConfigured || !supabase) return;
  try {
    const { error } = await supabase.from("decision_log").insert({
      decision_id: args.decisionId,
      source: args.source,
      verdict: args.verdict,
      action: args.action,
      payload: args.payload ?? {},
    });
    if (error) {
      // Migration not applied yet (PGRST205 / 42P01) is the common
      // path on fresh deploys — warn once, don't bubble.
      console.warn("[decisionLog] insert failed:", error.message);
    }
  } catch (e) {
    console.warn("[decisionLog] write threw:", e);
  }
}

/**
 * Build a payload snapshot from a TodaysDecision so the row carries
 * enough context for after-the-fact analytics without joining other
 * tables.
 */
function decisionToPayload(d: TodaysDecision): Record<string, unknown> {
  return {
    headline:    d.headline,
    confidence:  d.confidence,
    risk:        d.risk,
    reasons:     d.reasons.slice(0, 3),
    leg_count:   d.card?.legs.length ?? 0,
    combined_american_odds: d.card?.result?.combinedAmericanOdds ?? null,
    pool_had_candidates:    d.poolHadCandidates,
  };
}

export function logDecisionShown(args: {
  decisionId: string;
  source: DecisionSource;
  decision: TodaysDecision;
}): void {
  void writeRow({
    decisionId: args.decisionId,
    source: args.source,
    verdict: args.decision.verdict,
    action: "shown",
    payload: decisionToPayload(args.decision),
  });
}

export function logDecisionFollowed(args: {
  decisionId: string;
  source: DecisionSource;
  verdict: DecisionVerdict;
  payload?: Record<string, unknown>;
}): void {
  void writeRow({
    decisionId: args.decisionId,
    source: args.source,
    verdict: args.verdict,
    action: "followed",
    payload: args.payload ?? {},
  });
}

export function logDecisionOverridden(args: {
  decisionId: string;
  source: DecisionSource;
  verdict: DecisionVerdict;
  payload?: Record<string, unknown>;
}): void {
  void writeRow({
    decisionId: args.decisionId,
    source: args.source,
    verdict: args.verdict,
    action: "overridden",
    payload: args.payload ?? {},
  });
}
