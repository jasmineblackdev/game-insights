/**
 * Shadow Pick Learning — dashboard section that aggregates every
 * generated prediction (not just user-bet ones) into six tracking
 * categories and surfaces the high-edge picks the filters dropped.
 *
 * Reads from the read-only abstraction in src/lib/ml/shadowPickTracking.ts
 * which composes prop_impressions + picks_log + parlay_leg_rejections —
 * no new write paths are needed because the loggers are already wired
 * in src/lib/ml/impressionLogger.ts.
 */

import { useQuery } from "@tanstack/react-query";
import { Eye, Filter, Sparkles } from "lucide-react";
import {
  fetchShadowSummary,
  fetchShadowMissedOpportunities,
  fetchShadowFilterStrictness,
  SHADOW_CATEGORY_LABEL,
  SHADOW_CATEGORY_DESCRIPTION,
  type ShadowSummaryRow,
  type ShadowMissedRow,
  type ShadowFilterRow,
  type ShadowCategory,
} from "@/lib/ml/shadowPickTracking";
import { cn } from "@/lib/utils";

const CATEGORY_TONE: Record<ShadowCategory, string> = {
  RECOMMENDED_BET: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  USER_TAKEN:      "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30",
  USER_SKIPPED:    "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  MONITOR_ONLY:    "bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/30",
  PASS:            "bg-muted text-muted-foreground border-border",
  FILTERED_OUT:    "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
};

function pct(v: number | null | undefined, suffix = "%"): string {
  return v == null ? "—" : `${v.toFixed(1)}${suffix}`;
}

function CategoryPill({ category }: { category: ShadowCategory }) {
  return (
    <span className={cn(
      "inline-flex items-center text-[10px] font-bold tracking-wider rounded-full px-1.5 py-0.5 border",
      CATEGORY_TONE[category],
    )}>
      {SHADOW_CATEGORY_LABEL[category]}
    </span>
  );
}

export function ShadowPickLearningSection({ windowDays = 30 }: { windowDays?: number }) {
  const { data: summary = [] } = useQuery<ShadowSummaryRow[]>({
    queryKey: ["shadow-summary", windowDays],
    queryFn: () => fetchShadowSummary(windowDays),
    staleTime: 60_000,
  });
  const { data: missed = [] } = useQuery<ShadowMissedRow[]>({
    queryKey: ["shadow-missed", windowDays],
    queryFn: () => fetchShadowMissedOpportunities(windowDays),
    staleTime: 60_000,
  });
  const { data: strictness = [] } = useQuery<ShadowFilterRow[]>({
    queryKey: ["shadow-filters", windowDays],
    queryFn: () => fetchShadowFilterStrictness(windowDays),
    staleTime: 60_000,
  });

  const totalGenerated = summary.reduce((s, r) => s + r.generated_count, 0);

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Eye className="w-4 h-4 text-primary" />
          <h3 className="font-display font-bold text-sm text-foreground">Shadow Pick Learning</h3>
          <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
            {totalGenerated.toLocaleString()} pick events tracked / {windowDays}d
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Every prediction the engine produces is tracked automatically — even when the user doesn't place
          the bet. Each pick is classified into one of six categories so the model learns from skipped,
          monitored, and filtered picks too.
        </p>

        {summary.length === 0 || totalGenerated === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No tracked pick events yet — open Game Insights to populate <code className="bg-muted px-1 rounded">prop_impressions</code>.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {summary.map((row) => (
              <div key={row.category} className="rounded-md border border-border bg-background/50 p-2.5 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <CategoryPill category={row.category} />
                  <span className="text-base font-bold tabular-nums text-foreground">
                    {row.generated_count}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground leading-tight">
                  {SHADOW_CATEGORY_DESCRIPTION[row.category]}
                </p>
                <div className="flex items-center justify-between text-[10px] tabular-nums pt-1 border-t border-border/50">
                  <span className="text-muted-foreground">
                    Hit {pct(row.hit_rate_pct)} <span className="opacity-60">({row.resolved_count}n)</span>
                  </span>
                  <span className={cn(
                    row.est_roi_pct == null ? "text-muted-foreground"
                      : row.est_roi_pct > 0 ? "text-emerald-600 dark:text-emerald-400 font-bold"
                      : row.est_roi_pct < 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
                  )}>
                    ROI {pct(row.est_roi_pct)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Best missed opportunities */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber-500" />
          <h3 className="font-display font-bold text-sm text-foreground">Best missed opportunities</h3>
        </div>
        <p className="text-[11px] text-muted-foreground">
          High-edge picks (≥ 4%) the system either filtered out or downgraded to monitor/pass. Sorted by
          pick-time edge — these are the candidates most worth re-examining when tuning filter rules.
        </p>
        {missed.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No high-edge filtered or downgraded picks in the last {windowDays} days.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] text-muted-foreground uppercase tracking-wider">
                <tr>
                  <th className="text-left py-1.5">Sport</th>
                  <th className="text-left py-1.5">Market</th>
                  <th className="text-left py-1.5">Status</th>
                  <th className="text-left py-1.5">Reason</th>
                  <th className="text-right py-1.5">Edge</th>
                  <th className="text-right py-1.5">ML p</th>
                  <th className="text-right py-1.5">Conf</th>
                </tr>
              </thead>
              <tbody>
                {missed.map((m, i) => (
                  <tr key={i} className="border-t border-border/60">
                    <td className="py-1.5">{m.sport}</td>
                    <td className="py-1.5 text-muted-foreground">{m.stat_type ?? "—"}</td>
                    <td className="py-1.5"><CategoryPill category={m.category} /></td>
                    <td className="py-1.5 text-muted-foreground text-[11px]">{m.reason}</td>
                    <td className="py-1.5 text-right tabular-nums font-bold text-emerald-600 dark:text-emerald-400">
                      {m.edge == null ? "—" : `+${(m.edge * 100).toFixed(1)}%`}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {m.ml_hit_prob == null ? "—" : `${(m.ml_hit_prob * 100).toFixed(0)}%`}
                    </td>
                    <td className="py-1.5 text-right text-muted-foreground">{m.confidence ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Filter strictness */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-primary" />
          <h3 className="font-display font-bold text-sm text-foreground">Filters that blocked the most picks</h3>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Which optimizer rules are dropping the most candidates? Reasons blocking high-conf picks with
          large max edges are the first place to look when filters feel too strict.
        </p>
        {strictness.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No filter activity in the last {windowDays} days.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] text-muted-foreground uppercase tracking-wider">
                <tr>
                  <th className="text-left py-1.5">Filter reason</th>
                  <th className="text-right py-1.5">Blocked</th>
                  <th className="text-right py-1.5">High-conf</th>
                  <th className="text-right py-1.5">Avg edge</th>
                  <th className="text-right py-1.5">Max edge</th>
                </tr>
              </thead>
              <tbody>
                {strictness.map((r) => (
                  <tr key={r.rejection_reason} className="border-t border-border/60">
                    <td className="py-1.5">{r.rejection_reason}</td>
                    <td className="py-1.5 text-right tabular-nums">{r.blocked_count}</td>
                    <td className={cn(
                      "py-1.5 text-right tabular-nums",
                      r.high_conf_count >= 3 && "text-amber-600 dark:text-amber-400 font-bold",
                    )}>{r.high_conf_count}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {r.avg_edge == null ? "—" : `+${(r.avg_edge * 100).toFixed(1)}%`}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {r.max_edge == null ? "—" : `+${(r.max_edge * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
