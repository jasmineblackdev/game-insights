/**
 * PickContributionPanel — visual breakdown of why the engine ranked a
 * player prop where it did.
 *
 * Renders the 5 component contributions (edge, volume, matchup, trend,
 * line value) as horizontal bars whose width is proportional to each
 * component's `weighted` value, plus the variance penalty and (when ML
 * is active for the bucket) the ML hit-prob boost. Risk flags surface
 * underneath as small chips.
 *
 * Data comes from `computeEdgeScoreBreakdown` in playerEdgeMock.ts so
 * this panel never drifts from the live scoring formula.
 */

import { computeEdgeScoreBreakdown, type PlayerEdgePrediction } from "@/data/playerEdgeMock";
import { cn } from "@/lib/utils";

export interface PickContributionPanelProps {
  pred: PlayerEdgePrediction;
  className?: string;
}

const COMPONENT_LABELS: Record<string, string> = {
  edge:       "Edge %",
  volume:     "Volume / role",
  matchup:    "Matchup",
  trend:      "Recent trend",
  line_value: "Line value",
};

export function PickContributionPanel({ pred, className }: PickContributionPanelProps) {
  const b = computeEdgeScoreBreakdown(pred);
  const positives = [
    { key: "edge",       ...b.components.edge },
    { key: "volume",     ...b.components.volume },
    { key: "matchup",    ...b.components.matchup },
    { key: "trend",      ...b.components.trend },
    { key: "line_value", ...b.components.line_value },
  ];
  const maxWeighted = Math.max(...positives.map((p) => p.weighted), 1);
  const variance = b.components.variance;
  const mlBoost = b.components.ml_boost;

  const flags = [
    b.riskFlags.high_variance        && { label: "High variance",          tone: "amber" as const },
    b.riskFlags.low_role_stability   && { label: "Low role stability",     tone: "red"   as const },
    b.riskFlags.blowout_risk         && { label: "Blowout risk",           tone: "amber" as const },
    b.riskFlags.line_moving_against  && { label: "Line moving against",    tone: "red"   as const },
  ].filter(Boolean) as { label: string; tone: "amber" | "red" }[];

  return (
    <div className={cn("rounded-md border border-border bg-card/50 p-3 space-y-3", className)}>
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Why this pick
        </p>
        <p className="text-[10px] tabular-nums text-muted-foreground">
          score <span className="font-bold text-foreground">{b.final_score.toFixed(1)}</span>
          <span className="opacity-60"> · ×{b.timing_multiplier.toFixed(2)} timing</span>
        </p>
      </div>

      {/* Component bars */}
      <div className="space-y-1.5">
        {positives.map((p) => {
          const widthPct = Math.max(2, (p.weighted / maxWeighted) * 100);
          return (
            <div key={p.key} className="grid grid-cols-[110px_1fr_44px] gap-2 items-center">
              <span className="text-[11px] text-muted-foreground">{COMPONENT_LABELS[p.key]}</span>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary/70"
                  style={{ width: `${widthPct}%` }}
                />
              </div>
              <span className="tabular-nums text-[11px] text-right text-foreground font-medium">
                +{p.weighted.toFixed(1)}
              </span>
            </div>
          );
        })}

        {/* Variance penalty */}
        {variance.weighted > 0 ? (
          <div className="grid grid-cols-[110px_1fr_44px] gap-2 items-center">
            <span className="text-[11px] text-muted-foreground">Variance</span>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-red-500/60"
                style={{ width: `${Math.max(2, (variance.weighted / maxWeighted) * 100)}%` }}
              />
            </div>
            <span className="tabular-nums text-[11px] text-right text-red-600 dark:text-red-400 font-medium">
              −{variance.weighted.toFixed(1)}
            </span>
          </div>
        ) : null}

        {/* ML boost (only when active) */}
        {mlBoost.active ? (
          <div className="grid grid-cols-[110px_1fr_44px] gap-2 items-center">
            <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold">
              ML boost
            </span>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500/70"
                style={{ width: `${Math.max(2, (mlBoost.value / 0.4) * 100)}%` }}
              />
            </div>
            <span className="tabular-nums text-[11px] text-right text-emerald-600 dark:text-emerald-400 font-medium">
              +{(mlBoost.value * 100).toFixed(0)}
            </span>
          </div>
        ) : null}
      </div>

      {/* Risk flags */}
      {flags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border/60">
          {flags.map((f) => (
            <span
              key={f.label}
              className={cn(
                "text-[10px] font-bold uppercase tracking-wider rounded-full px-1.5 py-0.5 border",
                f.tone === "red"
                  ? "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30"
                  : "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
              )}
            >
              {f.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
