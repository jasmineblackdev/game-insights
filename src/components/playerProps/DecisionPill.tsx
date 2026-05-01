/**
 * DecisionPill — single-glance verdict badge.
 * PLACE (green) / MODIFY (amber) / AVOID (red) with icon.
 *
 * Pure rendering; the verdict comes from legAudit() in
 * executionAssistant.ts. Same source of truth the slip-level
 * auditSlip uses, so per-card and per-slip verdicts agree.
 */

import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { legAudit } from "@/lib/valueParlay/executionAssistant";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";

interface Props {
  candidate: ValueBetCandidate;
  /** Smaller variant for inline scanner rows. */
  size?: "sm" | "md";
  /** Show the trailing reason text. Defaults to true on md, false on sm. */
  showReason?: boolean;
}

export function DecisionPill({ candidate, size = "md", showReason }: Props) {
  const decision = candidate.decision ?? legAudit(candidate);
  const showReasonResolved = showReason ?? size === "md";

  const tone =
    decision.verdict === "PLACE" ? "border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-400"
    : decision.verdict === "MODIFY" ? "border-amber-500/40 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400"
    : "border-red-500/40 bg-red-500/[0.08] text-red-700 dark:text-red-400";
  const Icon =
    decision.verdict === "PLACE" ? CheckCircle2
    : decision.verdict === "MODIFY" ? AlertTriangle
    : XCircle;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border font-bold",
        size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]",
        tone,
      )}
      title={`${decision.verdict} — ${decision.reason}`}
    >
      <Icon className={size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5"} />
      <span>{decision.verdict}</span>
      {showReasonResolved ? (
        <span className="font-normal opacity-80 ml-1 hidden sm:inline">
          · {decision.reason}
        </span>
      ) : null}
    </span>
  );
}
