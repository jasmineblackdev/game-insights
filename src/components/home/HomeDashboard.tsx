/**
 * HomeDashboard — main content for the Home view-mode. Two sections:
 *   1. Top AI Picks Today      — moneyline winners (uses HomePickCard)
 *   2. Best Player Props Today — top edges (uses HomePropCard)
 *
 * The previous "Top Parlays Today" tier-card row was removed in the
 * Phase B restructure: those three cards were nav shortcuts only (no
 * real legs/odds) and visually duplicated the actual auto-built
 * parlays in ParlayBuilderSection. A single "Open Parlay Builder"
 * CTA below the header points to the canonical place where parlay
 * cards live.
 *
 * Extracted from Index.tsx so the page-level component stays focused
 * on routing + state. forwardRef so motion.div / AnimatePresence
 * parents that pass refs through don't trigger
 * "Function components cannot be given refs".
 */

import { forwardRef } from "react";
import { Sparkles, ChevronRight } from "lucide-react";
import type { GamePrediction, League } from "@/data/mockGames";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import type { ParlayBuildMode } from "@/lib/valueParlay/types";
import { HomePickCard } from "./HomePickCard";
import { HomePropCard } from "./HomePropCard";

export interface HomeDashboardProps {
  topGames: GamePrediction[];
  topProps: PlayerEdgePrediction[];
  isPropsPending: boolean;
  league: League;
  onSelectGame: (g: GamePrediction) => void;
  /** Called when "See all props" link fires. */
  onNavigatePlayerProps: () => void;
  /** Called when the user taps "Open Parlay Builder". Mode is unused at the call site now (deep-linking removed) but kept for callsite stability. */
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

      {/* Open Parlay Builder — single CTA replacing the three static
          tier shortcut cards. The canonical Safe/Balanced/Aggressive/
          Cash-Out cards live inside ParlayBuilderSection itself. */}
      <section>
        <button
          type="button"
          onClick={() => onNavigateToParlay("balanced")}
          className="w-full rounded-lg border border-primary/40 bg-primary/[0.06] hover:bg-primary/[0.12] transition-colors p-4 flex items-center gap-3 text-left"
        >
          <Sparkles className="w-5 h-5 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-display font-bold text-base text-foreground">Open Parlay Builder</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Safe · Balanced · Aggressive · Cash-Out — auto-built from today's edges.
            </p>
          </div>
          <ChevronRight className="w-5 h-5 text-primary shrink-0" />
        </button>
      </section>
    </div>
  );
});
