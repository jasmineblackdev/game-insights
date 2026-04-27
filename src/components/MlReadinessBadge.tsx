/**
 * MlReadinessBadge — small pill that surfaces whether a pick's
 * underlying model is RULES MODE / LEARNING MODE / ML CALIBRATED for
 * this (sport × market_type). Pulled from the live mlReadiness module
 * (see src/lib/learning/mlReadiness.ts) so the badge never lies about
 * the actual calibration state.
 *
 * Intentionally small + tooltip-rich: it's a transparency indicator,
 * not a primary CTA.
 */

import { cn } from "@/lib/utils";
import { getMlReadinessSync, type MlReadinessState } from "@/lib/learning/mlReadiness";

type Tone = "rules" | "learning" | "calibrated";

const STATE_TO_LABEL: Record<MlReadinessState, string> = {
  rules:      "RULES MODE",
  learning:   "LEARNING",
  calibrated: "ML CALIBRATED",
};

const STATE_TO_CLASS: Record<Tone, string> = {
  rules:      "bg-muted text-muted-foreground border border-border",
  learning:   "bg-sky-500/10 text-sky-700 dark:text-sky-400 border border-sky-500/30",
  calibrated: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30",
};

export interface MlReadinessBadgeProps {
  sport: string;
  marketType: string;
  /** "compact" hides the LEARNING/CALIBRATED label suffix on small surfaces. */
  size?: "sm" | "compact";
  className?: string;
}

export function MlReadinessBadge({ sport, marketType, size = "sm", className }: MlReadinessBadgeProps) {
  const sample = getMlReadinessSync(sport, marketType);
  const label = STATE_TO_LABEL[sample.state];
  const text = size === "compact"
    ? (sample.state === "calibrated" ? "ML" : sample.state === "learning" ? "LRN" : "RUL")
    : label;

  const tip =
    sample.state === "calibrated"
      ? `${sport.toUpperCase()} ${marketType} — Platt calibration active over ${sample.resolved_count} resolved samples.`
      : sample.state === "learning"
        ? `${sport.toUpperCase()} ${marketType} — model is learning (${sample.resolved_count}/${100} resolved samples). Picks use rules + adaptive weights, no Platt calibration yet.`
        : `${sport.toUpperCase()} ${marketType} — fewer than 25 resolved samples (${sample.resolved_count}); picks are pure rules-engine output.`;

  return (
    <span
      title={tip}
      className={cn(
        "inline-flex items-center text-[9px] font-bold tracking-wider rounded-full px-1.5 py-0.5",
        STATE_TO_CLASS[sample.state],
        className,
      )}
    >
      {text}
    </span>
  );
}
