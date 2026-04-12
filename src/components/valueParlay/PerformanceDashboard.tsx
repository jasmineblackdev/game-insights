/**
 * PerformanceDashboard — model analytics surface.
 *
 * Five panels driven by Supabase RPCs:
 *   1. Timing bucket performance (hit rate + ROI)
 *   2. Exclusion reason frequency
 *   3. Stability score vs outcome
 *   4. Safe pool depth by sport
 *
 * Shows an empty-state nudge when no resolved predictions exist yet.
 * Lookup window toggles between 7 and 30 days.
 */

import { useState } from "react";
import { BarChart2, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useTimingPerformance,
  useExclusionFrequency,
  useStabilityVsOutcome,
  useSafePoolDepth,
  useRecommendedVsExcluded,
  useRoiBySport,
  useRoiByRiskBand,
  useTimingBySport,
  useRecommendedVsExcludedBySport,
  useRoiByMarketType,
  useResolutionCompleteness,
} from "@/hooks/useAnalyticsDashboard";
import type {
  TimingBucketRow,
  ExclusionFrequencyRow,
  StabilityRow,
  SafePoolDepthRow,
  RecommendedVsExcludedRow,
  RoiBySportRow,
  RoiByRiskBandRow,
  TimingBySportRow,
  RecommendedVsExcludedBySportRow,
  RoiByMarketTypeRow,
  ResolutionCompletenessRow,
} from "@/hooks/useAnalyticsDashboard";

// ── Helpers ───────────────────────────────────────────────────────────────────

function pctColor(pct: number | null): string {
  if (pct == null) return "text-muted-foreground";
  if (pct >= 55) return "text-emerald-600 dark:text-emerald-400";
  if (pct >= 48) return "text-foreground";
  return "text-rose-500 dark:text-rose-400";
}

function roiColor(roi: number | null): string {
  if (roi == null) return "text-muted-foreground";
  if (roi >= 5)    return "text-emerald-600 dark:text-emerald-400";
  if (roi >= 0)    return "text-foreground";
  return "text-rose-500 dark:text-rose-400";
}

function fmt(n: number | null, suffix = "%", decimals = 1): string {
  if (n == null) return "—";
  return `${n.toFixed(decimals)}${suffix}`;
}

function SectionHeader({ title }: { title: string }) {
  return (
    <p className="text-[10px] font-semibold tracking-wider text-muted-foreground mb-2">{title}</p>
  );
}

function LoadingRows({ n = 3 }: { n?: number }) {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="h-7 rounded bg-muted/30 animate-pulse" />
      ))}
    </div>
  );
}

function NoDataNote({ label }: { label: string }) {
  return (
    <p className="text-[10px] text-muted-foreground italic py-2">
      No {label} data yet — predictions resolve after games complete.
    </p>
  );
}

// ── Timing bucket panel ───────────────────────────────────────────────────────

function timingBucketLabel(bucket: string): string {
  if (bucket === "now")     return "Now";
  if (bucket === "monitor") return "Monitor";
  if (bucket === "wait")    return "Wait";
  return bucket;
}

