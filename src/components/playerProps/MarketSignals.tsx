/**
 * Action Network-style market intelligence panel.
 *
 * Renders public/money split, line movement, and a single dominant
 * sharp/public badge. When the upstream feed isn't plumbed, the
 * panel hides cleanly — never shows fake numbers.
 */

import { Activity, Flame, TrendingDown, TrendingUp, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { deriveMarketSignals, rawSignalsFromCandidate } from "@/lib/valueParlay/marketSignals";
import type { MarketBadgeKind } from "@/lib/valueParlay/marketSignals";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";

interface Props {
  candidate: ValueBetCandidate;
  /** Compact mode shrinks padding for inline scanner rows. */
  compact?: boolean;
}

const BADGE_LABEL: Record<MarketBadgeKind, string> = {
  reverse_line_move: "Line Reversal",
  sharp_signal:      "Sharp Fade",
  steam_move:        "Steam Move",
  public_heavy:      "Public Heavy",
  neutral:           "",
};

const BADGE_TONE: Record<MarketBadgeKind, string> = {
  reverse_line_move: "border-emerald-500/40 bg-emerald-500/[0.10] text-emerald-700 dark:text-emerald-400",
  sharp_signal:      "border-violet-500/40 bg-violet-500/[0.10] text-violet-700 dark:text-violet-400",
  steam_move:        "border-blue-500/40 bg-blue-500/[0.10] text-blue-700 dark:text-blue-400",
  public_heavy:      "border-amber-500/40 bg-amber-500/[0.10] text-amber-700 dark:text-amber-400",
  neutral:           "",
};

const BADGE_ICON: Record<MarketBadgeKind, React.ComponentType<{ className?: string }>> = {
  reverse_line_move: Activity,
  sharp_signal:      Flame,
  steam_move:        TrendingUp,
  public_heavy:      Users,
  neutral:           Activity,
};

export function MarketSignals({ candidate, compact = false }: Props) {
  const direction =
    candidate.marketType === "total" || candidate.marketType === "player_prop"
      ? ((candidate.selectionLabel ?? "").toUpperCase().includes("UNDER") ? "under" : "over") as const
      : "this_side" as const;

  const signals = deriveMarketSignals({
    raw: rawSignalsFromCandidate(candidate),
    marketType: candidate.marketType,
    direction,
  });

  const { raw, movement } = signals;
  const havePublic = raw.percentBets != null;
  const haveMoney = raw.percentMoney != null;
  const haveLine = raw.openLine != null && raw.currentLine != null;

  // Hide entirely when no field has data.
  if (!havePublic && !haveMoney && !haveLine) return null;

  const Icon = BADGE_ICON[signals.dominantBadge];
  const moveTone = movement == null ? "text-muted-foreground"
    : movement > 0 ? "text-emerald-700 dark:text-emerald-400"
    : movement < 0 ? "text-red-700 dark:text-red-400"
    : "text-muted-foreground";

  return (
    <div className={cn("space-y-1", compact ? "" : "space-y-1.5")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums">
        {havePublic ? (
          <span className="text-muted-foreground">
            Public <span className="text-foreground font-semibold">{raw.percentBets}%</span>
          </span>
        ) : null}
        {haveMoney ? (
          <>
            <span className="text-muted-foreground/60">·</span>
            <span className="text-muted-foreground">
              Money <span className="text-foreground font-semibold">{raw.percentMoney}%</span>
            </span>
          </>
        ) : null}
        {haveLine ? (
          <>
            <span className="text-muted-foreground/60">·</span>
            <span className="text-muted-foreground inline-flex items-center gap-1">
              Line
              <span className="text-foreground font-semibold">{raw.openLine}</span>
              {movement != null && movement !== 0 ? (
                movement > 0 ? <TrendingUp className="w-3 h-3 text-muted-foreground" /> : <TrendingDown className="w-3 h-3 text-muted-foreground" />
              ) : null}
              <span className={cn("font-semibold", moveTone)}>{raw.currentLine}</span>
            </span>
          </>
        ) : null}
      </div>
      {signals.hasSignal ? (
        <div
          className={cn(
            "inline-flex items-center gap-1 rounded-full border font-bold",
            compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]",
            BADGE_TONE[signals.dominantBadge],
          )}
          title={signals.signalNote}
        >
          <Icon className={compact ? "w-3 h-3" : "w-3.5 h-3.5"} />
          {BADGE_LABEL[signals.dominantBadge]}
        </div>
      ) : null}
    </div>
  );
}
