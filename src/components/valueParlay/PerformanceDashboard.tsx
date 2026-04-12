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

import { useState, useMemo } from "react";
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
  useConfidenceCalibration,
  useConfidenceCalibrationBySport,
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
  ConfidenceCalibrationRow,
  ConfidenceCalibrationBySportRow,
} from "@/hooks/useAnalyticsDashboard";

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Sample-size reliability helpers ──────────────────────────────────────────

/** Minimum resolved count for a stat to be meaningfully interpreted. */
const MIN_RELIABLE = 10;
const MIN_NOISY    = 5;

/** Color class for a resolved count cell — makes sample size visually obvious. */
function sampleSizeClass(n: number): string {
  if (n >= MIN_RELIABLE) return "text-foreground";
  if (n >= MIN_NOISY)    return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground/60";
}

/** Inline sample size badge shown alongside hit rate / ROI when n is low. */
function SampleNote({ n }: { n: number }) {
  if (n >= MIN_RELIABLE) return null;
  return (
    <span className={cn(
      "ml-1 text-[9px] font-semibold",
      n >= MIN_NOISY ? "text-amber-500" : "text-muted-foreground/50"
    )}>
      {n < MIN_NOISY ? "n<5 — noise" : "low n"}
    </span>
  );
}

/** Panel-level caution note when a sport has low resolution coverage. */
function LowCoverageNote({ sport }: { sport: string }) {
  return (
    <span className="ml-1 text-[9px] text-amber-500 font-medium" title={`${sport}: low resolution coverage — interpret with caution`}>
      ⚠ low coverage
    </span>
  );
}

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

/** Panel-level total resolved count badge — warns when entire panel is low-N. */
function PanelNBadge({ n }: { n: number }) {
  const cls =
    n >= 50  ? "text-emerald-600/70 dark:text-emerald-400/60 border-emerald-500/20 bg-emerald-500/5"
    : n >= 10 ? "text-amber-500 border-amber-500/25 bg-amber-500/5"
    :           "text-rose-500 border-rose-500/25 bg-rose-500/5";
  return (
    <span className={cn("text-[9px] font-mono font-semibold tabular-nums px-1.5 py-0.5 rounded border", cls)}>
      {n < 10 ? "⚠ " : ""}n={n}
    </span>
  );
}

