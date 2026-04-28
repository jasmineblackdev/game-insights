/**
 * SharpBadges — small inline badges on home cards / parlay legs that
 * call out the three Sharp-Mode signals:
 *   - "Sharp Edge"      edge ≥ threshold
 *   - "Positive EV"     EV ≥ threshold
 *   - "Line Advantage"  line moved in our favor since recommendation
 *
 * Badges show whether or not Sharp Mode is currently enabled — they're
 * descriptive markers, not gates. The Sharp filter pipeline uses the
 * same thresholds to decide which picks to surface.
 */

import { cn } from "@/lib/utils";
import { computeEV, SHARP_DEFAULTS } from "@/lib/learning/sharpMode";
import { useSharpMode } from "@/context/SharpModeContext";

export interface SharpBadgesProps {
  /** American odds for the leg — e.g. -150, +185. */
  americanOdds: number | null | undefined;
  /** Model's win probability (0–1). */
  modelProbability: number | null | undefined;
  /** Implied probability (0–1) — usually derived from odds; pass when known. */
  impliedProbability?: number | null;
  /** Line movement since recommendation in pp; positive = favorable. */
  lineMovementPp?: number | null;
  className?: string;
}

export function SharpBadges({
  americanOdds,
  modelProbability,
  impliedProbability,
  lineMovementPp,
  className,
}: SharpBadgesProps) {
  const { thresholds } = useSharpMode();
  const t = thresholds ?? SHARP_DEFAULTS;

  const mp = modelProbability ?? 0;
  const ip = impliedProbability ?? (americanOdds != null
    ? (americanOdds >= 0 ? 100 / (americanOdds + 100) : -americanOdds / (-americanOdds + 100))
    : 0);
  const edge = mp - ip;
  const ev = americanOdds != null ? computeEV(mp, americanOdds) : 0;

  const hasSharpEdge   = edge >= t.edgeThreshold && Number.isFinite(edge);
  const hasPositiveEv  = ev >= t.evThreshold;
  const hasLineAdv     = typeof lineMovementPp === "number" && lineMovementPp > 1;

  if (!hasSharpEdge && !hasPositiveEv && !hasLineAdv) return null;

  return (
    <span className={cn("inline-flex items-center gap-1 flex-wrap", className)}>
      {hasSharpEdge ? (
        <span
          className="text-[9px] font-bold tracking-wider rounded-full px-1.5 py-0.5 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30"
          title={`Edge ${(edge * 100).toFixed(1)}pp ≥ ${(t.edgeThreshold * 100).toFixed(0)}pp threshold`}
        >
          SHARP EDGE
        </span>
      ) : null}
      {hasPositiveEv ? (
        <span
          className="text-[9px] font-bold tracking-wider rounded-full px-1.5 py-0.5 bg-sky-500/12 text-sky-700 dark:text-sky-300 border border-sky-500/30"
          title={`EV ${ev.toFixed(3)} ≥ ${t.evThreshold} threshold`}
        >
          +EV
        </span>
      ) : null}
      {hasLineAdv ? (
        <span
          className="text-[9px] font-bold tracking-wider rounded-full px-1.5 py-0.5 bg-violet-500/12 text-violet-700 dark:text-violet-300 border border-violet-500/30"
          title={`Line moved +${lineMovementPp?.toFixed(1)}pp in your favor`}
        >
          LINE ADV
        </span>
      ) : null}
    </span>
  );
}
