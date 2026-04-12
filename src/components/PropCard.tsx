/**
 * PropCard — standalone reusable player prop display card.
 * Extracted from the HomePropCard inline component in Index.tsx.
 *
 * Optional slots:
 *   dateBadge        — "TOMORROW" / "TODAY" context label
 *   earlyValueLabel  — "OPENING EDGE" / "EARLY VALUE" / "LINE VALUE"
 *   lineMovementRisk — "MOVING" (line moving against the pick)
 *                      or "CONFIRMED" (sharp action confirming the pick)
 */

import { cn } from "@/lib/utils";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";

// ── Line movement helpers ─────────────────────────────────────────────────────

/**
 * Derives a line-movement signal from the prediction.
 *
 * line_delta = line_value − opening_line_value
 * Positive = line moved UP  (worse for Over, better for Under)
 * Negative = line moved DOWN (better for Over, worse for Under)
 *
 * Returns:
 *   "confirmed" — sharp action moving WITH the pick
 *   "fading"    — line moving AGAINST the pick (value eroding)
 *   null        — no meaningful movement
 */
export function lineMovementSignal(
  pred: Pick<PlayerEdgePrediction, "prediction_direction" | "line_delta">
): "confirmed" | "fading" | null {
  const delta = pred.line_delta;
  if (delta == null || Math.abs(delta) < 0.5) return null;
  const isOver = pred.prediction_direction === "MORE";
  const movingDown = delta < 0;
  return (isOver ? movingDown : !movingDown) ? "confirmed" : "fading";
}

// ── Early value label helpers ─────────────────────────────────────────────────

/** Returns the strongest "early edge" label that applies, or null. */
export function earlyValueTag(
  pred: Pick<PlayerEdgePrediction, "edge" | "line_delta" | "ml_debug">
): "LINE VALUE" | "OPENING EDGE" | "EARLY VALUE" | null {
  const delta  = pred.line_delta;
  const stab   = pred.ml_debug?.stability_score ?? 0;

  // Line confirmed by sharp action → LINE VALUE (highest priority)
  if (delta != null && Math.abs(delta) >= 0.5) {
    // Use a simplified directionless check here — just signal that the line is active
    return "LINE VALUE";
  }
  // Strong early model vs market gap
  if (pred.edge >= 10) return "OPENING EDGE";
  // Solid edge with role certainty
  if (pred.edge >= 6 && stab >= 0.60) return "EARLY VALUE";
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PropCard({
  pred,
  rank,
  dateBadge,
  earlyValueLabel,
  showLineMovement = false,
}: {
  pred: PlayerEdgePrediction;
  rank: number;
  /** Optional date context badge shown in the card header. */
  dateBadge?: "TOMORROW" | "TODAY";
  /**
   * Override the computed early-value label. Pass the result of `earlyValueTag(pred)`
   * when you want the label shown. Omit (or pass undefined) to hide it.
   */
  earlyValueLabel?: "LINE VALUE" | "OPENING EDGE" | "EARLY VALUE" | null;
  /** When true, derives and shows the line-movement signal badge. */
  showLineMovement?: boolean;
}) {
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

  const timingLabel = pred.best_time_to_bet ?? pred.timing_note;
  const timingClass =
    pred.timing_urgency === "now"
      ? "text-emerald-700 dark:text-emerald-400 bg-emerald-500/12"
      : pred.timing_urgency === "wait"
        ? "text-muted-foreground bg-muted/70"
        : "text-amber-700 dark:text-amber-400 bg-amber-500/10";

  const lineSig = showLineMovement ? lineMovementSignal(pred) : null;

  const earlyValueClass: Record<string, string> = {
    "LINE VALUE":   "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20",
    "OPENING EDGE": "bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20",
    "EARLY VALUE":  "bg-primary/10 text-primary border border-primary/20",
  };

  const stab = pred.ml_debug?.stability_score;
  const lowStability = stab != null && stab < 0.45;

  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground font-medium">Prop #{rank}</span>
        <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", confClass)}>
          {pred.confidence}
        </span>
        {pred.volatility_flag && pred.consistency_label !== "volatile" && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-600 dark:text-orange-400">
            Volatile
          </span>
        )}
        {earlyValueLabel && (
          <span
            className={cn(
              "text-[10px] font-bold px-1.5 py-0.5 rounded-full tracking-wider",
              earlyValueClass[earlyValueLabel] ?? "bg-muted text-muted-foreground"
            )}
          >
            {earlyValueLabel}
          </span>
        )}
        {lineSig === "confirmed" && (
          <span
            className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
            title="Line movement confirming this pick (sharp action in our direction)"
          >
            ↓ CONFIRMED
          </span>
        )}
        {lineSig === "fading" && (
          <span
            className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
            title="Line moving against this pick — value may be eroding"
          >
            ↑ MOVING
          </span>
        )}
        {dateBadge && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border tracking-wider">
            {dateBadge}
          </span>
        )}
        <span className="text-[10px] font-medium text-muted-foreground ml-auto">{pred.sport}</span>
      </div>
      <p className="text-xs text-muted-foreground">{pred.player_name}</p>
      <p className="font-display font-bold text-lg text-foreground leading-tight">{headline}</p>
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground">
          Edge{" "}
          <span
            className={cn(
              "font-bold",
              pred.prediction_direction === "MORE"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-500"
            )}
          >
            {pred.prediction_direction === "MORE" ? "+" : "−"}
            {Math.abs(pred.edge).toFixed(1)}
          </span>
        </p>
        {timingLabel && (
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full",
              timingClass
            )}
          >
            {timingLabel}
          </span>
        )}
        {lowStability && (
          <span
            className="text-[10px] text-amber-600/70 dark:text-amber-400/70"
            title={`Role stability: ${stab?.toFixed(2)} — role uncertainty higher than ideal for pregame`}
          >
            ↯ low stab
          </span>
        )}
        {pred.ml_hit_probability != null && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {(pred.ml_hit_probability * 100).toFixed(0)}% hit
          </span>
        )}
      </div>
    </div>
  );
}
