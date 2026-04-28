/**
 * ProBetCard — top-of-home card surfacing the latest Pro Mode trade
 * decision. Three states map to status:
 *
 *   READY     — one bet to consider; user can Confirm or Dismiss
 *   WAIT      — passed filters but bankroll discipline says WAIT
 *   BLOCKED   — at least one hard gate failed; trade exists for audit
 *               but Confirm is disabled
 *
 * "Confirm" bridges the trade to recommended_parlays.user_placed=true
 * (downstream the resolver picks it up). "Dismiss" just closes the
 * card. The user is in charge of the actual bet placement on the
 * sportsbook — this app never auto-places.
 */

import { useEffect, useState } from "react";
import { Crown, CheckCircle2, X, Clock, ShieldAlert, Loader2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import {
  loadActiveProTrade,
  confirmProTrade,
  dismissProTrade,
  sweepExpiredProTrades,
  type ProTradeRow,
} from "@/lib/learning/proTradeQueue";

function fmtDollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

function statusTone(s: ProTradeRow["status"]): { cls: string; label: string; Icon: typeof Crown } {
  if (s === "ready") {
    return {
      cls: "border-emerald-500/40 bg-emerald-500/[0.06]",
      label: "READY",
      Icon: CheckCircle2,
    };
  }
  if (s === "wait") {
    return {
      cls: "border-amber-500/40 bg-amber-500/[0.06]",
      label: "WAIT",
      Icon: Clock,
    };
  }
  return {
    cls: "border-red-500/40 bg-red-500/[0.06]",
    label: "BLOCKED",
    Icon: ShieldAlert,
  };
}

export function ProBetCard() {
  const qc = useQueryClient();
  const enabled = isSupabaseConfigured && !!supabase;

  // Sweep expired rows on first mount; cheap, fire-and-forget.
  useEffect(() => { void sweepExpiredProTrades(); }, []);

  const { data: trade, isPending } = useQuery({
    queryKey: ["pro-trade-active"],
    enabled,
    staleTime: 30_000,
    queryFn: () => loadActiveProTrade(),
  });

  const confirmMut = useMutation({
    mutationFn: async (id: string) => {
      const ok = await confirmProTrade(id);
      if (!ok) throw new Error("confirm failed");
      // Bridge to recommended_parlays.user_placed if linked. Bridge
      // chooses source label app_recommended_and_placed which the
      // resolver / bridge already understand.
      if (trade?.parlay_id && supabase) {
        await supabase
          .from("recommended_parlays")
          .update({
            user_placed: true,
            source: "app_recommended_and_placed",
            placed_at: new Date().toISOString(),
          })
          .eq("id", trade.parlay_id);
      }
    },
    onSuccess: () => {
      toast.success("Pro Bet confirmed — go place it on your book");
      qc.invalidateQueries({ queryKey: ["pro-trade-active"] });
    },
    onError: () => toast.error("Couldn't confirm — try again"),
  });

  const dismissMut = useMutation({
    mutationFn: dismissProTrade,
    onSuccess: () => {
      toast.message("Pro Bet dismissed");
      qc.invalidateQueries({ queryKey: ["pro-trade-active"] });
    },
  });

  if (!enabled || isPending) return null;
  if (!trade) return null;

  const { cls, label, Icon } = statusTone(trade.status);
  const legs = trade.parlay_snapshot?.legs ?? [];
  const odds = trade.parlay_snapshot?.combinedAmericanOdds;
  const hitProb = trade.parlay_snapshot?.projectedHitProbability;
  const payoutMult = trade.parlay_snapshot?.projectedPayoutMultiplier;
  const projectedPayout = trade.stake > 0 && payoutMult
    ? trade.stake * payoutMult
    : null;

  return (
    <div className={cn("rounded-lg border-2 px-4 py-3", cls)}>
      <div className="flex items-start gap-3">
        <Crown className="w-5 h-5 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-bold tracking-wider uppercase text-foreground">Pro Mode Decision</span>
            <span className={cn(
              "inline-flex items-center gap-1 text-[10px] font-bold tracking-wider rounded-full px-2 py-0.5",
              trade.status === "ready" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
              trade.status === "wait"  && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
              trade.status === "blocked"&& "bg-red-500/15 text-red-700 dark:text-red-400",
            )}>
              <Icon className="w-3 h-3" />
              {label}
            </span>
            {trade.sport ? (
              <span className="text-[10px] text-muted-foreground uppercase">{trade.sport}</span>
            ) : null}
          </div>
          <div className="mt-2 space-y-1 text-sm">
            {legs.map((l, i) => (
              <p key={i} className="text-foreground">
                <span className="text-muted-foreground tabular-nums mr-1">{i + 1}.</span>
                {l.selectionLabel ?? "(leg)"}
                <span className="text-muted-foreground tabular-nums ml-2">
                  {l.americanOdds != null ? (l.americanOdds > 0 ? `+${l.americanOdds}` : l.americanOdds) : ""}
                </span>
              </p>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Stake</p>
              <p className="font-bold tabular-nums">{fmtDollars(trade.stake)}</p>
            </div>
            {projectedPayout != null ? (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Payout</p>
                <p className="font-bold tabular-nums">{fmtDollars(projectedPayout)}</p>
              </div>
            ) : null}
            {odds != null ? (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Combined</p>
                <p className="font-bold tabular-nums">{odds > 0 ? `+${odds}` : odds}</p>
              </div>
            ) : null}
            {hitProb != null ? (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Hit prob</p>
                <p className="font-bold tabular-nums">{Math.round(hitProb * 100)}%</p>
              </div>
            ) : null}
          </div>
          {trade.reason ? (
            <p className="text-xs text-muted-foreground mt-2">{trade.reason}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1"
          onClick={() => dismissMut.mutate(trade.id)}
          disabled={dismissMut.isPending}
        >
          <X className="w-3.5 h-3.5" />
          Dismiss
        </Button>
        <Button
          variant="default"
          size="sm"
          className="gap-1"
          onClick={() => confirmMut.mutate(trade.id)}
          disabled={trade.status === "blocked" || confirmMut.isPending}
          title={trade.status === "blocked" ? "Blocked by bankroll discipline / quality gates — see reason." : undefined}
        >
          {confirmMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
          {trade.status === "blocked" ? "Blocked" : trade.status === "wait" ? "Confirm anyway" : "Confirm Bet"}
        </Button>
      </div>
    </div>
  );
}
