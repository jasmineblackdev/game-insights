/**
 * ML Performance — read-only dashboard surfacing the learning loop's
 * resolved-data rollups: win rate by sport, by bet type, by odds range,
 * plus the worst-performing stat categories ("most common loss reasons").
 *
 * Data comes from RPCs in 20260430300000_ml_performance_rollups.sql.
 * Until the migration is applied + at least a few resolutions land, the
 * page shows empty-state placeholders.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, BarChart3, Brain, RefreshCw, Trophy, TrendingDown } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SportRow      { sport: string; resolved_count: number; won: number; lost: number; win_pct: number | null }
interface BetTypeRow    { bet_type: string; resolved_count: number; won: number; lost: number; win_pct: number | null }
interface OddsBucketRow { odds_bucket: string; resolved_count: number; won: number; lost: number; win_pct: number | null; avg_payout_x: number | null; est_roi_pct: number | null }
interface LossReasonRow { sport: string; stat_type: string; losses: number; hits: number; loss_pct: number | null }

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

function pct(v: number | null): string {
  return v == null ? "—" : `${v.toFixed(1)}%`;
}

function StatTable<T extends object>({
  title,
  icon: Icon,
  rows,
  cols,
  empty,
}: {
  title: string;
  icon: typeof Trophy;
  rows: T[];
  cols: { key: keyof T; label: string; align?: "left" | "right"; format?: (v: unknown) => string }[];
  empty: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2">
        <Icon className="w-4 h-4 text-primary" />
        {title}
      </h3>
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
                        {c.format ? c.format(v) : String(v ?? "—")}
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

export default function MLPerformancePage() {
  const { data: bySport = [],   refetch: r1, isFetching: f1 } = useQuery({ queryKey: ["ml-perf-sport"],   queryFn: () => rpc<SportRow>("analytics_model_performance_by_sport"),     staleTime: 60_000 });
  const { data: byBet = [],     refetch: r2, isFetching: f2 } = useQuery({ queryKey: ["ml-perf-bet"],     queryFn: () => rpc<BetTypeRow>("analytics_model_performance_by_bet_type"), staleTime: 60_000 });
  const { data: byOdds = [],    refetch: r3, isFetching: f3 } = useQuery({ queryKey: ["ml-perf-odds"],    queryFn: () => rpc<OddsBucketRow>("analytics_model_performance_by_odds_range"), staleTime: 60_000 });
  const { data: lossList = [], refetch: r4, isFetching: f4 } = useQuery({ queryKey: ["ml-perf-loss"],    queryFn: () => rpc<LossReasonRow>("analytics_loss_reasons"),               staleTime: 60_000 });

  const refreshAll = () => { r1(); r2(); r3(); r4(); };
  const isFetching = f1 || f2 || f3 || f4;

  return (
    <div className="container mx-auto max-w-5xl px-4 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/"><ArrowLeft className="w-4 h-4" /></Link>
        </Button>
        <Brain className="w-5 h-5 text-primary" />
        <h1 className="font-display font-bold text-2xl text-foreground">ML Performance</h1>
        <Button size="sm" variant="outline" onClick={refreshAll} disabled={isFetching} className="ml-auto gap-1">
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Rolling 30-day windows pulled from <code className="bg-muted px-1.5 py-0.5 rounded">prediction_history</code> +{" "}
        <code className="bg-muted px-1.5 py-0.5 rounded">recommended_parlays</code>. Empty rows mean
        the rollup hasn't received enough resolved samples yet.
      </p>

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
