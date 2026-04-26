/**
 * HomeMoveCard — compact "Today's Move" card for Home.
 *
 * Strips the full AutoProfitCard down to: action label, recommended
 * ticket (or "no bet" message), suggested stake, payout, 1–2 reasons,
 * and two buttons (Add to Slip + Open Daily Plan). Heavier
 * interactivity (lock, regenerate, replace weakest) lives on /daily.
 */

import { Link } from "react-router-dom";
import { ArrowRight, Plus, Sparkles, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildAutoProfit,
  deriveAdjustedStake,
  actionLabel,
  actionBadgeClass,
  modeBadgeClass,
  modeLabel,
} from "@/lib/dailyPlan/autoProfit";
import type { DailyPlanCard } from "@/lib/dailyPlan/dailyPlanGenerator";
import { useBankroll } from "@/context/BankrollContext";
import { useValueParlay } from "@/context/ValueParlayContext";

function formatAmerican(o: number): string {
  return o > 0 ? `+${o}` : `${o}`;
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function HomeMoveCard({ plan }: { plan: DailyPlanCard[] }) {
  const { addValueLeg } = useValueParlay();
  const {
    currentBankroll,
    suggestStake,
    lossStreak,
    winStreak,
    hadLossToday,
    todaysExposure,
  } = useBankroll();

  const auto = buildAutoProfit({
    plan,
    currentBankroll,
    lossStreak,
    winStreak,
    hadLossToday,
    todaysExposure,
  });

  const ticket = auto.ticket;
  const baseStake = ticket ? suggestStake(ticket.stakeRisk).stake : 0;
  const adjusted = deriveAdjustedStake({
    baseStake,
    currentBankroll,
    lossStreak,
    todaysExposure,
    action: auto.action,
  });

  const addAllToSlip = () => {
    if (!ticket) return;
    let added = 0;
    for (const l of ticket.legs) {
      const r = addValueLeg(l);
      if (r.ok) added++;
    }
    if (added) toast.success(`Added ${added} leg${added === 1 ? "" : "s"} to slip`);
    else toast.message("Already on slip");
  };

  // No-bet branch — clear empty state, never shows "no qualifying build"
  if (auto.mode === "no_bet" || !ticket || !ticket.result) {
    return (
      <div className="rounded-lg border border-border bg-card/60 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h2 className="font-display font-bold text-sm text-foreground">Today&rsquo;s Move</h2>
          <span className={cn(
            "ml-auto text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full border uppercase",
            modeBadgeClass(auto.mode),
          )}>
            {modeLabel(auto.mode)}
          </span>
        </div>
        <div className="rounded-md border border-dashed border-border p-4 space-y-2">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-muted-foreground" />
            <p className="font-bold text-foreground text-sm">No strong plays right now</p>
          </div>
          <p className="text-xs text-muted-foreground">
            Wait for a better setup or take a small bet only. Stronger picks tend to surface as lineup
            confirmations land closer to game time.
          </p>
        </div>
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link to="/daily" className="text-xs">
              <Sparkles className="w-3.5 h-3.5" />
              Open Daily Plan
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  const hitPct = Math.round((ticket.result.projectedHitProbability ?? 0) * 100);
  const payoutAmount = adjusted.stake * (ticket.result.projectedPayoutMultiplier ?? 1);

  return (
    <div className="rounded-lg border border-primary/20 bg-gradient-to-br from-primary/5 to-card/60 p-5 space-y-3">
      {/* Header: title + mode + action */}
      <div className="flex items-center gap-2 flex-wrap">
        <Sparkles className="w-4 h-4 text-primary" />
        <h2 className="font-display font-bold text-sm text-foreground">Today&rsquo;s Move</h2>
        <span className={cn(
          "ml-auto text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full border uppercase",
          modeBadgeClass(auto.mode),
        )}>
          {modeLabel(auto.mode)}
        </span>
        <span className={cn(
          "text-xs font-black tracking-wide px-3 py-1 rounded-full uppercase shadow-sm",
          actionBadgeClass(auto.action),
        )}>
          {actionLabel(auto.action)}
        </span>
      </div>

      {/* Ticket headline */}
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground capitalize">
          {ticket.tier} · {ticket.legs.length} leg{ticket.legs.length === 1 ? "" : "s"} ·{" "}
          <span className="tabular-nums">{formatAmerican(ticket.result.combinedAmericanOdds)}</span>{" "}· hit {hitPct}%
        </p>
        <ul className="space-y-0.5">
          {ticket.legs.slice(0, 3).map((l) => (
            <li key={l.id} className="text-sm font-semibold text-foreground truncate">
              · {l.selectionLabel}
            </li>
          ))}
        </ul>
      </div>

      {/* Stake / payout — one compact row */}
      {auto.action !== "SKIP" && auto.action !== "WAIT" && adjusted.stake > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2 text-sm">
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Stake</span>
            <p className="font-bold tabular-nums">${adjusted.stake}</p>
          </div>
          <div className="text-right">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Pays</span>
            <p className="font-bold tabular-nums">{fmtMoney(payoutAmount)}</p>
          </div>
        </div>
      ) : null}

      {/* 1–2 reasons */}
      <p className="text-xs text-muted-foreground leading-snug">{auto.reason}</p>
      {auto.notes.length > 0 ? (
        <p className="text-[11px] text-muted-foreground/80 italic leading-snug">{auto.notes[0]}</p>
      ) : null}

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="default"
          className="flex-1"
          onClick={addAllToSlip}
          disabled={auto.action === "SKIP" || auto.action === "WAIT"}
        >
          <Plus className="w-3.5 h-3.5" />
          Add to Slip
        </Button>
        <Button asChild variant="outline" size="sm" className="flex-1">
          <Link to="/daily">
            <Sparkles className="w-3.5 h-3.5" />
            Open Daily Plan
          </Link>
        </Button>
      </div>
    </div>
  );
}
