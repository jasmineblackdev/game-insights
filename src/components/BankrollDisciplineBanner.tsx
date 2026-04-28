/**
 * BankrollDisciplineBanner — surfaces Stop Loss / Profit Lock / Profit
 * Target states above the home / daily plan content. Quiet when state
 * is "ok" (no banner shown). Read-only — actual stake reductions are
 * applied at the autoProfit / suggestStake layer (next session).
 */

import { useEffect, useState } from "react";
import { Shield, ShieldAlert, ShieldCheck, Trophy, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBankroll } from "@/context/BankrollContext";
import { computeDiscipline } from "@/lib/bankroll/discipline";
import { pokeSessionHigh } from "@/lib/bankroll/sessionHigh";

export function BankrollDisciplineBanner() {
  const {
    isInitialized,
    currentBankroll,
    todayPnl,
    lossStreak,
    todaysExposure,
  } = useBankroll();

  // Track today's session high in localStorage. The poke updates the
  // stored value when current exceeds it; the returned value is what
  // we feed into computeDiscipline so trailing-drawdown can fire.
  const [sessionHigh, setSessionHigh] = useState<number | null>(null);
  useEffect(() => {
    if (!isInitialized || currentBankroll <= 0) return;
    setSessionHigh(pokeSessionHigh(currentBankroll));
  }, [isInitialized, currentBankroll]);

  if (!isInitialized) return null;
  if (currentBankroll <= 0) return null;

  const status = computeDiscipline({
    startOfDayBankroll: currentBankroll - todayPnl,
    currentBankroll,
    todayPnl,
    lossStreak,
    todaysExposure,
    sessionHigh,
  });

  if (status.state === "ok") return null;

  const Icon =
    status.state === "stop_loss_hit"
      ? ShieldAlert
      : status.state === "profit_target"
        ? Trophy
        : status.state === "profit_locked"
          ? ShieldCheck
          : status.state === "drawdown_wait"
            ? TrendingDown
            : Shield;

  const tone =
    status.state === "stop_loss_hit"
      ? "border-red-500/40 bg-red-500/[0.06] text-red-700 dark:text-red-400"
      : status.state === "profit_target"
        ? "border-violet-500/40 bg-violet-500/[0.06] text-violet-700 dark:text-violet-400"
        : status.state === "drawdown_wait"
          ? "border-amber-500/40 bg-amber-500/[0.06] text-amber-700 dark:text-amber-400"
          : "border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-400";

  const label =
    status.state === "stop_loss_hit" ? "STOP LOSS"
    : status.state === "profit_target" ? "PROFIT TARGET"
    : status.state === "drawdown_wait" ? "DRAWDOWN WAIT"
    : "PROFIT LOCK";

  return (
    <div className={cn("rounded-lg border px-4 py-3 flex items-start gap-3", tone)}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-bold text-sm text-foreground">
          {label}
          {status.stakeMultiplier > 0 && status.state !== "stop_loss_hit" ? (
            <span className="text-xs text-muted-foreground font-normal ml-2">
              · stakes ×{status.stakeMultiplier.toFixed(2)}
            </span>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">{status.reason}</p>
      </div>
    </div>
  );
}
