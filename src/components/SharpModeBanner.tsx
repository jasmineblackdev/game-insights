/**
 * SharpModeBanner — sticky banner shown on Home + DailyPlan when
 * Sharp Mode is active. Communicates that the user is intentionally
 * in a stricter mode (fewer picks, only high-edge bets) so an empty
 * picks list reads as "nothing qualifying today" instead of "broken".
 */

import { Link } from "react-router-dom";
import { Crosshair, ChevronRight } from "lucide-react";
import { useSharpMode } from "@/context/SharpModeContext";

interface Props {
  /** Optional count of qualifying picks for today, e.g. shown by Home. */
  qualifyingCount?: number | null;
}

export function SharpModeBanner({ qualifyingCount }: Props) {
  const { enabled, thresholds } = useSharpMode();
  if (!enabled) return null;

  const tail = qualifyingCount == null
    ? null
    : qualifyingCount === 0
      ? "No sharp bets right now — wait for a better opportunity."
      : `${qualifyingCount} pick${qualifyingCount === 1 ? "" : "s"} pass the strict edge filter.`;

  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] px-4 py-3 flex items-center gap-3">
      <Crosshair className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
      <div className="flex-1 min-w-0 text-sm">
        <p className="font-bold text-foreground">
          Sharp Mode Active — only high-edge bets shown
        </p>
        <p className="text-xs text-muted-foreground">
          Edge ≥ {(thresholds.edgeThreshold * 100).toFixed(0)}pp · EV ≥ {thresholds.evThreshold} · max{" "}
          {thresholds.maxLegs} legs · {thresholds.minSampleCount}+ resolved samples per bucket.
          {tail ? ` ${tail}` : ""}
        </p>
      </div>
      <Link
        to="/picks"
        className="text-xs text-primary font-semibold hover:opacity-80 inline-flex items-center gap-0.5 shrink-0"
      >
        Settings <ChevronRight className="w-3 h-3" />
      </Link>
    </div>
  );
}
