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
import { useQuery } from "@tanstack/react-query";
import { fetchPlayerLastGames, type PlayerGameStat } from "@/lib/playerGameLog";
import { MlReadinessBadge } from "@/components/MlReadinessBadge";

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

// ── Last-5 recent games strip ────────────────────────────────────────────────
// Fetches the player's last 5 game values for the prop's stat_type from the
// ESPN gamelog endpoint. Cached 10 minutes via React Query; silent failure
// hides the strip so non-supported sports/stats don't show an empty row.

function RecentGamesStrip({
  sport,
  playerId,
  statType,
  line,
  direction,
}: {
  sport: string;
  playerId: string;
  statType: string;
  line: number;
  direction: "MORE" | "LESS";
}) {
  const { data = [], isLoading } = useQuery<PlayerGameStat[]>({
    queryKey: ["player-gamelog", sport, playerId, statType],
    queryFn:  () => fetchPlayerLastGames(sport, playerId, statType, 5),
    staleTime: 10 * 60 * 1000,
    gcTime:    30 * 60 * 1000,
    enabled:   !!playerId && !!statType,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
        <span className="font-semibold tracking-wider">L5</span>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="h-4 w-6 rounded bg-muted/60 animate-pulse" />
        ))}
      </div>
    );
  }

  if (!data.length) return null;

  const hits = data.filter((g) =>
    direction === "MORE" ? g.value > line : g.value < line
  ).length;

  return (
    <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
      <span className="font-semibold tracking-wider text-muted-foreground">L5</span>
      {data.map((g, i) => {
        const hit =
          direction === "MORE" ? g.value > line :
          direction === "LESS" ? g.value < line :
          null;
        const push = g.value === line;
        return (
          <span
            key={i}
            className={cn(
              "tabular-nums font-semibold px-1.5 py-0.5 rounded border",
              push
                ? "bg-muted text-muted-foreground border-border"
                : hit
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                  : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/25"
            )}
            title={`${g.date}${g.opponent ? ` ${g.homeAway === "away" ? "@" : "vs"} ${g.opponent}` : ""}: ${g.value}`}
          >
            {Number.isInteger(g.value) ? g.value : g.value.toFixed(1)}
          </span>
        );
      })}
      <span className="text-muted-foreground/80 ml-0.5">
        {hits}/{data.length} hit
      </span>
    </div>
  );
}

// ── Model status badge ───────────────────────────────────────────────────────
// Single transparency badge per pick: shows whether probability is rules-only,
// ML-blended, calibrating, or low-data-quality. Hovering reveals sample size
// + data quality + leader source so the user can audit each pick.

function ModelStatusPill({ pred }: { pred: PlayerEdgePrediction }) {
  if (!pred.model_status) return null;
  const tone = pred.model_status;
  const sampleSize = pred.ml_debug?.ml_sample_size ?? 0;
  const dq = pred.data_quality;
  const source = pred.prop_source;

  const cls =
    tone === "ml_active"        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30"
    : tone === "calibrating"    ? "bg-sky-500/10 text-sky-700 dark:text-sky-400 border border-sky-500/30"
    : tone === "low_data_quality" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30"
    :                             "bg-muted text-muted-foreground border border-border";

  const short =
    tone === "ml_active"        ? "ML ACTIVE"
    : tone === "calibrating"    ? "CALIBRATING"
    : tone === "low_data_quality" ? "LOW DATA"
    :                             "RULES";

  const tip =
    `${pred.sport} ${pred.stat_type} · n=${sampleSize}` +
    (dq != null ? ` · DQ ${dq.toFixed(2)}` : "") +
    (source ? ` · src: ${source}` : "");

  return (
    <span
      className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded-full tracking-wider", cls)}
      title={tip}
    >
      {short}
    </span>
  );
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
        {/* MlReadinessBadge replaces the legacy ModelStatusPill so the
            "ML" indicator only fires when Platt calibration is actually
            applied and the bucket has ≥100 resolved samples. The old
            pill stayed mounted so its tooltip (ml_sample_size, data
            quality, source) is still discoverable on hover. */}
        <MlReadinessBadge sport={pred.sport} marketType="player_prop" />
        <ModelStatusPill pred={pred} />
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
      <RecentGamesStrip
        sport={pred.sport}
        playerId={pred.player_id}
        statType={pred.stat_type}
        line={pred.line_value}
        direction={pred.prediction_direction}
      />
    </div>
  );
}
