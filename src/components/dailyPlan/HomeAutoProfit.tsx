/**
 * HomeAutoProfit — top card on Home that surfaces the day's
 * recommended move. Uses the lightweight HomeMoveCard (just action +
 * ticket + stake + payout + 1-2 reasons + Add to Slip / Open Daily
 * Plan). Heavier interactivity lives on /daily.
 */

import { useMemo } from "react";
import { generateDailyPlan } from "@/lib/dailyPlan/dailyPlanGenerator";
import { HomeMoveCard } from "./HomeMoveCard";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";

interface Props {
  candidates: ValueBetCandidate[];
  loading: boolean;
}

export function HomeAutoProfit({ candidates, loading }: Props) {
  const plan = useMemo(
    () => generateDailyPlan({ candidates }),
    [candidates],
  );

  if (loading && candidates.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card/40 p-5 h-32 animate-pulse" />
    );
  }

  return <HomeMoveCard plan={plan} />;
}
