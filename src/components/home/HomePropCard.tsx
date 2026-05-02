/**
 * HomePropCard — single-prop tile shown in the Best Player Props
 * section of the Home dashboard. Action-first layout (per P4):
 * verdict + suggested stake + payout + ONE reason on the card; raw
 * stats (edge value, projection, timing, volatility) live in the
 * Disclosure footer.
 */

import { useMemo } from "react";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import { cn } from "@/lib/utils";
import { MlReadinessBadge } from "@/components/MlReadinessBadge";
import { SharpBadges } from "@/components/SharpBadges";
import { InjuryBadge } from "@/components/InjuryBadge";
import { Disclosure } from "@/components/ui/disclosure";
import { useBankroll } from "@/context/BankrollContext";
import {
  pickActionForPrediction,
  pickActionLabel,
  pickActionClass,
} from "@/lib/dailyPlan/pickAction";

export interface HomePropCardProps {
  pred: PlayerEdgePrediction;
  rank: number;
}

function americanMultiplier(american: number | null | undefined): number | null {
  if (american == null || !Number.isFinite(american)) return null;
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

export function HomePropCard({ pred, rank }: HomePropCardProps) {
  const dirLabel = pred.prediction_direction === "MORE" ? "Over" : "Under";
  const stat = pred.stat_type.replace(/_/g, " ");
  const headline =
    pred.stat_type === "fight_winner"
      ? `${pred.player_name} to Win`
      : `${dirLabel} ${pred.line_value} ${stat}`;

  const { lossStreak, hadLossToday, suggestStake } = useBankroll();
  const action = useMemo(
    () => pickActionForPrediction(pred, { lossStreak, hadLossToday }),
    [pred, lossStreak, hadLossToday],
  );

  // Stake tier from confidence — same mapping as game picks.
  const stakeRisk = pred.confidence === "HIGH" ? "low" : pred.confidence === "MED" ? "medium" : "high";
  const stake = suggestStake(stakeRisk);
  const stakeAmount = action === "BET_NOW" ? stake.stake
    : action === "SMALL_BET" ? Math.max(1, Math.round(stake.stake * 0.5))
    : 0;

  const american = pred.american_odds ?? null;
  const mult = americanMultiplier(american);
  const payout = mult != null && stakeAmount > 0
    ? Math.round(stakeAmount * mult * 100) / 100
    : null;

  // ONE reason: prefer the curated reason_1, then explanations[0],
  // then risk_factor as a last fallback.
  const headlineReason =
    pred.reason_1 ?? pred.explanations?.[0] ?? pred.risk_factor ?? "Model edge over market line";

  const timingLabel = pred.best_time_to_bet ?? pred.timing_note;
  const timingClass =
    pred.timing_urgency === "now"
      ? "text-emerald-700 dark:text-emerald-400 bg-emerald-500/12"
      : pred.timing_urgency === "wait"
        ? "text-muted-foreground bg-muted/70"
        : "text-amber-700 dark:text-amber-400 bg-amber-500/10";

  return (
    <div className="rounded-lg border border-border bg-card flex flex-col">
      <div className="p-4 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider", pickActionClass(action))}>
            {pickActionLabel(action)}
          </span>
          <span className="text-xs text-muted-foreground font-medium">Prop #{rank}</span>
          <MlReadinessBadge sport={pred.sport} marketType="player_prop" />
          <SharpBadges
            americanOdds={pred.american_odds ?? null}
            modelProbability={pred.ml_hit_probability ?? null}
            lineMovementPp={pred.line_delta != null ? -pred.line_delta : null}
          />
          <span className="text-[10px] font-medium text-muted-foreground ml-auto">{pred.sport}</span>
        </div>
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <span>{pred.player_name}</span>
          <InjuryBadge playerName={pred.player_name} sport={pred.sport} />
        </p>
        <p className="font-display font-bold text-lg text-foreground leading-tight">{headline}</p>
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
      </div>
      <Disclosure
        variant="dashed"
        className="m-2 mt-0"
        title="Details"
      >
        <div className="space-y-1 text-[11px]">
          <p>
            <span className="text-muted-foreground">Edge </span>
            <span className={cn("font-bold tabular-nums", pred.prediction_direction === "MORE" ? "text-emerald-600 dark:text-emerald-400" : "text-red-500")}>
              {pred.prediction_direction === "MORE" ? "+" : "−"}{Math.abs(pred.edge).toFixed(1)}
            </span>
            <span className="text-muted-foreground"> · Projection </span>
            <span className="font-bold text-foreground tabular-nums">{pred.projected_value}</span>
            <span className="text-muted-foreground"> · Confidence </span>
            <span className="font-bold text-foreground capitalize">{pred.confidence}</span>
          </p>
          {pred.consistency_label || pred.volatility_flag ? (
            <p className="text-muted-foreground">
              {pred.consistency_label ? `Form: ${pred.consistency_label}` : null}
              {pred.volatility_flag ? " · Volatile" : ""}
            </p>
          ) : null}
          {timingLabel ? (
            <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full", timingClass)}>
              {timingLabel}
            </span>
          ) : null}
          <p className="text-muted-foreground">{pred.reason_1}</p>
          {pred.reason_2 ? <p className="text-muted-foreground">{pred.reason_2}</p> : null}
          {pred.risk_factor ? (
            <p className="text-red-500/80">
              <span className="font-semibold">Risk:</span> {pred.risk_factor}
            </p>
          ) : null}
        </div>
      </Disclosure>
    </div>
  );
}
