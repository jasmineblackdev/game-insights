/**
 * HomeDashboard — main content for the Home view-mode. Three sections:
 *   1. Top AI Picks Today      — moneyline winners (uses HomePickCard)
 *   2. Best Player Props Today — top edges (uses HomePropCard)
 *   3. Top Parlays Today       — risk-tier shortcut into the parlay
 *                                builder (Safe / Balanced / Aggressive)
 *
 * Extracted from Index.tsx so the page-level component stays focused
 * on routing + state. forwardRef so motion.div / AnimatePresence
 * parents that pass refs through don't trigger
 * "Function components cannot be given refs".
 */

import { forwardRef } from "react";
import type { GamePrediction, League } from "@/data/mockGames";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import type { ParlayBuildMode } from "@/lib/valueParlay/types";
import { cn } from "@/lib/utils";
import { HomePickCard } from "./HomePickCard";
import { HomePropCard } from "./HomePropCard";

const PARLAY_TIERS: {
  mode: ParlayBuildMode;
  label: string;
  legs: string;
  desc: string;
  hitProb: string;
  color: string;
  badge: string;
}[] = [
  {
    mode: "safe",
    label: "Safe Parlay",
    legs: "2 legs",
    desc: "High-confidence picks · target +120 to +320 · max 1 medium-conf leg.",
    hitProb: "~65–72%",
    color: "border-emerald-500/40 bg-emerald-500/5",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  {
    mode: "balanced",
    label: "Balanced Parlay",
    legs: "3 legs",
    desc: "Edge + probability balance · target +250 to +550 combined odds.",
    hitProb: "~45–55%",
    color: "border-amber-500/40 bg-amber-500/5",
    badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  {
    mode: "aggressive",
    label: "Aggressive Parlay",
    legs: "6–8 legs",
    desc: "High-upside combinations with bigger payout potential.",
    hitProb: "~20–35%",
    color: "border-violet-500/40 bg-violet-500/5",
    badge: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
];

export interface HomeDashboardProps {
  topGames: GamePrediction[];
  topProps: PlayerEdgePrediction[];
  isPropsPending: boolean;
  league: League;
  onSelectGame: (g: GamePrediction) => void;
  /** Called when "See all props" link fires. */
  onNavigatePlayerProps: () => void;
  onNavigateToParlay: (mode: ParlayBuildMode) => void;
}

export const HomeDashboard = forwardRef<HTMLDivElement, HomeDashboardProps>(function HomeDashboard({
  topGames,
  topProps,
  isPropsPending,
  league,
  onSelectGame,
  onNavigatePlayerProps,
  onNavigateToParlay,
}, ref) {
  return (
    <div ref={ref} className="space-y-10">
      {/* Top AI Picks Today */}
      <section>
        <div className="mb-4">
          <h3 className="font-display font-bold text-lg text-foreground">Top AI Picks Today</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Highest-confidence {league.toUpperCase()} picks right now
          </p>
        </div>
        {topGames.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {topGames.map((game, i) => (
              <HomePickCard
                key={game.id}
                game={game}
                rank={i + 1}
                onSelect={() => onSelectGame(game)}
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-lg border border-border bg-card/40 h-32 animate-pulse" />
            ))}
          </div>
        )}
      </section>

      {/* Best Player Props Today */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-display font-bold text-lg text-foreground">Best Player Props Today</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Top-ranked props by edge and confidence</p>
          </div>
          <button
            type="button"
            onClick={onNavigatePlayerProps}
            className="text-xs text-primary font-semibold hover:opacity-80 shrink-0"
          >
            See all props →
          </button>
        </div>
        {isPropsPending ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-lg border border-border bg-card/40 h-32 animate-pulse" />
            ))}
          </div>
        ) : topProps.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {topProps.map((pred, i) => (
              <HomePropCard key={pred.id} pred={pred} rank={i + 1} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card/40 p-6 text-center text-sm text-muted-foreground">
            No props available — check Player Props tab for live data.
          </div>
        )}
      </section>

      {/* Top Parlays Today */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-display font-bold text-lg text-foreground">Top Parlays Today</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Pick a risk tier — AI builds the legs automatically
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigateToParlay("balanced")}
            className="text-xs text-primary font-semibold hover:opacity-80 shrink-0"
          >
            Open builder →
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {PARLAY_TIERS.map((tier) => (
            <button
              key={tier.label}
              type="button"
              onClick={() => onNavigateToParlay(tier.mode)}
              className={cn(
                "text-left rounded-lg border p-4 flex flex-col gap-2 hover:brightness-110 transition-all",
                tier.color
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", tier.badge)}>
                  {tier.legs}
                </span>
              </div>
              <p className="font-display font-bold text-base text-foreground">{tier.label}</p>
              <p className="text-xs text-muted-foreground">{tier.desc}</p>
              <p className="text-[11px] font-semibold text-foreground mt-auto">Hit prob: {tier.hitProb}</p>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
});
