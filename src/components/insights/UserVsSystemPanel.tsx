/**
 * User vs System performance panel — splits ROI / hit rate / CLV by
 * the 5 origin categories the user actually cares about (#171).
 *
 * Categories (display order):
 *   System recs · Auto-plan · Manual user · Live paper · Paper test
 *
 * Reads `analytics_performance_by_source` (migration 20260517).
 * CLV is null for the three paper_bets-backed categories until the
 * paper→prediction_history bridge ships under #164. We render "—"
 * for those cells rather than 0 so the gap is visible.
 *
 * Empty categories aren't hidden — comparing populated rows against
 * empty ones is the point of the panel.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchPerformanceBySource,
  PERFORMANCE_CATEGORY_LABELS,
  PERFORMANCE_CATEGORY_DESCRIPTIONS,
  type PerformanceBySourceRow,
} from "@/lib/analytics/performanceBySource";

const LOOKBACK_OPTIONS = [
  { label: "7d",  days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

export function UserVsSystemPanel() {
  const [lookbackDays, setLookbackDays] = useState<number>(30);
  const query = useQuery({
    queryKey: ["analytics-performance-by-source", lookbackDays],
    queryFn: () => fetchPerformanceBySource(lookbackDays),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const rows = query.data ?? [];
  const anyData = rows.some((r) => r.total > 0);

  return (
    <section className="space-y-3 border-t border-border pt-8">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
            <Users className="w-4 h-4 text-primary" />
            User vs system performance
          </h2>
          <p className="text-[11px] text-muted-foreground">
            ROI · hit rate · CLV split by where each bet came from.
          </p>
        </div>
        <div className="flex items-center gap-1">
          {LOOKBACK_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              type="button"
              onClick={() => setLookbackDays(opt.days)}
              className={cn(
                "px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-colors",
                lookbackDays === opt.days
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background/40 text-muted-foreground border-border/40 hover:text-foreground hover:border-border",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {query.isPending ? (
        <div className="rounded-md border border-border/40 bg-background/40 p-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading source split…
        </div>
      ) : !anyData ? (
        <div className="rounded-md border border-border/40 bg-background/40 px-3 py-2 text-[11px] text-muted-foreground">
          No bets in the last {lookbackDays}d to split by source.
        </div>
      ) : (
        <div className="overflow-x-auto -mx-3 sm:mx-0">
          <table className="w-full min-w-[680px] text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border/40">
                <th className="px-3 py-1.5 font-semibold">Source</th>
                <th className="px-3 py-1.5 font-semibold text-right">N</th>
                <th className="px-3 py-1.5 font-semibold text-right">W-L-P</th>
                <th className="px-3 py-1.5 font-semibold text-right">Hit rate</th>
                <th className="px-3 py-1.5 font-semibold text-right">ROI</th>
                <th className="px-3 py-1.5 font-semibold text-right">CLV avg</th>
                <th className="px-3 py-1.5 font-semibold text-right">% beat close</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <SourceRow key={r.category} row={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SourceRow({ row }: { row: PerformanceBySourceRow }) {
  const empty = row.total === 0;
  const wlp = `${row.won}-${row.lost}${row.push > 0 ? `-${row.push}` : ""}`;
  return (
    <tr
      className={cn(
        "border-b border-border/20",
        empty ? "opacity-60" : "",
      )}
      title={PERFORMANCE_CATEGORY_DESCRIPTIONS[row.category]}
    >
      <td className="px-3 py-2">
        <div className="font-semibold text-foreground">
          {PERFORMANCE_CATEGORY_LABELS[row.category]}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {PERFORMANCE_CATEGORY_DESCRIPTIONS[row.category]}
        </div>
      </td>
      <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
        {row.total > 0 ? row.total : "—"}
      </td>
      <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
        {row.resolved > 0 ? wlp : "—"}
      </td>
      <td className={cn("px-3 py-2 text-right font-mono tabular-nums", toneForHit(row.hitRatePct))}>
        {fmtPct(row.hitRatePct)}
      </td>
      <td className={cn("px-3 py-2 text-right font-mono tabular-nums", toneForRoi(row.roiPct))}>
        {fmtPct(row.roiPct)}
      </td>
      <td className={cn("px-3 py-2 text-right font-mono tabular-nums", toneForClv(row.clvPpAvg))}>
        {fmtPp(row.clvPpAvg, row.clvSample)}
      </td>
      <td className={cn("px-3 py-2 text-right font-mono tabular-nums", toneForBeatClose(row.pctBeatClose))}>
        {fmtPct(row.pctBeatClose, row.clvSample)}
      </td>
    </tr>
  );
}

// ── Formatters / tones ───────────────────────────────────────────────

function fmtPct(v: number | null, gateSample?: number): string {
  if (gateSample != null && gateSample === 0) return "—";
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function fmtPp(v: number | null, gateSample?: number): string {
  if (gateSample != null && gateSample === 0) return "—";
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)} pp`;
}

function toneForRoi(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v > 5)   return "text-emerald-600 dark:text-emerald-400";
  if (v < -5)  return "text-red-600 dark:text-red-400";
  return "text-foreground";
}

function toneForHit(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 55)   return "text-emerald-600 dark:text-emerald-400";
  if (v < 45)    return "text-red-600 dark:text-red-400";
  return "text-foreground";
}

function toneForClv(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v > 0.5)   return "text-emerald-600 dark:text-emerald-400";
  if (v < -0.5)  return "text-red-600 dark:text-red-400";
  return "text-foreground";
}

function toneForBeatClose(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 55)   return "text-emerald-600 dark:text-emerald-400";
  if (v < 45)    return "text-red-600 dark:text-red-400";
  return "text-foreground";
}
