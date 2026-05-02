/**
 * Today's Decision — top-of-Home card answering "should I bet today?"
 *
 * Phase 2 of the consolidation. Renders one of three states from the
 * `selectTodaysDecision` aggregator:
 *
 *   BET     — green tile. Headline = top pick / parlay label.
 *             Reasons + confidence + risk + "Open in Builder" CTA.
 *   MODIFY  — amber tile. Same shape as BET but the verdict signals
 *             "softer" — caller may suggest smaller stake.
 *   SKIP    — neutral tile. "No bet today" with the discipline reason.
 *             Shows a small "View best available anyway" link so the
 *             user can override; suppressed when the pool itself is
 *             empty (nothing to override to).
 */

import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  MinusCircle,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TodaysDecision } from "@/lib/insights/todaysDecision";
import {
  logDecisionFollowed,
  logDecisionOverridden,
  logDecisionShown,
} from "@/lib/learning/decisionLog";

interface Props {
  decision: TodaysDecision;
  /** When true, the card renders compactly (no reasons list). */
  compact?: boolean;
}

/** Minimal UUID v4 generator — avoids pulling crypto.randomUUID
 *  through the build for browsers that don't expose it. */
function newDecisionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `dec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function TodaysDecisionCard({ decision, compact = false }: Props) {
  // Stable decision_id per (verdict, headline) tuple within a session
  // — re-render with same content shouldn't double-log. Headline
  // change (different pick / new slate) gets a fresh id.
  const decisionId = useMemo(
    () => newDecisionId(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [decision.verdict, decision.headline],
  );

  useEffect(() => {
    logDecisionShown({
      decisionId,
      source: "todays_decision",
      decision,
    });
    // Re-fire when the decision content actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionId]);

  const { verdict, headline, reasons, confidence, risk, card, poolHadCandidates } = decision;

  const tone = verdict === "BET"
    ? "border-emerald-500/40 bg-emerald-500/[0.05]"
    : verdict === "MODIFY"
      ? "border-amber-500/40 bg-amber-500/[0.05]"
      : "border-border bg-card/40";

  const Icon = verdict === "BET" ? CheckCircle2 : verdict === "MODIFY" ? TriangleAlert : MinusCircle;
  const iconClass = verdict === "BET" ? "text-emerald-600 dark:text-emerald-400"
    : verdict === "MODIFY" ? "text-amber-700 dark:text-amber-400"
    : "text-muted-foreground";

  return (
    <section className={cn("rounded-xl border p-4 sm:p-5 space-y-3", tone)}>
      <div className="flex items-start gap-3">
        <Icon className={cn("w-5 h-5 shrink-0 mt-0.5", iconClass)} />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              Today's Decision
            </p>
            {confidence !== "—" ? (
              <span className={cn(
                "text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase",
                confidence === "HIGH" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : confidence === "MED" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                : "bg-muted text-muted-foreground",
              )}>
                {confidence}
              </span>
            ) : null}
            {risk !== "—" ? (
              <span className={cn(
                "text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase",
                risk === "Low" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : risk === "Medium" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "bg-red-500/10 text-red-700 dark:text-red-400",
              )}>
                Risk {risk}
              </span>
            ) : null}
          </div>
          <p className="text-sm sm:text-base font-display font-bold text-foreground">
            {headline}
          </p>
        </div>
      </div>

      {!compact && reasons.length > 0 ? (
        <ul className="space-y-1 pl-7 text-[12px] text-muted-foreground">
          {reasons.slice(0, 3).map((r, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <ChevronRight className="w-3 h-3 mt-0.5 shrink-0 opacity-60" />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-2 pl-7">
        {verdict === "BET" || verdict === "MODIFY" ? (
          <Link
            to="/builder?view=parlay_builder"
            onClick={() => logDecisionFollowed({
              decisionId, source: "todays_decision", verdict,
            })}
            className={cn(
              "inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors",
              verdict === "BET"
                ? "bg-emerald-600 text-white hover:bg-emerald-600/90"
                : "bg-amber-600 text-white hover:bg-amber-600/90",
            )}
          >
            Open in Builder
            <ArrowRight className="w-3 h-3" />
          </Link>
        ) : null}

        {/* "View best available anyway" — only when SKIP and the pool
            has SOMETHING to look at. Suppressed on truly-empty slates
            where there's nothing to override to. Logged as an
            override since the user is going against the SKIP verdict. */}
        {verdict === "SKIP" && poolHadCandidates ? (
          <Link
            to="/builder"
            onClick={() => logDecisionOverridden({
              decisionId, source: "todays_decision", verdict,
            })}
            className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            View best available anyway →
          </Link>
        ) : null}

        {card?.legs.length ? (
          <span className="text-[10px] text-muted-foreground tabular-nums ml-auto">
            {card.legs.length} {card.legs.length === 1 ? "leg" : "legs"}
            {card.result?.combinedAmericanOdds != null ? (
              <> · {card.result.combinedAmericanOdds > 0 ? "+" : ""}{card.result.combinedAmericanOdds}</>
            ) : null}
          </span>
        ) : null}
      </div>
    </section>
  );
}
