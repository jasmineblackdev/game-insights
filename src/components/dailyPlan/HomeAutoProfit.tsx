/**
 * HomeAutoProfit — single CTA card on Home that points to /daily.
 *
 * Previously rendered the day's full recommended move via HomeMoveCard
 * (action + ticket + stake + payout + reasons + Add to Slip). After
 * the Phase B/D restructure that surface duplicated the canonical
 * auto-built parlay cards inside ParlayBuilderSection, so the card is
 * now just a nav CTA. The full tier-pinned planning workflow stays at
 * /daily — DailyPlanPage is the only place it lives.
 *
 * forwardRef preserved so motion.div / AnimatePresence parents that
 * pass refs through asChild slots don't warn.
 */

import { forwardRef } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Sparkles } from "lucide-react";

export const HomeAutoProfit = forwardRef<HTMLDivElement, Record<string, never>>(
  function HomeAutoProfit(_props, ref) {
    return (
      <div ref={ref}>
        <Link
          to="/daily"
          className="block w-full rounded-lg border border-primary/40 bg-primary/[0.06] hover:bg-primary/[0.12] transition-colors p-4 flex items-center gap-3"
        >
          <Sparkles className="w-5 h-5 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-display font-bold text-base text-foreground">Open Daily Plan →</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Build 3 tiered bets with bankroll sizing.
            </p>
          </div>
          <ChevronRight className="w-5 h-5 text-primary shrink-0" />
        </Link>
      </div>
    );
  },
);
