/**
 * PropScanner — Props.Cash-style fast-scan list.
 *
 * Sorted by a composite priority score so the user's eye lands on the
 * picks the engine rates highest. Each row is ≤44px tall for thumb-
 * scrolling on mobile; tap a row to expand into a full card.
 *
 * Priority key:
 *   verdict_weight × edge × min(1, samples_last10/10) × confidence_weight
 * Where:
 *   verdict_weight: PLACE=1.0, MODIFY=0.5, AVOID=0.1
 *   confidence_weight: high=1.0, medium=0.7, low=0.4
 *
 * This matches the user's stated goal: place-able edges with real
 * sample backing surface first, MODIFY second, AVOID surfaces last
 * (visible but visually deprioritized).
 */

import { useMemo, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useValueParlay } from "@/context/ValueParlayContext";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";
import { legAudit } from "@/lib/valueParlay/executionAssistant";
import { DecisionPill } from "./DecisionPill";
import { TrustRow } from "./TrustRow";
import { HitRateBars } from "./HitRateBars";
import { WhyThisPick } from "./WhyThisPick";
import { MarketSignals } from "./MarketSignals";
import { Last10Chart } from "./Last10Chart";
import { ConsistencyTrendStrip } from "./ConsistencyTrendStrip";
import { MatchupInsight } from "./MatchupInsight";

interface Props {
  /** Pool to scan — typically the recommended candidate pool. */
  candidates: ValueBetCandidate[];
  /** Cap rows to keep the list scannable. Default 20. */
  limit?: number;
  /** Optional title override. */
  title?: string;
}

const VERDICT_WEIGHT: Record<string, number> = { PLACE: 1.0, MODIFY: 0.5, AVOID: 0.1 };
const CONFIDENCE_WEIGHT: Record<string, number> = { high: 1.0, medium: 0.7, low: 0.4 };

function scanPriority(c: ValueBetCandidate): number {
  const decision = c.decision ?? legAudit(c);
  const vw = VERDICT_WEIGHT[decision.verdict] ?? 0.1;
  const cw = CONFIDENCE_WEIGHT[c.confidence ?? "low"] ?? 0.4;
  const sampleFactor = Math.min(1, (c.hitRates?.samples.last10 ?? 0) / 10);
  const sampleAdj = sampleFactor === 0 ? 0.5 : sampleFactor; // don't zero out fresh-data props
  const edge = Math.max(0, c.edge ?? 0);
  return vw * cw * sampleAdj * (edge + 0.001);
}

export function PropScanner({ candidates, limit = 20, title = "Top props today" }: Props) {
  const props = useMemo(() => {
    const onlyProps = candidates.filter((c) => c.pickType === "player_prop");
    return [...onlyProps]
      .sort((a, b) => scanPriority(b) - scanPriority(a))
      .slice(0, limit);
  }, [candidates, limit]);

  if (!props.length) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/40 p-4 text-sm text-muted-foreground italic">
        No player props in the current pool.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card/50 overflow-hidden">
      <div className="px-3 py-2 border-b border-border/40 flex items-center gap-2">
        <p className="font-display font-bold text-sm text-foreground">{title}</p>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {props.length}
        </span>
      </div>
      <ul className="divide-y divide-border/40">
        {props.map((c) => (
          <ScannerRow key={c.id} candidate={c} />
        ))}
      </ul>
    </div>
  );
}

function ScannerRow({ candidate }: { candidate: ValueBetCandidate }) {
  const [expanded, setExpanded] = useState(false);
  const { addValueLeg, isValueLegAdded } = useValueParlay();
  const added = isValueLegAdded(candidate.id);

  const last10 = candidate.hitRates?.last10;
  const last10Samples = candidate.hitRates?.samples.last10 ?? 0;
  const last10Wins = last10 != null ? Math.round(last10 * last10Samples) : null;
  const edge = (candidate.edge ?? 0) * 100;
  const edgeTone =
    edge >= 6 ? "text-emerald-700 dark:text-emerald-400"
    : edge >= 3 ? "text-amber-700 dark:text-amber-400"
    : "text-muted-foreground";

  const onAdd = () => {
    const r = addValueLeg(candidate);
    if (r.ok) toast.success(`Added ${candidate.selectionLabel}.`);
    else toast.error(r.message ?? "Couldn't add leg.");
  };

  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-left"
        aria-expanded={expanded}
      >
        <DecisionPill candidate={candidate} size="sm" showReason={false} />
        <span className="text-[10px] uppercase font-bold text-muted-foreground w-10 shrink-0">
          {candidate.sport}
        </span>
        <span className="flex-1 min-w-0 truncate text-sm font-semibold text-foreground">
          {candidate.selectionLabel}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground shrink-0 hidden sm:inline">
          {last10 != null ? `L10 ${last10Wins}/${last10Samples}` : ""}
        </span>
        <span className={cn("text-[11px] font-bold tabular-nums shrink-0 w-12 text-right", edgeTone)}>
          {edge >= 0 ? "+" : ""}{edge.toFixed(1)}%
        </span>
        <ChevronRight
          className={cn(
            "w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform",
            expanded ? "rotate-90" : "",
          )}
        />
      </button>
      {expanded ? (
        <div className="px-3 pb-3 pt-1 space-y-2 bg-background/40 border-t border-border/30">
          <TrustRow candidate={candidate} />
          {candidate.hitRates?.gameByGame?.length ? (
            <Last10Chart candidate={candidate} compact />
          ) : null}
          <ConsistencyTrendStrip candidate={candidate} />
          {candidate.hitRates ? (
            <HitRateBars rates={candidate.hitRates} compact />
          ) : null}
          <MatchupInsight candidate={candidate} />
          <MarketSignals candidate={candidate} compact />
          <WhyThisPick candidate={candidate} />
          <div className="flex items-center justify-end pt-1">
            <Button
              size="sm"
              variant={added ? "secondary" : "outline"}
              onClick={onAdd}
              disabled={added}
              className="h-7 px-2 text-[11px] gap-1"
            >
              {added ? "Added" : <><Plus className="w-3 h-3" /> Add to slip</>}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
