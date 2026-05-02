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
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { cn } from "@/lib/utils";
import { PaperBetEntryForm } from "@/components/paperBets/PaperBetEntryForm";
import { PaperBetCard } from "@/components/paperBets/PaperBetCard";
import { PaperHeaderTiles } from "@/components/paperBets/PaperHeaderTiles";
import { MySlipsTable } from "@/components/paperBets/MySlipsTable";
import {
  getPaperBankroll,
  listPaperBets,
  markPaperBetNeedsReview,
  settlePaperBet,
  updatePaperBetLegs,
  PaperBetsMigrationMissingError,
} from "@/lib/paperBets/store";
import { resolvePaperBet } from "@/lib/paperBets/resolver";
import { useLiveBetTracker } from "@/hooks/useLiveBetTracker";

type Tab = "build" | "open" | "settled" | "perf" | "myslips";

export default function PaperBetsPage() {
  const [tab, setTab] = useState<Tab>("build");
  /** When set, the slip builder hydrates from this draft id on mount. */
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
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

  // Live-bet tracker — polls ESPN every 60s for any open bets with
  // bet_timing="live". Updates live_state during the game and
  // auto-settles when the game flips to FINAL via the existing
  // resolver path (resolved_via='espn'). Page-visibility gated.
  useLiveBetTracker({ bets, onChanged: refresh });
  const settled = useMemo(
    () => bets.filter((b) => b.status === "won" || b.status === "lost" || b.status === "push" || b.status === "voided"),
    [bets],
  );

  // Auto-resolve sweep on Open tab visit. Best-effort; never blocks.
  // Per-pass summary tracks resolved / pending / needs-review / failed
  // so the user gets honest feedback, not just "Resolved X".
  const [sweeping, setSweeping] = useState(false);
  const sweep = useCallback(
    async (opts?: { betIds?: string[]; silent?: boolean }) => {
      if (sweeping) return;
      const candidates = opts?.betIds
        ? open.filter((b) => opts.betIds!.includes(b.id))
        : open;
      if (!candidates.length) return;
      setSweeping(true);
      try {
        let resolved = 0;
        let pending = 0;
        let needsReview = 0;
        let failed = 0;
        for (const b of candidates) {
          try {
            const r = await resolvePaperBet(b);
            const becameTerminal =
              r.status === "won" || r.status === "lost" ||
              r.status === "push" || r.status === "voided";
            if (becameTerminal) {
              await settlePaperBet({
                betId: b.id,
                status: r.status,
                pnl: r.pnl ?? 0,
                legs: r.legs,
                resolvedVia: "espn",
              });
              resolved += 1;
            } else if (r.status === "needs_review") {
              await markPaperBetNeedsReview(b.id, r.legs);
              needsReview += 1;
            } else {
              // Still open / in_progress — game not final. Persist the
              // updated legs (with their resolutionDiagnosis) so the
              // per-leg "Pending — game not final" surfaces in the UI
              // without flipping status to needs_review.
              await updatePaperBetLegs(b.id, r.legs).catch(() => {});
              pending += 1;
            }
          } catch (e) {
            console.warn("[paper-sweep] bet failed:", b.id, e);
            failed += 1;
          }
        }
        if (!opts?.silent) {
          const parts: string[] = [];
          if (resolved)    parts.push(`${resolved} resolved`);
          if (pending)     parts.push(`${pending} pending`);
          if (needsReview) parts.push(`${needsReview} needs review`);
          if (failed)      parts.push(`${failed} failed`);
          if (parts.length) {
            const msg = parts.join(" · ");
            if (resolved && !failed && !needsReview) toast.success(msg);
            else if (failed)                          toast.error(msg);
            else                                      toast.message(msg);
          }
        }
        if (resolved + pending + needsReview > 0) refresh();
      } finally {
        setSweeping(false);
      }
    },
    [open, sweeping, refresh],
  );

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
        <h1 className="font-display font-bold text-xl text-foreground">Paper Bets</h1>
        <Button size="sm" variant="outline" onClick={() => { refresh(); sweep(); }} disabled={sweeping} className="gap-1">
          <RefreshCw className={cn("w-3.5 h-3.5", sweeping ? "animate-spin" : "")} />
          Refresh
        </Button>
      </div>

      {migrationMissing ? (
        <PaperMigrationMissingCard rawError={otherError} />
      ) : otherError ? (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/[0.06] p-4 text-sm space-y-2">
          <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400 font-bold">
            <AlertTriangle className="w-4 h-4 mt-0.5" />
            <span>Couldn't load paper bets.</span>
          </div>
          <p className="text-foreground">{otherError.message}</p>
        </div>
      ) : (
        <PaperReadyCard />
      )}

      <PaperHeaderTiles
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
        <TabButton active={tab === "myslips"} onClick={() => setTab("myslips")}>My Slips</TabButton>
      </div>

      {tab === "build" ? (
        <PaperBetEntryForm
          onPlaced={() => {
            setEditingDraftId(null);
            refresh();
          }}
          loadDraftId={editingDraftId}
          onDraftSaved={refresh}
        />
      ) : null}

      {tab === "open" ? (
        <div className="space-y-3">
          {open.length === 0 ? (
            <p className="text-sm text-muted-foreground italic py-6 text-center">
              No open paper bets. Add one in Slip builder.
            </p>
          ) : (
            open.map((b) => (
              <PaperBetCard
                key={b.id}
                bet={b}
                onChanged={refresh}
                onEditBet={(draftId) => {
                  setEditingDraftId(draftId);
                  setTab("build");
                }}
              />
            ))
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

      {tab === "myslips" ? (
        <MySlipsTable
          bets={bets}
          onEditDraft={(id) => {
            setEditingDraftId(id);
            setTab("build");
          }}
          onNewSlip={() => {
            setEditingDraftId(null);
            setTab("build");
          }}
          onChange={refresh}
        />
      ) : null}
    </div>
  );
}

/**
 * Green confirmation tile shown when the migration IS applied. Replaces
 * the old red error banner that showed even on healthy installs and made
 * the page look broken on first visit.
 */
function PaperReadyCard() {
  return (
    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/[0.05] p-3 sm:p-4 flex items-start gap-3">
      <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-foreground">Paper mode is ready</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Track bets, test strategies, and measure performance — fake money only, no DraftKings connection.
        </p>
      </div>
      <Disclosure variant="chevron" title={<span className="text-xs font-semibold">How it works</span>}>
        <ul className="text-[11px] text-muted-foreground leading-relaxed list-disc pl-4 space-y-1 mt-1">
          <li>Type a DraftKings selection verbatim — the normalizer extracts market / stat / line.</li>
          <li>Add multiple legs to build a parlay; SGP is auto-detected when legs share a game id.</li>
          <li>Auto-resolve sweeps the Open tab against ESPN final scores when you visit it.</li>
          <li>Live bets capture a game-state snapshot at entry and resolve through the same pipeline.</li>
          <li>Performance breaks down by sport / market / odds band, with Live and Pregame tracked separately.</li>
        </ul>
      </Disclosure>
    </div>
  );
}

/**
 * Helpful empty state when the Supabase migration hasn't been applied
 * yet. Clear primary action ("Run migration") with the exact filename
 * to copy, plus one-line CLI fallback.
 */
function PaperMigrationMissingCard({ rawError }: { rawError?: Error }) {
  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-500/[0.05] p-4 space-y-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-foreground">One-time setup needed</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Apply the Paper Bets migration to your Supabase project — then refresh this page.
          </p>
        </div>
      </div>
      <div className="rounded-md bg-muted/40 px-3 py-2 space-y-1.5">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Migration file</p>
        <pre className="text-[11px] overflow-x-auto text-foreground">
supabase/migrations/20260509000000_paper_bets.sql
        </pre>
      </div>
      <div className="text-[11px] text-muted-foreground space-y-1">
        <p>
          Run via CLI: <code className="text-foreground bg-muted/40 px-1 rounded">supabase db push</code>{" "}
          — or paste the file into Supabase dashboard → SQL editor → Run.
        </p>
        <p>
          The 20260510 file (<code className="text-foreground bg-muted/40 px-1 rounded">paper_bets_live_timing.sql</code>)
          adds live-tracking columns; apply it too if you want the Live vs Pregame split.
        </p>
      </div>
      {rawError ? (
        <p className="text-[10px] text-muted-foreground">
          Raw error: <span className="text-foreground">{rawError.message}</span>
        </p>
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

      <LiveVsPregameBreakdown bets={bets} />

      <p className="text-[11px] text-muted-foreground italic">
        Paper results inform the calibration loop in V2 — they don't immediately overwrite model weights.
        Live and pregame results are tracked separately so live-bet patterns don't leak into pregame calibration.
      </p>
    </div>
  );
}

/**
 * Live vs Pregame breakdown — segments by sport, market, period
 * entered, and odds band so the user can see whether live entries
 * are profitable distinct from pregame entries.
 */
function LiveVsPregameBreakdown({
  bets,
}: {
  bets: import("@/lib/paperBets/types").PaperBet[];
}) {
  const live = bets.filter((b) => b.betTiming === "live");
  const pregame = bets.filter((b) => b.betTiming !== "live");

  if (bets.length === 0) return null;

  const summarize = (set: import("@/lib/paperBets/types").PaperBet[]) => {
    const w = set.filter((b) => b.status === "won").length;
    const l = set.filter((b) => b.status === "lost").length;
    const p = set.filter((b) => b.status === "push").length;
    const pnl = set.reduce((s, b) => s + (b.pnl ?? 0), 0);
    const stake = set.reduce((s, b) => s + b.stake, 0);
    return {
      n: set.length,
      hitRate: (w / Math.max(1, w + l)) * 100,
      pnl,
      roi: stake > 0 ? (pnl / stake) * 100 : 0,
      record: `${w}-${l}-${p}`,
    };
  };

  const liveAgg = summarize(live);
  const preAgg = summarize(pregame);

  // Aggregator keyed by an arbitrary string, returns same hit/ROI shape.
  function bucket<K extends string>(
    set: import("@/lib/paperBets/types").PaperBet[],
    keyFn: (b: import("@/lib/paperBets/types").PaperBet) => K | null,
  ): { key: K; n: number; hitRate: number; roi: number }[] {
    const map = new Map<K, import("@/lib/paperBets/types").PaperBet[]>();
    for (const b of set) {
      const k = keyFn(b);
      if (k == null) continue;
      const arr = map.get(k) ?? [];
      arr.push(b);
      map.set(k, arr);
    }
    return [...map.entries()]
      .map(([key, arr]) => {
        const s = summarize(arr);
        return { key, n: s.n, hitRate: s.hitRate, roi: s.roi };
      })
      .sort((a, b) => b.n - a.n);
  }

  const oddsBand = (american: number): string => {
    if (!Number.isFinite(american)) return "—";
    if (american <= -200) return "≤-200";
    if (american <= -110) return "-200..-110";
    if (american <= 100)  return "-110..+100";
    if (american <= 200)  return "+100..+200";
    return "+200+";
  };

  // Live-bet segmentation: by sport, market, period, odds band.
  const bySport  = bucket(live, (b) => (b.legs[0]?.sport ?? null));
  const byMarket = bucket(live, (b) => (b.legs[0]?.marketType ?? null));
  const byPeriod = bucket(live, (b) => b.liveState?.period ?? null);
  const byOdds   = bucket(live, (b) => oddsBand(b.combinedOddsAmerican));

  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/[0.04] p-3 space-y-3">
      <p className="text-sm font-bold text-foreground">Live vs Pregame</p>
      <div className="grid grid-cols-2 gap-2">
        <PerfBlock title="Pregame" agg={preAgg} />
        <PerfBlock title="Live"    agg={liveAgg} highlight />
      </div>

      {live.length > 0 ? (
        <details className="rounded-md border border-border/40 bg-background/40 p-2 text-xs">
          <summary className="font-semibold text-foreground cursor-pointer select-none">
            Live segmentation ({live.length} live bets)
          </summary>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
            <SegmentBlock title="By sport"  rows={bySport} />
            <SegmentBlock title="By market" rows={byMarket} />
            <SegmentBlock title="By period entered" rows={byPeriod} />
            <SegmentBlock title="By odds band"      rows={byOdds} />
          </div>
        </details>
      ) : (
        <p className="text-[11px] text-muted-foreground italic">
          No live bets yet — toggle "Track Live Bet" in the slip builder to start.
        </p>
      )}
    </div>
  );
}

function PerfBlock({
  title, agg, highlight,
}: {
  title: string;
  agg: { n: number; hitRate: number; pnl: number; roi: number; record: string };
  highlight?: boolean;
}) {
  return (
    <div className={cn(
      "rounded-md border px-3 py-2",
      highlight ? "border-blue-500/40 bg-blue-500/[0.06]" : "border-border/40 bg-background/40",
    )}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="text-lg font-bold tabular-nums text-foreground">
        {agg.n} {agg.n === 1 ? "bet" : "bets"}
      </p>
      <div className="text-[11px] text-muted-foreground tabular-nums">
        {agg.record} · Hit {agg.hitRate.toFixed(0)}% · ROI {agg.roi >= 0 ? "+" : "−"}{Math.abs(agg.roi).toFixed(1)}%
      </div>
      <div className={cn(
        "text-[11px] tabular-nums font-semibold",
        agg.pnl > 0 ? "text-emerald-600 dark:text-emerald-400"
        : agg.pnl < 0 ? "text-red-600 dark:text-red-400"
        : "text-muted-foreground",
      )}>
        P/L {agg.pnl >= 0 ? "+" : "−"}${Math.abs(agg.pnl).toFixed(2)}
      </div>
    </div>
  );
}

function SegmentBlock({
  title, rows,
}: {
  title: string;
  rows: { key: string; n: number; hitRate: number; roi: number }[];
}) {
  return (
    <div className="rounded-md border border-border/30 bg-muted/20 p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {rows.length === 0 ? (
          <li className="text-muted-foreground italic">No data yet.</li>
        ) : rows.map((r) => (
          <li key={r.key} className="flex items-center justify-between gap-2">
            <span className="uppercase font-semibold text-foreground truncate">{r.key}</span>
            <span className="tabular-nums text-muted-foreground">
              {r.n}b · {r.hitRate.toFixed(0)}% · {r.roi >= 0 ? "+" : "−"}{Math.abs(r.roi).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
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