function TimingPanel({ rows, loading }: { rows: TimingBucketRow[]; loading: boolean }) {
  if (loading) return <LoadingRows />;
  const resolved = rows.filter((r) => r.resolved_predictions > 0);
  if (!resolved.length) return <NoDataNote label="resolved timing" />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px] tabular-nums">
        <thead>
          <tr className="text-muted-foreground text-left border-b border-border">
            <th className="py-1 pr-3 font-semibold">Bucket</th>
            <th className="py-1 pr-3 font-semibold text-right">Total</th>
            <th className="py-1 pr-3 font-semibold text-right">Resolved</th>
            <th className="py-1 pr-3 font-semibold text-right">Hit%</th>
            <th className="py-1 pr-3 font-semibold text-right">ROI%</th>
            <th className="py-1 font-semibold text-right">Avg edge</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.timing_bucket} className="border-b border-border/50 last:border-0">
              <td className="py-1.5 pr-3 font-semibold">
                <span className={cn(
                  "px-1.5 py-0.5 rounded-full text-[9px] font-bold",
                  r.timing_bucket === "now"     && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                  r.timing_bucket === "wait"    && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                  r.timing_bucket === "monitor" && "bg-muted/40 text-muted-foreground",
                )}>
                  {timingBucketLabel(r.timing_bucket)}
                </span>
              </td>
              <td className="py-1.5 pr-3 text-right text-muted-foreground">{r.total_predictions}</td>
              <td className="py-1.5 pr-3 text-right text-muted-foreground">{r.resolved_predictions}</td>
              <td className={cn("py-1.5 pr-3 text-right font-semibold", pctColor(r.hit_rate_pct))}>
                {fmt(r.hit_rate_pct)}
              </td>
              <td className={cn("py-1.5 pr-3 text-right font-semibold", roiColor(r.roi_pct))}>
                {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)}
              </td>
              <td className="py-1.5 text-right text-muted-foreground">
                {r.avg_edge != null ? `${(r.avg_edge * 100).toFixed(1)}pp` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Exclusion frequency panel ─────────────────────────────────────────────────

function ExclusionPanel({ rows, loading }: { rows: ExclusionFrequencyRow[]; loading: boolean }) {
  if (loading) return <LoadingRows />;
  if (!rows.length) return <NoDataNote label="exclusion" />;

  const overfire = rows[0] && rows[0].pct_of_excluded > 60;

  return (
    <div className="space-y-1.5">
      {overfire && (
        <div className="flex items-center gap-1.5 text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded px-2 py-1">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          Top reason "{rows[0].exclusion_reason}" accounts for {rows[0].pct_of_excluded}% of exclusions — possible overfire
        </div>
      )}
      {rows.map((r) => (
        <div key={r.exclusion_reason} className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2">
            <span className="text-[10px] text-foreground font-medium">{r.exclusion_reason}</span>
            <div className="flex-1 bg-muted/30 rounded-full h-1 min-w-[40px]">
              <div
                className={cn(
                  "h-1 rounded-full",
                  overfire && r.exclusion_reason === rows[0].exclusion_reason
                    ? "bg-amber-400"
                    : "bg-primary/60"
                )}
                style={{ width: `${Math.min(100, r.pct_of_excluded)}%` }}
              />
            </div>
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">
            {r.exclusion_count} ({r.pct_of_excluded}%)
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Stability vs outcome panel ────────────────────────────────────────────────

function StabilityPanel({ rows, loading }: { rows: StabilityRow[]; loading: boolean }) {
  if (loading) return <LoadingRows />;
  const resolved = rows.filter((r) => r.total > 0);
  if (!resolved.length) return <NoDataNote label="stability" />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px] tabular-nums">
        <thead>
          <tr className="text-muted-foreground text-left border-b border-border">
            <th className="py-1 pr-3 font-semibold">Stability bucket</th>
            <th className="py-1 pr-3 font-semibold text-right">Count</th>
            <th className="py-1 pr-3 font-semibold text-right">Win%</th>
            <th className="py-1 font-semibold text-right">Avg stability</th>
          </tr>
        </thead>
        <tbody>
          {resolved.map((r) => (
            <tr key={r.stability_bucket} className="border-b border-border/50 last:border-0">
              <td className="py-1.5 pr-3 font-medium text-foreground">{r.stability_bucket}</td>
              <td className="py-1.5 pr-3 text-right text-muted-foreground">{r.total}</td>
              <td className={cn("py-1.5 pr-3 text-right font-semibold", pctColor(r.hit_rate_pct))}>
                {fmt(r.hit_rate_pct)}
              </td>
              <td className="py-1.5 text-right text-muted-foreground">
                {r.avg_stability_score != null ? (r.avg_stability_score * 100).toFixed(0) : "—"}/100
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Safe pool depth panel ─────────────────────────────────────────────────────

function SafePoolPanel({ rows, loading }: { rows: SafePoolDepthRow[]; loading: boolean }) {
  if (loading) return <LoadingRows />;
  if (!rows.length) return <NoDataNote label="safe pool depth" />;

  // Pivot: sport → recent safe_pct average
  const bySport = rows.reduce<Record<string, { safe: number; total: number }>>((acc, r) => {
    if (!acc[r.sport]) acc[r.sport] = { safe: 0, total: 0 };
    acc[r.sport].safe  += r.safe_eligible;
    acc[r.sport].total += r.total_candidates;
    return acc;
  }, {});

  return (
    <div className="space-y-1.5">
      {Object.entries(bySport).map(([sport, { safe, total }]) => {
        const pct = total > 0 ? Math.round((safe / total) * 100) : 0;
        const thin = safe < 3;
        return (
          <div key={sport} className="flex items-center gap-2">
            <span className={cn(
              "text-[9px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0 w-12 text-center",
              thin
                ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                : "bg-muted/40 text-muted-foreground"
            )}>
              {sport}
            </span>
            <div className="flex-1 bg-muted/30 rounded-full h-1.5">
              <div
                className={cn("h-1.5 rounded-full", thin ? "bg-amber-400" : "bg-primary/60")}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground shrink-0 w-20 text-right">
              {safe} safe / {total} total
            </span>
            {thin && <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />}
          </div>
        );
      })}
    </div>
  );
}

// ── Recommended vs excluded panel ────────────────────────────────────────────

function RecommendedVsExcludedPanel({
  rows,
  loading,
}: {
  rows: RecommendedVsExcludedRow[];
  loading: boolean;
}) {
  if (loading) return <LoadingRows n={2} />;
  const resolved = rows.filter((r) => r.resolved_count > 0);
  if (!resolved.length) return <NoDataNote label="recommended vs excluded" />;

  const rec  = rows.find((r) => r.is_recommended);
  const excl = rows.find((r) => !r.is_recommended);
  const delta =
    rec?.hit_rate_pct != null && excl?.hit_rate_pct != null
      ? rec.hit_rate_pct - excl.hit_rate_pct
      : null;

  return (
    <div className="space-y-3">
      {delta != null && (
        <div className={cn(
          "text-[10px] px-2.5 py-1.5 rounded border",
          delta >= 5
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
            : delta >= 0
            ? "bg-muted/40 text-muted-foreground border-border"
            : "bg-rose-500/10 text-rose-500 border-rose-500/20"
        )}>
          {delta >= 5
            ? `Filter working: recommended hits ${delta.toFixed(1)}pp higher than excluded`
            : delta >= 0
            ? `Slight edge: recommended hits ${delta.toFixed(1)}pp higher — needs more data`
            : `⚠ Filter may be hurting: excluded is outperforming recommended by ${Math.abs(delta).toFixed(1)}pp`}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] tabular-nums">
          <thead>
            <tr className="text-muted-foreground text-left border-b border-border">
              <th className="py-1 pr-3 font-semibold">Status</th>
              <th className="py-1 pr-3 font-semibold text-right">Matched</th>
              <th className="py-1 pr-3 font-semibold text-right">Resolved</th>
              <th className="py-1 pr-3 font-semibold text-right">Hit%</th>
              <th className="py-1 pr-3 font-semibold text-right">ROI%</th>
              <th className="py-1 font-semibold text-right">Avg edge</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.is_recommended)} className="border-b border-border/50 last:border-0">
                <td className="py-1.5 pr-3">
                  <span className={cn(
                    "px-1.5 py-0.5 rounded-full text-[9px] font-bold",
                    r.is_recommended
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-muted/40 text-muted-foreground"
                  )}>
                    {r.is_recommended ? "Recommended" : "Excluded"}
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-right text-muted-foreground">{r.total_matched}</td>
                <td className="py-1.5 pr-3 text-right text-muted-foreground">{r.resolved_count}</td>
                <td className={cn("py-1.5 pr-3 text-right font-semibold", pctColor(r.hit_rate_pct))}>
                  {fmt(r.hit_rate_pct)}
                </td>
                <td className={cn("py-1.5 pr-3 text-right font-semibold", roiColor(r.roi_pct))}>
                  {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)}
                </td>
                <td className="py-1.5 text-right text-muted-foreground">
                  {r.avg_edge != null ? `${(r.avg_edge * 100).toFixed(1)}pp` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── ROI by sport panel ────────────────────────────────────────────────────────

function RoiBySportPanel({ rows, loading }: { rows: RoiBySportRow[]; loading: boolean }) {
  if (loading) return <LoadingRows />;
  const resolved = rows.filter((r) => r.resolved_count > 0);
  if (!resolved.length) return <NoDataNote label="sport ROI" />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px] tabular-nums">
        <thead>
          <tr className="text-muted-foreground text-left border-b border-border">
            <th className="py-1 pr-3 font-semibold">Sport</th>
            <th className="py-1 pr-3 font-semibold text-right">Resolved</th>
            <th className="py-1 pr-3 font-semibold text-right">Hit%</th>
            <th className="py-1 pr-3 font-semibold text-right">ROI%</th>
            <th className="py-1 font-semibold text-right">Avg edge</th>
          </tr>
        </thead>
        <tbody>
          {resolved.map((r) => (
            <tr key={r.sport} className="border-b border-border/50 last:border-0">
              <td className="py-1.5 pr-3 font-bold text-foreground">{r.sport}</td>
              <td className="py-1.5 pr-3 text-right text-muted-foreground">{r.resolved_count}</td>
              <td className={cn("py-1.5 pr-3 text-right font-semibold", pctColor(r.hit_rate_pct))}>
                {fmt(r.hit_rate_pct)}
              </td>
              <td className={cn("py-1.5 pr-3 text-right font-semibold", roiColor(r.roi_pct))}>
                {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)}
              </td>
              <td className="py-1.5 text-right text-muted-foreground">
                {r.avg_edge != null ? `${(r.avg_edge * 100).toFixed(1)}pp` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── ROI by risk band panel ────────────────────────────────────────────────────

function RoiByRiskBandPanel({ rows, loading }: { rows: RoiByRiskBandRow[]; loading: boolean }) {
  if (loading) return <LoadingRows />;
  const resolved = rows.filter((r) => r.resolved_count > 0);
  if (!resolved.length) return <NoDataNote label="risk band ROI" />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px] tabular-nums">
        <thead>
          <tr className="text-muted-foreground text-left border-b border-border">
            <th className="py-1 pr-3 font-semibold">Risk band</th>
            <th className="py-1 pr-3 font-semibold text-right">Matched</th>
            <th className="py-1 pr-3 font-semibold text-right">Hit%</th>
            <th className="py-1 font-semibold text-right">ROI%</th>
          </tr>
        </thead>
        <tbody>
          {resolved.map((r) => (
            <tr key={r.risk_band} className="border-b border-border/50 last:border-0">
              <td className="py-1.5 pr-3 font-medium text-foreground capitalize">{r.risk_band}</td>
              <td className="py-1.5 pr-3 text-right text-muted-foreground">{r.resolved_count}</td>
              <td className={cn("py-1.5 pr-3 text-right font-semibold", pctColor(r.hit_rate_pct))}>
                {fmt(r.hit_rate_pct)}
              </td>
              <td className={cn("py-1.5 text-right font-semibold", roiColor(r.roi_pct))}>
                {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Timing by sport panel ─────────────────────────────────────────────────────

function TimingBySportPanel({ rows, loading }: { rows: TimingBySportRow[]; loading: boolean }) {
  if (loading) return <LoadingRows />;
  const resolved = rows.filter((r) => r.resolved_count > 0);
  if (!resolved.length) return <NoDataNote label="timing by sport" />;

  // Group rows by sport for rendering
  const sports = [...new Set(resolved.map((r) => r.sport))];

  return (
    <div className="space-y-4">
      {sports.map((sport) => {
        const sportRows = resolved.filter((r) => r.sport === sport);
        return (
          <div key={sport}>
            <p className="text-[9px] font-bold tracking-wider text-muted-foreground mb-1">{sport}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-[10px] tabular-nums">
                <tbody>
                  {sportRows.map((r) => (
                    <tr key={r.timing_bucket} className="border-b border-border/40 last:border-0">
                      <td className="py-1 pr-3">
                        <span className={cn(
                          "px-1.5 py-0.5 rounded-full text-[9px] font-bold",
                          r.timing_bucket === "now"     && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                          r.timing_bucket === "wait"    && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                          r.timing_bucket === "monitor" && "bg-muted/40 text-muted-foreground",
                        )}>
                          {r.timing_bucket}
                        </span>
                      </td>
                      <td className="py-1 pr-3 text-right text-muted-foreground">{r.resolved_count} resolved</td>
                      <td className={cn("py-1 pr-3 text-right font-semibold", pctColor(r.hit_rate_pct))}>
                        {fmt(r.hit_rate_pct)} hit
                      </td>
                      <td className={cn("py-1 text-right font-semibold", roiColor(r.roi_pct))}>
                        {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)} ROI
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Recommended vs excluded by sport panel ────────────────────────────────────

function RecVsExclBySportPanel({
  rows,
  loading,
}: {
  rows: RecommendedVsExcludedBySportRow[];
  loading: boolean;
}) {
  if (loading) return <LoadingRows />;
  const resolved = rows.filter((r) => r.resolved_count > 0);
  if (!resolved.length) return <NoDataNote label="filter quality by sport" />;

  const sports = [...new Set(resolved.map((r) => r.sport))];

  return (
    <div className="space-y-3">
      {sports.map((sport) => {
        const rec  = resolved.find((r) => r.sport === sport && r.is_recommended);
        const excl = resolved.find((r) => r.sport === sport && !r.is_recommended);
        const delta =
          rec?.hit_rate_pct != null && excl?.hit_rate_pct != null
            ? rec.hit_rate_pct - excl.hit_rate_pct
            : null;

        return (
          <div key={sport} className="space-y-1">
            <div className="flex items-center gap-2">
              <p className="text-[9px] font-bold tracking-wider text-muted-foreground">{sport}</p>
              {delta != null && (
                <span className={cn(
                  "text-[9px] px-1.5 py-0.5 rounded font-semibold",
                  delta >= 5  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : delta >= 0 ? "bg-muted/40 text-muted-foreground"
                  : "bg-rose-500/10 text-rose-500"
                )}>
                  {delta >= 0 ? "+" : ""}{delta.toFixed(1)}pp
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              {[rec, excl].map((r) =>
                r ? (
                  <div key={String(r.is_recommended)} className="flex items-center justify-between bg-muted/20 rounded px-2 py-1">
                    <span className={cn(
                      "font-semibold",
                      r.is_recommended ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
                    )}>
                      {r.is_recommended ? "Rec" : "Excl"}
                    </span>
                    <span className={cn("font-semibold tabular-nums", pctColor(r.hit_rate_pct))}>
                      {fmt(r.hit_rate_pct)}
                    </span>
                    <span className={cn("font-semibold tabular-nums", roiColor(r.roi_pct))}>
                      {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)}
                    </span>
                  </div>
                ) : null
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── ROI by market type panel ──────────────────────────────────────────────────

function RoiByMarketTypePanel({ rows, loading }: { rows: RoiByMarketTypeRow[]; loading: boolean }) {
  if (loading) return <LoadingRows />;
  if (!rows.length) return <NoDataNote label="market type ROI" />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px] tabular-nums">
        <thead>
          <tr className="text-muted-foreground text-left border-b border-border">
            <th className="py-1 pr-2 font-semibold">Sport</th>
            <th className="py-1 pr-3 font-semibold">Market</th>
            <th className="py-1 pr-3 font-semibold text-right">Resolved</th>
            <th className="py-1 pr-3 font-semibold text-right">Hit%</th>
            <th className="py-1 font-semibold text-right">ROI%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.sport}-${r.stat_type}`} className="border-b border-border/40 last:border-0">
              <td className="py-1.5 pr-2 text-muted-foreground font-semibold">{r.sport}</td>
              <td className="py-1.5 pr-3 text-foreground font-medium">{r.stat_type.replace(/_/g, " ")}</td>
              <td className="py-1.5 pr-3 text-right text-muted-foreground">{r.resolved_count}</td>
              <td className={cn("py-1.5 pr-3 text-right font-semibold", pctColor(r.hit_rate_pct))}>
                {fmt(r.hit_rate_pct)}
              </td>
              <td className={cn("py-1.5 text-right font-semibold", roiColor(r.roi_pct))}>
                {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Resolution completeness panel ─────────────────────────────────────────────

function ResolutionPanel({ rows, loading }: { rows: ResolutionCompletenessRow[]; loading: boolean }) {
  if (loading) return <LoadingRows />;
  if (!rows.length) return <NoDataNote label="resolution completeness" />;

  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const stale = r.stale_pending > 0;
        return (
          <div key={r.sport} className="flex items-center gap-2">
            <span className="text-[9px] font-bold text-muted-foreground uppercase w-12 shrink-0">{r.sport}</span>
            <div className="flex-1 bg-muted/30 rounded-full h-1.5">
              <div
                className={cn("h-1.5 rounded-full", r.resolution_pct >= 80 ? "bg-emerald-500/70" : r.resolution_pct >= 50 ? "bg-primary/60" : "bg-amber-400")}
                style={{ width: `${Math.min(100, r.resolution_pct)}%` }}
              />
            </div>
            <span className={cn(
              "text-[10px] tabular-nums font-semibold shrink-0 w-20 text-right",
              r.resolution_pct >= 80 ? "text-emerald-600 dark:text-emerald-400"
              : r.resolution_pct >= 50 ? "text-foreground"
              : "text-amber-600 dark:text-amber-400"
            )}>
              {r.resolution_pct}% ({r.resolved_count}/{r.total_surfaced})
            </span>
            {stale && (
              <span className="text-[9px] text-amber-500 shrink-0 flex items-center gap-0.5">
                <AlertTriangle className="w-2.5 h-2.5" />
                {r.stale_pending} stale
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export function PerformanceDashboard() {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<7 | 30>(30);

  const timingQ          = useTimingPerformance(days);
  const exclQ            = useExclusionFrequency(days);
  const stabilityQ       = useStabilityVsOutcome(days);
  const safeQ            = useSafePoolDepth(days);
  const recVsExclQ       = useRecommendedVsExcluded(days);
  const roiSportQ        = useRoiBySport(days);
  const roiRiskQ         = useRoiByRiskBand(days);
  const timingBySportQ   = useTimingBySport(days);
  const recVsExclSportQ  = useRecommendedVsExcludedBySport(days);
  const roiMarketQ       = useRoiByMarketType(days);
  const resolutionQ      = useResolutionCompleteness(days);

  return (
    <div className="rounded-lg border border-border bg-card/40">
      {/* Header toggle */}
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-card/60 transition-colors rounded-t-lg"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-primary" />
          <span className="text-sm font-display font-bold text-foreground">Performance Analytics</span>
          <span className="text-[10px] text-muted-foreground">timing · filter quality · stability · sport ROI</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-5 border-t border-border">
          {/* Lookback toggle */}
          <div className="flex gap-2 pt-3">
            <p className="text-[10px] text-muted-foreground self-center">Window:</p>
            {([7, 30] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={cn(
                  "px-2.5 py-0.5 rounded-full text-[10px] font-semibold border transition-colors",
                  days === d ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"
                )}
              >
                {d}d
              </button>
            ))}
          </div>

          {/* 1. Timing performance */}
          <section className="space-y-2">
            <SectionHeader title="HIT RATE + ROI BY TIMING BUCKET" />
            <TimingPanel rows={timingQ.data ?? []} loading={timingQ.isLoading} />
          </section>

          {/* 2. Exclusion reasons */}
          <section className="space-y-2">
            <SectionHeader title="EXCLUSION REASON FREQUENCY" />
            <ExclusionPanel rows={exclQ.data ?? []} loading={exclQ.isLoading} />
          </section>

          {/* 3. Recommended vs excluded — filter quality validation */}
          <section className="space-y-2">
            <SectionHeader title="RECOMMENDED VS EXCLUDED HIT RATE" />
            <RecommendedVsExcludedPanel rows={recVsExclQ.data ?? []} loading={recVsExclQ.isLoading} />
          </section>

          {/* 4. Stability vs outcome */}
          <section className="space-y-2">
            <SectionHeader title="STABILITY SCORE VS WIN RATE" />
            <StabilityPanel rows={stabilityQ.data ?? []} loading={stabilityQ.isLoading} />
          </section>

          {/* 5. ROI by sport */}
          <section className="space-y-2">
            <SectionHeader title="HIT RATE + ROI BY SPORT" />
            <RoiBySportPanel rows={roiSportQ.data ?? []} loading={roiSportQ.isLoading} />
          </section>

          {/* 6. ROI by risk band */}
          <section className="space-y-2">
            <SectionHeader title="HIT RATE + ROI BY RISK BAND" />
            <RoiByRiskBandPanel rows={roiRiskQ.data ?? []} loading={roiRiskQ.isLoading} />
          </section>

          {/* 7. Exclusion reasons */}
          <section className="space-y-2">
            <SectionHeader title="EXCLUSION REASON FREQUENCY" />
            <ExclusionPanel rows={exclQ.data ?? []} loading={exclQ.isLoading} />
          </section>

          {/* 8. Safe pool depth */}
          <section className="space-y-2">
            <SectionHeader title="SAFE MODE POOL DEPTH BY SPORT" />
            <SafePoolPanel rows={safeQ.data ?? []} loading={safeQ.isLoading} />
          </section>

          {/* 9. Timing by sport */}
          <section className="space-y-2">
            <SectionHeader title="TIMING PERFORMANCE BY SPORT" />
            <TimingBySportPanel rows={timingBySportQ.data ?? []} loading={timingBySportQ.isLoading} />
          </section>

          {/* 10. Filter quality by sport */}
          <section className="space-y-2">
            <SectionHeader title="FILTER QUALITY BY SPORT (RECOMMENDED VS EXCLUDED)" />
            <RecVsExclBySportPanel rows={recVsExclSportQ.data ?? []} loading={recVsExclSportQ.isLoading} />
          </section>

          {/* 11. ROI by market type */}
          <section className="space-y-2">
            <SectionHeader title="ROI BY MARKET TYPE (TOP BY ROI)" />
            <RoiByMarketTypePanel rows={roiMarketQ.data ?? []} loading={roiMarketQ.isLoading} />
          </section>

          {/* 12. Resolution completeness */}
          <section className="space-y-2">
            <SectionHeader title="RESOLUTION COMPLETENESS BY SPORT" />
            <ResolutionPanel rows={resolutionQ.data ?? []} loading={resolutionQ.isLoading} />
          </section>
        </div>
      )}
    </div>
  );
}