function SectionHeader({ title, totalN }: { title: string; totalN?: number }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <p className="text-[10px] font-semibold tracking-wider text-muted-foreground">{title}</p>
      {totalN != null && <PanelNBadge n={totalN} />}
    </div>
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

// ── Trend helpers ─────────────────────────────────────────────────────────────

type TrendDir = "up" | "flat" | "down";

/** Compare recent (7d) vs baseline (30d). Positive diff = improving. */
function trendDir(
  recent:    number | null,
  baseline:  number | null,
  threshold: number = 2,
): TrendDir | null {
  if (recent == null || baseline == null) return null;
  const diff = recent - baseline;
  if (Math.abs(diff) < threshold) return "flat";
  return diff > 0 ? "up" : "down";
}

function TrendBadge({ dir, showLabel = false }: { dir: TrendDir | null; showLabel?: boolean }) {
  if (!dir) return <span className="text-muted-foreground/40 text-[9px]">—</span>;
  const color =
    dir === "up"   ? "text-emerald-600 dark:text-emerald-400"
    : dir === "down" ? "text-rose-500"
    : "text-muted-foreground/60";
  const arrow = dir === "up" ? "↑" : dir === "down" ? "↓" : "→";
  const label = dir === "up" ? "improving" : dir === "down" ? "declining" : "flat";
  return (
    <span className={cn("text-[10px] font-bold tabular-nums", color)}>
      {arrow}{showLabel && <span className="ml-0.5 font-normal text-[9px]">{label}</span>}
    </span>
  );
}

// ── Trend summary panel ───────────────────────────────────────────────────────

/** Aggregate hit rate + avg edge pp across all sports from sport-ROI rows. */
function aggHitRate(rows: RoiBySportRow[]): number | null {
  const resolved = rows.reduce((s, r) => s + r.resolved_count, 0);
  const wins     = rows.reduce((s, r) => s + r.win_count, 0);
  return resolved > 0 ? Math.round((wins / resolved) * 1000) / 10 : null;
}

function aggEdgePp(rows: RoiBySportRow[]): number | null {
  const totalResolved = rows.reduce((s, r) => s + r.resolved_count, 0);
  if (!totalResolved) return null;
  const weighted = rows.reduce((s, r) => s + r.avg_edge * r.resolved_count, 0);
  return Math.round((weighted / totalResolved) * 10000) / 100;
}

function TrendSummaryPanel({
  sportData7,
  sportData30,
  recData7,
  recData30,
  loading,
}: {
  sportData7:  RoiBySportRow[];
  sportData30: RoiBySportRow[];
  recData7:    RecommendedVsExcludedRow[];
  recData30:   RecommendedVsExcludedRow[];
  loading:     boolean;
}) {
  if (loading) return <LoadingRows n={3} />;

  const hitRate7  = aggHitRate(sportData7);
  const hitRate30 = aggHitRate(sportData30);
  const edge7     = aggEdgePp(sportData7);
  const edge30    = aggEdgePp(sportData30);
  const recHit7   = recData7.find((r) => r.is_recommended)?.hit_rate_pct  ?? null;
  const recHit30  = recData30.find((r) => r.is_recommended)?.hit_rate_pct ?? null;
  const resolved7 = sportData7.reduce((s, r) => s + r.resolved_count, 0);

  const hasAny = hitRate7 != null || hitRate30 != null;
  if (!hasAny) return <NoDataNote label="trend" />;

  type MetricRow = { label: string; val7: number | null; val30: number | null; suffix: string; threshold: number };
  const metrics: MetricRow[] = [
    { label: "Hit rate",       val7: hitRate7, val30: hitRate30, suffix: "%",  threshold: 2   },
    { label: "Avg edge",       val7: edge7,    val30: edge30,    suffix: "pp", threshold: 0.5 },
    { label: "Rec. hit rate",  val7: recHit7,  val30: recHit30,  suffix: "%",  threshold: 2   },
  ];

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] tabular-nums">
          <thead>
            <tr className="text-muted-foreground text-left border-b border-border">
              <th className="py-1 pr-3 font-semibold">Metric</th>
              <th className="py-1 pr-3 font-semibold text-right">7d</th>
              <th className="py-1 pr-3 font-semibold text-right">30d</th>
              <th className="py-1 font-semibold text-center">Trend</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map(({ label, val7, val30, suffix, threshold }) => {
              const dir = trendDir(val7, val30, threshold);
              return (
                <tr key={label} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 pr-3 text-foreground font-medium">{label}</td>
                  <td className={cn("py-1.5 pr-3 text-right font-semibold", val7 != null ? pctColor(val7) : "text-muted-foreground")}>
                    {val7 != null ? `${val7.toFixed(1)}${suffix}` : "—"}
                  </td>
                  <td className={cn("py-1.5 pr-3 text-right font-semibold", val30 != null ? pctColor(val30) : "text-muted-foreground")}>
                    {val30 != null ? `${val30.toFixed(1)}${suffix}` : "—"}
                  </td>
                  <td className="py-1.5 text-center">
                    <TrendBadge dir={dir} showLabel />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {resolved7 < MIN_NOISY && resolved7 > 0 && (
        <p className="text-[9px] text-amber-500 mt-1.5">
          ⚠ Only {resolved7} resolved picks in last 7d — trend may not be reliable
        </p>
      )}
    </div>
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
            <th className="py-1 pr-3 font-semibold text-right">n (resolved)</th>
            <th className="py-1 pr-3 font-semibold text-right">Hit%</th>
            <th className="py-1 pr-3 font-semibold text-right">ROI%</th>
            <th className="py-1 font-semibold text-right">Avg edge</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const n = r.resolved_predictions;
            return (
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
                <td className={cn("py-1.5 pr-3 text-right font-semibold", sampleSizeClass(n))}>
                  {n}<SampleNote n={n} />
                </td>
                <td className={cn("py-1.5 pr-3 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : pctColor(r.hit_rate_pct))}>
                  {fmt(r.hit_rate_pct)}
                </td>
                <td className={cn("py-1.5 pr-3 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : roiColor(r.roi_pct))}>
                  {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)}
                </td>
                <td className="py-1.5 text-right text-muted-foreground">
                  {r.avg_edge != null ? `${(r.avg_edge * 100).toFixed(1)}pp` : "—"}
                </td>
              </tr>
            );
          })}
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
  const minN = Math.min(rec?.resolved_count ?? 0, excl?.resolved_count ?? 0);
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
          {minN < MIN_RELIABLE && <span className="ml-2 text-amber-500">⚠ low sample (n={minN})</span>}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] tabular-nums">
          <thead>
            <tr className="text-muted-foreground text-left border-b border-border">
              <th className="py-1 pr-3 font-semibold">Status</th>
              <th className="py-1 pr-3 font-semibold text-right">n (resolved)</th>
              <th className="py-1 pr-3 font-semibold text-right">Hit%</th>
              <th className="py-1 pr-3 font-semibold text-right">ROI%</th>
              <th className="py-1 font-semibold text-right">Avg edge</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const n = r.resolved_count;
              return (
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
                  <td className={cn("py-1.5 pr-3 text-right font-semibold", sampleSizeClass(n))}>
                    {n}<SampleNote n={n} />
                  </td>
                  <td className={cn("py-1.5 pr-3 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : pctColor(r.hit_rate_pct))}>
                    {fmt(r.hit_rate_pct)}
                  </td>
                  <td className={cn("py-1.5 pr-3 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : roiColor(r.roi_pct))}>
                    {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)}
                  </td>
                  <td className="py-1.5 text-right text-muted-foreground">
                    {r.avg_edge != null ? `${(r.avg_edge * 100).toFixed(1)}pp` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── ROI by sport panel ────────────────────────────────────────────────────────

function RoiBySportPanel({
  rows,
  loading,
  lowResolutionSports = new Set<string>(),
  data7 = [],
  data30 = [],
}: {
  rows: RoiBySportRow[];
  loading: boolean;
  lowResolutionSports?: Set<string>;
  /** Always 7-day rows — used for trend comparison regardless of active window. */
  data7?: RoiBySportRow[];
  /** Always 30-day rows — used for trend comparison. */
  data30?: RoiBySportRow[];
}) {
  if (loading) return <LoadingRows />;
  const resolved = rows.filter((r) => r.resolved_count > 0);
  if (!resolved.length) return <NoDataNote label="sport ROI" />;

  const showTrend = data7.length > 0 && data30.length > 0;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px] tabular-nums">
        <thead>
          <tr className="text-muted-foreground text-left border-b border-border">
            <th className="py-1 pr-3 font-semibold">Sport</th>
            <th className="py-1 pr-3 font-semibold text-right">n (resolved)</th>
            <th className="py-1 pr-3 font-semibold text-right">Hit%</th>
            <th className="py-1 pr-3 font-semibold text-right">ROI%</th>
            <th className={cn("py-1 font-semibold text-right", showTrend ? "pr-3" : "")}>Avg edge</th>
            {showTrend && <th className="py-1 font-semibold text-center">Trend</th>}
          </tr>
        </thead>
        <tbody>
          {resolved.map((r) => {
            const n = r.resolved_count;
            const lowCoverage = lowResolutionSports.has(r.sport);
            const hit7  = data7.find((x) => x.sport === r.sport)?.hit_rate_pct ?? null;
            const hit30 = data30.find((x) => x.sport === r.sport)?.hit_rate_pct ?? null;
            const dir = showTrend ? trendDir(hit7, hit30) : null;
            return (
              <tr key={r.sport} className="border-b border-border/50 last:border-0">
                <td className="py-1.5 pr-3 font-bold text-foreground">
                  {r.sport}
                  {lowCoverage && <LowCoverageNote sport={r.sport} />}
                </td>
                <td className={cn("py-1.5 pr-3 text-right font-semibold", sampleSizeClass(n))}>
                  {n}<SampleNote n={n} />
                </td>
                <td className={cn("py-1.5 pr-3 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : pctColor(r.hit_rate_pct))}>
                  {fmt(r.hit_rate_pct)}
                </td>
                <td className={cn("py-1.5 pr-3 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : roiColor(r.roi_pct))}>
                  {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)}
                </td>
                <td className={cn("py-1.5 text-right text-muted-foreground", showTrend ? "pr-3" : "")}>
                  {r.avg_edge != null ? `${(r.avg_edge * 100).toFixed(1)}pp` : "—"}
                </td>
                {showTrend && (
                  <td className="py-1.5 text-center">
                    <TrendBadge dir={dir} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {showTrend && (
        <p className="text-[9px] text-muted-foreground/60 mt-1">Trend: ↑↓→ compares 7d vs 30d hit rate</p>
      )}
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
            <th className="py-1 pr-3 font-semibold text-right">n (resolved)</th>
            <th className="py-1 pr-3 font-semibold text-right">Hit%</th>
            <th className="py-1 font-semibold text-right">ROI%</th>
          </tr>
        </thead>
        <tbody>
          {resolved.map((r) => {
            const n = r.resolved_count;
            return (
              <tr key={r.risk_band} className="border-b border-border/50 last:border-0">
                <td className="py-1.5 pr-3 font-medium text-foreground capitalize">{r.risk_band}</td>
                <td className={cn("py-1.5 pr-3 text-right font-semibold", sampleSizeClass(n))}>
                  {n}<SampleNote n={n} />
                </td>
                <td className={cn("py-1.5 pr-3 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : pctColor(r.hit_rate_pct))}>
                  {fmt(r.hit_rate_pct)}
                </td>
                <td className={cn("py-1.5 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : roiColor(r.roi_pct))}>
                  {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Timing by sport panel ─────────────────────────────────────────────────────

/** Weighted hit rate across all timing buckets for a single sport. */
function aggTimingSportHitRate(rows: TimingBySportRow[], sport: string): number | null {
  const sportRows = rows.filter((r) => r.sport === sport);
  const resolved  = sportRows.reduce((s, r) => s + r.resolved_count, 0);
  const wins      = sportRows.reduce((s, r) => s + r.win_count, 0);
  return resolved > 0 ? Math.round((wins / resolved) * 1000) / 10 : null;
}

function TimingBySportPanel({
  rows,
  loading,
  lowResolutionSports = new Set<string>(),
  data7 = [],
  data30 = [],
}: {
  rows: TimingBySportRow[];
  loading: boolean;
  lowResolutionSports?: Set<string>;
  data7?: TimingBySportRow[];
  data30?: TimingBySportRow[];
}) {
  if (loading) return <LoadingRows />;
  const resolved = rows.filter((r) => r.resolved_count > 0);
  if (!resolved.length) return <NoDataNote label="timing by sport" />;

  const sports = [...new Set(resolved.map((r) => r.sport))];
  const showTrend = data7.length > 0 && data30.length > 0;

  return (
    <div className="space-y-4">
      {sports.map((sport) => {
        const sportRows = resolved.filter((r) => r.sport === sport);
        const lowCoverage = lowResolutionSports.has(sport);
        const sportDir = showTrend
          ? trendDir(aggTimingSportHitRate(data7, sport), aggTimingSportHitRate(data30, sport))
          : null;
        return (
          <div key={sport}>
            <p className="text-[9px] font-bold tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
              {sport}
              {showTrend && <TrendBadge dir={sportDir} />}
              {lowCoverage && <LowCoverageNote sport={sport} />}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-[10px] tabular-nums">
                <tbody>
                  {sportRows.map((r) => {
                    const n = r.resolved_count;
                    return (
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
                        <td className={cn("py-1 pr-3 text-right font-semibold", sampleSizeClass(n))}>
                          n={n}<SampleNote n={n} />
                        </td>
                        <td className={cn("py-1 pr-3 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : pctColor(r.hit_rate_pct))}>
                          {fmt(r.hit_rate_pct)} hit
                        </td>
                        <td className={cn("py-1 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : roiColor(r.roi_pct))}>
                          {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)} ROI
                        </td>
                      </tr>
                    );
                  })}
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

/** Delta (rec - excl hit rate) for a sport from a row set. */
function sportFilterDelta(rows: RecommendedVsExcludedBySportRow[], sport: string): number | null {
  const rec  = rows.find((r) => r.sport === sport && r.is_recommended);
  const excl = rows.find((r) => r.sport === sport && !r.is_recommended);
  if (rec?.hit_rate_pct != null && excl?.hit_rate_pct != null) {
    return rec.hit_rate_pct - excl.hit_rate_pct;
  }
  return null;
}

function RecVsExclBySportPanel({
  rows,
  loading,
  lowResolutionSports = new Set<string>(),
  data7 = [],
  data30 = [],
}: {
  rows: RecommendedVsExcludedBySportRow[];
  loading: boolean;
  lowResolutionSports?: Set<string>;
  data7?: RecommendedVsExcludedBySportRow[];
  data30?: RecommendedVsExcludedBySportRow[];
}) {
  if (loading) return <LoadingRows />;
  const resolved = rows.filter((r) => r.resolved_count > 0);
  if (!resolved.length) return <NoDataNote label="filter quality by sport" />;

  const sports = [...new Set(resolved.map((r) => r.sport))];
  const showTrend = data7.length > 0 && data30.length > 0;

  return (
    <div className="space-y-3">
      {sports.map((sport) => {
        const rec  = resolved.find((r) => r.sport === sport && r.is_recommended);
        const excl = resolved.find((r) => r.sport === sport && !r.is_recommended);
        const minN = Math.min(rec?.resolved_count ?? 0, excl?.resolved_count ?? 0);
        const lowCoverage = lowResolutionSports.has(sport);
        const delta =
          rec?.hit_rate_pct != null && excl?.hit_rate_pct != null
            ? rec.hit_rate_pct - excl.hit_rate_pct
            : null;
        // Trend: is the filter delta (rec - excl) widening or narrowing?
        const filterTrend = showTrend
          ? trendDir(sportFilterDelta(data7, sport), sportFilterDelta(data30, sport), 2)
          : null;

        return (
          <div key={sport} className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
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
              {showTrend && <TrendBadge dir={filterTrend} />}
              {minN < MIN_RELIABLE && <span className="text-[9px] text-amber-500">n={minN} — low sample</span>}
              {lowCoverage && <LowCoverageNote sport={sport} />}
            </div>
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              {[rec, excl].map((r) => {
                if (!r) return null;
                const n = r.resolved_count;
                return (
                  <div key={String(r.is_recommended)} className="flex items-center justify-between bg-muted/20 rounded px-2 py-1">
                    <span className={cn(
                      "font-semibold",
                      r.is_recommended ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
                    )}>
                      {r.is_recommended ? "Rec" : "Excl"} <span className={cn("text-[9px]", sampleSizeClass(n))}>n={n}</span>
                    </span>
                    <span className={cn("font-semibold tabular-nums", n < MIN_NOISY ? "text-muted-foreground/50" : pctColor(r.hit_rate_pct))}>
                      {fmt(r.hit_rate_pct)}
                    </span>
                    <span className={cn("font-semibold tabular-nums", n < MIN_NOISY ? "text-muted-foreground/50" : roiColor(r.roi_pct))}>
                      {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)}
                    </span>
                  </div>
                );
              })}
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
          {rows.map((r) => {
            const n = r.resolved_count;
            return (
              <tr key={`${r.sport}-${r.stat_type}`} className="border-b border-border/40 last:border-0">
                <td className="py-1.5 pr-2 text-muted-foreground font-semibold">{r.sport}</td>
                <td className="py-1.5 pr-3 text-foreground font-medium">{r.stat_type.replace(/_/g, " ")}</td>
                <td className={cn("py-1.5 pr-3 text-right font-semibold", sampleSizeClass(n))}>
                  {n}<SampleNote n={n} />
                </td>
                <td className={cn("py-1.5 pr-3 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : pctColor(r.hit_rate_pct))}>
                  {fmt(r.hit_rate_pct)}
                </td>
                <td className={cn("py-1.5 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : roiColor(r.roi_pct))}>
                  {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)}
                </td>
              </tr>
            );
          })}
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

// ── Confidence calibration panel ─────────────────────────────────────────────

const CONF_ORDER = ["HIGH", "MED", "LOW"];

function ConfCalibrationPanel({
  overall,
  bySport,
  overallLoading,
  bySportLoading,
  lowResolutionSports = new Set<string>(),
  overall7 = [],
  overall30 = [],
}: {
  overall: ConfidenceCalibrationRow[];
  bySport: ConfidenceCalibrationBySportRow[];
  overallLoading: boolean;
  bySportLoading: boolean;
  lowResolutionSports?: Set<string>;
  overall7?: ConfidenceCalibrationRow[];
  overall30?: ConfidenceCalibrationRow[];
}) {
  // Calibration verdict: HIGH hit% > MED hit% > LOW hit%?
  const resolvedOverall = overall.filter((r) => (r.resolved_count ?? 0) >= MIN_NOISY);
  const high = resolvedOverall.find((r) => r.confidence === "HIGH")?.hit_rate_pct;
  const med  = resolvedOverall.find((r) => r.confidence === "MED")?.hit_rate_pct;
  const low  = resolvedOverall.find((r) => r.confidence === "LOW")?.hit_rate_pct;
  const wellOrdered =
    high != null && med != null && low != null && high > med && med > low;
  const partiallyOrdered =
    high != null && med != null && high > med;

  // Trend: is HIGH confidence hit rate improving? Is the HIGH–LOW calibration gap widening?
  const showCalibTrend = overall7.length > 0 && overall30.length > 0;
  const high7   = overall7.find((r) => r.confidence === "HIGH")?.hit_rate_pct ?? null;
  const high30  = overall30.find((r) => r.confidence === "HIGH")?.hit_rate_pct ?? null;
  const low7    = overall7.find((r) => r.confidence === "LOW")?.hit_rate_pct ?? null;
  const low30   = overall30.find((r) => r.confidence === "LOW")?.hit_rate_pct ?? null;
  const gap7    = high7 != null && low7  != null ? high7  - low7  : null;
  const gap30   = high30 != null && low30 != null ? high30 - low30 : null;
  const highTrend = showCalibTrend ? trendDir(high7, high30) : null;
  const gapTrend  = showCalibTrend ? trendDir(gap7, gap30, 1) : null;

  const sports = [...new Set(bySport.map((r) => r.sport))];

  function confBadge(conf: string) {
    return (
      <span className={cn(
        "px-1.5 py-0.5 rounded-full text-[9px] font-bold",
        conf === "HIGH" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        : conf === "MED" ? "bg-primary/10 text-primary"
        : "bg-muted/40 text-muted-foreground"
      )}>
        {conf}
      </span>
    );
  }

  return (
    <div className="space-y-4">
      {/* Overall calibration verdict */}
      {!overallLoading && resolvedOverall.length > 0 && (
        <div className={cn(
          "text-[10px] px-2.5 py-1.5 rounded border",
          wellOrdered
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
            : partiallyOrdered
            ? "bg-muted/40 text-muted-foreground border-border"
            : "bg-rose-500/10 text-rose-500 border-rose-500/20"
        )}>
          {wellOrdered
            ? "Well calibrated: HIGH > MED > LOW hit rate ordering confirmed"
            : partiallyOrdered
            ? "Partially calibrated: HIGH > MED confirmed — LOW needs more data"
            : "⚠ Calibration gap: HIGH/MED ordering not confirmed — investigate confidence scoring"}
        </div>
      )}

      {/* Calibration trend mini-table */}
      {showCalibTrend && (high7 != null || high30 != null) && (
        <div className="border border-border/50 rounded p-2 space-y-1 text-[10px]">
          <p className="text-[9px] font-semibold text-muted-foreground tracking-wider mb-1.5">CALIBRATION TREND (7d vs 30d)</p>
          {[
            { label: "HIGH hit rate",   val7: high7,  val30: high30, dir: highTrend, suffix: "%" },
            { label: "H–L gap",         val7: gap7,   val30: gap30,  dir: gapTrend,  suffix: "pp", note: "widening = better calibration" },
          ].map(({ label, val7: v7, val30: v30, dir, suffix, note }) => (
            <div key={label} className="flex items-center gap-2 flex-wrap">
              <span className="text-muted-foreground w-24 shrink-0">{label}</span>
              <span className="tabular-nums text-foreground">{v7 != null ? `${v7.toFixed(1)}${suffix}` : "—"}</span>
              <span className="text-muted-foreground/50">vs</span>
              <span className="tabular-nums text-muted-foreground">{v30 != null ? `${v30.toFixed(1)}${suffix}` : "—"}</span>
              <TrendBadge dir={dir} showLabel />
              {note && <span className="text-[9px] text-muted-foreground/50">{note}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Overall table */}
      {overallLoading ? <LoadingRows n={3} /> : overall.filter(r => r.resolved_count > 0).length === 0 ? (
        <NoDataNote label="confidence calibration" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] tabular-nums">
            <thead>
              <tr className="text-muted-foreground text-left border-b border-border">
                <th className="py-1 pr-3 font-semibold">Confidence</th>
                <th className="py-1 pr-3 font-semibold text-right">n (resolved)</th>
                <th className="py-1 pr-3 font-semibold text-right">Hit%</th>
                <th className="py-1 pr-3 font-semibold text-right">ROI%</th>
                <th className="py-1 font-semibold text-right">Avg edge</th>
              </tr>
            </thead>
            <tbody>
              {[...overall].sort((a, b) => CONF_ORDER.indexOf(a.confidence) - CONF_ORDER.indexOf(b.confidence)).map((r) => {
                const n = r.resolved_count;
                return (
                  <tr key={r.confidence} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pr-3">{confBadge(r.confidence)}</td>
                    <td className={cn("py-1.5 pr-3 text-right font-semibold", sampleSizeClass(n))}>
                      {n}<SampleNote n={n} />
                    </td>
                    <td className={cn("py-1.5 pr-3 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : pctColor(r.hit_rate_pct))}>
                      {fmt(r.hit_rate_pct)}
                    </td>
                    <td className={cn("py-1.5 pr-3 text-right font-semibold", n < MIN_NOISY ? "text-muted-foreground/50" : roiColor(r.roi_pct))}>
                      {r.roi_pct != null && r.roi_pct >= 0 ? "+" : ""}{fmt(r.roi_pct)}
                    </td>
                    <td className="py-1.5 text-right text-muted-foreground">
                      {r.avg_edge != null ? `${(r.avg_edge * 100).toFixed(1)}pp` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* By-sport breakdown */}
      {!bySportLoading && bySport.filter(r => r.resolved_count > 0).length > 0 && (
        <div className="space-y-3 pt-1 border-t border-border/50">
          <p className="text-[9px] font-semibold tracking-wider text-muted-foreground pt-1">BY SPORT</p>
          {sports.map((sport) => {
            const sportRows = bySport
              .filter((r) => r.sport === sport && r.resolved_count > 0)
              .sort((a, b) => CONF_ORDER.indexOf(a.confidence) - CONF_ORDER.indexOf(b.confidence));
            if (!sportRows.length) return null;
            const lowCoverage = lowResolutionSports.has(sport);
            return (
              <div key={sport}>
                <p className="text-[9px] font-bold tracking-wider text-muted-foreground mb-1">
                  {sport}
                  {lowCoverage && <LowCoverageNote sport={sport} />}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {sportRows.map((r) => {
                    const n = r.resolved_count;
                    return (
                      <div key={r.confidence} className="flex items-center gap-1 bg-muted/20 rounded px-2 py-1 text-[10px]">
                        {confBadge(r.confidence)}
                        <span className={cn("font-semibold tabular-nums", n < MIN_NOISY ? "text-muted-foreground/50" : pctColor(r.hit_rate_pct))}>
                          {fmt(r.hit_rate_pct)}
                        </span>
                        <span className={cn("text-[9px]", sampleSizeClass(n))}>n={n}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
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
  const confidenceCalibQ = useConfidenceCalibration(days);
  const confCalibBySportQ = useConfidenceCalibrationBySport(days);

  // Always fetch both windows so trend comparison is always available.
  // React Query dedupes against the window-driven hooks above when days matches.
  const roiSportQ7          = useRoiBySport(7);
  const roiSportQ30         = useRoiBySport(30);
  const recVsExclQ7         = useRecommendedVsExcluded(7);
  const recVsExclQ30        = useRecommendedVsExcluded(30);
  const recVsExclSportQ7    = useRecommendedVsExcludedBySport(7);
  const recVsExclSportQ30   = useRecommendedVsExcludedBySport(30);
  const timingBySportQ7     = useTimingBySport(7);
  const timingBySportQ30    = useTimingBySport(30);
  const confidenceCalibQ7   = useConfidenceCalibration(7);
  const confidenceCalibQ30  = useConfidenceCalibration(30);

  const trendLoading =
    roiSportQ7.isLoading || roiSportQ30.isLoading ||
    recVsExclQ7.isLoading || recVsExclQ30.isLoading;

  // Panel-level total resolved counts for overreaction-risk panels.
  // Shown as header badges so it's obvious at a glance if a panel is low-N.
  const timingBySportTotalN = useMemo(
    () => (timingBySportQ.data ?? []).reduce((s, r) => s + r.resolved_count, 0),
    [timingBySportQ.data]
  );
  const recVsExclSportTotalN = useMemo(
    () => (recVsExclSportQ.data ?? [])
      .filter((r) => r.is_recommended)
      .reduce((s, r) => s + r.resolved_count, 0),
    [recVsExclSportQ.data]
  );
  const roiMarketTotalN = useMemo(
    () => (roiMarketQ.data ?? []).reduce((s, r) => s + r.resolved_count, 0),
    [roiMarketQ.data]
  );

  // Sports with resolution < 40% get a caution flag on per-sport panels
  const lowResolutionSports = useMemo(
    () => new Set((resolutionQ.data ?? []).filter((r) => r.resolution_pct < 40).map((r) => r.sport)),
    [resolutionQ.data]
  );

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

          {/* 0. Trend overview */}
          <section className="space-y-2">
            <SectionHeader title="7D VS 30D TREND OVERVIEW" />
            <TrendSummaryPanel
              sportData7={roiSportQ7.data ?? []}
              sportData30={roiSportQ30.data ?? []}
              recData7={recVsExclQ7.data ?? []}
              recData30={recVsExclQ30.data ?? []}
              loading={trendLoading}
            />
          </section>

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
            <RoiBySportPanel
              rows={roiSportQ.data ?? []}
              loading={roiSportQ.isLoading}
              lowResolutionSports={lowResolutionSports}
              data7={roiSportQ7.data ?? []}
              data30={roiSportQ30.data ?? []}
            />
          </section>

          {/* 6. ROI by risk band */}
          <section className="space-y-2">
            <SectionHeader title="HIT RATE + ROI BY RISK BAND" />
            <RoiByRiskBandPanel rows={roiRiskQ.data ?? []} loading={roiRiskQ.isLoading} />
          </section>

          {/* 7. Safe pool depth */}
          <section className="space-y-2">
            <SectionHeader title="SAFE MODE POOL DEPTH BY SPORT" />
            <SafePoolPanel rows={safeQ.data ?? []} loading={safeQ.isLoading} />
          </section>

          {/* 8. Timing by sport */}
          <section className="space-y-2">
            <SectionHeader title="TIMING PERFORMANCE BY SPORT" totalN={timingBySportQ.isLoading ? undefined : timingBySportTotalN} />
            <TimingBySportPanel
              rows={timingBySportQ.data ?? []}
              loading={timingBySportQ.isLoading}
              lowResolutionSports={lowResolutionSports}
              data7={timingBySportQ7.data ?? []}
              data30={timingBySportQ30.data ?? []}
            />
          </section>

          {/* 9. Filter quality by sport */}
          <section className="space-y-2">
            <SectionHeader title="FILTER QUALITY BY SPORT (RECOMMENDED VS EXCLUDED)" totalN={recVsExclSportQ.isLoading ? undefined : recVsExclSportTotalN} />
            <RecVsExclBySportPanel
              rows={recVsExclSportQ.data ?? []}
              loading={recVsExclSportQ.isLoading}
              lowResolutionSports={lowResolutionSports}
              data7={recVsExclSportQ7.data ?? []}
              data30={recVsExclSportQ30.data ?? []}
            />
          </section>

          {/* 10. ROI by market type */}
          <section className="space-y-2">
            <SectionHeader title="ROI BY MARKET TYPE (TOP BY ROI)" totalN={roiMarketQ.isLoading ? undefined : roiMarketTotalN} />
            <RoiByMarketTypePanel rows={roiMarketQ.data ?? []} loading={roiMarketQ.isLoading} />
          </section>

          {/* 11. Resolution completeness */}
          <section className="space-y-2">
            <SectionHeader title="RESOLUTION COMPLETENESS BY SPORT" />
            <ResolutionPanel rows={resolutionQ.data ?? []} loading={resolutionQ.isLoading} />
          </section>

          {/* 12. Confidence calibration */}
          <section className="space-y-2">
            <SectionHeader title="CONFIDENCE CALIBRATION (HIGH > MED > LOW)" />
            <ConfCalibrationPanel
              overall={confidenceCalibQ.data ?? []}
              bySport={confCalibBySportQ.data ?? []}
              overallLoading={confidenceCalibQ.isLoading}
              bySportLoading={confCalibBySportQ.isLoading}
              lowResolutionSports={lowResolutionSports}
              overall7={confidenceCalibQ7.data ?? []}
              overall30={confidenceCalibQ30.data ?? []}
            />
          </section>
        </div>
      )}
    </div>
  );
}
