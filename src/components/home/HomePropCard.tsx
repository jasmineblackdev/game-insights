/**
 * HomePropCard — single-prop tile shown in the Best Player Props
 * section of the Home dashboard. Extracted from Index.tsx.
 */

import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import { cn } from "@/lib/utils";
import { MlReadinessBadge } from "@/components/MlReadinessBadge";

export interface HomePropCardProps {
  pred: PlayerEdgePrediction;
  rank: number;
}

export function HomePropCard({ pred, rank }: HomePropCardProps) {
  const dirLabel = pred.prediction_direction === "MORE" ? "Over" : "Under";
  const stat = pred.stat_type.replace(/_/g, " ");
  const headline =
    pred.stat_type === "fight_winner"
      ? `${pred.player_name} to Win`
      : `${dirLabel} ${pred.line_value} ${stat}`;

  const confClass =
    pred.confidence === "HIGH"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : pred.confidence === "MED"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-muted text-muted-foreground";

  // Timing badge — urgency-aware colour
  const timingLabel = pred.best_time_to_bet ?? pred.timing_note;
  const timingClass =
    pred.timing_urgency === "now"
      ? "text-emerald-700 dark:text-emerald-400 bg-emerald-500/12"
      : pred.timing_urgency === "wait"
        ? "text-muted-foreground bg-muted/70"
        : "text-amber-700 dark:text-amber-400 bg-amber-500/10";

  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground font-medium">Prop #{rank}</span>
        <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", confClass)}>
          {pred.confidence}
        </span>
        <MlReadinessBadge sport={pred.sport} marketType="player_prop" />
        {/* ML volatility flag */}
        {pred.volatility_flag && pred.consistency_label !== "volatile" && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-600 dark:text-orange-400">
            Volatile
          </span>
        )}
        <span className="text-[10px] font-medium text-muted-foreground ml-auto">{pred.sport}</span>
      </div>
      <p className="text-xs text-muted-foreground">{pred.player_name}</p>
      <p className="font-display font-bold text-lg text-foreground leading-tight">{headline}</p>
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground">
          Edge{" "}
          <span className={cn("font-bold", pred.prediction_direction === "MORE" ? "text-emerald-600 dark:text-emerald-400" : "text-red-500")}>
            {pred.prediction_direction === "MORE" ? "+" : "−"}{Math.abs(pred.edge).toFixed(1)}
          </span>
        </p>
        {/* ML timing badge */}
        {timingLabel && (
          <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full", timingClass)}>
            {timingLabel}
          </span>
        )}
      </div>
    </div>
  );
}
