/**
 * TrainingDataHealthPanel — Analytics-page surface for ML training
 * coverage. Shows per (sport, bet_type, market) bucket totals,
 * resolved vs pending, average data quality, missing-field rate, and
 * whether the bucket has cleared the activation threshold (≥25
 * resolved + avg data_quality ≥ 0.6).
 *
 * Reads the analytics_ml_training_health RPC. Quietly hidden when
 * Supabase isn't configured or the table/RPC hasn't been deployed yet.
 */

import { useEffect, useState } from "react";
import { Database, ShieldCheck, AlertTriangle, Minus } from "lucide-react";
import { fetchMlTrainingHealth, type MlBucketHealth } from "@/lib/ml/trainingSamples";
import { isSupabaseConfigured } from "@/lib/supabase";
import { cn } from "@/lib/utils";

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

export function TrainingDataHealthPanel() {
  const [rows, setRows] = useState<MlBucketHealth[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void fetchMlTrainingHealth().then((r) => {
      if (cancelled) return;
      setRows(r);
      setLoading(false);
      // If the array is empty, we can't tell whether it's "no samples
      // yet" or "table doesn't exist". Mark missing only if every call
      // returns empty and we know Supabase is configured. The user
      // sees a passive state either way.
      if (r.length === 0) setMissing(true);
    });
    return () => { cancelled = true; };
  }, []);

  if (!isSupabaseConfigured) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/40 p-4 text-xs text-muted-foreground">
        <Database className="w-4 h-4 inline mr-1.5 -mt-0.5" />
        Cloud sync unavailable — training samples are written when signed in to Supabase.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card/40 p-4 h-32 animate-pulse" />
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/40 p-4 text-xs text-muted-foreground space-y-1">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4" />
          <span className="font-bold text-foreground">Training data health</span>
        </div>
        {missing ? (
          <p>
            No training samples yet. Either the <code>ml_training_samples</code> migration hasn't been
            applied, or no recommended parlays have been logged. Mark a recommended parlay as placed
            (or run the migration) to start populating this table.
          </p>
        ) : (
          <p>No training samples in the user's bucket yet.</p>
        )}
      </div>
    );
  }

  const totalSamples   = rows.reduce((s, r) => s + r.totalSamples, 0);
  const totalResolved  = rows.reduce((s, r) => s + r.resolvedSamples, 0);
  const activeBuckets  = rows.filter((r) => r.mlActive).length;

  return (
    <div className="rounded-lg border border-border bg-card/40 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Database className="w-4 h-4 text-primary" />
        <h3 className="font-display font-bold text-sm text-foreground">Training data health</h3>
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
          {totalSamples} samples · {totalResolved} resolved · {activeBuckets}/{rows.length} buckets active
        </span>
      </div>

      <div className="overflow-x-auto -mx-4 px-4">
        <table className="w-full text-[11px] tabular-nums">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border">
              <th className="py-1.5 pr-2">Sport</th>
              <th className="py-1.5 pr-2">Type</th>
              <th className="py-1.5 pr-2">Market</th>
              <th className="py-1.5 pr-2 text-right">Total</th>
              <th className="py-1.5 pr-2 text-right">Resolved</th>
              <th className="py-1.5 pr-2 text-right">Avg DQ</th>
              <th className="py-1.5 pr-2 text-right">Miss%</th>
              <th className="py-1.5 pr-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.sport}:${r.betType}:${r.market}`} className="border-b border-border/40">
                <td className="py-1.5 pr-2 font-bold text-foreground">{r.sport}</td>
                <td className="py-1.5 pr-2 text-muted-foreground capitalize">{r.betType.replace(/_/g, " ")}</td>
                <td className="py-1.5 pr-2 text-muted-foreground">{r.market}</td>
                <td className="py-1.5 pr-2 text-right text-foreground">{r.totalSamples}</td>
                <td className="py-1.5 pr-2 text-right text-foreground">{r.resolvedSamples}</td>
                <td className="py-1.5 pr-2 text-right text-muted-foreground">{pct(r.avgDataQuality)}</td>
                <td className="py-1.5 pr-2 text-right text-muted-foreground">{pct(r.missingFieldRate)}</td>
                <td className="py-1.5 pr-2">
                  {r.mlActive ? (
                    <span className={cn(
                      "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold",
                      "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20",
                    )}>
                      <ShieldCheck className="w-3 h-3" />
                      ML active
                    </span>
                  ) : r.resolvedSamples >= 10 ? (
                    <span className={cn(
                      "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold",
                      "bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/20",
                    )}>
                      <AlertTriangle className="w-3 h-3" />
                      Calibrating
                    </span>
                  ) : (
                    <span className={cn(
                      "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold",
                      "bg-muted text-muted-foreground border border-border",
                    )}>
                      <Minus className="w-3 h-3" />
                      Rules mode
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-muted-foreground">
        ML activates per bucket once resolved samples ≥ 25 and average data quality ≥ 0.6. Buckets
        below that fall back to the rules engine.
      </p>
    </div>
  );
}
