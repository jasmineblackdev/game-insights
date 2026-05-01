/**
 * Recommended Parlays — full history of every parlay the app has surfaced,
 * plus parlays the user entered manually. Tabs by status, with inline
 * "mark as placed" / "set outcome" actions and a manual entry form.
 *
 * Source labelling lets the analytics view distinguish:
 *   app_recommended             — auto-saved from optimizer
 *   user_manual                 — typed in via the form
 *   app_recommended_and_placed  — promoted via "mark as placed"
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, AlertTriangle, ClipboardList, ListChecks, Plus, RefreshCw, Trophy } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ManualParlayEntryForm } from "@/components/parlayTracking/ManualParlayEntryForm";
import { probeRecommendedParlaysTable, setLegOutcome } from "@/lib/parlayTracking/recommendedParlayLogger";
import { aggressivelyResolvePendingParlays } from "@/lib/learning/aggressivePendingResolver";

type ParlayOutcome = "won" | "lost" | "push" | "pending" | "partial";
type ParlaySource =
  | "app_recommended"
  | "user_manual"
  | "app_recommended_and_placed";

interface RecommendedParlayRow {
  id: string;
  source: ParlaySource;
  recommended_at: string;
  date: string;
  tier: string | null;
  variant: string | null;
  sport_mix: string | null;
  market_mix: string | null;
  legs: Array<Record<string, unknown>>;
  leg_count: number;
  combined_american_odds: number | null;
  payout_multiplier: number | null;
  combined_probability: number | null;
  card_score: number | null;
  card_confidence: string | null;
  user_placed: boolean;
  user_stake: number | null;
  user_payout: number | null;
  outcome: ParlayOutcome;
  resolved_at: string | null;
  rules_only: boolean;
  ml_active: boolean;
  warnings: string[] | null;
  user_notes: string | null;
}

type Tab = "pending" | "won" | "lost" | "missed" | "manual" | "analytics";

const TAB_LABELS: Record<Tab, string> = {
  pending:   "Pending",
  won:       "Won",
  lost:      "Lost",
  missed:    "Missed",
  manual:    "Manual",
  analytics: "Analytics",
};

async function fetchRecommendedParlays(): Promise<RecommendedParlayRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("recommended_parlays")
    .select("*")
    .order("recommended_at", { ascending: false })
    .limit(200);
  if (error) {
    console.warn("[parlay-tracking] fetch failed:", error.message);
    return [];
  }
  return (data ?? []) as RecommendedParlayRow[];
}

function americanFmt(odds: number | null): string {
  if (odds == null) return "—";
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function ResultBadge({ outcome }: { outcome: ParlayOutcome }) {
  const cls =
    outcome === "won"     ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
    : outcome === "lost"  ? "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30"
    : outcome === "push"  ? "bg-muted text-muted-foreground border-border"
    : outcome === "partial" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30"
    :                       "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30";
  return (
    <span className={cn("text-[10px] font-bold tracking-wide px-2 py-0.5 rounded-full border", cls)}>
      {outcome.toUpperCase()}
    </span>
  );
}

function SourceBadge({ source }: { source: ParlaySource }) {
  const label =
    source === "app_recommended"             ? "AUTO"
    : source === "user_manual"               ? "MANUAL"
    : "PLACED";
  const cls =
    source === "user_manual" ? "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30"
    : source === "app_recommended_and_placed" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
    : "bg-muted text-muted-foreground border-border";
  return (
    <span className={cn("text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded border", cls)}>
      {label}
    </span>
  );
}

function ModelStatusChip({ row }: { row: RecommendedParlayRow }) {
  if (row.rules_only) {
    return <span className="text-[9px] font-semibold text-muted-foreground border border-border rounded-full px-1.5 py-0.5">RULES</span>;
  }
  if (row.ml_active) {
    return <span className="text-[9px] font-semibold text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 rounded-full px-1.5 py-0.5">ML</span>;
  }
  return null;
}

function ParlayRowCard({
  row,
  onUpdate,
}: {
  row: RecommendedParlayRow;
  onUpdate: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const setOutcome = async (outcome: ParlayOutcome) => {
    if (!supabase) return;
    setBusy(true);
    try {
      await supabase
        .from("recommended_parlays")
        .update({ outcome, resolved_at: new Date().toISOString() })
        .eq("id", row.id);
      toast.success(`Marked ${outcome.toUpperCase()}`);
      onUpdate();
    } catch {
      toast.error("Update failed");
    } finally {
      setBusy(false);
    }
  };

  const markPlaced = async () => {
    if (!supabase) return;
    setBusy(true);
    try {
      // Stamp each leg with its current american_odds as
      // odds_at_placement so the bridge can compute partial CLV
      // (clv_at_placement = implied(placement) − implied(recommend)).
      // We don't refetch here — the user marking placed soon after
      // recommendation gets identical recommend/placement odds (zero
      // signal); marking later captures stale odds (small signal).
      // Real CLV closing-line is a separate polling job.
      const legsAtPlacement = Array.isArray(row.legs)
        ? (row.legs as Array<Record<string, unknown>>).map((l) => ({
            ...l,
            odds_at_placement: l.american_odds ?? null,
          }))
        : row.legs;
      await supabase
        .from("recommended_parlays")
        .update({
          user_placed: true,
          source: "app_recommended_and_placed",
          placed_at: new Date().toISOString(),
          legs: legsAtPlacement,
        })
        .eq("id", row.id);
      toast.success("Marked as placed");
      onUpdate();
    } catch {
      toast.error("Update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start gap-2 flex-wrap">
        <SourceBadge source={row.source} />
        <ResultBadge outcome={row.outcome} />
        <ModelStatusChip row={row} />
        {row.tier && (
          <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-primary/10 text-primary capitalize">
            {row.tier}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground ml-auto">
          {new Date(row.recommended_at).toLocaleString()}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Legs</p>
          <p className="text-lg font-bold tabular-nums">{row.leg_count}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Combined</p>
          <p className="text-lg font-bold tabular-nums">{americanFmt(row.combined_american_odds)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Payout</p>
          <p className="text-lg font-bold tabular-nums">
            {row.payout_multiplier ? `${row.payout_multiplier.toFixed(2)}x` : "—"}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Hit prob</p>
          <p className="text-lg font-bold tabular-nums">
            {row.combined_probability ? `${(row.combined_probability * 100).toFixed(1)}%` : "—"}
          </p>
        </div>
      </div>

      {row.legs?.length > 0 && (
        <ol className="space-y-1 text-[11px]">
          {row.legs.map((leg, i) => {
            const l = leg as Record<string, unknown>;
            const legId = String(l.id ?? `idx-${i}`);
            const legOutcome = String(l.leg_outcome ?? "pending");
            const legCls =
              legOutcome === "won"  ? "border-emerald-500/40 bg-emerald-500/[0.05]"
              : legOutcome === "lost" ? "border-red-500/40 bg-red-500/[0.05]"
              : legOutcome === "push" ? "border-muted-foreground/30 bg-muted/40"
              :                          "border-border/60 bg-background/40";

            const setLeg = async (out: "won" | "lost" | "push" | "pending") => {
              const ok = await setLegOutcome(row.id, legId, out);
              if (ok) {
                toast.success(`Leg #${i + 1} → ${out}`);
                onUpdate();
              } else {
                toast.error("Couldn't update leg");
              }
            };

            return (
              <li key={i} className={cn("flex items-start gap-2 rounded border px-2 py-1.5", legCls)}>
                <span className="font-bold tabular-nums text-muted-foreground shrink-0 mt-0.5">
                  #{i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-foreground text-xs truncate">
                    {String(l.selection ?? "—")}
                  </p>
                  <p className="text-[10px] text-muted-foreground tabular-nums">
                    {String(l.sport ?? "").toUpperCase()} ·{" "}
                    {americanFmt((l.american_odds as number | null) ?? null)} ·{" "}
                    {String(l.confidence ?? "")} · {legOutcome}
                    {l.reason_excluded ? ` · skipped: ${String(l.reason_excluded)}` : ""}
                  </p>
                </div>
                {row.outcome !== "pending" && (
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => setLeg("won")}  className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20">W</button>
                    <button onClick={() => setLeg("lost")} className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20">L</button>
                    <button onClick={() => setLeg("push")} className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:bg-muted/80">P</button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {row.outcome === "pending" ? (
        <div className="flex flex-wrap gap-2 pt-1 border-t border-border/60">
          {!row.user_placed && (
            <Button size="sm" variant="outline" onClick={markPlaced} disabled={busy}>
              Mark as placed
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setOutcome("won")}    disabled={busy}>Won</Button>
          <Button size="sm" variant="outline" onClick={() => setOutcome("lost")}   disabled={busy}>Lost</Button>
          <Button size="sm" variant="outline" onClick={() => setOutcome("push")}   disabled={busy}>Push</Button>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground pt-1 border-t border-border/60">
          Resolved {row.resolved_at ? new Date(row.resolved_at).toLocaleString() : "—"}
        </p>
      )}
    </div>
  );
}

export default function RecommendedParlaysPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("pending");
  const [showManualForm, setShowManualForm] = useState(false);
  const [tableExists, setTableExists] = useState<boolean | null>(null);

  // Probe whether recommended_parlays exists; surfaces a deploy-warning
  // banner instead of misleading the user with empty state.
  useEffect(() => {
    probeRecommendedParlaysTable().then(setTableExists);
  }, []);

  const { data: rows = [], isFetching, refetch } = useQuery({
    queryKey: ["recommended-parlays"],
    queryFn:  fetchRecommendedParlays,
    staleTime: 60_000,
  });

  const [resolving, setResolving] = useState(false);
  const [resolveProgress, setResolveProgress] = useState<{ done: number; total: number } | null>(null);

  /**
   * Walk every pending row, fetch the relevant ESPN summaries on the
   * fly, settle each leg, roll up to parlay outcome, and write back.
   * Decoupled from the games-array resolver in Index/DailyPlanPage so
   * landing directly on /parlays still settles backlog. Idempotent —
   * safe to call repeatedly.
   */
  const sweepPending = useCallback(async (opts?: { silent?: boolean }) => {
    if (resolving) return;
    setResolving(true);
    setResolveProgress({ done: 0, total: 0 });
    try {
      const r = await aggressivelyResolvePendingParlays({
        onProgress: (done, total) => setResolveProgress({ done, total }),
      });
      if (r.errors.length && !opts?.silent) {
        toast.error(`Resolver hit ${r.errors.length} error${r.errors.length === 1 ? "" : "s"} (see console).`);
        // eslint-disable-next-line no-console
        console.warn("[parlay-resolver] errors:", r.errors);
      }
      if (r.legsSettled === 0 && r.scanned === 0 && !opts?.silent) {
        toast.message("No pending parlays to settle.");
      } else if (r.resolved > 0 || r.legsSettled > 0) {
        if (!opts?.silent) {
          toast.success(
            `Resolved ${r.resolved} parlay${r.resolved === 1 ? "" : "s"} · ${r.legsSettled} leg${r.legsSettled === 1 ? "" : "s"} settled.`,
          );
        }
        await refetch();
        qc.invalidateQueries({ queryKey: ["recommended-parlays"] });
      } else if (r.scanned > 0 && !opts?.silent) {
        toast.message(`Scanned ${r.scanned} pending — no games final yet.`);
      }
    } finally {
      setResolving(false);
      setResolveProgress(null);
    }
  }, [resolving, refetch, qc]);

  // Auto-sweep once on mount (silent — only toasts when something
  // resolved, otherwise stays quiet).
  useEffect(() => {
    if (tableExists === false) return; // skip when migration missing
    void sweepPending({ silent: true });
    // intentionally fire-once; user can hit Refresh for re-sweep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableExists]);

  const filtered = useMemo(() => {
    switch (tab) {
      case "pending":  return rows.filter((r) => r.outcome === "pending");
      case "won":      return rows.filter((r) => r.outcome === "won");
      case "lost":     return rows.filter((r) => r.outcome === "lost");
      case "missed":   return rows.filter((r) => !r.user_placed && r.outcome !== "pending");
      case "manual":   return rows.filter((r) => r.source === "user_manual");
      case "analytics": return [];
    }
  }, [rows, tab]);

  const counts = useMemo(() => {
    const c = { pending: 0, won: 0, lost: 0, missed: 0, manual: 0 };
    for (const r of rows) {
      if (r.outcome === "pending") c.pending++;
      if (r.outcome === "won")     c.won++;
      if (r.outcome === "lost")    c.lost++;
      if (!r.user_placed && r.outcome !== "pending") c.missed++;
      if (r.source === "user_manual") c.manual++;
    }
    return c;
  }, [rows]);

  return (
    <div className="container mx-auto max-w-5xl px-4 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/"><ArrowLeft className="w-4 h-4" /></Link>
        </Button>
        <ClipboardList className="w-5 h-5 text-primary" />
        <h1 className="font-display font-bold text-2xl text-foreground">Recommended Parlays</h1>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => { await sweepPending(); await refetch(); }}
          disabled={isFetching || resolving}
          className="ml-auto gap-1"
          title="Settle pending parlays from ESPN final scores + box scores"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", (isFetching || resolving) && "animate-spin")} />
          {resolving && resolveProgress
            ? `Resolving ${resolveProgress.done}/${resolveProgress.total}`
            : "Refresh & resolve"}
        </Button>
        <Button size="sm" variant="default" onClick={() => setShowManualForm(true)} className="gap-1">
          <Plus className="w-3.5 h-3.5" />
          Manual entry
        </Button>
      </div>

      {tableExists === false && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-xs">
            <p className="font-bold text-amber-700 dark:text-amber-400">
              Parlay tracking database is not deployed yet.
            </p>
            <p className="text-muted-foreground mt-0.5">
              Run the Supabase migration:{" "}
              <code className="bg-muted px-1.5 py-0.5 rounded">supabase db push</code>{" "}
              (or apply <code className="bg-muted px-1.5 py-0.5 rounded">20260430200000_recommended_parlays.sql</code> in the dashboard).
              Until then auto-saves and manual entries can't persist.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-1 rounded-full bg-muted p-0.5 w-fit">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => {
          const c = (counts as Record<string, number>)[t];
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs font-bold transition-colors capitalize",
                tab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {TAB_LABELS[t]}
              {typeof c === "number" && c > 0 && (
                <span className="ml-1.5 text-[10px] tabular-nums opacity-80">{c}</span>
              )}
            </button>
          );
        })}
      </div>

      {tab === "analytics" ? (
        <RollupAnalytics rows={rows} />
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/20 px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {tab === "pending"
              ? "No pending parlays. Auto-saved recommendations will appear here when the optimizer runs."
              : `No ${TAB_LABELS[tab].toLowerCase()} parlays yet.`}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((row) => (
            <ParlayRowCard key={row.id} row={row} onUpdate={() => qc.invalidateQueries({ queryKey: ["recommended-parlays"] })} />
          ))}
        </div>
      )}

      {showManualForm && (
        <ManualParlayEntryForm
          onClose={() => setShowManualForm(false)}
          onSaved={() => {
            setShowManualForm(false);
            // Drop the user on the Manual tab so they actually see the
            // bet they just saved instead of staring at the empty
            // Pending list.
            setTab("manual");
            qc.invalidateQueries({ queryKey: ["recommended-parlays"] });
          }}
        />
      )}
    </div>
  );
}

