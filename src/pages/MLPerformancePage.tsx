/**
 * ML Performance — read-only dashboard surfacing the learning loop's
 * resolved-data rollups: win rate by sport, by bet type, by odds range,
 * worst-performing stat categories, plus three Model Intelligence
 * sections:
 *
 *   • ML Readiness by Market — derived from analytics_ml_hit_rate_by_bucket
 *     (alpha + % to threshold computed client-side from resolved_count
 *     using the same curve as src/lib/ml/alphaConfig.ts).
 *
 *   • Confidence Calibration table — derived from
 *     analytics_confidence_calibration. "Expected" = avg_hit_prob the
 *     model said, "Actual" = hit_rate_pct that landed. Gaps >5 pp are
 *     flagged red so mis-calibrated buckets surface immediately.
 *
 *   • Missed Opportunities — direct read of parlay_leg_rejections
 *     grouped client-side by (sport, rejection_reason). We do NOT
 *     report would-have-hit % because rejected legs were never bet
 *     and have no resolved outcome — surfacing avg edge of what we
 *     filtered out is the honest signal.
 *
 * Data comes from RPCs in 20260430300000_ml_performance_rollups.sql,
 * 20260503000000_ml_hit_rate_by_bucket.sql,
 * 20260412900000_analytics_confidence_calibration.sql, and a direct
 * select on parlay_leg_rejections (20260430000000_ml_training_gaps.sql).
 * Until those run + at least a few resolutions land the page shows
 * empty-state placeholders.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  BarChart3,
  Brain,
  RefreshCw,
  Trophy,
  TrendingDown,
  Activity,
  Target,
  Filter,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ShadowPickLearningSection } from "@/components/ShadowPickLearningSection";

// ── Existing rollup types ────────────────────────────────────────────────────
interface SportRow      { sport: string; resolved_count: number; won: number; lost: number; win_pct: number | null }
interface BetTypeRow    { bet_type: string; resolved_count: number; won: number; lost: number; win_pct: number | null }
interface OddsBucketRow { odds_bucket: string; resolved_count: number; won: number; lost: number; win_pct: number | null; avg_payout_x: number | null; est_roi_pct: number | null }
interface LossReasonRow { sport: string; stat_type: string; losses: number; hits: number; loss_pct: number | null }

// ── Model-intelligence types ─────────────────────────────────────────────────
interface BucketRow {
  sport: string; bet_type: string; market: string; confidence: string;
  resolved_count: number; win_count: number; loss_count: number; push_count: number;
  hit_rate: number | null; active: boolean;
}
interface CalibrationRow {
  confidence: string; total_predictions: number; resolved_count: number;
  win_count: number; hit_rate_pct: number | null; roi_pct: number | null;
  avg_edge: number; avg_hit_prob?: number;
}
interface RejectionRow {
  sport: string; rejection_reason: string; edge: number | null;
  ml_hit_probability: number | null; confidence: string | null;
  rejection_date: string;
}

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) {
      console.warn(`[ml-perf] ${name}:`, error.message);
      return [];
    }
    return (data ?? []) as T[];
  } catch {
    return [];
  }
}

async function fetchRejections(days = 30): Promise<RejectionRow[]> {
  if (!supabase) return [];
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("parlay_leg_rejections")
      .select("sport, rejection_reason, edge, ml_hit_probability, confidence, rejection_date")
      .gte("rejection_date", since)
      .limit(2000);
    if (error) {
      console.warn("[ml-perf] parlay_leg_rejections:", error.message);
      return [];
    }
    return (data ?? []) as RejectionRow[];
  } catch {
    return [];
  }
}

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${v.toFixed(1)}%`;
}

// ── Alpha curve mirrors src/lib/ml/alphaConfig.ts (linear 25→100, cap 0.6) ──
function deriveAlpha(resolved: number): number {
  if (resolved < 25)  return 0;
  if (resolved >= 100) return 0.6;
  return Math.round(((resolved - 25) / 75 * 0.6) * 1000) / 1000;
}
function derivePctToThreshold(resolved: number): number {
  return Math.min(100, Math.round(resolved / 25 * 1000) / 10);
}
function deriveState(resolved: number): "rules" | "learning" | "active" {
  if (resolved < 25)  return "rules";
  if (resolved < 100) return "learning";
  return "active";
}

interface ReadinessRow {
  sport: string; bet_type: string; market: string; resolved_count: number;
  alpha: number; pct_to_threshold: number; state: "rules" | "learning" | "active";
}

/** Roll bucket rows up to (sport, bet_type, market) — sum across confidence tiers. */
function aggregateReadiness(rows: BucketRow[]): ReadinessRow[] {
  const map = new Map<string, ReadinessRow>();
  for (const r of rows) {
    const key = `${r.sport}|${r.bet_type}|${r.market}`;
    const cur = map.get(key);
    const resolved = (cur?.resolved_count ?? 0) + r.resolved_count;
    map.set(key, {
      sport: r.sport,
      bet_type: r.bet_type,
      market: r.market,
      resolved_count: resolved,
      alpha: deriveAlpha(resolved),
      pct_to_threshold: derivePctToThreshold(resolved),
      state: deriveState(resolved),
    });
  }
  return [...map.values()].sort((a, b) => b.resolved_count - a.resolved_count);
}

