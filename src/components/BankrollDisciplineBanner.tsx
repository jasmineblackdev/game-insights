/**
 * BankrollDisciplineBanner — surfaces Stop Loss / Profit Lock / Profit
 * Target states above the home / daily plan content. Quiet when state
 * is "ok" (no banner shown). Read-only — actual stake reductions are
 * applied at the autoProfit / suggestStake layer (next session).
 */

import { Shield, ShieldAlert, ShieldCheck, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBankroll } from "@/context/BankrollContext";
import { computeDiscipline } from "@/lib/bankroll/discipline";

export function BankrollDisciplineBanner() {
  const {
    isInitialized,
    currentBankroll,
    todayPnl,
    lossStreak,
    todaysExposure,
  } = useBankroll();

  if (!isInitialized) return null;
  if (currentBankroll <= 0) return null;

  const status = computeDiscipline({
    startOfDayBankroll: currentBankroll - todayPnl,
    currentBankroll,
    todayPnl,
    lossStreak,
    todaysExposure,
  });

  if (status.state === "ok") return null;

  const Icon =
    status.state === "stop_loss_hit"
      ? ShieldAlert
      : status.state === "profit_target"
        ? Trophy
        : status.state === "profit_locked"
          ? ShieldCheck
          : Shield;

  const tone =
    status.state === "stop_loss_hit"
      ? "border-red-500/40 bg-red-500/[0.06] text-red-700 dark:text-red-400"
      : status.state === "profit_target"
        ? "border-violet-500/40 bg-violet-500/[0.06] text-violet-700 dark:text-violet-400"
        : "border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-400";

  const label =
    status.state === "stop_loss_hit" ? "STOP LOSS"
    : status.state === "profit_target" ? "PROFIT TARGET"
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
