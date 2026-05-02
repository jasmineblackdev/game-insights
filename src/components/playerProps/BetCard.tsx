/**
 * BetCard — the canonical GameLens bet card.
 *
 * Composes:
 *   - DecisionPill         (PLACE / MODIFY / AVOID)
 *   - selectionLabel       (DraftKings-verbatim where possible)
 *   - TrustRow             (Model · Book · Edge · L10)
 *   - HitRateBars          (L5 / L10 / Season / vs Opp)   ← PROGRESSIVE
 *   - MarketSignals        (Public / Money / Line + badge) ← PROGRESSIVE
 *   - WhyThisPick          (single-line synthesis)
 *   - DraftKings action    (manual second-device instruction)
 *   - Add-to-slip CTA
 *
 * Progressive disclosure: by default shows DecisionPill + label +
 * TrustRow + WhyThisPick + CTA. Clicking "Details" reveals
 * HitRateBars + MarketSignals + DraftKings instruction.
 *
 * Mobile-first: every chip wraps; bars stack vertically; the trust
 * row collapses to two lines on <380px wide.
 */

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Copy, Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useValueParlay } from "@/context/ValueParlayContext";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";
import { legAudit } from "@/lib/valueParlay/executionAssistant";
import { isLikelyMalformedCombatLabel } from "@/lib/playerProps/combatMarketValidation";
import { DecisionPill } from "./DecisionPill";
import { TrustRow } from "./TrustRow";
import { HitRateBars } from "./HitRateBars";
import { WhyThisPick } from "./WhyThisPick";
import { MarketSignals } from "./MarketSignals";
import { Last10Chart } from "./Last10Chart";
import { ConsistencyTrendStrip } from "./ConsistencyTrendStrip";
import { MatchupInsight } from "./MatchupInsight";

interface Props {
  candidate: ValueBetCandidate;
  /** Compact summary view — collapsed by default. */
  defaultExpanded?: boolean;
  /**
   * Hide the Add-to-slip button. Useful when the card is shown
   * inside an audit / history surface where it shouldn't mutate
   * state.
   */
  hideAdd?: boolean;
}

