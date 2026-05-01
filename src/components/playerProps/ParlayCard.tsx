/**
 * ParlayCard — canonical card for an auto-built parlay.
 *
 * Surfaces the data the optimizer already computes:
 *   - SmartParlayResult.projectedHitProbability (correlation-aware,
 *     NOT naive multiplication)
 *   - projectedPayoutMultiplier
 *   - combinedAmericanOdds
 *   - cardConfidence
 *   - weakestLegId / strongestLegId
 *   - wouldITakeIt + wouldITakeItReason
 *   - warnings
 *
 * Plus derives a single PLACE / MODIFY / AVOID verdict for the
 * whole ticket from the slip-level auditSlip in executionAssistant —
 * same source of truth the DraftKings assistant uses.
 *
 * Progressive disclosure mirrors BetCard: summary always visible,
 * "Details" reveals leg-by-leg breakdown + correlation notes + DK
 * action plan + cash-out plan when applicable.
 */

import { useState } from "react";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useValueParlay } from "@/context/ValueParlayContext";
import type { SmartParlayResult, ValueBetCandidate } from "@/lib/valueParlay/types";
import { auditSlip, legAudit } from "@/lib/valueParlay/executionAssistant";

interface Props {
  title: string;
  /** Sub-tier label, e.g. "2 legs · staggered" or "Best value". */
  subtitle?: string;
  result: SmartParlayResult;
  /** True when this is the cash-out variant — adds a cash-out plan section. */
  cashOutVariant?: boolean;
  /** Override the apply CTA. */
  onApply?: (legs: ValueBetCandidate[]) => void;
}

