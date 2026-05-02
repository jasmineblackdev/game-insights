/**
 * /insights — System Health Dashboard.
 *
 * Decision-first layout:
 *   1. System Status (7d ROI / Hit / Avg CLV / Sample)
 *   2. Model Trust   (Brier / Calibration error / Status)
 *   3. Data Health   (Pending / Stale / Manual override rate)
 *   4. CLV dashboard (headline first; breakdowns hidden when empty)
 *   5. Saved Edge Cards (history readout)
 *   6. Advanced analytics — collapsed by default:
 *        Model performance · Parlay performance · ML training coverage · ML Perf
 *
 * BankrollWidget moved to Settings — Insights is read-only.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Brain,
  ChevronDown,
  ChevronUp,
  History,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { useEdgeCard } from "@/context/EdgeCardContext";
import { PerformanceDashboard } from "@/components/valueParlay/PerformanceDashboard";
import { ParlayPerformanceDashboard } from "@/components/valueParlay/ParlayPerformanceDashboard";
import { TrainingDataHealthPanel } from "@/components/ml/TrainingDataHealthPanel";
import { ClvDashboard } from "@/components/insights/ClvDashboard";
import {
  SystemStatusSection,
  ModelTrustSection,
  DataHealthSection,
} from "@/components/insights/SystemHealthSections";
import { MLPerformanceContent } from "@/pages/MLPerformancePage";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getSystemSummary } from "@/lib/insights/systemSummary";
import {
  type EdgeSlipOutcome,
  isDraftEdgeSlipItem,
  isTeamSlipItem,
} from "@/lib/edgeCardScoring";

function leagueShort(l: string) {
  return l.toUpperCase();
}

type AdvancedTab = "performance" | "parlay" | "training" | "ml_perf";

function EdgeCardPageInner() {
  const { history, setHistoryOutcome } = useEdgeCard();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedTab, setAdvancedTab] = useState<AdvancedTab>("performance");

  const summaryQuery = useQuery({
    queryKey: ["system-health-summary"],
    queryFn: getSystemSummary,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const historyRecord = useMemo(() => {
    let w = 0;
    let l = 0;
    let p = 0;
    for (const h of history) {
      if (h.outcome === "win") w++;
      else if (h.outcome === "loss") l++;
      else if (h.outcome === "push") p++;
    }
    const tracked = w + l + p;
    return { w, l, p, tracked };
  }, [history]);

  return (
    <div className="min-h-screen bg-background pb-12">
      <header className="border-b border-border surface-glass sticky top-0 z-40 pt-[env(safe-area-inset-top)]">
        <div className="container max-w-6xl mx-auto py-3 sm:py-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-primary" />
            <div>
              <h1 className="font-display font-bold text-base text-foreground">System Health</h1>
              <p className="text-[11px] text-muted-foreground">
                Recent ROI · model trust · data pipeline state
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="container max-w-6xl mx-auto py-5 sm:py-6 space-y-8">
        {/* ── Decision-first triplet ───────────────────────────────── */}
        <SystemStatusSection summary={summaryQuery.data ?? null} loading={summaryQuery.isPending} />
        <ModelTrustSection   summary={summaryQuery.data ?? null} loading={summaryQuery.isPending} />
        <DataHealthSection   summary={summaryQuery.data ?? null} loading={summaryQuery.isPending} />

        {/* ── CLV (headline first; breakdowns hide when empty) ─────── */}
        <section className="space-y-3 border-t border-border pt-8">
          <ClvDashboard />
        </section>

        {/* ── Saved Edge Cards ─────────────────────────────────────── */}
        <section className="space-y-3 border-t border-border pt-8">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
              <History className="w-4 h-4" />
              Saved Edge Cards
            </h2>
            {historyRecord.tracked > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Tracked:{" "}
                <span className="text-confidence-high font-semibold">{historyRecord.w}W</span> ·{" "}
                <span className="text-red-600 dark:text-red-400 font-semibold">{historyRecord.l}L</span>
                {historyRecord.p > 0 ? (
                  <>
                    {" "}
                    · <span className="text-foreground font-semibold">{historyRecord.p}P</span>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No saved cards yet. Build a parlay from Home and save it to start tracking.
            </p>
          ) : (
            <ul className="space-y-2">
              {history.slice(0, 12).map((h) => (
                <li
                  key={h.id}
                  className="rounded-md border border-border bg-card/50 px-3 py-2 text-xs text-muted-foreground space-y-2"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold text-foreground">Edge {h.size}</span>
                    <span>·</span>
                    <span>{new Date(h.savedAt).toLocaleString()}</span>
                    <span>·</span>
                    <span>{h.items.length} picks</span>
                    <span>·</span>
                    <span>conf {h.aggregateConfidence}</span>
                    <span>·</span>
                    <span>risk {h.riskLabel}</span>
                    {h.outcome ? (
                      <span
                        className={cn(
                          "ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full",
                          h.outcome === "win" && "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
                          h.outcome === "loss" && "bg-red-500/15 text-red-600 dark:text-red-400",
                          h.outcome === "push" && "bg-muted text-foreground"
                        )}
                      >
                        {h.outcome.toUpperCase()}
                      </span>
                    ) : null}
                  </div>
                  <span className="block text-[11px]">
                    {h.items
                      .map((x) =>
                        isTeamSlipItem(x)
                          ? `${leagueShort(x.league)} ${x.snapshot.pickedAbbr} vs ${x.snapshot.opponentAbbr}`
                          : isDraftEdgeSlipItem(x)
                            ? `Draft: ${x.snapshot.label}`
                            : x.snapshot.label
                      )
                      .join(" · ")}
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-[10px] text-muted-foreground mr-1">Result:</span>
                    {(["win", "loss", "push"] as const).map((o) => (
                      <Button
                        key={o}
                        type="button"
                        variant={h.outcome === o ? "default" : "outline"}
                        size="sm"
                        className={cn(
                          "h-7 text-[10px] px-2 capitalize",
                          h.outcome === o && o === "win" && "bg-emerald-600 hover:bg-emerald-600/90",
                          h.outcome === o && o === "loss" && "bg-red-600 hover:bg-red-600/90",
                          h.outcome === o && o === "push" && "bg-muted text-foreground"
                        )}
                        onClick={() => {
                          const next: EdgeSlipOutcome | null = h.outcome === o ? null : o;
                          setHistoryOutcome(h.id, next);
                          if (next) toast.success(`Marked ${next}`);
                        }}
                      >
                        {o}
                      </Button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Advanced analytics — collapsed by default ───────────── */}
        <section className="space-y-3 border-t border-border pt-8">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex items-center justify-between gap-2 w-full text-left group"
            aria-expanded={advancedOpen}
          >
            <h2 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary" />
              Advanced analytics
            </h2>
            <span className="text-[11px] text-muted-foreground group-hover:text-foreground inline-flex items-center gap-1">
              {advancedOpen ? "Hide" : "Show"}
              {advancedOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </span>
          </button>
          {advancedOpen ? (
            <div className="space-y-6">
              <div className="inline-flex items-center rounded-full bg-muted p-0.5 gap-0.5 flex-wrap">
                {([
                  { id: "performance", icon: TrendingUp, label: "Model" },
                  { id: "parlay",      icon: BarChart3,  label: "Parlay" },
                  { id: "training",    icon: BarChart3,  label: "Training" },
                  { id: "ml_perf",     icon: Brain,      label: "ML Perf" },
                ] as const).map(({ id, icon: Icon, label }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setAdvancedTab(id)}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors",
                      advancedTab === id
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="w-3 h-3" />
                    {label}
                  </button>
                ))}
              </div>

              {advancedTab === "performance" ? <PerformanceDashboard /> : null}
              {advancedTab === "parlay"      ? <ParlayPerformanceDashboard /> : null}
              {advancedTab === "training"    ? <TrainingDataHealthPanel /> : null}
              {advancedTab === "ml_perf"     ? <MLPerformanceContent embedded /> : null}
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

export default function EdgeCardPage() {
  return <EdgeCardPageInner />;
}
