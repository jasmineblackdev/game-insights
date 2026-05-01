/**
 * /paper — Paper Betting Mode page.
 *
 * Tabs: Slip Builder · Open · Settled · Performance
 *
 * PAPER MODE — fake money only. No DraftKings connection. Used to
 * test whether GameLens picks survive the round-trip through
 * DraftKings labelling before risking real bankroll.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PaperBetEntryForm } from "@/components/paperBets/PaperBetEntryForm";
import { PaperBetCard } from "@/components/paperBets/PaperBetCard";
import { PaperBankrollSummary } from "@/components/paperBets/PaperBankrollSummary";
import {
  getPaperBankroll,
  listPaperBets,
  settlePaperBet,
  PaperBetsMigrationMissingError,
} from "@/lib/paperBets/store";
import { resolvePaperBet } from "@/lib/paperBets/resolver";

type Tab = "build" | "open" | "settled" | "perf";

export default function PaperBetsPage() {
  const [tab, setTab] = useState<Tab>("build");
  const queryClient = useQueryClient();

  const bankrollQuery = useQuery({
    queryKey: ["paper-bankroll"],
    queryFn: getPaperBankroll,
    staleTime: 30_000,
    retry: false,
  });
  const betsQuery = useQuery({
    queryKey: ["paper-bets"],
    queryFn: () => listPaperBets({ status: "all", limit: 200 }),
    staleTime: 15_000,
    retry: false,
  });

  // Detect the most common deploy issue: migration not applied.
  const migrationMissing =
    bankrollQuery.error instanceof PaperBetsMigrationMissingError
    || betsQuery.error instanceof PaperBetsMigrationMissingError;
  const otherError = (bankrollQuery.error || betsQuery.error) as Error | undefined;

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["paper-bankroll"] });
    queryClient.invalidateQueries({ queryKey: ["paper-bets"] });
  }, [queryClient]);

  const bets = betsQuery.data ?? [];
  const open = useMemo(
    () => bets.filter((b) => b.status === "open" || b.status === "in_progress" || b.status === "needs_review"),
    [bets],
  );
  const settled = useMemo(
    () => bets.filter((b) => b.status === "won" || b.status === "lost" || b.status === "push" || b.status === "voided"),
    [bets],
  );

  // Auto-resolve sweep on Open tab visit. Best-effort; never blocks.
  const [sweeping, setSweeping] = useState(false);
  const sweep = useCallback(async () => {
    if (sweeping || !open.length) return;
    setSweeping(true);
    try {
      let changed = 0;
      for (const b of open) {
        const r = await resolvePaperBet(b);
        const becameTerminal = r.status !== "open" && r.status !== "in_progress";
        if (becameTerminal) {
          await settlePaperBet({
            betId: b.id,
            status: r.status,
            pnl: r.pnl ?? 0,
            legs: r.legs,
          });
          changed += 1;
        }
      }
      if (changed) {
        toast.success(`Resolved ${changed} paper bet${changed === 1 ? "" : "s"}.`);
        refresh();
      }
    } finally {
      setSweeping(false);
    }
  }, [open, sweeping, refresh]);

  useEffect(() => {
    if (tab === "open" && open.length) {
      // Fire once when the tab opens.
      sweep();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div className="container max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link to="/" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs">
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </Link>
          <h1 className="font-display font-bold text-xl text-foreground">Paper Bets</h1>
        </div>
        <Button size="sm" variant="outline" onClick={() => { refresh(); sweep(); }} disabled={sweeping} className="gap-1">
          <RefreshCw className={cn("w-3.5 h-3.5", sweeping ? "animate-spin" : "")} />
          Refresh
        </Button>
      </div>

      {migrationMissing ? (
        <div className="rounded-lg border border-red-500/50 bg-red-500/[0.06] p-4 text-sm space-y-2">
          <div className="flex items-start gap-2 text-red-700 dark:text-red-400 font-bold">
            <AlertTriangle className="w-4 h-4 mt-0.5" />
            <span>Paper Bets tables not deployed to Supabase.</span>
          </div>
          <p className="text-foreground">
            The page can't read or write paper bets because <code className="px-1 rounded bg-muted">paper_bets</code> /{" "}
            <code className="px-1 rounded bg-muted">paper_bankroll</code> don't exist in the project this deployment is pointing at.
          </p>
          <p className="text-muted-foreground">
            Apply the migration:
          </p>
          <pre className="text-[11px] bg-muted/40 rounded px-2 py-1.5 overflow-x-auto">
supabase/migrations/20260509000000_paper_bets.sql
          </pre>
          <p className="text-muted-foreground">
            Either via the Supabase CLI (<code className="text-foreground">supabase db push</code>) or by pasting the SQL into the
            Supabase dashboard → SQL editor → Run. Then refresh this page.
          </p>
          {otherError ? (
            <p className="text-[11px] text-muted-foreground">
              Raw error: <span className="text-foreground">{otherError.message}</span>
            </p>
          ) : null}
        </div>
      ) : otherError ? (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/[0.06] p-4 text-sm space-y-2">
          <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400 font-bold">
            <AlertTriangle className="w-4 h-4 mt-0.5" />
            <span>Couldn't load paper bets.</span>
          </div>
          <p className="text-foreground">{otherError.message}</p>
        </div>
      ) : null}

      <PaperBankrollSummary
        bankroll={bankrollQuery.data ?? null}
        bets={bets}
        onChanged={refresh}
        loading={bankrollQuery.isPending && !migrationMissing && !otherError}
      />

      <div className="flex flex-wrap gap-1 border-b border-border/60">
        <TabButton active={tab === "build"} onClick={() => setTab("build")}>Slip builder</TabButton>
        <TabButton active={tab === "open"} onClick={() => setTab("open")}>
          Open ({open.length})
        </TabButton>
        <TabButton active={tab === "settled"} onClick={() => setTab("settled")}>
          Settled ({settled.length})
        </TabButton>
        <TabButton active={tab === "perf"} onClick={() => setTab("perf")}>Performance</TabButton>
      </div>

      {tab === "build" ? (
        <PaperBetEntryForm onPlaced={refresh} />
      ) : null}

      {tab === "open" ? (
        <div className="space-y-3">
          {open.length === 0 ? (
            <p className="text-sm text-muted-foreground italic py-6 text-center">
              No open paper bets. Add one in Slip builder.
            </p>
          ) : (
            open.map((b) => <PaperBetCard key={b.id} bet={b} onChanged={refresh} />)
          )}
        </div>
      ) : null}

      {tab === "settled" ? (
        <div className="space-y-3">
          {settled.length === 0 ? (
            <p className="text-sm text-muted-foreground italic py-6 text-center">
              No settled paper bets yet.
            </p>
          ) : (
            settled.map((b) => <PaperBetCard key={b.id} bet={b} onChanged={refresh} />)
          )}
        </div>
      ) : null}

      {tab === "perf" ? (
        <PerformanceTab bets={settled} />
      ) : null}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-3 py-2 text-sm font-semibold border-b-2 transition-colors -mb-px",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function PerformanceTab({ bets }: { bets: import("@/lib/paperBets/types").PaperBet[] }) {
  if (bets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic py-6 text-center">
        Settle at least one bet to see performance breakdowns.
      </p>
    );
  }
  const totalStake = bets.reduce((s, b) => s + b.stake, 0);
  const totalPnl = bets.reduce((s, b) => s + (b.pnl ?? 0), 0);
  const won = bets.filter((b) => b.status === "won").length;
  const lost = bets.filter((b) => b.status === "lost").length;
  const push = bets.filter((b) => b.status === "push").length;
  const winRate = (won / Math.max(1, won + lost)) * 100;
  const avgStake = totalStake / bets.length;
  const avgOdds = bets.reduce((s, b) => s + b.combinedOddsAmerican, 0) / bets.length;
  const parlays = bets.filter((b) => b.betType === "parlay" || b.betType === "sgp");
  const parlayWon = parlays.filter((b) => b.status === "won").length;
  const parlayHit = parlays.length ? (parlayWon / parlays.length) * 100 : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <PerfStat label="Bets settled" value={`${bets.length}`} />
        <PerfStat label="Win rate" value={`${winRate.toFixed(1)}%`} />
        <PerfStat label="Total P/L" value={`${totalPnl >= 0 ? "+" : "−"}$${Math.abs(totalPnl).toFixed(2)}`} tone={totalPnl > 0 ? "win" : totalPnl < 0 ? "loss" : "neutral"} />
        <PerfStat label="ROI" value={`${totalStake > 0 ? ((totalPnl / totalStake) * 100).toFixed(1) : "0"}%`} />
        <PerfStat label="W-L-P" value={`${won}-${lost}-${push}`} />
        <PerfStat label="Avg stake" value={`$${avgStake.toFixed(2)}`} />
        <PerfStat label="Avg combined odds" value={Number.isFinite(avgOdds) ? `${avgOdds > 0 ? "+" : ""}${Math.round(avgOdds)}` : "—"} />
        <PerfStat label="Parlay hit rate" value={`${parlayHit.toFixed(1)}%`} />
      </div>
      <p className="text-[11px] text-muted-foreground italic">
        Paper results inform the calibration loop in V2 — they don't immediately overwrite model weights.
      </p>
    </div>
  );
}

function PerfStat({ label, value, tone }: { label: string; value: string; tone?: "win" | "loss" | "neutral" }) {
  return (
    <div className="rounded-md border border-border/40 bg-background/40 px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn(
        "text-base font-bold tabular-nums",
        tone === "win" ? "text-emerald-600 dark:text-emerald-400"
        : tone === "loss" ? "text-red-600 dark:text-red-400"
        : "text-foreground",
      )}>{value}</p>
    </div>
  );
}
