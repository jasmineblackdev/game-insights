/**
 * Parlay Performance Dashboard
 *
 * 8-panel view combining model contribution data, edge-bucket analysis,
 * timing/stability cross-tabs, parlay build history, and alpha status.
 * All panels read from the 5 new analytics RPCs added in the model_contribution migration.
 */

import { useEffect, useState } from "react";
import {
  useModelContribution,
  useParlayModelMix,
  useEdgeBucketPerformance,
  useTimingEdgeQuality,
  useStabilityEdgeQuality,
  useCalibrationImpact,
  useCalibrationImpactBySport,
  useEarlyValueImpact,
  useEarlyValueImpactBySport,
  useResolutionCompleteness,
  type ModelContributionRow,
  type ParlayModelMixRow,
  type EdgeBucketPerformanceRow,
  type TimingEdgeQualityRow,
  type StabilityEdgeQualityRow,
  type CalibrationImpactRow,
  type CalibrationImpactBySportRow,
  type EarlyValueImpactRow,
  type EarlyValueImpactBySportRow,
  type ResolutionCompletenessRow,
} from "@/hooks/useAnalyticsDashboard";
import { getAdaptiveWeightsSync, computeAlpha } from "@/lib/ml/weights";
import { ALPHA_RANGES, getAlphaRange } from "@/lib/ml/alphaConfig";
import { readAlphaAdjustmentLog, type AlphaAdjustmentLog } from "@/lib/ml/feedbackLoop";
import { getAllCalibrationEntries } from "@/lib/ml/confidenceCalibrationMap";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

// ── Sample size badge ────────────────────────────────────────────────────────

function SampleBadge({ n }: { n: number }) {
  const cls =
    n >= 50  ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20" :
    n >= 20  ? "text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 border-yellow-500/20" :
               "text-red-500 bg-red-500/10 border-red-500/20";
  return (
    <span className={cn("text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded border", cls)}>
      {n < 20 ? "⚠ " : ""}n={n}
    </span>
  );
}

// ── Shared primitives ────────────────────────────────────────────────────────

function SectionCard({
  title,
  subtitle,
  sampleSize,
  children,
}: {
  title: string;
  subtitle?: string;
  sampleSize?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-bold tracking-wider text-muted-foreground uppercase">{title}</h3>
          {subtitle && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{subtitle}</p>}
        </div>
        {sampleSize != null && <SampleBadge n={sampleSize} />}
      </div>
      {children}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <p className="text-xs text-muted-foreground/60 py-4 text-center">
      {label}
    </p>
  );
}

function LoadingRow() {
  return (
    <div className="h-5 w-full rounded bg-muted/40 animate-pulse" />
  );
}

function pct(v: number | null | undefined, decimals = 1): string {
  if (v == null) return "—";
  return `${v.toFixed(decimals)}%`;
}

function roiColor(v: number | null | undefined): string {
  if (v == null) return "text-muted-foreground";
  if (v > 5)   return "text-emerald-500";
  if (v > 0)   return "text-emerald-400/80";
  if (v < -10) return "text-red-500";
  if (v < 0)   return "text-red-400/80";
  return "text-muted-foreground";
}

function hitColor(v: number | null | undefined): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 60)  return "text-emerald-500";
  if (v >= 50)  return "text-yellow-500";
  return "text-red-400";
}

// ── Panel 1: Model Contribution ──────────────────────────────────────────────

