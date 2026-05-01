/**
 * TopPropsScanDebug — collapsible diagnostic panel showing exactly
 * what the ranker scanned, kept, and filtered out per category.
 *
 * Hidden by default. Tap "Show debug" to expand. Confirms the app is
 * actually scanning today's slate (vs serving a stale list).
 */

import { useState } from "react";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScanStats } from "@/lib/playerProps/topPropsRanker";

interface Props {
  stats: ScanStats;
  /** Optional rendering hint when odds are stale — adds a tone shift. */
  oddsStale?: boolean;
}

export function TopPropsScanDebug({ stats, oddsStale }: Props) {
  const [open, setOpen] = useState(false);

  const totalFiltered =
      stats.filtered_out.no_game_today
    + stats.filtered_out.inactive_player
    + stats.filtered_out.low_probability
    + stats.filtered_out.high_volatility_blocked
    + stats.filtered_out.duplicate_player_capped
    + stats.filtered_out.duplicate_game_capped
    + stats.filtered_out.duplicate_sport_capped
    + stats.filtered_out.high_volatility_in_top_capped;

  return (
    <div className={cn(
      "rounded-md border text-[11px] mt-2",
      oddsStale
        ? "border-amber-500/40 bg-amber-500/[0.04]"
        : "border-border/40 bg-muted/20",
    )}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left text-muted-foreground hover:text-foreground transition-colors"
        aria-expanded={open}
      >
        <Search className="w-3 h-3" />
        <span>
          Scanned <span className="font-mono tabular-nums text-foreground">{stats.total_scanned}</span> props
          {" · "}
          surfaced <span className="font-mono tabular-nums text-foreground">{stats.final_ranked}</span>
          {" · "}
          filtered <span className="font-mono tabular-nums text-foreground">{totalFiltered}</span>
        </span>
        <span className="ml-auto">
          {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </span>
      </button>
      {open ? (
        <div className="px-2.5 pb-2 pt-1 border-t border-border/30 space-y-1">
          <Row label="Pool after hard filters" value={stats.pool_after_filters} tone="info" />
          <Row label="Final ranked" value={stats.final_ranked} tone="info" />
          <hr className="border-border/30 my-1" />
          <Row label="Filtered: no game on slate" value={stats.filtered_out.no_game_today} />
          <Row label="Filtered: inactive / no leader data" value={stats.filtered_out.inactive_player} />
          <Row label="Filtered: probability < 0.50" value={stats.filtered_out.low_probability} />
          <Row label="Filtered: high vol + thin edge" value={stats.filtered_out.high_volatility_blocked} />
          <Row label="Capped: duplicate player (≥2)" value={stats.filtered_out.duplicate_player_capped} />
          <Row label="Capped: duplicate game (≥3)" value={stats.filtered_out.duplicate_game_capped} />
          <Row label="Capped: sport limit (≥3 in Top 10)" value={stats.filtered_out.duplicate_sport_capped} />
          <Row label="Capped: high-vol slot used (≥1 in Top 10)" value={stats.filtered_out.high_volatility_in_top_capped} />
        </div>
      ) : null}
    </div>
  );
}

function Row({
  label, value, tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "info";
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn(
        "tabular-nums font-mono",
        tone === "info" ? "text-foreground font-semibold" : "text-foreground/80",
      )}>
        {value}
      </span>
    </div>
  );
}
