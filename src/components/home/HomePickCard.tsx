/**
 * HomePickCard — single-game pick tile shown in the Top AI Picks
 * section of the Home dashboard. Action-first layout (per P4):
 * the verdict (BET NOW / SMALL BET / WAIT / SKIP) + suggested stake
 * + payout + ONE reason are surfaced. Raw stats live in the
 * Disclosure footer.
 */

import { useMemo } from "react";
import type { GamePrediction } from "@/data/mockGames";
import { cn } from "@/lib/utils";
import { MlReadinessBadge } from "@/components/MlReadinessBadge";
import { Disclosure } from "@/components/ui/disclosure";
import { useBankroll } from "@/context/BankrollContext";
import {
  pickActionForGame,
  pickActionLabel,
  pickActionClass,
} from "@/lib/dailyPlan/pickAction";

export interface HomePickCardProps {
  game: GamePrediction;
  rank: number;
  onSelect: () => void;
}

function americanMultiplier(american: number | undefined): number | null {
  if (american == null || !Number.isFinite(american)) return null;
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

export function HomePickCard({ game, rank, onSelect }: HomePickCardProps) {
  const homeWins = game.winProbability.home >= game.winProbability.away;
  const pick = homeWins ? game.homeTeam : game.awayTeam;
  const prob = Math.round(Math.max(game.winProbability.home, game.winProbability.away));

  const { lossStreak, hadLossToday, suggestStake } = useBankroll();
  const action = useMemo(
    () => pickActionForGame(game, { lossStreak, hadLossToday }),
    [game, lossStreak, hadLossToday],
  );

  // Stake tier — high-confidence picks are eligible for low-risk
  // stake; lower confidence drops to medium/high tier.
  const stakeRisk = game.confidence === "high" ? "low" : game.confidence === "medium" ? "medium" : "high";
  const stake = suggestStake(stakeRisk);
  const stakeAmount = action === "BET_NOW" ? stake.stake
    : action === "SMALL_BET" ? Math.max(1, Math.round(stake.stake * 0.5))
    : 0;

  const american = homeWins ? game.lines?.homeMl : game.lines?.awayMl;
  const americanNum = american ? parseInt(american.replace("+", ""), 10) : undefined;
  const mult = americanMultiplier(americanNum);
  const payout = mult != null && stakeAmount > 0
    ? Math.round(stakeAmount * mult * 100) / 100
    : null;

  // ONE reason surfaced — first topReason or fall back to the model
  // probability statement.
  const headlineReason = game.topReasons[0] ?? `Model projects ${prob}% win probability`;

  return (
    <div className="rounded-lg border border-border bg-card flex flex-col w-full">
      <button
        type="button"
        onClick={onSelect}
        className="text-left p-4 flex flex-col gap-2 hover:bg-muted/30 transition-colors rounded-t-lg"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider", pickActionClass(action))}>
            {pickActionLabel(action)}
          </span>
          <span className="text-xs text-muted-foreground font-medium">Pick #{rank}</span>
          <MlReadinessBadge sport={game.league} marketType="team_moneyline" />
          <span className="text-[10px] font-medium text-muted-foreground ml-auto">{game.league.toUpperCase()}</span>
        </div>
        <p className="font-display font-bold text-lg text-foreground leading-tight">
          {pick.name} to win
        </p>
        {action !== "SKIP" && action !== "WAIT" ? (
          <div className="flex items-baseline gap-3 text-xs">
            <span className="text-muted-foreground">
              Stake <span className="font-bold text-foreground tabular-nums">${stakeAmount}</span>
            </span>
            {payout != null ? (
              <span className="text-muted-foreground">
                Payout <span className="font-bold text-foreground tabular-nums">${payout}</span>
              </span>
            ) : null}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground line-clamp-2">{headlineReason}</p>
      </button>
      <Disclosure
        variant="dashed"
        className="m-2 mt-0"
        title="Details"
      >
        <div className="space-y-1 text-[11px]">
          <p className="text-muted-foreground">
            {game.homeTeam.name} vs {game.awayTeam.name}
            {game.gameTime ? ` · ${game.gameTime}` : ""}
          </p>
          <p>
            <span className="text-muted-foreground">Model </span>
            <span className="font-bold text-foreground tabular-nums">{prob}%</span>
            {american ? (
              <>
                <span className="text-muted-foreground"> · ML </span>
                <span className="font-bold text-foreground tabular-nums">{american}</span>
              </>
            ) : null}
            <span className="text-muted-foreground"> · Confidence </span>
            <span className="font-bold text-foreground capitalize">{game.confidence}</span>
          </p>
          {game.topReasons.slice(0, 3).map((r, i) => (
            <p key={i} className="text-muted-foreground">· {r}</p>
          ))}
          {game.riskFactors[0] ? (
            <p className="text-red-500/80">
              <span className="font-semibold">Risk:</span> {game.riskFactors[0]}
            </p>
          ) : null}
        </div>
      </Disclosure>
    </div>
  );
}