function ModelContributionPanel({ days }: { days: number }) {
  const { data, isLoading } = useModelContribution(days);
  const rows = (data ?? []) as ModelContributionRow[];
  const totalResolved = rows.reduce((s, r) => s + Number(r.resolved_count ?? 0), 0);

  const VARIANT_LABEL: Record<string, string> = {
    rules:      "Rules engine",
    ml_blended: "ML blended",
    ml_full:    "ML full",
  };

  return (
    <SectionCard
      title="Model contribution"
      subtitle="Hit rate & ROI by model variant — requires ≥10 resolved per variant"
      sampleSize={isLoading ? undefined : totalResolved}
    >
      {isLoading ? (
        <div className="space-y-1.5">
          {[0, 1].map((i) => <LoadingRow key={i} />)}
        </div>
      ) : !rows.length ? (
        <EmptyState label="Not enough resolved predictions yet (need ≥10 per variant)" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground/70">
                <th className="text-left py-1 pr-3 font-medium">Variant</th>
                <th className="text-right py-1 pr-3 font-medium">n</th>
                <th className="text-right py-1 pr-3 font-medium">Hit %</th>
                <th className="text-right py-1 pr-3 font-medium">ROI</th>
                <th className="text-right py-1 font-medium">Avg edge</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model_variant} className="border-t border-border/40">
                  <td className="py-1.5 pr-3 font-medium text-foreground">
                    {VARIANT_LABEL[r.model_variant] ?? r.model_variant}
                  </td>
                  <td className="text-right py-1.5 pr-3 tabular-nums">
                    <SampleBadge n={Number(r.resolved_count)} />
                  </td>
                  <td className={cn("text-right py-1.5 pr-3 tabular-nums font-semibold", hitColor(r.hit_rate_pct))}>
                    {pct(r.hit_rate_pct)}
                  </td>
                  <td className={cn("text-right py-1.5 pr-3 tabular-nums font-semibold", roiColor(r.roi_pct))}>
                    {pct(r.roi_pct)}
                  </td>
                  <td className="text-right py-1.5 tabular-nums text-muted-foreground">
                    {r.avg_edge != null ? `${(Number(r.avg_edge) * 100).toFixed(1)}pp` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// ── Panel 2: Edge Bucket Performance ─────────────────────────────────────────

function EdgeBucketPanel({ days }: { days: number }) {
  const { data, isLoading } = useEdgeBucketPerformance(days);
  const rows = (data ?? []) as EdgeBucketPerformanceRow[];
  const totalResolved = rows.reduce((s, r) => s + Number(r.resolved_count ?? 0), 0);

  const byBucket = rows.reduce<Record<string, EdgeBucketPerformanceRow[]>>((acc, r) => {
    (acc[r.edge_bucket] ??= []).push(r);
    return acc;
  }, {});

  const BUCKETS = ["0–2%", "2–5%", "5–8%", "8%+"];

  return (
    <SectionCard
      title="Edge bucket performance"
      subtitle="Does higher edge actually convert? Requires ≥5 resolved per sport/market/bucket"
      sampleSize={isLoading ? undefined : totalResolved}
    >
      {isLoading ? (
        <div className="space-y-1.5">
          {[0, 1, 2, 3].map((i) => <LoadingRow key={i} />)}
        </div>
      ) : !rows.length ? (
        <EmptyState label="Not enough resolved data yet (need ≥5 per bucket)" />
      ) : (
        <div className="space-y-2">
          {BUCKETS.map((bucket) => {
            const bucketRows = byBucket[bucket];
            if (!bucketRows?.length) return null;
            const totalR = bucketRows.reduce((s, r) => s + Number(r.resolved_count), 0);
            const totalW = bucketRows.reduce((s, r) => s + Number(r.win_count), 0);
            const aggHit = totalR ? (totalW / totalR) * 100 : null;
            const avgRoi = bucketRows.reduce((s, r) => s + (r.roi_pct ?? 0), 0) / bucketRows.length;

            return (
              <div key={bucket} className="flex items-center justify-between gap-2 text-xs">
                <span className="font-mono font-semibold text-foreground w-14 shrink-0">{bucket}</span>
                <div className="flex items-center gap-2 flex-1 justify-end">
                  <SampleBadge n={totalR} />
                  <span className={cn("tabular-nums font-semibold", hitColor(aggHit))}>
                    {pct(aggHit)} hit
                  </span>
                  <span className={cn("tabular-nums font-semibold", roiColor(avgRoi))}>
                    {pct(avgRoi)} ROI
                  </span>
                </div>
              </div>
            );
          })}
          <p className="text-[10px] text-muted-foreground/60 pt-1">
            {rows.length} sport/market/bucket combos
          </p>
        </div>
      )}
    </SectionCard>
  );
}

// ── Panel 3: Timing × Edge ────────────────────────────────────────────────────

function TimingEdgePanel({ days }: { days: number }) {
  const { data, isLoading } = useTimingEdgeQuality(days);
  const rows = (data ?? []) as TimingEdgeQualityRow[];
  const totalResolved = rows.reduce((s, r) => s + Number(r.resolved_count ?? 0), 0);

  const TIMING_ORDER = ["now", "monitor", "wait"];
  const TIMING_LABEL: Record<string, string> = { now: "Now", monitor: "Monitor", wait: "Wait" };
  const TIMING_COLOR: Record<string, string> = {
    now:     "text-emerald-500",
    monitor: "text-yellow-500",
    wait:    "text-red-400",
  };

  const byTiming = rows.reduce<Record<string, TimingEdgeQualityRow[]>>((acc, r) => {
    (acc[r.timing_bucket] ??= []).push(r);
    return acc;
  }, {});

  return (
    <SectionCard
      title="Timing × edge quality"
      subtitle={`Does "bet now" timing improve edge realization within the same edge range?`}
      sampleSize={isLoading ? undefined : totalResolved}
    >
      {isLoading ? (
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => <LoadingRow key={i} />)}
        </div>
      ) : !rows.length ? (
        <EmptyState label="Not enough resolved data yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground/70">
                <th className="text-left py-1 pr-3 font-medium">Timing</th>
                <th className="text-left py-1 pr-3 font-medium">Edge</th>
                <th className="text-right py-1 pr-3 font-medium">n</th>
                <th className="text-right py-1 pr-3 font-medium">Hit %</th>
                <th className="text-right py-1 font-medium">ROI</th>
              </tr>
            </thead>
            <tbody>
              {TIMING_ORDER.flatMap((timing) =>
                (byTiming[timing] ?? []).map((r, i) => (
                  <tr key={`${timing}-${r.edge_bucket}`} className="border-t border-border/40">
                    <td className={cn("py-1.5 pr-3 font-semibold", TIMING_COLOR[timing] ?? "text-foreground")}>
                      {i === 0 ? (TIMING_LABEL[timing] ?? timing) : ""}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-muted-foreground">{r.edge_bucket}</td>
                    <td className="text-right py-1.5 pr-3">
                      <SampleBadge n={Number(r.resolved_count)} />
                    </td>
                    <td className={cn("text-right py-1.5 pr-3 tabular-nums font-semibold", hitColor(r.hit_rate_pct))}>
                      {pct(r.hit_rate_pct)}
                    </td>
                    <td className={cn("text-right py-1.5 tabular-nums font-semibold", roiColor(r.roi_pct))}>
                      {pct(r.roi_pct)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// ── Panel 4: Stability × Edge ─────────────────────────────────────────────────

function StabilityEdgePanel({ days }: { days: number }) {
  const { data, isLoading } = useStabilityEdgeQuality(days);
  const rows = (data ?? []) as StabilityEdgeQualityRow[];
  const totalResolved = rows.reduce((s, r) => s + Number(r.resolved_count ?? 0), 0);

  const STABILITY_COLOR: Record<string, string> = {
    "high (≥0.70)":       "text-emerald-500",
    "medium (0.45–0.70)": "text-yellow-500",
    "low (<0.45)":        "text-red-400",
    "unknown":            "text-muted-foreground",
  };

  const byStability = rows.reduce<Record<string, StabilityEdgeQualityRow[]>>((acc, r) => {
    (acc[r.stability_bucket] ??= []).push(r);
    return acc;
  }, {});

  const STABILITY_ORDER = ["high (≥0.70)", "medium (0.45–0.70)", "low (<0.45)", "unknown"];

  return (
    <SectionCard
      title="Stability × edge quality"
      subtitle="Does ML stability score predict whether edge converts?"
      sampleSize={isLoading ? undefined : totalResolved}
    >
      {isLoading ? (
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => <LoadingRow key={i} />)}
        </div>
      ) : !rows.length ? (
        <EmptyState label="Not enough resolved data yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground/70">
                <th className="text-left py-1 pr-3 font-medium">Stability</th>
                <th className="text-left py-1 pr-3 font-medium">Edge</th>
                <th className="text-right py-1 pr-3 font-medium">n</th>
                <th className="text-right py-1 pr-3 font-medium">Hit %</th>
                <th className="text-right py-1 font-medium">ROI</th>
              </tr>
            </thead>
            <tbody>
              {STABILITY_ORDER.flatMap((stab) =>
                (byStability[stab] ?? []).map((r, i) => (
                  <tr key={`${stab}-${r.edge_bucket}`} className="border-t border-border/40">
                    <td className={cn("py-1.5 pr-3 font-semibold whitespace-nowrap", STABILITY_COLOR[stab] ?? "text-foreground")}>
                      {i === 0 ? stab : ""}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-muted-foreground">{r.edge_bucket}</td>
                    <td className="text-right py-1.5 pr-3">
                      <SampleBadge n={Number(r.resolved_count)} />
                    </td>
                    <td className={cn("text-right py-1.5 pr-3 tabular-nums font-semibold", hitColor(r.hit_rate_pct))}>
                      {pct(r.hit_rate_pct)}
                    </td>
                    <td className={cn("text-right py-1.5 tabular-nums font-semibold", roiColor(r.roi_pct))}>
                      {pct(r.roi_pct)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// ── Panel 5: Parlay Model Mix ─────────────────────────────────────────────────

function ParlayModelMixPanel({ days }: { days: number }) {
  const { data, isLoading } = useParlayModelMix(days);
  const rows = (data ?? []) as ParlayModelMixRow[];
  const totalParlays = rows.reduce((s, r) => s + Number(r.parlay_count ?? 0), 0);

  const TIER_COLOR: Record<string, string> = {
    safe:       "text-emerald-500",
    balanced:   "text-yellow-500",
    aggressive: "text-orange-500",
  };

  return (
    <SectionCard
      title="Parlay ML mix vs outcome"
      subtitle="Do parlays with more ML legs outperform rules-only parlays?"
      sampleSize={isLoading ? undefined : totalParlays}
    >
      {isLoading ? (
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => <LoadingRow key={i} />)}
        </div>
      ) : !rows.length ? (
        <EmptyState label="No parlay build history yet — auto-build some parlays to populate" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground/70">
                <th className="text-left py-1 pr-3 font-medium">Tier</th>
                <th className="text-left py-1 pr-3 font-medium">ML ratio</th>
                <th className="text-right py-1 pr-3 font-medium">Parlays</th>
                <th className="text-right py-1 pr-3 font-medium">Resolved</th>
                <th className="text-right py-1 pr-3 font-medium">Hit %</th>
                <th className="text-right py-1 font-medium">ROI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.tier}-${r.ml_ratio_bucket}`} className="border-t border-border/40">
                  <td className={cn("py-1.5 pr-3 font-semibold capitalize", TIER_COLOR[r.tier] ?? "text-foreground")}>
                    {r.tier}
                  </td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{r.ml_ratio_bucket}</td>
                  <td className="text-right py-1.5 pr-3 tabular-nums text-muted-foreground">
                    {r.parlay_count}
                  </td>
                  <td className="text-right py-1.5 pr-3">
                    <SampleBadge n={Number(r.resolved_count)} />
                  </td>
                  <td className={cn("text-right py-1.5 pr-3 tabular-nums font-semibold", hitColor(r.hit_rate_pct))}>
                    {pct(r.hit_rate_pct)}
                  </td>
                  <td className={cn("text-right py-1.5 tabular-nums font-semibold", roiColor(r.roi_pct))}>
                    {pct(r.roi_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// ── Panel 6: Tier summary ─────────────────────────────────────────────────────

function TierSummaryPanel({ days }: { days: number }) {
  const { data, isLoading } = useParlayModelMix(days);
  const rows = (data ?? []) as ParlayModelMixRow[];

  const byTier = rows.reduce<Record<string, { parlays: number; resolved: number; hits: number; roiSum: number; roiN: number }>>((acc, r) => {
    if (!acc[r.tier]) acc[r.tier] = { parlays: 0, resolved: 0, hits: 0, roiSum: 0, roiN: 0 };
    acc[r.tier].parlays  += Number(r.parlay_count);
    acc[r.tier].resolved += Number(r.resolved_count);
    if (r.hit_rate_pct != null) {
      acc[r.tier].hits += Math.round((Number(r.hit_rate_pct) / 100) * Number(r.resolved_count));
    }
    if (r.roi_pct != null) {
      acc[r.tier].roiSum += Number(r.roi_pct);
      acc[r.tier].roiN++;
    }
    return acc;
  }, {});

  const totalParlays = Object.values(byTier).reduce((s, t) => s + t.parlays, 0);
  const TIERS = ["safe", "balanced", "aggressive"];
  const TIER_COLOR: Record<string, string> = {
    safe:       "text-emerald-500",
    balanced:   "text-yellow-500",
    aggressive: "text-orange-500",
  };

  return (
    <SectionCard
      title="Parlay build history — tier overview"
      subtitle={`Last ${days} days · aggregated from parlay_build_history + parlay_results`}
      sampleSize={isLoading ? undefined : totalParlays}
    >
      {isLoading ? (
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => <LoadingRow key={i} />)}
        </div>
      ) : !rows.length ? (
        <EmptyState label="No parlay builds logged yet" />
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {TIERS.map((tier) => {
            const t = byTier[tier];
            if (!t) return null;
            const hitRate = t.resolved ? (t.hits / t.resolved) * 100 : null;
            const roi     = t.roiN ? t.roiSum / t.roiN : null;
            return (
              <div key={tier} className="rounded-lg border border-border/60 p-3 space-y-1 bg-card/40">
                <p className={cn("text-xs font-bold capitalize", TIER_COLOR[tier])}>
                  {tier}
                </p>
                <p className="text-lg font-mono font-bold text-foreground">{t.parlays}</p>
                <p className="text-[10px] text-muted-foreground">parlays built</p>
                {t.resolved > 0 && (
                  <div className="pt-1 space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <SampleBadge n={t.resolved} />
                      <span className="text-[10px] text-muted-foreground">resolved</span>
                    </div>
                    <p className={cn("text-xs font-semibold tabular-nums", hitColor(hitRate))}>
                      {pct(hitRate)} hit
                    </p>
                    <p className={cn("text-xs font-semibold tabular-nums", roiColor(roi))}>
                      {pct(roi)} ROI
                    </p>
                  </div>
                )}
                {!t.resolved && (
                  <p className="text-[10px] text-muted-foreground/60">no outcomes yet</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

// ── Signal activation monitor ────────────────────────────────────────────────

/**
 * Lightweight observation panel for the first activation wave.
 *
 * No new RPCs — composes from:
 *   useResolutionCompleteness  → resolved counts + completeness per sport
 *   useEarlyValueImpactBySport → EV label validation state
 *   getAllCalibrationEntries   → localStorage cal adjustment map (sync read)
 *   readAlphaAdjustmentLog     → localStorage alpha movement log (sync read)
 *
 * Shows: milestone activation status + per-sport signal state table.
 * Read-only display only. No thresholds changed here.
 */
function SignalActivationPanel() {
  const { data: compRaw = [], isLoading: compLoading } = useResolutionCompleteness(90);
  const { data: evRaw  = [], isLoading: evLoading   } = useEarlyValueImpactBySport(90);

  const compRows = compRaw as ResolutionCompletenessRow[];
  const evRows   = evRaw   as EarlyValueImpactBySportRow[];

  // Sync reads from localStorage — loaded once on mount
  const [calEntries, setCalEntries] = useState<ReturnType<typeof getAllCalibrationEntries>>({});
  const [alphaLogs, setAlphaLogs]   = useState<Record<string, AlphaAdjustmentLog | null>>({});

  useEffect(() => {
    setCalEntries(getAllCalibrationEntries());
    const logs: Record<string, AlphaAdjustmentLog | null> = {};
    for (const { key } of ALPHA_SPORTS) logs[key] = readAlphaAdjustmentLog(key);
    setAlphaLogs(logs);
  }, []);

  // ── Milestone derivations ───────────────────────────────────────────────────

  // First sport(s) to cross 50 resolved outcomes
  const at50 = compRows.filter((r) => Number(r.resolved_count) >= 50)
    .sort((a, b) => Number(b.resolved_count) - Number(a.resolved_count));

  // First alpha log showing a direction other than "unchanged"
  const alphaMovedEntries = Object.entries(alphaLogs)
    .filter(([, log]) => log && log.direction !== "unchanged") as [string, AlphaAdjustmentLog][];

  // Any non-zero calibration adjustment (absolute value > floating-point noise)
  const nonZeroCal = Object.entries(calEntries)
    .filter(([, e]) => Math.abs(e.adjustment) > 0.001)
    .sort((a, b) => Math.abs(b[1].adjustment) - Math.abs(a[1].adjustment));

  // EV boost active: sport has ✓ validation (all 3 labels ≥5 resolved, LINE VALUE
  // descending, all > none baseline) — mirrors buildEarlyValueBoostMap logic
  const evActiveSports: string[] = [];
  const evSports = [...new Set(evRows.map((r) => r.sport))];
  for (const sport of evSports) {
    const lv   = evRows.find((r) => r.sport === sport && r.label === "LINE VALUE");
    const oe   = evRows.find((r) => r.sport === sport && r.label === "OPENING EDGE");
    const ev   = evRows.find((r) => r.sport === sport && r.label === "EARLY VALUE");
    const none = evRows.find((r) => r.sport === sport && r.label === "none");
    const hasFive = (r: EarlyValueImpactBySportRow | undefined) =>
      r != null && Number(r.resolved_count) >= 5;
    if (!hasFive(lv) || !hasFive(oe) || !hasFive(ev) || !hasFive(none)) continue;
    const lvH = lv!.hit_rate_pct ?? 0;
    const oeH = oe!.hit_rate_pct ?? 0;
    const evH = ev!.hit_rate_pct ?? 0;
    const nH  = none!.hit_rate_pct ?? 0;
    if (lvH >= oeH && oeH >= evH && lvH > nH && oeH > nH && evH > nH) {
      evActiveSports.push(sport);
    }
  }

  // Sports below 85% resolution completeness
  const belowAlert = compRows.filter((r) => Number(r.resolution_pct) < 85);

  const isLoading = compLoading || evLoading;

  // ── Milestone row helper ───────────────────────────────────────────────────

  function Milestone({
    label,
    active,
    detail,
  }: {
    label: string;
    active: boolean;
    detail?: string;
  }) {
    return (
      <div className="flex items-start gap-2 text-[11px]">
        <span className={cn("font-bold shrink-0 mt-px", active ? "text-emerald-500" : "text-muted-foreground/30")}>
          {active ? "✓" : "○"}
        </span>
        <div className="min-w-0">
          <span className={active ? "text-foreground" : "text-muted-foreground/50"}>{label}</span>
          {detail && (
            <span className="ml-1.5 text-[10px] text-muted-foreground/60">{detail}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <SectionCard
      title="Signal activation status"
      subtitle="First-wave observation — read-only. No thresholds adjusted here."
    >
      {isLoading ? (
        <div className="space-y-1.5">{[0, 1, 2, 3, 4].map((i) => <LoadingRow key={i} />)}</div>
      ) : (
        <div className="space-y-4">

          {/* Milestone checklist */}
          <div className="space-y-1.5">
            <p className="text-[9px] font-semibold tracking-wider text-muted-foreground">MILESTONES</p>
            <Milestone
              label="First sport to 50 resolved outcomes"
              active={at50.length > 0}
              detail={at50.length > 0
                ? at50.map((r) => `${r.sport} (${r.resolved_count})`).join(", ")
                : "waiting — recalibration threshold not yet reached"}
            />
            <Milestone
              label="First alpha movement above sport minimum"
              active={alphaMovedEntries.length > 0}
              detail={alphaMovedEntries.length > 0
                ? alphaMovedEntries
                    .map(([s, l]) => `${s.toUpperCase()} ${l.direction === "up" ? "↑" : "↓"} ${l.alpha_before.toFixed(3)}→${l.alpha_after.toFixed(3)}`)
                    .join(", ")
                : "all sports at minimum — no contribution delta >2pp yet"}
            />
            <Milestone
              label="First non-zero confidence calibration adjustment"
              active={nonZeroCal.length > 0}
              detail={nonZeroCal.length > 0
                ? nonZeroCal.slice(0, 3).map(([k, e]) => `${k} (${e.adjustment > 0 ? "+" : ""}${e.adjustment.toFixed(3)})`).join(", ")
                : "all adjustments at 0.000 — waiting for ≥40 resolved per market"}
            />
            <Milestone
              label="First validated early-value boost by sport"
              active={evActiveSports.length > 0}
              detail={evActiveSports.length > 0
                ? evActiveSports.join(", ")
                : "no sport has full ✓ validation across all 3 EV labels yet"}
            />
            <Milestone
              label="Resolution completeness ≥85% across all sports"
              active={belowAlert.length === 0 && compRows.length > 0}
              detail={belowAlert.length > 0
                ? `${belowAlert.map((r) => `${r.sport} ${Number(r.resolution_pct).toFixed(0)}%`).join(", ")} — calibration paused for these`
                : compRows.length === 0 ? "no data yet" : "all clear"}
            />
          </div>

          {/* Per-sport state table */}
          {compRows.length > 0 && (
            <div className="space-y-1.5 border-t border-border/40 pt-3">
              <p className="text-[9px] font-semibold tracking-wider text-muted-foreground">PER-SPORT SIGNAL STATE</p>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px] tabular-nums">
                  <thead>
                    <tr className="text-muted-foreground/60 border-b border-border/40">
                      <th className="text-left py-1 pr-3 font-medium">Sport</th>
                      <th className="text-right py-1 pr-2 font-medium">Resolved</th>
                      <th className="text-right py-1 pr-2 font-medium">Alpha</th>
                      <th className="text-right py-1 pr-2 font-medium">Cal adj</th>
                      <th className="text-right py-1 pr-2 font-medium">EV</th>
                      <th className="text-right py-1 font-medium">Res%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ALPHA_SPORTS.map(({ key, label }) => {
                      const comp   = compRows.find((r) => r.sport.toLowerCase() === key);
                      const resolved = comp ? Number(comp.resolved_count) : 0;
                      const resPct   = comp ? Number(comp.resolution_pct) : null;
                      const resLow   = resPct !== null && resPct < 85;

                      // Alpha
                      const log   = alphaLogs[key];
                      const range = ALPHA_RANGES[key];
                      const alphaMoved = log && log.direction !== "unchanged";

                      // Calibration: any non-zero entry for this sport
                      const sportCalEntries = Object.entries(calEntries)
                        .filter(([k, e]) => k.startsWith(key.toUpperCase() + ":") && Math.abs(e.adjustment) > 0.001);
                      const hasCalAdj = sportCalEntries.length > 0;
                      const maxCalAdj = hasCalAdj
                        ? sportCalEntries.reduce((m, [, e]) => Math.abs(e.adjustment) > Math.abs(m) ? e.adjustment : m, 0)
                        : 0;

                      // EV boost
                      const evActive = evActiveSports.includes(key.toUpperCase()) || evActiveSports.includes(key);

                      return (
                        <tr key={key} className="border-b border-border/30 last:border-0">
                          <td className="py-1.5 pr-3 font-semibold text-foreground">{label}</td>
                          <td className={cn("text-right py-1.5 pr-2 font-semibold", resolved >= 50 ? "text-emerald-500" : "text-muted-foreground")}>
                            {resolved > 0 ? resolved : "—"}
                            {resolved >= 50 && <span className="ml-0.5 text-[8px]">✓</span>}
                          </td>
                          <td className={cn("text-right py-1.5 pr-2", alphaMoved ? "text-emerald-500 font-semibold" : "text-muted-foreground/40")}>
                            {alphaMoved
                              ? `${log!.direction === "up" ? "↑" : "↓"} ${log!.alpha_after.toFixed(3)}`
                              : range ? `${range.min.toFixed(2)} min` : "—"}
                          </td>
                          <td className={cn("text-right py-1.5 pr-2", hasCalAdj ? (maxCalAdj > 0 ? "text-emerald-500" : "text-rose-400") : "text-muted-foreground/40")}>
                            {hasCalAdj
                              ? `${maxCalAdj > 0 ? "+" : ""}${maxCalAdj.toFixed(3)}`
                              : "0.000"}
                          </td>
                          <td className={cn("text-right py-1.5 pr-2", evActive ? "text-emerald-500 font-semibold" : "text-muted-foreground/40")}>
                            {evActive ? "✓ active" : "—"}
                          </td>
                          <td className={cn("text-right py-1.5", resLow ? "text-amber-500 font-semibold" : resPct !== null ? "text-emerald-500/70" : "text-muted-foreground/30")}>
                            {resPct !== null ? `${Number(resPct).toFixed(0)}%` : "—"}
                            {resLow && <span className="ml-0.5 text-[8px]">⚠</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[9px] text-muted-foreground/40">
                Resolved ✓ = crossed 50 threshold · Alpha = first logged movement from minimum ·
                Cal adj = largest stored adjustment for this sport · EV = full ✓ validation active ·
                Res% amber when &lt;85% (calibration paused)
              </p>
            </div>
          )}

          {compRows.length === 0 && (
            <EmptyState label="No resolved predictions yet — check back after first game slate resolves" />
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ── Panel 7: Alpha status ─────────────────────────────────────────────────────

interface AlphaRow {
  sport:        string;
  label:        string;
  alpha:        number;
  sampleSize:   number;
  learned:      boolean;
  min:          number;
  max:          number;
  step:         number;
  calibratedAt: string | null;
  lastAdj:      AlphaAdjustmentLog | null;
}

const ALPHA_SPORTS: Array<{ key: string; label: string }> = [
  { key: "nba",    label: "NBA" },
  { key: "nfl",    label: "NFL" },
  { key: "mlb",    label: "MLB" },
  { key: "boxing", label: "Boxing" },
  { key: "mma",    label: "MMA / UFC" },
];

function alphaStatusDir(alpha: number, min: number, max: number): string {
  const mid = (min + max) / 2;
  if (alpha >= mid)              return "↑";
  if (alpha <= min + 0.005)      return "→";
  return "→";
}

function alphaStatusColor(alpha: number, min: number, max: number, learned: boolean): string {
  if (!learned) return "text-muted-foreground";
  const mid = (min + max) / 2;
  if (alpha >= mid) return "text-emerald-500";
  return "text-yellow-500";
}

function alphaBarWidth(alpha: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.round(Math.min(100, Math.max(0, ((alpha - min) / (max - min)) * 100)));
}

function AlphaStatusPanel() {
  const [rows, setRows] = useState<AlphaRow[]>([]);

  useEffect(() => {
    const loaded: AlphaRow[] = ALPHA_SPORTS.map(({ key, label }) => {
      const w     = getAdaptiveWeightsSync(key as Parameters<typeof getAdaptiveWeightsSync>[0], "hit_probability", "pregame");
      const range = getAlphaRange(key);
      return {
        sport:        key,
        label,
        alpha:        computeAlpha(w.sample_size),
        sampleSize:   w.sample_size,
        learned:      w.learned,
        min:          range.min,
        max:          range.max,
        step:         range.step,
        calibratedAt: w.calibrated_at,
        lastAdj:      readAlphaAdjustmentLog(key),
      };
    });
    setRows(loaded);
  }, []);

  return (
    <SectionCard
      title="Alpha status — ML trust by sport"
      subtitle="Current blend factor. Grows with resolved outcomes; bounded per-sport to prevent noise overfit."
    >
      {!rows.length ? (
        <div className="space-y-1.5">
          {[0, 1, 2, 3, 4].map((i) => <LoadingRow key={i} />)}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground/70">
                  <th className="text-left py-1 pr-3 font-medium w-24">Sport</th>
                  <th className="text-right py-1 pr-3 font-medium">Alpha</th>
                  <th className="py-1 pr-3 font-medium">
                    <span className="sr-only">Bar</span>
                  </th>
                  <th className="text-right py-1 pr-3 font-medium">Range</th>
                  <th className="text-right py-1 pr-3 font-medium">Samples</th>
                  <th className="text-right py-1 pr-3 font-medium">Status</th>
                  <th className="text-right py-1 font-medium">Last adj</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const barW    = alphaBarWidth(r.alpha, r.min, r.max);
                  const dirChar = alphaStatusDir(r.alpha, r.min, r.max);
                  const textCls = alphaStatusColor(r.alpha, r.min, r.max, r.learned);
                  const adj     = r.lastAdj;
                  const adjAge  = adj
                    ? formatDistanceToNow(new Date(adj.timestamp), { addSuffix: true })
                    : null;
                  const adjDirChar =
                    adj?.direction === "up"   ? "↑" :
                    adj?.direction === "down" ? "↓" : "→";
                  const adjCls =
                    adj?.direction === "up"   ? "text-emerald-500" :
                    adj?.direction === "down" ? "text-red-400" :
                                               "text-muted-foreground/60";
                  return (
                    <tr key={r.sport} className="border-t border-border/40">
                      <td className="py-2 pr-3 font-semibold text-foreground">{r.label}</td>
                      <td className={cn("text-right py-2 pr-3 tabular-nums font-mono font-semibold", textCls)}>
                        {r.alpha.toFixed(3)} {dirChar}
                      </td>
                      <td className="py-2 pr-3 min-w-[60px]">
                        <div className="h-1.5 w-16 rounded-full bg-muted/40 overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all",
                              r.learned ? "bg-emerald-500/70" : "bg-muted-foreground/30"
                            )}
                            style={{ width: `${barW}%` }}
                          />
                        </div>
                      </td>
                      <td className="text-right py-2 pr-3 tabular-nums text-muted-foreground font-mono">
                        {r.min}–{r.max}
                      </td>
                      <td className="text-right py-2 pr-3">
                        <SampleBadge n={r.sampleSize} />
                      </td>
                      <td className="text-right py-2 pr-3">
                        {r.learned ? (
                          <span className="text-emerald-500 text-[10px] font-semibold">active</span>
                        ) : r.sampleSize >= 10 ? (
                          <span className="text-yellow-500 text-[10px] font-semibold">learning</span>
                        ) : (
                          <span className="text-muted-foreground/60 text-[10px]">seeding</span>
                        )}
                      </td>
                      <td className="text-right py-2">
                        {adj ? (
                          <div className="flex flex-col items-end gap-0.5">
                            <span className={cn("text-[10px] font-semibold tabular-nums", adjCls)}>
                              {adjDirChar}{" "}
                              {adj.direction !== "unchanged"
                                ? `${adj.diff_pp > 0 ? "+" : ""}${adj.diff_pp.toFixed(1)}pp`
                                : "no change"}
                            </span>
                            <span className="text-[9px] text-muted-foreground/50">{adjAge}</span>
                          </div>
                        ) : (
                          <span className="text-[10px] text-muted-foreground/40">never run</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="text-[10px] text-muted-foreground/60 space-y-1 border-t border-border/30 pt-2">
            <p>
              <span className="font-semibold text-muted-foreground">Active</span> — ≥25 resolved · ML
              meaningfully blends into rules engine output.
            </p>
            <p>
              <span className="font-semibold text-muted-foreground">Learning</span> — 10–24 resolved · ML
              initialising, near-zero effect on predictions.
            </p>
            <p>
              <span className="font-semibold text-muted-foreground">Seeding</span> — &lt;10 resolved · alpha
              held at minimum, awaiting data.
            </p>
            <p className="pt-0.5">
              Alpha auto-adjusts ±{ALPHA_RANGES.nba?.step ?? 0.02} per sport when ml_blended
              outperforms/underperforms rules by &gt;2pp over the last 30 days.
              The &quot;Last adj&quot; column shows ↑/↓ when adjusted, → when checked but unchanged.
              &quot;never run&quot; means the feedback loop hasn&apos;t been triggered for that sport yet.
              Combat sports adjust more slowly due to smaller sample pools.
            </p>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ── Panel 7: Calibration impact ───────────────────────────────────────────────

const CAL_BUCKET_LABEL: Record<string, string> = {
  boosted:   "Boosted  (+0.02)",
  neutral:   "Neutral  (±0.02)",
  penalized: "Penalized (−0.02)",
  no_data:   "No data  (null)",
};

const CAL_BUCKET_COLOR: Record<string, string> = {
  boosted:   "text-emerald-500",
  neutral:   "text-muted-foreground",
  penalized: "text-rose-500",
  no_data:   "text-muted-foreground/40",
};

// ── Calibration impact by sport sub-section ───────────────────────────────────

const COMBAT_SPORTS = new Set(["BOXING", "MMA", "UFC"]);

/**
 * Transposed table: rows = sports, columns = Boosted | Neutral | Penalized | No-data%
 *
 * Key questions answered at a glance:
 *   - Where is the signal mature? (low no_data_pct, high resolved counts)
 *   - Where is the direction right? (boosted > neutral, penalized < neutral)
 *   - Combat sports — are they mostly no-data as expected?
 */
function CalibrationImpactBySportSection({
  rows,
  loading,
}: {
  rows: CalibrationImpactBySportRow[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-1.5 pt-3 border-t border-border/50">
        <p className="text-[9px] font-semibold tracking-wider text-muted-foreground">BY SPORT</p>
        <LoadingRow />
      </div>
    );
  }
  if (!rows.length) return null;

  // Group by sport
  const sports = [...new Set(rows.map((r) => r.sport))].sort();

  function sportBucket(sport: string, bucket: string): CalibrationImpactBySportRow | undefined {
    return rows.find((r) => r.sport === sport && r.adj_bucket === bucket);
  }

  function hitCell(row: CalibrationImpactBySportRow | undefined) {
    if (!row) return <td className="text-right py-1.5 pr-2 text-muted-foreground/25">—</td>;
    const { hit_rate_pct, resolved_count } = row;
    if (resolved_count < 5) {
      return (
        <td className="text-right py-1.5 pr-2 text-muted-foreground/40">
          —<span className="text-[8px] ml-0.5">/{resolved_count}</span>
        </td>
      );
    }
    return (
      <td className={cn("text-right py-1.5 pr-2 font-semibold", hitColor(hit_rate_pct))}>
        {pct(hit_rate_pct)}
        <span className="ml-0.5 text-[8px] text-muted-foreground/50">/{resolved_count}</span>
      </td>
    );
  }

  return (
    <div className="space-y-2 pt-3 border-t border-border/50">
      <div className="flex items-center gap-2">
        <p className="text-[9px] font-semibold tracking-wider text-muted-foreground">BY SPORT</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] tabular-nums">
          <thead>
            <tr className="text-muted-foreground/60 border-b border-border/40">
              <th className="text-left py-1 pr-3 font-medium">Sport</th>
              <th className="text-right py-1 pr-2 font-medium text-emerald-600/70">Boosted</th>
              <th className="text-right py-1 pr-2 font-medium">Neutral</th>
              <th className="text-right py-1 pr-2 font-medium text-rose-500/70">Penalized</th>
              <th className="text-right py-1 font-medium text-muted-foreground/50">No-data</th>
            </tr>
          </thead>
          <tbody>
            {sports.map((sport) => {
              const boostedRow   = sportBucket(sport, "boosted");
              const neutralRow   = sportBucket(sport, "neutral");
              const penalizedRow = sportBucket(sport, "penalized");
              const noDataRow    = sportBucket(sport, "no_data");

              // no_data_pct is the same on every row for a sport
              const noDataPct = (boostedRow ?? neutralRow ?? penalizedRow ?? noDataRow)?.no_data_pct ?? null;
              const isCombat  = COMBAT_SPORTS.has(sport);

              // Direction check: boosted > neutral > penalized?
              const boostedHit   = boostedRow?.hit_rate_pct   ?? null;
              const neutralHit   = neutralRow?.hit_rate_pct   ?? null;
              const penalizedHit = penalizedRow?.hit_rate_pct ?? null;
              const bResolved    = (boostedRow?.resolved_count   ?? 0) >= 5;
              const nResolved    = (neutralRow?.resolved_count   ?? 0) >= 5;
              const pResolved    = (penalizedRow?.resolved_count ?? 0) >= 5;

              let dirIcon: React.ReactNode = null;
              if (bResolved && nResolved && pResolved && boostedHit !== null && neutralHit !== null && penalizedHit !== null) {
                if (boostedHit > neutralHit && neutralHit > penalizedHit)
                  dirIcon = <span className="text-emerald-500 ml-1" title="Signal validated">✓</span>;
                else if (boostedHit > neutralHit)
                  dirIcon = <span className="text-yellow-500 ml-1" title="Partial signal">→</span>;
                else
                  dirIcon = <span className="text-rose-500 ml-1" title="Signal not confirmed">⚠</span>;
              }

              return (
                <tr key={sport} className="border-b border-border/30 last:border-0">
                  <td className={cn("py-1.5 pr-3 font-semibold", isCombat ? "text-muted-foreground/60" : "text-foreground")}>
                    {sport}
                    {dirIcon}
                    {isCombat && noDataPct !== null && noDataPct > 0.7 && (
                      <span className="ml-1 text-[8px] text-muted-foreground/40" title="Combat sport: low calibration coverage expected">
                        ~{Math.round(noDataPct * 100)}% no-data
                      </span>
                    )}
                  </td>
                  {hitCell(boostedRow)}
                  {hitCell(neutralRow)}
                  {hitCell(penalizedRow)}
                  <td className="text-right py-1.5 text-muted-foreground/50">
                    {noDataPct !== null ? (
                      <span className={noDataPct > 0.6 ? "text-amber-500/70" : "text-muted-foreground/40"}>
                        {Math.round(noDataPct * 100)}%
                        {noDataRow && (
                          <span className="ml-0.5 text-[8px]">/{noDataRow.leg_count}</span>
                        )}
                      </span>
                    ) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[9px] text-muted-foreground/40">
        Hit%/n shown when ≥5 resolved. ✓ = boosted&gt;neutral&gt;penalized · → = partial · ⚠ = not confirmed
        · No-data% amber when &gt;60%
      </p>
    </div>
  );
}

function CalibrationImpactPanel({ days }: { days: number }) {
  const { data = [], isLoading }          = useCalibrationImpact(days);
  const { data: bySport = [], isLoading: sportLoading } = useCalibrationImpactBySport(days);

  const totalLegs = data.reduce((s, r) => s + r.leg_count, 0);
  const totalResolved = data.reduce((s, r) => s + r.resolved_count, 0);

  // Signal validity: boosted hit > neutral hit AND penalized hit < neutral hit?
  const boosted   = data.find((r) => r.adj_bucket === "boosted");
  const neutral   = data.find((r) => r.adj_bucket === "neutral");
  const penalized = data.find((r) => r.adj_bucket === "penalized");

  const signalValid =
    boosted?.hit_rate_pct != null &&
    neutral?.hit_rate_pct != null &&
    penalized?.hit_rate_pct != null &&
    boosted.hit_rate_pct > neutral.hit_rate_pct &&
    penalized.hit_rate_pct < neutral.hit_rate_pct;

  const signalPartial =
    !signalValid &&
    boosted?.hit_rate_pct != null &&
    neutral?.hit_rate_pct != null &&
    boosted.hit_rate_pct > neutral.hit_rate_pct;

  function validationNote() {
    if (totalResolved < 10) return null;
    if (signalValid)   return <span className="text-emerald-500 font-semibold">✓ signal validated</span>;
    if (signalPartial) return <span className="text-yellow-500 font-semibold">→ partial signal</span>;
    return <span className="text-rose-500 font-semibold">⚠ signal not confirmed</span>;
  }

  return (
    <SectionCard
      title="Calibration adjustment impact"
      subtitle="Are boosted legs winning more than neutral or penalized legs?"
      sampleSize={totalResolved > 0 ? totalResolved : undefined}
    >
      {isLoading ? (
        <div className="space-y-2"><LoadingRow /><LoadingRow /><LoadingRow /></div>
      ) : !data.length ? (
        <EmptyState label="No parlay build legs logged yet" />
      ) : (
        <div className="space-y-3">
          {/* Validation verdict */}
          {totalResolved >= 10 && (
            <div className="text-[10px] flex items-center gap-1.5">
              {validationNote()}
              <span className="text-muted-foreground/50">
                ({totalResolved} resolved legs across {totalLegs} built)
              </span>
            </div>
          )}

          {/* Bucket table */}
          <table className="w-full text-[10px] tabular-nums">
            <thead>
              <tr className="text-muted-foreground/60 border-b border-border/40">
                <th className="text-left py-1 pr-3 font-medium">Bucket</th>
                <th className="text-right py-1 pr-2 font-medium">Legs</th>
                <th className="text-right py-1 pr-2 font-medium">Parlays</th>
                <th className="text-right py-1 pr-2 font-medium">Hit%</th>
                <th className="text-right py-1 font-medium">ROI%</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => {
                const legPct = totalLegs > 0 ? (r.leg_count / totalLegs * 100).toFixed(0) : "—";
                return (
                  <tr key={r.adj_bucket} className="border-b border-border/30 last:border-0">
                    <td className={cn("py-1.5 pr-3 font-medium", CAL_BUCKET_COLOR[r.adj_bucket])}>
                      {CAL_BUCKET_LABEL[r.adj_bucket] ?? r.adj_bucket}
                    </td>
                    <td className="text-right py-1.5 pr-2">
                      <span className="font-semibold">{r.leg_count}</span>
                      <span className="ml-0.5 text-[8px] text-muted-foreground/50">
                        {legPct}%
                      </span>
                    </td>
                    <td className="text-right py-1.5 pr-2 text-muted-foreground">
                      {r.parlay_count}
                    </td>
                    <td className="text-right py-1.5 pr-2">
                      {r.resolved_count < 5 ? (
                        <span className="text-muted-foreground/40">
                          —<span className="text-[8px] ml-0.5">/{r.resolved_count}</span>
                        </span>
                      ) : (
                        <span className={hitColor(r.hit_rate_pct)}>
                          {pct(r.hit_rate_pct)}
                          <span className="ml-0.5 text-[8px] text-muted-foreground/50">
                            /{r.resolved_count}
                          </span>
                        </span>
                      )}
                    </td>
                    <td className={cn("text-right py-1.5 font-semibold", roiColor(r.roi_pct))}>
                      {r.resolved_count < 5 ? "—" : pct(r.roi_pct)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Distribution bar */}
          {totalLegs > 0 && (
            <div className="space-y-1">
              <p className="text-[9px] text-muted-foreground/50 font-medium tracking-wider">
                LEG DISTRIBUTION
              </p>
              <div className="flex h-2 rounded-full overflow-hidden gap-px">
                {(["boosted", "neutral", "penalized", "no_data"] as const).map((bucket) => {
                  const row = data.find((r) => r.adj_bucket === bucket);
                  const w = row ? (row.leg_count / totalLegs * 100) : 0;
                  if (w < 1) return null;
                  const bg =
                    bucket === "boosted"   ? "bg-emerald-500/60" :
                    bucket === "penalized" ? "bg-rose-500/60" :
                    bucket === "no_data"   ? "bg-muted/40" :
                                             "bg-muted-foreground/30";
                  return (
                    <div
                      key={bucket}
                      className={cn("transition-all", bg)}
                      style={{ width: `${w}%` }}
                      title={`${CAL_BUCKET_LABEL[bucket]}: ${row?.leg_count} legs (${w.toFixed(0)}%)`}
                    />
                  );
                })}
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {data.map((r) => (
                  <span key={r.adj_bucket} className={cn("text-[8px]", CAL_BUCKET_COLOR[r.adj_bucket])}>
                    {r.adj_bucket}: {(r.leg_count / totalLegs * 100).toFixed(0)}%
                  </span>
                ))}
              </div>
            </div>
          )}

          {totalResolved < 10 && (
            <p className="text-[9px] text-muted-foreground/50">
              Needs ≥10 resolved legs to validate signal. Currently {totalResolved} resolved.
            </p>
          )}
        </div>
      )}

      {/* By-sport breakdown — separate section, always shown when data exists */}
      <CalibrationImpactBySportSection rows={bySport} loading={sportLoading} />
    </SectionCard>
  );
}

// ── Panel 8: Early value label impact ────────────────────────────────────────

const EV_LABEL_COLOR: Record<string, string> = {
  "LINE VALUE":   "text-blue-500",
  "OPENING EDGE": "text-violet-500",
  "EARLY VALUE":  "text-primary",
  "none":         "text-muted-foreground/50",
};

const EV_LABEL_DESC: Record<string, string> = {
  "LINE VALUE":   "|Δline| ≥ 0.5pp — active line movement",
  "OPENING EDGE": "edge ≥ 10% — strong model vs market gap",
  "EARLY VALUE":  "edge ≥ 6% + stability ≥ 0.60",
  "none":         "no early-value signal at build time",
};

const EV_LABEL_ORDER = ["LINE VALUE", "OPENING EDGE", "EARLY VALUE", "none"] as const;

// ── Early value by sport sub-section ─────────────────────────────────────────

/**
 * Transposed table: rows = sports, columns = LINE VALUE | OPENING EDGE | EARLY VALUE | No-label%
 *
 * Key questions at a glance:
 *   - Which sports have validated LINE VALUE signal? (often NBA first)
 *   - Does OPENING EDGE hold up in MLB better than other labels?
 *   - Combat sports: are they still mostly no-label as expected?
 */
function EarlyValueImpactBySportSection({
  rows,
  loading,
}: {
  rows: EarlyValueImpactBySportRow[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-1.5 pt-3 border-t border-border/50">
        <p className="text-[9px] font-semibold tracking-wider text-muted-foreground">BY SPORT</p>
        <LoadingRow />
      </div>
    );
  }
  if (!rows.length) return null;

  const sports = [...new Set(rows.map((r) => r.sport))].sort();

  function sportLabel(sport: string, label: string): EarlyValueImpactBySportRow | undefined {
    return rows.find((r) => r.sport === sport && r.label === label);
  }

  function hitCell(row: EarlyValueImpactBySportRow | undefined) {
    if (!row) return <td className="text-right py-1.5 pr-2 text-muted-foreground/25">—</td>;
    const { hit_rate_pct, resolved_count } = row;
    if (Number(resolved_count) < 5) {
      return (
        <td className="text-right py-1.5 pr-2 text-muted-foreground/40">
          —<span className="text-[8px] ml-0.5">/{resolved_count}</span>
        </td>
      );
    }
    return (
      <td className={cn("text-right py-1.5 pr-2 font-semibold", hitColor(hit_rate_pct))}>
        {pct(hit_rate_pct)}
        <span className="ml-0.5 text-[8px] text-muted-foreground/50">/{resolved_count}</span>
      </td>
    );
  }

  return (
    <div className="space-y-2 pt-3 border-t border-border/50">
      <p className="text-[9px] font-semibold tracking-wider text-muted-foreground">BY SPORT</p>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] tabular-nums">
          <thead>
            <tr className="text-muted-foreground/60 border-b border-border/40">
              <th className="text-left py-1 pr-3 font-medium">Sport</th>
              <th className="text-right py-1 pr-2 font-medium text-blue-500/70">Line Value</th>
              <th className="text-right py-1 pr-2 font-medium text-violet-500/70">Opening Edge</th>
              <th className="text-right py-1 pr-2 font-medium text-primary/70">Early Value</th>
              <th className="text-right py-1 font-medium text-muted-foreground/50">No-label</th>
            </tr>
          </thead>
          <tbody>
            {sports.map((sport) => {
              const lvRow   = sportLabel(sport, "LINE VALUE");
              const oeRow   = sportLabel(sport, "OPENING EDGE");
              const evRow   = sportLabel(sport, "EARLY VALUE");
              const noneRow = sportLabel(sport, "none");

              const noLabelPct = (lvRow ?? oeRow ?? evRow ?? noneRow)?.no_label_pct ?? null;
              const isCombat   = COMBAT_SPORTS.has(sport);

              // Per-sport validation: any labeled bucket outperforms none?
              const lvHit   = Number(lvRow?.resolved_count ?? 0) >= 5  ? lvRow?.hit_rate_pct  ?? null : null;
              const oeHit   = Number(oeRow?.resolved_count ?? 0) >= 5  ? oeRow?.hit_rate_pct  ?? null : null;
              const evHit   = Number(evRow?.resolved_count ?? 0) >= 5  ? evRow?.hit_rate_pct  ?? null : null;
              const noneHit = Number(noneRow?.resolved_count ?? 0) >= 5 ? noneRow?.hit_rate_pct ?? null : null;

              const labeledHits = [lvHit, oeHit, evHit].filter((h): h is number => h !== null);
              const bestLabeled = labeledHits.length ? Math.max(...labeledHits) : null;
              const allLabeled  = [lvHit, oeHit, evHit];
              const hasAllThree = allLabeled.every((h) => h !== null);

              let dirIcon: React.ReactNode = null;
              if (labeledHits.length >= 2 && noneHit !== null) {
                const allAboveNone = labeledHits.every((h) => h > noneHit);
                const descending   = hasAllThree
                  ? (lvHit! >= oeHit! && oeHit! >= evHit!)
                  : labeledHits[0] >= labeledHits[labeledHits.length - 1];
                if (allAboveNone && descending && hasAllThree)
                  dirIcon = <span className="text-emerald-500 ml-1" title="Signal validated">✓</span>;
                else if (bestLabeled !== null && noneHit !== null && bestLabeled > noneHit)
                  dirIcon = <span className="text-yellow-500 ml-1" title="Partial signal">→</span>;
                else
                  dirIcon = <span className="text-rose-500 ml-1" title="Signal not confirmed">⚠</span>;
              }

              return (
                <tr key={sport} className="border-b border-border/30 last:border-0">
                  <td className={cn("py-1.5 pr-3 font-semibold", isCombat ? "text-muted-foreground/60" : "text-foreground")}>
                    {sport}
                    {dirIcon}
                    {isCombat && noLabelPct !== null && noLabelPct > 0.7 && (
                      <span className="ml-1 text-[8px] text-muted-foreground/40" title="Combat sport: low early-value label coverage expected">
                        ~{Math.round(noLabelPct * 100)}% no-label
                      </span>
                    )}
                  </td>
                  {hitCell(lvRow)}
                  {hitCell(oeRow)}
                  {hitCell(evRow)}
                  <td className="text-right py-1.5 text-muted-foreground/50">
                    {noLabelPct !== null ? (
                      <span className={noLabelPct > 0.6 ? "text-amber-500/70" : "text-muted-foreground/40"}>
                        {Math.round(noLabelPct * 100)}%
                        {noneRow && (
                          <span className="ml-0.5 text-[8px]">/{noneRow.leg_count}</span>
                        )}
                      </span>
                    ) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[9px] text-muted-foreground/40">
        Hit%/n shown when ≥5 resolved per bucket.
        ✓ = all three labels validated in order · → = partial · ⚠ = not confirmed
        · No-label% amber when &gt;60%
      </p>
    </div>
  );
}

function EarlyValueImpactPanel({ days }: { days: number }) {
  const { data = [], isLoading }                       = useEarlyValueImpact(days);
  const { data: bySport = [], isLoading: sportLoading } = useEarlyValueImpactBySport(days);
  const rows = data as EarlyValueImpactRow[];

  const totalLegs     = rows.reduce((s, r) => s + Number(r.leg_count), 0);
  const totalResolved = rows.reduce((s, r) => s + Number(r.resolved_count), 0);

  // Signal validation: LINE VALUE > OPENING EDGE > EARLY VALUE > none (where each has ≥5 resolved)
  function rowByLabel(label: string) { return rows.find((r) => r.label === label); }
  const lv  = rowByLabel("LINE VALUE");
  const oe  = rowByLabel("OPENING EDGE");
  const ev  = rowByLabel("EARLY VALUE");
  const none = rowByLabel("none");

  const hasEnough = (r: EarlyValueImpactRow | undefined) =>
    r != null && Number(r.resolved_count) >= 5;

  // Best-effort ordering check on whatever buckets have ≥5 resolved
  const labeledRows = [lv, oe, ev].filter((r): r is EarlyValueImpactRow => hasEnough(r));
  const noneRow = hasEnough(none) ? none : undefined;

  let signalVerdict: "validated" | "partial" | "unconfirmed" | null = null;
  if (labeledRows.length >= 2) {
    // All labeled > none, and descending among labeled
    const labeledHits = labeledRows.map((r) => r.hit_rate_pct ?? 0);
    const allDescending = labeledHits.every((h, i) => i === 0 || h <= labeledHits[i - 1]);
    const allAboveNone  = noneRow
      ? labeledHits.every((h) => h > (noneRow.hit_rate_pct ?? 0))
      : true;

    if (allDescending && allAboveNone && labeledRows.length === 3) signalVerdict = "validated";
    else if (labeledRows.length >= 2 && labeledHits[0] > labeledHits[labeledHits.length - 1]) signalVerdict = "partial";
    else signalVerdict = "unconfirmed";
  } else if (totalResolved >= 10) {
    signalVerdict = "unconfirmed";
  }

  return (
    <SectionCard
      title="Early value label impact"
      subtitle="Do LINE VALUE / OPENING EDGE / EARLY VALUE legs outperform unlabeled legs?"
      sampleSize={totalResolved > 0 ? totalResolved : undefined}
    >
      {isLoading ? (
        <div className="space-y-2"><LoadingRow /><LoadingRow /><LoadingRow /></div>
      ) : !rows.length ? (
        <EmptyState label="No parlay build legs logged yet. Auto-build some parlays to populate." />
      ) : (
        <div className="space-y-3">

          {/* Signal verdict */}
          {signalVerdict && (
            <div className="text-[10px] flex items-center gap-1.5">
              {signalVerdict === "validated"   && <span className="text-emerald-500 font-semibold">✓ signal validated</span>}
              {signalVerdict === "partial"     && <span className="text-yellow-500 font-semibold">→ partial signal</span>}
              {signalVerdict === "unconfirmed" && <span className="text-rose-500 font-semibold">⚠ signal not confirmed</span>}
              <span className="text-muted-foreground/50">
                ({totalResolved} resolved legs across {totalLegs} built)
              </span>
            </div>
          )}

          {/* Label table */}
          <div className="overflow-x-auto">
            <table className="w-full text-[10px] tabular-nums">
              <thead>
                <tr className="text-muted-foreground/60 border-b border-border/40">
                  <th className="text-left py-1 pr-3 font-medium">Label</th>
                  <th className="text-right py-1 pr-2 font-medium">Legs</th>
                  <th className="text-right py-1 pr-2 font-medium">Hit%</th>
                  <th className="text-right py-1 pr-2 font-medium">ROI%</th>
                  <th className="text-right py-1 pr-2 font-medium">Avg edge</th>
                  <th className="text-right py-1 font-medium">Avg stab</th>
                </tr>
              </thead>
              <tbody>
                {EV_LABEL_ORDER.map((label) => {
                  const r = rowByLabel(label);
                  if (!r) return null;
                  const legPct = totalLegs > 0
                    ? `${(Number(r.leg_count) / totalLegs * 100).toFixed(0)}%`
                    : "";
                  const thin = Number(r.resolved_count) < 5;
                  return (
                    <tr key={label} className="border-b border-border/30 last:border-0">
                      <td className={cn("py-1.5 pr-3 font-medium whitespace-nowrap", EV_LABEL_COLOR[label])}>
                        {label}
                      </td>
                      <td className="text-right py-1.5 pr-2">
                        <span className="font-semibold">{r.leg_count}</span>
                        {legPct && (
                          <span className="ml-0.5 text-[8px] text-muted-foreground/50">{legPct}</span>
                        )}
                      </td>
                      <td className="text-right py-1.5 pr-2">
                        {thin ? (
                          <span className="text-muted-foreground/40">
                            —<span className="text-[8px] ml-0.5">/{r.resolved_count}</span>
                          </span>
                        ) : (
                          <span className={hitColor(r.hit_rate_pct)}>
                            {pct(r.hit_rate_pct)}
                            <span className="ml-0.5 text-[8px] text-muted-foreground/50">
                              /{r.resolved_count}
                            </span>
                          </span>
                        )}
                      </td>
                      <td className={cn("text-right py-1.5 pr-2 font-semibold", roiColor(r.roi_pct))}>
                        {thin ? "—" : pct(r.roi_pct)}
                      </td>
                      <td className="text-right py-1.5 pr-2 text-muted-foreground font-mono">
                        {r.avg_edge != null
                          ? `${(Number(r.avg_edge) * 100).toFixed(1)}pp`
                          : "—"}
                      </td>
                      <td className="text-right py-1.5 text-muted-foreground font-mono">
                        {r.avg_stability != null ? Number(r.avg_stability).toFixed(2) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Label legend */}
          <div className="space-y-0.5 border-t border-border/30 pt-2">
            {EV_LABEL_ORDER.map((label) => (
              rowByLabel(label) ? (
                <p key={label} className="text-[9px] text-muted-foreground/50">
                  <span className={cn("font-semibold", EV_LABEL_COLOR[label])}>{label}</span>
                  {" — "}
                  {EV_LABEL_DESC[label]}
                </p>
              ) : null
            ))}
          </div>

          {totalResolved < 10 && (
            <p className="text-[9px] text-muted-foreground/50">
              Needs ≥5 resolved per label to show hit rate. Currently {totalResolved} total resolved.
            </p>
          )}
        </div>
      )}

      {/* By-sport breakdown — always shown when data exists */}
      <EarlyValueImpactBySportSection rows={bySport as EarlyValueImpactBySportRow[]} loading={sportLoading} />
    </SectionCard>
  );
}

// ── Panel 9: Resolution completeness ─────────────────────────────────────────

function ResolutionCompletenessPanel({ days }: { days: number }) {
  const { data = [], isLoading } = useResolutionCompleteness(days);
  const rows = data as ResolutionCompletenessRow[];

  const totalSurfaced = rows.reduce((s, r) => s + Number(r.total_surfaced), 0);
  const alertSports = rows.filter((r) => Number(r.resolution_pct) < 85);

  return (
    <SectionCard
      title="Resolution completeness"
      subtitle={`Last ${days} days · per-sport prediction resolution rate (target ≥85%)`}
      sampleSize={isLoading ? undefined : totalSurfaced > 0 ? totalSurfaced : undefined}
    >
      {isLoading ? (
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => <LoadingRow key={i} />)}
        </div>
      ) : !rows.length ? (
        <EmptyState label="No prediction history yet" />
      ) : (
        <div className="space-y-3">
          {alertSports.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <p className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                ⚠ Low resolution rate: {alertSports.map((r) => r.sport).join(", ")} — check resolution pipeline
              </p>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-xs tabular-nums">
              <thead>
                <tr className="text-muted-foreground/60 border-b border-border/40">
                  <th className="text-left py-1 pr-3 font-medium">Sport</th>
                  <th className="text-right py-1 pr-2 font-medium">Surfaced</th>
                  <th className="text-right py-1 pr-2 font-medium">Resolved</th>
                  <th className="text-right py-1 pr-2 font-medium">Pending</th>
                  <th className="text-right py-1 pr-2 font-medium">Res%</th>
                  <th className="text-right py-1 font-medium">Stale</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const resPct  = Number(r.resolution_pct);
                  const isLow   = resPct < 85;
                  const isStale = Number(r.stale_pending) > 0;
                  return (
                    <tr key={r.sport} className="border-b border-border/30 last:border-0">
                      <td className="py-1.5 pr-3 font-semibold text-foreground">{r.sport}</td>
                      <td className="text-right py-1.5 pr-2 text-muted-foreground">{r.total_surfaced}</td>
                      <td className="text-right py-1.5 pr-2 text-emerald-500/80">{r.resolved_count}</td>
                      <td className="text-right py-1.5 pr-2 text-muted-foreground">{r.pending_count}</td>
                      <td className={cn("text-right py-1.5 pr-2 font-semibold", isLow ? "text-amber-500" : "text-emerald-500")}>
                        {resPct.toFixed(0)}%{isLow && <span className="ml-0.5 text-[9px]">⚠</span>}
                      </td>
                      <td className={cn("text-right py-1.5", isStale ? "text-amber-500 font-semibold" : "text-muted-foreground/30")}>
                        {isStale ? r.stale_pending : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[9px] text-muted-foreground/40">
            Stale = pending predictions &gt;3 days with no result logged. Res% amber when &lt;85%.
          </p>
        </div>
      )}
    </SectionCard>
  );
}

// ── Panel 10: How it works ────────────────────────────────────────────────────

function HowItWorksPanel() {
  return (
    <SectionCard title="How this dashboard works">
      <div className="space-y-2 text-xs text-muted-foreground">
        <div>
          <span className="font-semibold text-foreground">Model contribution</span> — compares predictions
          tagged <code className="text-primary">rules</code> vs{" "}
          <code className="text-primary">ml_blended</code>. Requires ≥10 resolved per variant.
          The <SampleBadge n={0} /> badge turns green at n≥50, yellow at n≥20, red below that.
          Don&apos;t trust ROI from red badges.
        </div>
        <div>
          <span className="font-semibold text-foreground">Edge buckets</span> — slices by edge magnitude.
          High edge should convert to higher ROI. If 0–2% beats 5–8%, calibration needs work.
        </div>
        <div>
          <span className="font-semibold text-foreground">Timing × edge</span> — validates whether
          "now" timing signals improve conversion within the same edge band.
        </div>
        <div>
          <span className="font-semibold text-foreground">Stability × edge</span> — checks whether ML
          stability ≥0.70 predicts better conversion. A strong signal validates the stability model.
        </div>
        <div>
          <span className="font-semibold text-foreground">Alpha status</span> — shows current ML trust
          (alpha) per sport. Alpha grows automatically from resolved outcome volume. Combat sports have
          tighter bounds (0.03–0.18/0.20) to prevent noise overfit from small sample windows.
          The feedback loop adjusts alpha ±0.02 when contribution analytics cross the 2pp threshold.
        </div>
        <div>
          <span className="font-semibold text-foreground">Early value label impact</span> — validates
          whether the Tomorrow tab&apos;s{" "}
          <code className="text-blue-500">LINE VALUE</code>,{" "}
          <code className="text-violet-500">OPENING EDGE</code>, and{" "}
          <code className="text-primary">EARLY VALUE</code> labels predict better conversion.
          Signal is validated when hit rate descends LINE VALUE → OPENING EDGE → EARLY VALUE → none.
          Needs ≥5 resolved per label. Avg stability column answers whether the 0.60 stability
          threshold is selecting higher-quality legs. The by-sport breakdown identifies which sports
          have validated signals first — prerequisite for per-sport ranking boosts in Option 1.
        </div>
        <div>
          <span className="font-semibold text-foreground">Calibration impact</span> — validates whether
          the confidence calibration adjustment is actually helping. Legs are bucketed into{" "}
          <code className="text-emerald-500">boosted</code> (&gt;+0.02),{" "}
          <code className="text-muted-foreground">neutral</code> (±0.02), and{" "}
          <code className="text-rose-500">penalized</code> (&lt;−0.02). Signal is validated when boosted
          hit rate &gt; neutral &gt; penalized. Needs ≥10 resolved per bucket to be meaningful.
        </div>
        <div>
          <span className="font-semibold text-foreground">Resolution completeness</span> — tracks what
          fraction of surfaced predictions have been resolved per sport. Target is ≥85%. Amber when below
          that threshold — check the resolution pipeline. Stale count flags predictions pending for
          &gt;3 days with no result logged; high stale counts indicate a data feed gap.
        </div>
        <div className="pt-1 text-[10px] text-muted-foreground/60">
          All data is read-only. Parlay builds are logged automatically on auto-build.
          Calibration adjustments refresh every 25 resolved outcomes per sport.
        </div>
      </div>
    </SectionCard>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const DAY_OPTIONS = [7, 30, 90] as const;

export function ParlayPerformanceDashboard() {
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>(30);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-display font-bold text-base text-foreground">
            Parlay performance &amp; model analytics
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            ML contribution tracking, edge bucket analysis, and parlay build history
          </p>
        </div>
        <div className="flex items-center gap-1">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={cn(
                "text-xs px-3 py-1 rounded-full border transition-colors",
                days === d
                  ? "bg-primary/15 text-primary border-primary/30 font-bold"
                  : "text-muted-foreground border-transparent hover:text-foreground"
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Signal activation monitor — observation mode, read-only */}
      <SignalActivationPanel />

      {/* Alpha status — always visible, not affected by day toggle */}
      <AlphaStatusPanel />

      {/* Panel grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ModelContributionPanel days={days} />
        <TierSummaryPanel days={days} />
        <EdgeBucketPanel days={days} />
        <ParlayModelMixPanel days={days} />
        <TimingEdgePanel days={days} />
        <StabilityEdgePanel days={days} />
      </div>

      {/* Calibration impact — full width, separate from cross-tab grid */}
      <CalibrationImpactPanel days={days} />

      {/* Early value label impact — answers do LINE VALUE > EARLY VALUE? */}
      <EarlyValueImpactPanel days={days} />

      {/* Resolution completeness — per-sport pipeline health check */}
      <ResolutionCompletenessPanel days={days} />

      {/* Full-width how-it-works */}
      <HowItWorksPanel />
    </div>
  );
}
