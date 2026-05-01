/**
 * ConsistencyTrendStrip — single line showing
 *   "Consistency: High · Trend: Up"
 * Derived from hitRates.consistency + hitRates.trend on the candidate
 * (both computed at enrichment time). Hides when neither label is
 * available.
 */

import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";

interface Props {
  candidate: ValueBetCandidate;
}

export function ConsistencyTrendStrip({ candidate }: Props) {
  const consistency = candidate.hitRates?.consistency;
  const trend = candidate.hitRates?.trend;
  if (!consistency && !trend) return null;

  const consTone =
    consistency === "high" ? "text-emerald-700 dark:text-emerald-400"
    : consistency === "medium" ? "text-amber-700 dark:text-amber-400"
    : consistency === "low" ? "text-red-700 dark:text-red-400"
    : "text-muted-foreground";
  const consLabel =
    consistency === "high" ? "High consistency"
    : consistency === "medium" ? "Medium consistency"
    : consistency === "low" ? "Low consistency"
    : null;

  const trendTone =
    trend === "up" ? "text-emerald-700 dark:text-emerald-400"
    : trend === "down" ? "text-red-700 dark:text-red-400"
    : trend === "flat" ? "text-muted-foreground"
    : "text-muted-foreground";
  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendLabel =
    trend === "up" ? "Trending up"
    : trend === "down" ? "Trending down"
    : trend === "flat" ? "Flat"
    : null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
      {consLabel ? (
        <span className={cn("font-semibold", consTone)}>{consLabel}</span>
      ) : null}
      {consLabel && trendLabel ? <span className="text-muted-foreground/60">·</span> : null}
      {trendLabel ? (
        <span className={cn("inline-flex items-center gap-1 font-semibold", trendTone)}>
          <TrendIcon className="w-3 h-3" />
          {trendLabel}
        </span>
      ) : null}
    </div>
  );
}
