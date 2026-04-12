/**
 * Parlay Performance Dashboard
 *
 * 7-panel view combining model contribution data, edge-bucket analysis,
 * timing/stability cross-tabs, and parlay build history.
 * All panels read from the 5 new analytics RPCs added in the model_contribution migration.
 */

import { useState } from "react";
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
import { cn } from "@/lib/utils";

// ── Shared primitives ────────────────────────────────────────────────────────

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
      <div>
        <h3 className="text-xs font-bold tracking-wider text-muted-foreground uppercase">{title}</h3>
        {subtitle && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{subtitle}</p>}
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
  if (v > 5) return "text-emerald-500";
  if (v > 0) return "text-emerald-400/80";
  if (v < -10) return "text-red-500";
  if (v < 0) return "text-red-400/80";
  return "text-muted-foreground";
}

function hitColor(v: number | null | undefined): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 60) return "text-emerald-500";
  if (v >= 50) return "text-yellow-500";
  return "text-red-400";
}

// ── Panel 1: Model Contribution ──────────────────────────────────────────────

function ModelContributionPanel({ days }: { days: number }) {
  const { data, isLoading } = useModelContribution(days);
  const rows = (data ?? []) as ModelContributionRow[];

  const VARIANT_LABEL: Record<string, string> = {
    rules:      "Rules engine",
    ml_blended: "ML blended",
    ml_full:    "ML full",
  };

  return (
    <SectionCard
      title="Model contribution"
      subtitle="Hit rate & ROI by model variant — requires ≥10 resolved per variant"
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
                <th className="text-right py-1 pr-3 font-medium">Resolved</th>
                <th className="text-right py-1 pr-3 font-medium">Hit rate</th>
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
                  <td className="text-right py-1.5 pr-3 tabular-nums text-muted-foreground">
                    {r.resolved_count}
                  </td>
                  <td className={cn("text-right py-1.5 pr-3 tabular-nums font-semibold", hitColor(r.hit_rate_pct))}>
                    {pct(r.hit_rate_pct)}
                  </td>
                  <td className={cn("text-right py-1.5 pr-3 tabular-nums font-semibold", roiColor(r.roi_pct))}>
                    {pct(r.roi_pct)}
                  </td>
                  <td className="text-right py-1.5 tabular-nums text-muted-foreground">
                    {r.avg_edge != null ? `${(r.avg_edge * 100).toFixed(1)}pp` : "—"}
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

  // Group by edge bucket for summary view
  const byBucket = rows.reduce<Record<string, EdgeBucketPerformanceRow[]>>((acc, r) => {
    (acc[r.edge_bucket] ??= []).push(r);
    return acc;
  }, {});

  const BUCKETS = ["0–2%", "2–5%", "5–8%", "8%+"];

  return (
    <SectionCard
      title="Edge bucket performance"
      subtitle="Does higher edge actually convert? Requires ≥5 resolved per sport/market/bucket"
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
            const totalResolved = bucketRows.reduce((s, r) => s + r.resolved_count, 0);
            const totalWins = bucketRows.reduce((s, r) => s + r.win_count, 0);
            const aggHit = totalResolved ? (totalWins / totalResolved) * 100 : null;
            const avgRoi = bucketRows.reduce((s, r) => s + (r.roi_pct ?? 0), 0) / bucketRows.length;

            return (
              <div key={bucket} className="flex items-center justify-between gap-2 text-xs">
                <span className="font-mono font-semibold text-foreground w-14 shrink-0">{bucket}</span>
                <div className="flex items-center gap-3 flex-1 justify-end">
                  <span className="text-muted-foreground tabular-nums">{totalResolved}n</span>
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
            {rows.length} sport/market/bucket combos · hover sports for breakdown
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

  const TIMING_ORDER = ["now", "monitor", "wait"];
  const TIMING_LABEL: Record<string, string> = {
    now:     "Now",
    monitor: "Monitor",
    wait:    "Wait",
  };
  const TIMING_COLOR: Record<string, string> = {
    now:     "text-emerald-500",
    monitor: "text-yellow-500",
    wait:    "text-red-400",
  };

  // Group by timing_bucket
  const byTiming = rows.reduce<Record<string, TimingEdgeQualityRow[]>>((acc, r) => {
    (acc[r.timing_bucket] ??= []).push(r);
    return acc;
  }, {});

  return (
    <SectionCard
      title="Timing × edge quality"
      subtitle={`Does "bet now" timing improve edge realization within the same edge range?`}
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
                    <td className="text-right py-1.5 pr-3 tabular-nums text-muted-foreground">{r.resolved_count}</td>
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
                    <td className="text-right py-1.5 pr-3 tabular-nums text-muted-foreground">{r.resolved_count}</td>
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

  const TIER_COLOR: Record<string, string> = {
    safe:       "text-emerald-500",
    balanced:   "text-yellow-500",
    aggressive: "text-orange-500",
  };

  return (
    <SectionCard
      title="Parlay ML mix vs outcome"
      subtitle="Do parlays with more ML legs outperform rules-only parlays?"
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
                  <td className="text-right py-1.5 pr-3 tabular-nums text-muted-foreground">{r.parlay_count}</td>
                  <td className="text-right py-1.5 pr-3 tabular-nums text-muted-foreground">{r.resolved_count}</td>
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

// ── Panel 6: Tier summary from parlay model mix ───────────────────────────────

function TierSummaryPanel({ days }: { days: number }) {
  const { data, isLoading } = useParlayModelMix(days);
  const rows = (data ?? []) as ParlayModelMixRow[];

  // Aggregate by tier
  const byTier = rows.reduce<Record<string, { parlays: number; resolved: number; hits: number; roiSum: number; roiN: number }>>((acc, r) => {
    if (!acc[r.tier]) acc[r.tier] = { parlays: 0, resolved: 0, hits: 0, roiSum: 0, roiN: 0 };
    acc[r.tier].parlays  += r.parlay_count;
    acc[r.tier].resolved += r.resolved_count;
    if (r.hit_rate_pct != null) {
      acc[r.tier].hits   += Math.round((r.hit_rate_pct / 100) * r.resolved_count);
    }
    if (r.roi_pct != null) {
      acc[r.tier].roiSum += r.roi_pct;
      acc[r.tier].roiN++;
    }
    return acc;
  }, {});

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

// ── Panel 7: Info / guide ─────────────────────────────────────────────────────

function HowItWorksPanel() {
  return (
    <SectionCard
      title="How this dashboard works"
    >
      <div className="space-y-2 text-xs text-muted-foreground">
        <div>
          <span className="font-semibold text-foreground">Model contribution</span> — compares predictions
          tagged <code className="text-primary">rules</code> vs{" "}
          <code className="text-primary">ml_blended</code> in prediction_history. Requires ≥10 resolved
          per variant before surfacing. ML blended predictions come from enriched player props
          where the ML layer is active (alpha ≥ 0.05).
        </div>
        <div>
          <span className="font-semibold text-foreground">Edge buckets</span> — slices resolved predictions
          by edge magnitude (0–2%, 2–5%, 5–8%, 8%+). High edge should convert to higher ROI.
          If the 0–2% bucket beats 5–8%, edge calibration needs work.
        </div>
        <div>
          <span className="font-semibold text-foreground">Timing × edge</span> — checks whether "bet now"
          timing signals improve edge realization vs "wait" signals within the same edge band.
          A strong signal here validates the timing model.
        </div>
        <div>
          <span className="font-semibold text-foreground">Stability × edge</span> — checks whether high
          ML stability score (≥0.70) correlates with better conversion. If stable predictions
          outperform, the model is learning reliable patterns.
        </div>
        <div>
          <span className="font-semibold text-foreground">Parlay builds</span> — logged whenever you
          auto-build a parlay. parlay_results are populated once leg outcomes resolve. The ML
          ratio bucket answers whether parlays with more ML legs outperform pure-rules parlays.
        </div>
        <div className="pt-1 text-[10px] text-muted-foreground/60">
          All data is read-only. Alpha adjustments run automatically in the background
          (±0.02 per sport) when ml_blended outperforms or underperforms rules by &gt;2pp.
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
