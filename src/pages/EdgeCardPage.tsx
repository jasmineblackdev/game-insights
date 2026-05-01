/**
 * /edge — Analytics surface.
 *
 * Refactored from the old "team picks + best value + parlay builder + ML
 * analytics" hub. Pick-building lives on Home now; this page is purely
 * the analytics + saved-history readout so users can review model and
 * parlay performance without picker-UI noise on the same screen.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  BarChart3,
  Brain,
  History,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { useEdgeCard } from "@/context/EdgeCardContext";
import { PerformanceDashboard } from "@/components/valueParlay/PerformanceDashboard";
import { ParlayPerformanceDashboard } from "@/components/valueParlay/ParlayPerformanceDashboard";
import { TrainingDataHealthPanel } from "@/components/ml/TrainingDataHealthPanel";
import { ClvDashboard } from "@/components/insights/ClvDashboard";
import { BankrollWidget } from "@/components/bankroll/BankrollWidget";
import { MLPerformanceContent } from "@/pages/MLPerformancePage";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type EdgeSlipOutcome,
  isDraftEdgeSlipItem,
  isTeamSlipItem,
} from "@/lib/edgeCardScoring";

function leagueShort(l: string) {
  return l.toUpperCase();
}

type AnalyticsTab = "performance" | "ml_perf";

function EdgeCardPageInner() {
  const { history, setHistoryOutcome } = useEdgeCard();
  const [tab, setTab] = useState<AnalyticsTab>("performance");

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
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <Link
              to="/"
              className="flex items-center gap-2 min-h-10 text-sm text-muted-foreground hover:text-foreground transition-colors touch-manipulation shrink-0"
            >
              <ArrowLeft className="w-4 h-4 shrink-0" />
              Home
            </Link>
            <div className="h-4 w-px bg-border hidden sm:block" />
            <div className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-primary" />
              <div>
                <h1 className="font-display font-bold text-base text-foreground">Analytics</h1>
                <p className="text-[11px] text-muted-foreground">
                  ML model performance · parlay history · saved Edge Cards
                </p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="container max-w-6xl mx-auto py-5 sm:py-6 space-y-8">
        <BankrollWidget />

        {/* Performance / ML Perf sub-tabs — ML Perf used to be a
            separate top-level nav entry; folded in here so Analytics
            is the single hub for model + parlay + training-data
            insight. The /ml-performance route still works for direct
            links and renders the same MLPerformanceContent. */}
        <div className="inline-flex items-center rounded-full bg-muted p-0.5 gap-0.5">
          {([
            { id: "performance", icon: BarChart3, label: "Performance" },
            { id: "ml_perf",     icon: Brain,     label: "ML Perf" },
          ] as const).map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold transition-colors",
                tab === id
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          ))}
        </div>

        {tab === "ml_perf" ? (
          <MLPerformanceContent embedded />
        ) : (
          <>

        <section className="space-y-3">
          <ClvDashboard />
        </section>

        <section className="space-y-3 border-t border-border pt-8">
          <h2 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-confidence-high" />
            Model performance
          </h2>
          <PerformanceDashboard />
        </section>

        <section className="space-y-3 border-t border-border pt-8">
          <h2 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-primary" />
            Parlay performance
          </h2>
          <ParlayPerformanceDashboard />
        </section>

        <section className="space-y-3 border-t border-border pt-8">
          <h2 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-primary" />
            ML training coverage
          </h2>
          <TrainingDataHealthPanel />
        </section>

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
          </>
        )}
      </main>
    </div>
  );
}

export default function EdgeCardPage() {
  return <EdgeCardPageInner />;
}
