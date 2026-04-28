/**
 * My Picks — full history of logged props, manual outcome marking,
 * and running accuracy stats broken down by confidence tier.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, XCircle, Minus, Clock, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SharpModeSettings } from "@/components/SharpModeSettings";
import { cn } from "@/lib/utils";
import {
  fetchMyPicks,
  fetchAccuracyStats,
  markPickOutcome,
  resolveOutcomes,
  type PickLogRow,
  type PickOutcome,
} from "@/lib/picksLog";

// ── Helpers ───────────────────────────────────────────────────────────────────

function betHeadline(row: PickLogRow): string {
  const st = row.stat_type.replace(/_/g, " ");
  if (row.stat_type === "fight_winner")  return "To Win";
  if (row.stat_type === "ko_tko")        return "Win by KO/TKO";
  if (row.stat_type === "submission")    return "Win by Submission";
  if (row.stat_type === "decision")      return "Win by Decision";
  if (row.stat_type === "draw")          return "Fight Ends in Draw";
  if (row.stat_type === "total_rounds")
    return `${row.direction === "MORE" ? "Over" : "Under"} ${row.line_value} Rounds`;
  return `${row.direction === "MORE" ? "Over" : "Under"} ${row.line_value} ${st}`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7)   return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function confBadgeClass(c: string): string {
  if (c === "HIGH") return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  if (c === "MED")  return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  return "bg-muted text-muted-foreground";
}

function OutcomeBadge({ outcome }: { outcome: PickOutcome }) {
  if (outcome === "win")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="w-3 h-3" /> Won
      </span>
    );
  if (outcome === "loss")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500/15 text-red-500">
        <XCircle className="w-3 h-3" /> Lost
      </span>
    );
  if (outcome === "push")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400">
        <Minus className="w-3 h-3" /> Push
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
      <Clock className="w-3 h-3" /> Pending
    </span>
  );
}

// ── Individual pick card ──────────────────────────────────────────────────────

function PickCard({ row, onMark }: { row: PickLogRow; onMark: (id: string, outcome: PickOutcome) => void }) {
  const headline = betHeadline(row);
  const isPending = row.outcome == null;

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card/80 p-4 flex flex-col gap-3",
        row.outcome === "win"  && "border-l-4 border-l-emerald-500/60",
        row.outcome === "loss" && "border-l-4 border-l-red-500/50",
        row.outcome === "push" && "border-l-4 border-l-amber-500/50",
        isPending              && "border-l-4 border-l-muted-foreground/30",
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground tracking-wider">
              {row.sport}
            </span>
            <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", confBadgeClass(row.confidence))}>
              {row.confidence}
            </span>
          </div>
          <p className="font-display font-bold text-sm text-foreground truncate">{row.player_name}</p>
          <p className="text-xs text-muted-foreground">{row.team} vs {row.opponent}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <OutcomeBadge outcome={row.outcome} />
          <span className="text-[10px] text-muted-foreground">{relativeTime(row.created_at)}</span>
        </div>
      </div>

      {/* Bet headline */}
      <div className="bg-muted/40 rounded-md px-3 py-2 text-center">
        <p className="font-display font-bold text-base text-foreground">{headline}</p>
        {row.actual_value != null && (
          <p className="text-xs text-muted-foreground mt-0.5">
            Actual: <span className="font-bold text-foreground">{row.actual_value}</span>
            {" · "}Line: {row.line_value}
          </p>
        )}
      </div>

      {/* Manual outcome controls — only for pending picks */}
      {isPending && (
        <div className="flex gap-2 pt-1 border-t border-border">
          <button
            type="button"
            onClick={() => onMark(row.id, "win")}
            className="flex-1 text-xs font-semibold py-1.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
          >
            Won
          </button>
          <button
            type="button"
            onClick={() => onMark(row.id, "loss")}
            className="flex-1 text-xs font-semibold py-1.5 rounded-md bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"
          >
            Lost
          </button>
          <button
            type="button"
            onClick={() => onMark(row.id, "push")}
            className="flex-1 text-xs font-semibold py-1.5 rounded-md bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
          >
            Push
          </button>
        </div>
      )}
    </div>
  );
}

// ── Accuracy stat bar ─────────────────────────────────────────────────────────