interface MissedRow {
  sport: string; rejection_reason: string;
  rejected_count: number; high_conf_count: number;
  avg_edge: number | null; avg_ml_prob: number | null;
}
function aggregateRejections(rows: RejectionRow[]): MissedRow[] {
  const map = new Map<string, { sport: string; reason: string; n: number; hc: number; edges: number[]; probs: number[] }>();
  for (const r of rows) {
    const key = `${r.sport}|${r.rejection_reason}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { sport: r.sport, reason: r.rejection_reason, n: 0, hc: 0, edges: [], probs: [] };
      map.set(key, entry);
    }
    entry.n += 1;
    if (r.confidence === "HIGH") entry.hc += 1;
    if (r.edge != null) entry.edges.push(r.edge);
    if (r.ml_hit_probability != null) entry.probs.push(r.ml_hit_probability);
  }
  const avg = (arr: number[]) => arr.length === 0 ? null : arr.reduce((s, x) => s + x, 0) / arr.length;
  return [...map.values()]
    .filter((e) => e.n >= 3)
    .map((e) => ({
      sport: e.sport,
      rejection_reason: e.reason,
      rejected_count: e.n,
      high_conf_count: e.hc,
      avg_edge: avg(e.edges),
      avg_ml_prob: avg(e.probs),
    }))
    .sort((a, b) => b.high_conf_count - a.high_conf_count || b.rejected_count - a.rejected_count);
}

function StatTable<T extends object>({
  title,
  icon: Icon,
  rows,
  cols,
  empty,
  description,
}: {
  title: string;
  icon: typeof Trophy;
  rows: T[];
  cols: { key: keyof T; label: string; align?: "left" | "right"; format?: (v: unknown, row: T) => React.ReactNode }[];
  empty: string;
  description?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2">
        <Icon className="w-4 h-4 text-primary" />
        {title}
      </h3>
      {description ? <p className="text-[11px] text-muted-foreground">{description}</p> : null}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[10px] text-muted-foreground uppercase tracking-wider">
              <tr>
                {cols.map((c) => (
                  <th key={String(c.key)} className={cn("py-1.5", c.align === "right" ? "text-right" : "text-left")}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border/60">
                  {cols.map((c) => {
                    const v = (r as Record<string, unknown>)[String(c.key)];
                    return (
                      <td key={String(c.key)} className={cn("py-1.5 tabular-nums", c.align === "right" ? "text-right" : "text-left")}>
                        {c.format ? c.format(v, r) : String(v ?? "—")}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Coloured pill for ML state. */
function StatePill({ state }: { state: "rules" | "learning" | "active" }) {
  const cls =
    state === "active"   ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30"
  : state === "learning" ? "bg-sky-500/10 text-sky-700 dark:text-sky-400 border border-sky-500/30"
                         : "bg-muted text-muted-foreground border border-border";
  const label = state === "active" ? "Active" : state === "learning" ? "Learning" : "Not enough data";
  return <span className={cn("inline-flex items-center text-[10px] font-bold tracking-wider rounded-full px-1.5 py-0.5", cls)}>{label}</span>;
}

/** Tiny progress bar to show how far a market is from the 25-sample activation threshold. */
function ProgressBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  const tone = v >= 100 ? "bg-emerald-500" : v >= 50 ? "bg-sky-500" : "bg-muted-foreground/40";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden min-w-[60px]">
        <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${v}%` }} />
      </div>
      <span className="tabular-nums text-[10px] text-muted-foreground w-10 text-right">{v.toFixed(0)}%</span>
    </div>
  );
}

