/**
 * HomeAutoProfit — top card on Home that mirrors the Auto Profit
 * recommendation from /daily so the user lands on a clear next step
 * without navigating. Builds the three-tier plan from candidates the
 * Home page already loaded, then defers all heavy interactivity
 * (Replace weakest, Regenerate) to /daily via a "Go to Daily Plan"
 * link — Home keeps the surface lightweight.
 */

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { generateDailyPlan } from "@/lib/dailyPlan/dailyPlanGenerator";
import { AutoProfitCard } from "./AutoProfitCard";
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

  return (
    <div className="space-y-2">
      <AutoProfitCard
        plan={plan}
        // Home doesn't allow per-tier swap from this surface — sends
        // users to /daily for the full lock/regenerate/replace toolkit.
        onReplaceWeakest={() => {
          // No-op on Home; the AutoProfitCard's Replace Weakest button
          // is hidden by the consumer when `plan` has only one ticket
          // available, but the prop signature still needs to exist.
        }}
      />
      <div className="flex justify-end">
        <Button asChild variant="ghost" size="sm">
          <Link to="/daily" className="text-xs">
            <Sparkles className="w-3.5 h-3.5" />
            Open full Daily Plan
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
