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
  type ModelContributionRow,
  type ParlayModelMixRow,
  type EdgeBucketPerformanceRow,
  type TimingEdgeQualityRow,
  type StabilityEdgeQualityRow,
  type CalibrationImpactRow,
  type CalibrationImpactBySportRow,
} from "@/hooks/useAnalyticsDashboard";
import { getAdaptiveWeightsSync, computeAlpha } from "@/lib/ml/weights";
import { ALPHA_RANGES, getAlphaRange } from "@/lib/ml/alphaConfig";
import { readAlphaAdjustmentLog, type AlphaAdjustmentLog } from "@/lib/ml/feedbackLoop";
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

// ── Panel 8: How it works ─────────────────────────────────────────────────────

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
          <span className="font-semibold text-foreground">Calibration impact</span> — validates whether
          the confidence calibration adjustment is actually helping. Legs are bucketed into{" "}
          <code className="text-emerald-500">boosted</code> (&gt;+0.02),{" "}
          <code className="text-muted-foreground">neutral</code> (±0.02), and{" "}
          <code className="text-rose-500">penalized</code> (&lt;−0.02). Signal is validated when boosted
          hit rate &gt; neutral &gt; penalized. Needs ≥10 resolved per bucket to be meaningful.
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

      {/* Full-width how-it-works */}
      <HowItWorksPanel />
    </div>
  );
}
