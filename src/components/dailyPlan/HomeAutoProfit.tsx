/**
 * HomeAutoProfit — top card on Home that surfaces the day's
 * recommended move. Uses the lightweight HomeMoveCard (just action +
 * ticket + stake + payout + 1-2 reasons + Add to Slip / Open Daily
 * Plan). Heavier interactivity lives on /daily.
 */

import { forwardRef, useMemo } from "react";
import { generateDailyPlan } from "@/lib/dailyPlan/dailyPlanGenerator";
import { HomeMoveCard } from "./HomeMoveCard";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";

interface Props {
  candidates: ValueBetCandidate[];
  loading: boolean;
}

/**
 * forwardRef so motion.div / AnimatePresence parents that pass refs
 * through asChild slots don't trigger React's "Function components
 * cannot be given refs" warning. Component itself doesn't need the
 * ref — it's just a forwarder so the wrapper chain stays clean.
 */
export const HomeAutoProfit = forwardRef<HTMLDivElement, Props>(
  function HomeAutoProfit({ candidates, loading }, ref) {
    const plan = useMemo(
      () => generateDailyPlan({ candidates }),
      [candidates],
    );

    if (loading && candidates.length === 0) {
      return (
        <div ref={ref} className="rounded-lg border border-border bg-card/40 p-5 h-32 animate-pulse" />
      );
    }

    return (
      <div ref={ref}>
        <HomeMoveCard plan={plan} />
      </div>
    );
  },
);
