/**
 * TrustRow — single line surfacing the four numbers users want to see
 * before they place a bet:
 *   Model 64% · Book 56% · +8.0% · L10 7/10
 *
 * Mobile-first: wraps onto two lines when the container is narrow.
 * Each segment has its own color tone so the eye locks onto edge first.
 */

import type { ValueBetCandidate } from "@/lib/valueParlay/types";
import { cn } from "@/lib/utils";

interface Props {
  candidate: ValueBetCandidate;
}

export function TrustRow({ candidate: c }: Props) {
  const m = Math.round((c.modelProbability ?? 0) * 100);
  const b = Math.round((c.impliedProbability ?? 0) * 100);
  const e = (c.edge ?? 0) * 100;
  const eSign = e >= 0 ? "+" : "−";
  const edgeTone =
    e >= 6 ? "text-emerald-700 dark:text-emerald-400"
    : e >= 3 ? "text-amber-700 dark:text-amber-400"
    : "text-muted-foreground";

  const last10 = c.hitRates?.last10;
  const last10Samples = c.hitRates?.samples.last10 ?? 0;
  const last10Wins = last10 != null ? Math.round(last10 * last10Samples) : null;
  const hrTone =
    last10 == null ? "text-muted-foreground"
    : last10 >= 0.65 ? "text-emerald-700 dark:text-emerald-400"
    : last10 >= 0.50 ? "text-amber-700 dark:text-amber-400"
    : "text-red-700 dark:text-red-400";

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums">
      <span className="text-muted-foreground">
        Model <span className="text-foreground font-semibold">{m}%</span>
      </span>
      <span className="text-muted-foreground/60">·</span>
      <span className="text-muted-foreground">
        Book <span className="text-foreground font-semibold">{b}%</span>
      </span>
      <span className="text-muted-foreground/60">·</span>
      <span className={cn("font-semibold", edgeTone)}>
        {eSign}{Math.abs(e).toFixed(1)}%
      </span>
      {last10 != null ? (
        <>
          <span className="text-muted-foreground/60">·</span>
          <span className={cn("font-semibold", hrTone)}>
            L10 {last10Wins}/{last10Samples}
          </span>
        </>
      ) : null}
    </div>
  );
}
