/**
 * ProModeBanner — sticky banner shown on Home + DailyPlan when Pro
 * Mode is active. Communicates the pipeline summary and links to
 * settings.
 */

import { Link } from "react-router-dom";
import { Crown, ChevronRight } from "lucide-react";
import { useProMode } from "@/context/ProModeContext";

interface Props {
  /** Latest pipeline outcome — surfaced in the banner subline. */
  pipelineSummary?: string | null;
}

export function ProModeBanner({ pipelineSummary }: Props) {
  const { enabled } = useProMode();
  if (!enabled) return null;
  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/[0.06] px-4 py-3 flex items-center gap-3">
      <Crown className="w-4 h-4 text-violet-600 dark:text-violet-400 shrink-0" />
      <div className="flex-1 min-w-0 text-sm">
        <p className="font-bold text-foreground">
          Pro Mode Active — disciplined daily decision pipeline
        </p>
        <p className="text-xs text-muted-foreground">
          Sport Priority → Sharp filter → Discipline → Scaling Ladder. One trade per day,
          empty days are valid.
          {pipelineSummary ? ` ${pipelineSummary}` : ""}
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
