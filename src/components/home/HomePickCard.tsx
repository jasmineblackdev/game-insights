/**
 * HomePickCard — single-game pick tile shown in the Top AI Picks
 * section of the Home dashboard. Extracted from Index.tsx to keep
 * the page-level component focused on routing + state.
 */

import type { GamePrediction } from "@/data/mockGames";
import { cn } from "@/lib/utils";

export interface HomePickCardProps {
  game: GamePrediction;
  rank: number;
  onSelect: () => void;
}

export function HomePickCard({ game, rank, onSelect }: HomePickCardProps) {
  const homeWins = game.winProbability.home >= game.winProbability.away;
  const pick = homeWins ? game.homeTeam : game.awayTeam;
  // winProbability values are already in 0–100 scale (percentage)
  const prob = Math.round(Math.max(game.winProbability.home, game.winProbability.away));
  const confClass =
    game.confidence === "high"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : game.confidence === "medium"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-muted text-muted-foreground";

  return (
    <button
      type="button"
      onClick={onSelect}
      className="text-left rounded-lg border border-border bg-card hover:bg-muted/30 transition-colors p-4 flex flex-col gap-2 w-full"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground font-medium">Pick #{rank}</span>
        <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", confClass)}>
          {game.confidence.toUpperCase()}
        </span>
        <span className="text-[10px] font-medium text-muted-foreground ml-auto">{game.league.toUpperCase()}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {game.homeTeam.name} vs {game.awayTeam.name}
      </p>
      <p className="font-display font-bold text-lg text-foreground leading-tight">
        {pick.name} to win
      </p>
      <p className="text-xs text-muted-foreground">{prob}% model probability</p>
    </button>
  );
}