export function BetCard({ candidate: c, defaultExpanded = false, hideAdd = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { addValueLeg, isValueLegAdded } = useValueParlay();
  const added = isValueLegAdded(c.id);
  const decision = c.decision ?? legAudit(c);

  // Final UI safeguard for combat-sports market shapes. Upstream
  // filters in topPropsRanker + buildEnrichedPropCandidates should
  // already drop malformed combat props; this catches anything that
  // slipped through (cached candidates, third-party sources) and
  // disables Add-to-slip so the bad leg can never enter the slip.
  const isMalformedCombat = isLikelyMalformedCombatLabel(
    c.sport, c.selectionLabel, c.statType,
  );

  if (isMalformedCombat) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/[0.04] p-3 text-xs text-red-700 dark:text-red-400 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="font-bold">Invalid market — hidden for safety</p>
          <p className="text-[11px] opacity-80 mt-0.5">
            Combat prop combined a binary market with an Over/Under line. Source feed
            needs review.
          </p>
        </div>
      </div>
    );
  }

  const onAdd = () => {
    const r = addValueLeg(c);
    if (r.ok) toast.success(`Added ${c.selectionLabel}.`);
    else toast.error(r.message ?? "Couldn't add leg.");
  };

  const dkLine = buildDkInstruction(c);
  const onCopyDk = () => {
    if (!dkLine) return;
    navigator.clipboard.writeText(dkLine).then(
      () => toast.success("DraftKings instruction copied."),
      () => toast.error("Copy failed."),
    );
  };

  return (
    <div className="rounded-lg border border-border/60 bg-card/50 p-3 space-y-2">
      {/* Header: decision + sport + odds + confidence */}
      <div className="flex items-center gap-2 flex-wrap">
        <DecisionPill candidate={c} size="sm" showReason={false} />
        <span className="text-[10px] uppercase font-bold text-muted-foreground">{c.sport}</span>
        <span className="text-[10px] font-mono tabular-nums text-muted-foreground">
          {formatOdds(c.americanOdds)}
        </span>
        <span className={cn(
          "text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase",
          c.confidence === "high" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          : c.confidence === "medium" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
          : "bg-muted/40 text-muted-foreground",
        )}>
          {c.confidence}
        </span>
        <span className="text-[10px] text-muted-foreground ml-auto">
          Risk {riskLabel(c.riskBand)}
        </span>
      </div>

      {/* Primary label */}
      <p className="text-sm font-semibold text-foreground">{c.selectionLabel}</p>

      {/* Trust row — always visible */}
      <TrustRow candidate={c} />

      {/* Outlier-style: last 10 chart + consistency/trend always visible.
          The chart IS the visual story — keep it above the fold. */}
      {c.hitRates?.gameByGame?.length ? (
        <div className="space-y-1">
          <Last10Chart candidate={c} compact />
          <ConsistencyTrendStrip candidate={c} />
        </div>
      ) : null}

      {/* Matchup insight — single line, always visible when present */}
      <MatchupInsight candidate={c} />

      {/* Why this pick — always visible */}
      <WhyThisPick candidate={c} />

      {/* Progressive disclosure: deep stats + DK action */}
      {expanded ? (
        <div className="space-y-2 pt-2 border-t border-border/40">
          {c.hitRates ? (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
                Hit rate windows
              </p>
              <HitRateBars rates={c.hitRates} />
              <div className="mt-2">
                <Last10Chart candidate={c} />
              </div>
            </div>
          ) : null}

          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
              Market signals
            </p>
            <MarketSignals candidate={c} />
          </div>

          {dkLine ? (
            <div className="rounded-md bg-background/60 border border-border/40 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2 mb-0.5">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                  DraftKings action
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 gap-1 text-[10px]"
                  onClick={onCopyDk}
                >
                  <Copy className="w-3 h-3" /> Copy
                </Button>
              </div>
              <p className="text-[12px] text-foreground">{dkLine}</p>
            </div>
          ) : null}

          {decision.reason ? (
            <p className="text-[11px] text-muted-foreground italic">
              Verdict reason: {decision.reason}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Footer */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
        >
          {expanded ? "Hide details" : "Details"}
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        {!hideAdd ? (
          <Button
            size="sm"
            variant={added ? "secondary" : "outline"}
            className="ml-auto h-8 px-3 gap-1"
            onClick={onAdd}
            disabled={added}
          >
            {added ? "Added" : <><Plus className="w-3.5 h-3.5" /> Add to slip</>}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────

function formatOdds(o: number): string {
  if (!Number.isFinite(o) || o === 0) return "—";
  return o > 0 ? `+${o}` : `${o}`;
}

function riskLabel(b: ValueBetCandidate["riskBand"]): "Low" | "Medium" | "High" {
  return b === "low" ? "Low" : b === "moderate" ? "Medium" : "High";
}

/**
 * Build the second-device DraftKings instruction. Honest about what
 * we know — only includes "avoid if line moves worse than X" when we
 * have a current price to anchor against.
 */
function buildDkInstruction(c: ValueBetCandidate): string {
  const decision = c.decision ?? legAudit(c);
  if (decision.verdict === "AVOID") {
    return `Do not place — ${decision.reason.toLowerCase()}.`;
  }
  const odds = formatOdds(c.americanOdds);
  const worsened = c.americanOdds < 0
    ? `worse than ${formatOdds(c.americanOdds - 30)}`
    : `worse than ${formatOdds(c.americanOdds - 20)}`;
  if (decision.verdict === "MODIFY") {
    return `Place at ${odds} only if ${decision.reason.toLowerCase()} can be addressed; otherwise pass.`;
  }
  return `Place: ${c.selectionLabel} at ${odds} or better. Avoid if line moves ${worsened}.`;
}
