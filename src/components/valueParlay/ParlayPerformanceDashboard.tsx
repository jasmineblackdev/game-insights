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
  type ModelContributionRow,
  type ParlayModelMixRow,
  type EdgeBucketPerformanceRow,
  type TimingEdgeQualityRow,
  type StabilityEdgeQualityRow,
} from "@/hooks/useAnalyticsDashboard";
import { getAdaptiveWeightsSync, computeAlpha } from "@/lib/ml/weights";
import { ALPHA_RANGES, getAlphaRange } from "@/lib/ml/alphaConfig";
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
  sport:       string;
  label:       string;
  alpha:       number;
  sampleSize:  number;
  learned:     boolean;
  min:         number;
  max:         number;
  step:        number;
  calibratedAt: string | null;
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
      const w = getAdaptiveWeightsSync(key as Parameters<typeof getAdaptiveWeightsSync>[0], "hit_probability", "pregame");
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
                  <th className="text-right py-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const barW    = alphaBarWidth(r.alpha, r.min, r.max);
                  const dirChar = alphaStatusDir(r.alpha, r.min, r.max);
                  const textCls = alphaStatusColor(r.alpha, r.min, r.max, r.learned);
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
                      <td className="text-right py-2">
                        {r.learned ? (
                          <span className="text-emerald-500 text-[10px] font-semibold">active</span>
                        ) : r.sampleSize >= 10 ? (
                          <span className="text-yellow-500 text-[10px] font-semibold">learning</span>
                        ) : (
                          <span className="text-muted-foreground/60 text-[10px]">seeding</span>
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
              Combat sports adjust more slowly due to smaller sample pools.
            </p>
          </div>
        </div>
      )}
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
        <div className="pt-1 text-[10px] text-muted-foreground/60">
          All data is read-only. Parlay builds are logged automatically on auto-build.
          parlay_results populate once leg outcomes resolve in prediction_history.
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

      {/* Full-width how-it-works */}
      <HowItWorksPanel />
    </div>
  );
}
