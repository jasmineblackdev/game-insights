/**
 * PaperBetCard — visual representation of a single paper ticket.
 *
 * Shows legs + per-leg status + auto-resolved actuals + the ticket
 * total P/L. For "open" / "needs_review" tickets, exposes manual
 * settle buttons (Won / Lost / Push / Void) so the user can resolve
 * legs the auto-resolver couldn't confidently match.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Check, X, Circle, AlertTriangle, Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { resolvePaperBet } from "@/lib/paperBets/resolver";
import { settlePaperBet, voidPaperBet } from "@/lib/paperBets/store";
import { americanToPayoutMultiplier } from "@/lib/paperBets/normalizer";
import type { PaperBet, PaperLeg, PaperLegStatus } from "@/lib/paperBets/types";

interface Props {
  bet: PaperBet;
  onChanged?: () => void;
}

export function PaperBetCard({ bet, onChanged }: Props) {
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await resolvePaperBet(bet);
      try {
        await settlePaperBet({
          betId: bet.id,
          status: r.status,
          pnl: r.pnl ?? 0,
          legs: r.legs,
        });
        toast.success(`Bet ${r.status.replace("_", " ")} — ${r.pnl != null ? formatPnl(r.pnl) : "still pending"}.`);
        onChanged?.();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Settle failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const manualSettle = async (legIdx: number, newStatus: PaperLegStatus) => {
    if (busy) return;
    setBusy(true);
    try {
      const updatedLegs: PaperLeg[] = bet.legs.map((l, i) =>
        i === legIdx ? { ...l, status: newStatus, resolvedReason: "Manual override.", resolvedAt: new Date().toISOString() } : l,
      );
      // Recompute roll-up off the updated legs.
      const allResolved = updatedLegs.every((l) => l.status !== "open");
      let parlayStatus: PaperBet["status"] = "in_progress";
      let pnl = 0;
      if (updatedLegs.some((l) => l.status === "lost")) {
        parlayStatus = "lost";
        pnl = -bet.stake;
      } else if (allResolved) {
        const won = updatedLegs.filter((l) => l.status === "won");
        if (won.length === updatedLegs.length) {
          const dec = updatedLegs.reduce((m, l) => m * americanToPayoutMultiplier(l.americanOdds), 1);
          parlayStatus = "won";
          pnl = Math.round(bet.stake * (dec - 1) * 100) / 100;
        } else if (updatedLegs.every((l) => l.status === "push" || l.status === "voided")) {
          parlayStatus = "push";
          pnl = 0;
        } else {
          parlayStatus = "won";
          // Recompute payout dropping pushed legs.
          const dec = won.reduce((m, l) => m * americanToPayoutMultiplier(l.americanOdds), 1);
          pnl = Math.round(bet.stake * (dec - 1) * 100) / 100;
        }
      } else if (updatedLegs.some((l) => l.status === "needs_review")) {
        parlayStatus = "needs_review";
      }
      try {
        await settlePaperBet({
          betId: bet.id,
          status: parlayStatus,
          pnl,
          legs: updatedLegs,
        });
        toast.success("Leg updated.");
        onChanged?.();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Update failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const onVoid = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await voidPaperBet(bet.id);
      toast.success("Paper bet voided.");
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Void failed.");
    } finally {
      setBusy(false);
    }
  };

  const tone = statusTone(bet.status);
  const pnlText = bet.pnl != null ? formatPnl(bet.pnl) : null;

  return (
    <div className={cn("rounded-lg border p-3 sm:p-4 space-y-3", tone)}>
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge status={bet.status} />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold">
          {bet.betType}
          {bet.legs.length > 1 ? ` · ${bet.legs.length} legs` : ""}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums ml-auto">
          ${bet.stake.toFixed(2)} risk · {bet.combinedOddsAmerican > 0 ? `+${bet.combinedOddsAmerican}` : bet.combinedOddsAmerican}
        </span>
      </div>

      <ul className="space-y-2">
        {bet.legs.map((l, i) => (
          <li key={i} className="rounded-md border border-border/40 bg-background/40 p-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <LegStatusIcon status={l.status} />
              <span className="text-[10px] uppercase font-bold text-muted-foreground">{l.sport}</span>
              <span className="flex-1 min-w-0 truncate text-sm font-semibold text-foreground">{l.dkLabel}</span>
              <span className="font-mono tabular-nums text-xs text-foreground">
                {l.americanOdds > 0 ? `+${l.americanOdds}` : l.americanOdds}
              </span>
            </div>
            {l.playerName || l.teamLabel ? (
              <p className="text-[11px] text-muted-foreground">
                {l.playerName ?? l.teamLabel}
                {l.statType ? ` · ${l.statType}` : ""}
                {l.direction && l.line != null ? ` · ${l.direction} ${l.line}` : ""}
              </p>
            ) : null}
            {l.resolvedActual != null || l.resolvedReason ? (
              <p className="text-[11px] text-foreground">
                {l.resolvedActual != null ? <span className="font-semibold">Actual {l.resolvedActual} · </span> : null}
                <span className="text-muted-foreground">{l.resolvedReason}</span>
              </p>
            ) : null}
            {l.status === "open" || l.status === "needs_review" ? (
              <div className="flex flex-wrap gap-1 pt-1">
                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => manualSettle(i, "won")} disabled={busy}>Won</Button>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => manualSettle(i, "lost")} disabled={busy}>Lost</Button>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => manualSettle(i, "push")} disabled={busy}>Push</Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {pnlText ? (
        <div className="text-sm font-bold text-foreground tabular-nums">
          P/L: <span className={cn(bet.pnl != null && bet.pnl > 0 ? "text-emerald-600 dark:text-emerald-400" : bet.pnl != null && bet.pnl < 0 ? "text-red-600 dark:text-red-400" : "")}>{pnlText}</span>
        </div>
      ) : null}

      {bet.notes ? (
        <p className="text-[11px] text-muted-foreground italic">"{bet.notes}"</p>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {(bet.status === "open" || bet.status === "in_progress" || bet.status === "needs_review") ? (
          <>
            <Button size="sm" variant="outline" className="gap-1 h-8 text-xs" onClick={refresh} disabled={busy}>
              <RefreshCw className={cn("w-3 h-3", busy ? "animate-spin" : "")} />
              Resolve from feeds
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground" onClick={onVoid} disabled={busy}>Void</Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Helpers / sub-components ──────────────────────────────────────────

function statusTone(s: PaperBet["status"]): string {
  if (s === "won") return "border-emerald-500/40 bg-emerald-500/[0.06]";
  if (s === "lost") return "border-red-500/40 bg-red-500/[0.06]";
  if (s === "push") return "border-blue-500/40 bg-blue-500/[0.06]";
  if (s === "voided") return "border-border/60 bg-muted/30";
  if (s === "needs_review") return "border-amber-500/40 bg-amber-500/[0.06]";
  if (s === "in_progress") return "border-primary/40 bg-primary/[0.04]";
  return "border-border/60 bg-card/40";
}

function StatusBadge({ status }: { status: PaperBet["status"] }) {
  const label =
    status === "needs_review" ? "NEEDS REVIEW"
    : status === "in_progress" ? "IN PROGRESS"
    : status.toUpperCase();
  const cls =
    status === "won" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
    : status === "lost" ? "bg-red-500/15 text-red-700 dark:text-red-400"
    : status === "push" ? "bg-blue-500/15 text-blue-700 dark:text-blue-400"
    : status === "voided" ? "bg-muted text-muted-foreground"
    : status === "needs_review" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
    : status === "in_progress" ? "bg-primary/15 text-primary"
    : "bg-muted text-muted-foreground";
  return <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", cls)}>{label}</span>;
}

function LegStatusIcon({ status }: { status: PaperLegStatus }) {
  if (status === "won") return <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />;
  if (status === "lost") return <X className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />;
  if (status === "push") return <Circle className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />;
  if (status === "voided") return <Circle className="w-3.5 h-3.5 text-muted-foreground" />;
  if (status === "needs_review") return <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />;
  return <Clock className="w-3.5 h-3.5 text-muted-foreground" />;
}

function formatPnl(pnl: number): string {
  if (pnl === 0) return "$0.00";
  const sign = pnl > 0 ? "+" : "−";
  return `${sign}$${Math.abs(pnl).toFixed(2)}`;
}