export function ParlayCard({ title, subtitle, result, cashOutVariant, onApply }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { setBuilderLegs } = useValueParlay();

  if (!result.legs.length) return null;

  const hit = result.projectedHitProbability;
  const payoutX = result.projectedPayoutMultiplier;
  const combined = result.combinedAmericanOdds;
  const cardAudit = auditSlip({ slipLegs: result.legs });

  const weakIdx = result.legs.findIndex((l) => l.id === result.weakestLegId);
  const weak = weakIdx >= 0 ? result.legs[weakIdx] : null;
  const strongIdx = result.legs.findIndex((l) => l.id === result.strongestLegId);
  const strong = strongIdx >= 0 ? result.legs[strongIdx] : null;
  const weakReason = weak ? legAudit(weak).reason : null;

  const apply = () => {
    if (onApply) onApply(result.legs);
    else {
      setBuilderLegs(result.legs);
      toast.success(`${result.legs.length}-leg parlay applied to slip.`);
    }
  };

  // Same-game correlation = ≥2 legs sharing correlationGroupId
  const corrCounts = new Map<string, number>();
  for (const l of result.legs) {
    const g = l.correlationGroupId ?? l.gameId;
    corrCounts.set(g, (corrCounts.get(g) ?? 0) + 1);
  }
  const hasCorrelation = [...corrCounts.values()].some((n) => n >= 2);

  const verdictTone =
    cardAudit.verdict === "PLACE" ? "border-emerald-500/40 bg-emerald-500/[0.04]"
    : cardAudit.verdict === "MODIFY" ? "border-amber-500/40 bg-amber-500/[0.04]"
    : cardAudit.verdict === "AVOID" ? "border-red-500/40 bg-red-500/[0.04]"
    : "border-border/60 bg-card/50";

  return (
    <div className={cn("rounded-lg border p-3 space-y-2", verdictTone)}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wide font-bold text-muted-foreground">
          {title}
        </span>
        {subtitle ? (
          <span className="text-[10px] text-muted-foreground">· {subtitle}</span>
        ) : null}
        <span className="ml-auto text-[10px] font-bold uppercase">
          <VerdictBadge verdict={cardAudit.verdict} />
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <Stat label="Adj. hit"  value={`${(hit * 100).toFixed(1)}%`} />
        <Stat label="Payout"    value={`${payoutX.toFixed(2)}x`} />
        <Stat label="Combined"  value={combined > 0 ? `+${combined}` : `${combined}`} />
      </div>

      {/* Always-visible legs */}
      <ul className="space-y-1 text-xs">
        {result.legs.map((l, i) => (
          <li key={l.id} className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground tabular-nums w-4">{i + 1}.</span>
            <span className="text-[10px] uppercase font-bold text-muted-foreground w-10 shrink-0">{l.sport}</span>
            <span className="flex-1 min-w-0 truncate text-foreground">{l.selectionLabel}</span>
            <span className="font-mono tabular-nums text-[11px] text-muted-foreground">
              {l.americanOdds > 0 ? `+${l.americanOdds}` : l.americanOdds}
            </span>
            {l.id === result.weakestLegId && result.legs.length > 1 ? (
              <span className="text-[9px] uppercase font-bold text-amber-700 dark:text-amber-400">weak</span>
            ) : null}
          </li>
        ))}
      </ul>

      {/* Weakest leg explanation */}
      {weak && weak.id !== strong?.id ? (
        <p className="text-[11px]">
          <span className="font-bold text-amber-700 dark:text-amber-400">Weakest leg: </span>
          <span className="text-foreground">{weak.selectionLabel}</span>
          {weakReason ? <span className="text-muted-foreground"> — {weakReason.toLowerCase()}.</span> : null}
        </p>
      ) : null}

      {/* Why this parlay */}
      {result.wouldITakeItReason ? (
        <p className="text-[11px] text-muted-foreground line-clamp-2">
          {result.wouldITakeItReason}
        </p>
      ) : null}

      {/* Correlation warning */}
      {hasCorrelation ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          ⚠ Same-game correlation — books don't pay full parlay odds when legs move together.
        </p>
      ) : null}

      {/* Progressive disclosure */}
      {expanded ? (
        <div className="space-y-2 pt-2 border-t border-border/40">
          {result.warnings.length ? (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
                Optimizer warnings
              </p>
              <ul className="text-[11px] text-muted-foreground space-y-0.5">
                {result.warnings.map((w, i) => (
                  <li key={i}>· {w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
              DraftKings action
            </p>
            <p className="text-[12px] text-foreground">
              {cardAudit.draftKingsInstruction}
            </p>
          </div>

          {cashOutVariant ? (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
                Cash-out plan
              </p>
              <p className="text-[12px] text-foreground">
                After leg 1 settles, watch the cash-out price. Take it when offered ≥ 60% of full payout
                AND the remaining legs aren't comfortably in your favour. Otherwise ride.
              </p>
            </div>
          ) : null}

          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
              Card metrics
            </p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>Confidence: <span className="text-foreground font-semibold capitalize">{result.cardConfidence}</span></span>
              <span>Smart score: <span className="text-foreground font-semibold tabular-nums">{result.smartParlayScore.toFixed(2)}</span></span>
              {result.fragilityScore != null ? (
                <span>Fragility: <span className="text-foreground font-semibold tabular-nums">{result.fragilityScore.toFixed(0)}/100</span></span>
              ) : null}
              <span>Correlation pen: <span className="text-foreground font-semibold tabular-nums">−{(result.correlationPenalty * 100).toFixed(1)}pp</span></span>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
        >
          {expanded ? "Hide details" : "Details"}
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        <Button size="sm" variant="default" className="ml-auto h-8 px-3 gap-1" onClick={apply}>
          <Plus className="w-3.5 h-3.5" /> Apply to slip
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-background/40 border border-border/30 px-2 py-1">
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-bold tabular-nums text-foreground">{value}</p>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: "PLACE" | "MODIFY" | "AVOID" | "BUILD" | "INSUFFICIENT_DATA" }) {
  const tone =
    verdict === "PLACE" || verdict === "BUILD" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
    : verdict === "MODIFY" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
    : verdict === "AVOID" ? "bg-red-500/15 text-red-700 dark:text-red-400"
    : "bg-muted text-muted-foreground";
  return (
    <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold uppercase", tone)}>
      {verdict.replace("_", " ")}
    </span>
  );
}