// ── Analytics rollup ─────────────────────────────────────────────────────────

function RollupAnalytics({ rows }: { rows: RecommendedParlayRow[] }) {
  const bySport = useMemo(() => {
    const m = new Map<string, { won: number; lost: number; pending: number }>();
    for (const r of rows) {
      const s = r.sport_mix ?? "unknown";
      const cur = m.get(s) ?? { won: 0, lost: 0, pending: 0 };
      if (r.outcome === "won")     cur.won++;
      if (r.outcome === "lost")    cur.lost++;
      if (r.outcome === "pending") cur.pending++;
      m.set(s, cur);
    }
    return [...m.entries()];
  }, [rows]);

  const byTier = useMemo(() => {
    const m = new Map<string, { won: number; lost: number; pending: number }>();
    for (const r of rows) {
      const t = r.tier ?? "other";
      const cur = m.get(t) ?? { won: 0, lost: 0, pending: 0 };
      if (r.outcome === "won")     cur.won++;
      if (r.outcome === "lost")    cur.lost++;
      if (r.outcome === "pending") cur.pending++;
      m.set(t, cur);
    }
    return [...m.entries()];
  }, [rows]);

  const hitRate = (won: number, lost: number) => {
    const dec = won + lost;
    return dec ? `${Math.round((100 * won) / dec)}%` : "—";
  };

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="rounded-lg border border-border bg-card p-4 space-y-2">
        <h3 className="font-display font-bold text-sm flex items-center gap-2">
          <Trophy className="w-4 h-4 text-emerald-500" /> Hit rate by tier
        </h3>
        {byTier.length === 0 ? <p className="text-xs text-muted-foreground">No data yet.</p> : (
          <table className="w-full text-xs">
            <thead className="text-[10px] text-muted-foreground uppercase">
              <tr><th className="text-left">Tier</th><th className="text-right">W-L</th><th className="text-right">Hit %</th></tr>
            </thead>
            <tbody>
              {byTier.map(([k, v]) => (
                <tr key={k} className="border-t border-border/60">
                  <td className="py-1 capitalize">{k}</td>
                  <td className="py-1 text-right tabular-nums">{v.won}-{v.lost}</td>
                  <td className="py-1 text-right tabular-nums font-semibold">{hitRate(v.won, v.lost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="rounded-lg border border-border bg-card p-4 space-y-2">
        <h3 className="font-display font-bold text-sm flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-sky-500" /> Hit rate by sport mix
        </h3>
        {bySport.length === 0 ? <p className="text-xs text-muted-foreground">No data yet.</p> : (
          <table className="w-full text-xs">
            <thead className="text-[10px] text-muted-foreground uppercase">
              <tr><th className="text-left">Sport mix</th><th className="text-right">W-L</th><th className="text-right">Hit %</th></tr>
            </thead>
            <tbody>
              {bySport.map(([k, v]) => (
                <tr key={k} className="border-t border-border/60">
                  <td className="py-1">{k}</td>
                  <td className="py-1 text-right tabular-nums">{v.won}-{v.lost}</td>
                  <td className="py-1 text-right tabular-nums font-semibold">{hitRate(v.won, v.lost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