/**
 * Shared content body — reusable from /ml-performance (full-page) and
 * /edge → ML Perf sub-tab. Stripped of route-level chrome so it can
 * compose into a parent shell.
 */
export function MLPerformanceContent({ embedded = false }: { embedded?: boolean }) {
  const { data: bySport = [],   refetch: r1, isFetching: f1 } = useQuery({ queryKey: ["ml-perf-sport"],   queryFn: () => rpc<SportRow>("analytics_model_performance_by_sport"),     staleTime: 60_000 });
  const { data: byBet = [],     refetch: r2, isFetching: f2 } = useQuery({ queryKey: ["ml-perf-bet"],     queryFn: () => rpc<BetTypeRow>("analytics_model_performance_by_bet_type"), staleTime: 60_000 });
  const { data: byOdds = [],    refetch: r3, isFetching: f3 } = useQuery({ queryKey: ["ml-perf-odds"],    queryFn: () => rpc<OddsBucketRow>("analytics_model_performance_by_odds_range"), staleTime: 60_000 });
  const { data: lossList = [], refetch: r4, isFetching: f4 } = useQuery({ queryKey: ["ml-perf-loss"],    queryFn: () => rpc<LossReasonRow>("analytics_loss_reasons"),               staleTime: 60_000 });
  const { data: bucketRows = [], refetch: r5, isFetching: f5 } = useQuery({ queryKey: ["ml-perf-buckets"], queryFn: () => rpc<BucketRow>("analytics_ml_hit_rate_by_bucket"),         staleTime: 60_000 });
  const { data: calibration = [], refetch: r6, isFetching: f6 } = useQuery({ queryKey: ["ml-perf-calib"],  queryFn: () => rpc<CalibrationRow>("analytics_confidence_calibration", { lookback_days: 30 }), staleTime: 60_000 });
  const { data: rejections = [], refetch: r7, isFetching: f7 } = useQuery({ queryKey: ["ml-perf-reject"], queryFn: () => fetchRejections(30),                                       staleTime: 60_000 });

  const readinessRows = useMemo(() => aggregateReadiness(bucketRows), [bucketRows]);
  const missedRows    = useMemo(() => aggregateRejections(rejections), [rejections]);

  const refreshAll = () => { r1(); r2(); r3(); r4(); r5(); r6(); r7(); };
  const isFetching = f1 || f2 || f3 || f4 || f5 || f6 || f7;

  return (
    <div className={embedded ? "space-y-5" : "container mx-auto max-w-5xl px-4 py-6 space-y-5"}>
      {!embedded ? (
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/"><ArrowLeft className="w-4 h-4" /></Link>
          </Button>
          <Brain className="w-5 h-5 text-primary" />
          <h1 className="font-display font-bold text-2xl text-foreground">Model Intelligence</h1>
          <Button size="sm" variant="outline" onClick={refreshAll} disabled={isFetching} className="ml-auto gap-1">
            <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-end">
          <Button size="sm" variant="outline" onClick={refreshAll} disabled={isFetching} className="gap-1">
            <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Rolling 30-day windows pulled from <code className="bg-muted px-1.5 py-0.5 rounded">prediction_history</code>,{" "}
        <code className="bg-muted px-1.5 py-0.5 rounded">ml_training_samples</code>, and{" "}
        <code className="bg-muted px-1.5 py-0.5 rounded">recommended_parlays</code>. Empty rows mean the rollup hasn't received enough resolved samples yet.
      </p>

      {/* ── 1. ML Readiness by Market ───────────────────────────── */}
      <StatTable<ReadinessRow>
        title="ML Readiness by Market"
        icon={Activity}
        description="Each (sport, bet_type, market) combination's progress toward the 25-sample activation threshold. Alpha is the blending weight between rules and ML output (capped at 0.6)."
        rows={readinessRows}
        cols={[
          { key: "sport",            label: "Sport" },
          { key: "bet_type",         label: "Bet type" },
          { key: "market",           label: "Market" },
          { key: "resolved_count",   label: "Resolved", align: "right" },
          { key: "pct_to_threshold", label: "Progress", align: "right",
            format: (v) => <ProgressBar value={v as number} /> },
          { key: "alpha",            label: "Alpha",    align: "right",
            format: (v) => (v as number).toFixed(2) },
          { key: "state",            label: "State",    align: "right",
            format: (v) => <StatePill state={v as "rules" | "learning" | "active"} /> },
        ]}
        empty="No resolved ML training samples yet — picks are running pure rules-engine output."
      />

      {/* ── 2. Confidence Calibration ──────────────────────────── */}
      <StatTable<CalibrationRow>
        title="Confidence Calibration"
        icon={Target}
        description="Expected = avg model probability the engine assigned. Actual = hit rate that resolved. Gaps over 5 percentage points are highlighted — those buckets are mis-calibrated and need re-weighting."
        rows={calibration}
        cols={[
          { key: "confidence",       label: "Tier" },
          { key: "resolved_count",   label: "n",        align: "right" },
          { key: "avg_hit_prob",     label: "Expected", align: "right",
            format: (v) => v == null ? "—" : `${((v as number) * 100).toFixed(1)}%` },
          { key: "hit_rate_pct",     label: "Actual",   align: "right",
            format: (v) => pct(v as number | null) },
          { key: "roi_pct",          label: "ROI",      align: "right",
            format: (v) => {
              const n = v as number | null;
              if (n == null) return "—";
              const tone = n > 0 ? "text-emerald-600 dark:text-emerald-400" : n < 0 ? "text-red-600 dark:text-red-400" : "";
              return <span className={tone}>{pct(n)}</span>;
            } },
          { key: "hit_rate_pct",     label: "Gap",      align: "right",
            format: (_v, row) => {
              const expected = row.avg_hit_prob != null ? row.avg_hit_prob * 100 : null;
              const actual   = row.hit_rate_pct;
              if (expected == null || actual == null) return "—";
              const gap = actual - expected;
              const big = Math.abs(gap) > 5;
              const tone = big ? (gap < 0 ? "text-red-600 dark:text-red-400 font-bold" : "text-amber-600 dark:text-amber-400 font-bold") : "text-muted-foreground";
              return <span className={tone}>{gap > 0 ? "+" : ""}{gap.toFixed(1)} pp</span>;
            } },
        ]}
        empty="Need ≥ 5 resolved predictions per confidence tier before calibration appears."
      />

      {/* ── 3. Existing model-performance rollups ──────────────── */}
      <div className="grid md:grid-cols-2 gap-4">
        <StatTable<SportRow>
          title="Win rate by sport"
          icon={Trophy}
          rows={bySport}
          cols={[
            { key: "sport",          label: "Sport" },
            { key: "won",            label: "W",     align: "right" },
            { key: "lost",           label: "L",     align: "right" },
            { key: "win_pct",        label: "Win %", align: "right", format: (v) => pct(v as number | null) },
            { key: "resolved_count", label: "n",     align: "right" },
          ]}
          empty="No resolved predictions in the last 30 days."
        />

        <StatTable<BetTypeRow>
          title="Win rate by bet type"
          icon={BarChart3}
          rows={byBet}
          cols={[
            { key: "bet_type",       label: "Type" },
            { key: "won",            label: "W",     align: "right" },
            { key: "lost",           label: "L",     align: "right" },
            { key: "win_pct",        label: "Win %", align: "right", format: (v) => pct(v as number | null) },
            { key: "resolved_count", label: "n",     align: "right" },
          ]}
          empty="No bet-type rollups yet (need ≥ 5 resolutions per type)."
        />
      </div>

      <StatTable<OddsBucketRow>
        title="Win rate + ROI by combined-odds bucket"
        icon={BarChart3}
        rows={byOdds}
        cols={[
          { key: "odds_bucket",    label: "Combined odds" },
          { key: "won",            label: "W",        align: "right" },
          { key: "lost",           label: "L",        align: "right" },
          { key: "win_pct",        label: "Win %",    align: "right", format: (v) => pct(v as number | null) },
          { key: "avg_payout_x",   label: "Avg payout", align: "right", format: (v) => v == null ? "—" : `${(v as number).toFixed(2)}x` },
          { key: "est_roi_pct",    label: "Est. ROI", align: "right", format: (v) => pct(v as number | null) },
          { key: "resolved_count", label: "n",        align: "right" },
        ]}
        empty="No resolved parlays yet — auto-saved + manually entered parlays will populate this once they resolve."
      />

      {/* ── 4. Missed Opportunities ─────────────────────────────── */}
      <StatTable<MissedRow>
        title="Missed Opportunities (Filter Audit)"
        icon={Filter}
        description="Every candidate the parlay optimizer dropped, grouped by reason. Rejected legs were never bet, so we don't claim a 'would-have-hit' rate — instead we surface the average edge and how many were HIGH-confidence picks. Reasons with high counts of HIGH-conf rejections are candidates for filter-rule tuning."
        rows={missedRows}
        cols={[
          { key: "sport",            label: "Sport" },
          { key: "rejection_reason", label: "Reason" },
          { key: "rejected_count",   label: "n",        align: "right" },
          { key: "high_conf_count",  label: "High-conf", align: "right",
            format: (v) => {
              const n = v as number;
              return <span className={n >= 3 ? "text-amber-600 dark:text-amber-400 font-bold" : ""}>{n}</span>;
            } },
          { key: "avg_edge",         label: "Avg edge", align: "right",
            format: (v) => v == null ? "—" : (v as number).toFixed(3) },
          { key: "avg_ml_prob",      label: "Avg ML prob", align: "right",
            format: (v) => v == null ? "—" : `${((v as number) * 100).toFixed(1)}%` },
        ]}
        empty="No filtered candidates in the last 30 days — either filters are off or no parlays were built."
      />

      {/* ── 5. Shadow Pick Learning — every generated prediction, classified ── */}
      <ShadowPickLearningSection windowDays={30} />

      <StatTable<LossReasonRow>
        title="Worst-performing stat categories (most common losses)"
        icon={TrendingDown}
        rows={lossList}
        cols={[
          { key: "sport",     label: "Sport" },
          { key: "stat_type", label: "Stat" },
          { key: "losses",    label: "L",       align: "right" },
          { key: "hits",      label: "W",       align: "right" },
          { key: "loss_pct",  label: "Loss %",  align: "right", format: (v) => pct(v as number | null) },
        ]}
        empty="Need ≥ 5 resolutions per (sport, stat) before this populates."
      />
    </div>
  );
}

/** Route-level page — preserves /ml-performance for direct links. */
export default function MLPerformancePage() {
  return <MLPerformanceContent />;
}