function AccuracyBar({ wins, losses, pushes, pending, winPct }: {
  wins: number; losses: number; pushes: number; pending: number; winPct: number | null;
}) {
  const resolved = wins + losses;
  return (
    <div className="flex flex-wrap items-center gap-4 text-sm">
      <span className="text-emerald-600 dark:text-emerald-400 font-bold">{wins}W</span>
      <span className="text-red-500 font-bold">{losses}L</span>
      {pushes > 0 && <span className="text-amber-600 dark:text-amber-400 font-bold">{pushes}P</span>}
      <span className="text-muted-foreground">{pending} pending</span>
      {resolved >= 3 && winPct != null && (
        <span className={cn(
          "font-black text-base px-3 py-0.5 rounded-full",
          winPct >= 60 ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" :
          winPct >= 50 ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" :
          "bg-red-500/15 text-red-500"
        )}>
          {winPct}%
        </span>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type OutcomeFilter = "all" | "pending" | "win" | "loss" | "push";
type ConfFilter    = "all" | "HIGH" | "MED" | "LOW";

export default function PicksPage() {
  const qc = useQueryClient();
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const [confFilter,    setConfFilter]    = useState<ConfFilter>("all");

  const { data: picks = [], isPending: picksLoading } = useQuery({
    queryKey: ["picks-log"],
    queryFn:  () => fetchMyPicks(),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const { data: accuracy } = useQuery({
    queryKey: ["picks-accuracy"],
    queryFn:  fetchAccuracyStats,
    staleTime: 60_000,
  });

  const markMutation = useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: PickOutcome }) =>
      markPickOutcome(id, outcome),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["picks-log"] });
      void qc.invalidateQueries({ queryKey: ["picks-accuracy"] });
    },
  });

  const autoResolveMutation = useMutation({
    mutationFn: resolveOutcomes,
    onSuccess: (resolved) => {
      if (resolved > 0) {
        void qc.invalidateQueries({ queryKey: ["picks-log"] });
        void qc.invalidateQueries({ queryKey: ["picks-accuracy"] });
      }
    },
  });

  const filtered = picks.filter((p) => {
    if (outcomeFilter !== "all" && (outcomeFilter === "pending" ? p.outcome != null : p.outcome !== outcomeFilter)) return false;
    if (confFilter    !== "all" && p.confidence !== confFilter) return false;
    return true;
  });

  const handleMark = (id: string, outcome: PickOutcome) => {
    markMutation.mutate({ id, outcome });
  };

  const OUTCOME_FILTERS: { value: OutcomeFilter; label: string }[] = [
    { value: "all",     label: "All" },
    { value: "pending", label: "Pending" },
    { value: "win",     label: "Won" },
    { value: "loss",    label: "Lost" },
    { value: "push",    label: "Push" },
  ];

  const CONF_FILTERS: { value: ConfFilter; label: string }[] = [
    { value: "all",  label: "All" },
    { value: "HIGH", label: "HIGH" },
    { value: "MED",  label: "MED" },
    { value: "LOW",  label: "LOW" },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* ── Header ──────────────────────────────────── */}
      <header className="border-b border-border surface-glass sticky top-0 z-40 pt-[env(safe-area-inset-top)]">
        <div className="container max-w-4xl mx-auto py-3 sm:py-4 flex items-center justify-between">
          <Link
            to="/"
            className="inline-flex items-center gap-2 min-h-10 text-sm text-muted-foreground hover:text-foreground transition-colors touch-manipulation -ml-1 px-1 rounded-md"
          >
            <ArrowLeft className="w-4 h-4 shrink-0" />
            Back
          </Link>
          <button
            type="button"
            onClick={() => autoResolveMutation.mutate()}
            disabled={autoResolveMutation.isPending}
            className="text-xs text-primary hover:underline disabled:opacity-50"
          >
            {autoResolveMutation.isPending ? "Checking ESPN…" : "Auto-resolve from ESPN"}
          </button>
        </div>
      </header>

      <main className="container max-w-4xl mx-auto py-6 sm:py-8 space-y-6">
        {/* Sharp Mode toggle — disciplined edge-only filter. Surface
            here for now; will move to a dedicated /settings route
            when one exists. */}
        <SharpModeSettings />

        {/* ── Title + accuracy ──────────────────────── */}
        <div className="space-y-3">
          <h1 className="font-display font-bold text-2xl sm:text-3xl text-foreground">My Picks</h1>
          <p className="text-sm text-muted-foreground">
            Every prop you've copied, tracked automatically. Mark outcomes manually or hit "Auto-resolve" to check ESPN box scores.
          </p>

          {accuracy && accuracy.total > 0 && (
            <div className="rounded-lg border border-border bg-card/60 p-4 space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">30-Day Accuracy</p>
              <AccuracyBar
                wins={accuracy.wins}
                losses={accuracy.losses}
                pushes={accuracy.pushes}
                pending={accuracy.pending}
                winPct={accuracy.winPct}
              />
              {Object.keys(accuracy.byConfidence).length > 0 && (
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground pt-1 border-t border-border">
                  {(["HIGH", "MED", "LOW"] as const).map((c) => {
                    const tier = accuracy.byConfidence[c];
                    if (!tier || tier.wins + tier.losses < 2) return null;
                    const pct = Math.round(tier.wins / (tier.wins + tier.losses) * 100);
                    return (
                      <span key={c}>
                        <span className={cn("font-bold", confBadgeClass(c).split(" ")[1])}>{c}</span>
                        {" "}{pct}% ({tier.wins}W-{tier.losses}L)
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Filters ───────────────────────────────── */}
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-wrap gap-1.5">
            {OUTCOME_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setOutcomeFilter(f.value)}
                className={cn(
                  "min-h-9 px-3 py-1 rounded-full text-xs font-semibold border transition-colors",
                  outcomeFilter === f.value
                    ? "bg-card text-foreground border-primary/40 shadow-sm"
                    : "border-transparent bg-muted/60 text-muted-foreground hover:text-foreground"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CONF_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setConfFilter(f.value)}
                className={cn(
                  "min-h-9 px-3 py-1 rounded-full text-xs font-semibold border transition-colors",
                  confFilter === f.value
                    ? "bg-card text-foreground border-primary/40 shadow-sm"
                    : "border-transparent bg-muted/60 text-muted-foreground hover:text-foreground"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Picks grid ────────────────────────────── */}
        {picksLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-48 rounded-lg border border-border bg-muted/30 animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 space-y-3">
            <TrendingUp className="w-10 h-10 mx-auto text-muted-foreground/40" />
            <p className="text-muted-foreground text-sm">
              {picks.length === 0
                ? "No picks logged yet. Go to Player Props and hit \"Copy Pick\" to start tracking."
                : "No picks match these filters."}
            </p>
            {picks.length === 0 && (
              <Button variant="outline" size="sm" asChild>
                <Link to="/">Browse Props</Link>
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((row) => (
              <PickCard key={row.id} row={row} onMark={handleMark} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
