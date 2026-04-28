/**
 * Compact bankroll widget — displayed on Home + Parlay Builder.
 * Shows current bankroll, today's P/L, and suggested stake sizing.
 * Click the chevron to open the full management panel.
 */

import { useState } from "react";
import { Wallet, ChevronDown, ChevronUp, Plus, Minus, TrendingUp, TrendingDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBankroll } from "@/context/BankrollContext";
import { BankrollPanel } from "./BankrollPanel";
import { LocalOnlyBadge } from "@/components/LocalOnlyBadge";
import { stageForBankroll } from "@/lib/bankroll/scalingLadder";
import { cn } from "@/lib/utils";

function fmt(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function BankrollWidget({ compact = false }: { compact?: boolean }) {
  const {
    isInitialized,
    startingBankroll,
    currentBankroll,
    todayPnl,
    totalPnl,
    stakeSuggestions,
    initStartingBankroll,
  } = useBankroll();

  const [open, setOpen] = useState(false);
  const [setupValue, setSetupValue] = useState("");

  // Wait for hydration so we don't flash "set bankroll" then snap to a value.
  if (!isInitialized) return null;

  const needsSetup = startingBankroll === 0 && currentBankroll === 0;

  if (needsSetup) {
    return (
      <div className="rounded-lg border border-border bg-card/60 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Wallet className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-display font-bold">Set your bankroll</h3>
          <LocalOnlyBadge className="ml-auto" />
        </div>
        <p className="text-xs text-muted-foreground">
          Enter your starting bankroll so we can suggest realistic stake sizes for each pick.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(setupValue);
            if (Number.isFinite(n) && n > 0) {
              initStartingBankroll(n);
              setSetupValue("");
            }
          }}
          className="flex gap-2"
        >
          <div className="relative flex-1">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
            <input
              type="number"
              inputMode="decimal"
              min="1"
              step="1"
              value={setupValue}
              onChange={(e) => setSetupValue(e.target.value)}
              placeholder="50"
              className="w-full h-9 rounded-md border border-input bg-background pl-6 pr-2 text-sm"
            />
          </div>
          <Button type="submit" size="sm" disabled={!setupValue || Number(setupValue) <= 0}>
            Save
          </Button>
        </form>
      </div>
    );
  }

  const todayPos = todayPnl > 0;
  const todayNeg = todayPnl < 0;

  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full p-3 flex items-center gap-3 hover:bg-muted/40 transition-colors text-left"
      >
        <Wallet className="w-4 h-4 text-primary shrink-0" />
        <LocalOnlyBadge />

        <div className="flex-1 min-w-0 grid grid-cols-3 gap-2">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Bankroll</p>
            <p className="text-sm font-bold tabular-nums">{fmt(currentBankroll)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Today</p>
            <p
              className={cn(
                "text-sm font-bold tabular-nums flex items-center gap-1",
                todayPos && "text-emerald-600 dark:text-emerald-400",
                todayNeg && "text-red-500",
              )}
            >
              {todayPos ? <TrendingUp className="w-3 h-3" /> : todayNeg ? <TrendingDown className="w-3 h-3" /> : null}
              {fmt(todayPnl)}
            </p>
          </div>
          {!compact ? (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Suggest</p>
              <p className="text-sm font-bold tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">${stakeSuggestions.low.stake}</span>
                <span className="text-muted-foreground"> · </span>
                <span className="text-amber-600 dark:text-amber-400">${stakeSuggestions.medium.stake}</span>
                <span className="text-muted-foreground"> · </span>
                <span className="text-red-500">${stakeSuggestions.high.stake}</span>
              </p>
            </div>
          ) : (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total P/L</p>
              <p
                className={cn(
                  "text-sm font-bold tabular-nums",
                  totalPnl > 0 && "text-emerald-600 dark:text-emerald-400",
                  totalPnl < 0 && "text-red-500",
                )}
              >
                {fmt(totalPnl)}
              </p>
            </div>
          )}
        </div>

        {open ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {open ? (
        <div className="border-t border-border p-3 sm:p-4 space-y-4">
          {/* Scaling Ladder — surface the bankroll stage so users
              understand WHY their stake suggestions are what they are. */}
          {(() => {
            const stage = stageForBankroll(currentBankroll);
            return (
              <div className="rounded-md border border-border/60 bg-background/40 p-2 flex items-start gap-2">
                <span className={cn(
                  "text-[10px] font-bold tracking-wider uppercase rounded-full px-2 py-0.5",
                  stage.stage === "beginner"   && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                  stage.stage === "building"   && "bg-sky-500/15 text-sky-700 dark:text-sky-400",
                  stage.stage === "established"&& "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
                  stage.stage === "pro"        && "bg-violet-500/15 text-violet-700 dark:text-violet-400",
                )}>
                  {stage.label}
                </span>
                <p className="text-[11px] text-muted-foreground leading-snug">
                  Max stake: <span className="font-bold text-foreground tabular-nums">{(stage.maxStakePct * 100).toFixed(0)}%</span> per bet
                  {" · "}
                  {stage.description}
                </p>
              </div>
            );
          })()}
          <BankrollPanel onClose={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

/** Inline "+/− deposit" chips for quick adjustments. Used by panel. */
export function BankrollQuickActions() {
  const { deposit, withdraw } = useBankroll();
  const [amt, setAmt] = useState("");

  const submit = (mode: "deposit" | "withdraw") => {
    const n = Number(amt);
    if (!Number.isFinite(n) || n <= 0) return;
    if (mode === "deposit") deposit(n, "Manual deposit");
    else withdraw(n, "Manual withdrawal");
    setAmt("");
  };

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="1"
          value={amt}
          onChange={(e) => setAmt(e.target.value)}
          placeholder="Amount"
          className="w-full h-9 rounded-md border border-input bg-background pl-6 pr-2 text-sm"
        />
      </div>
      <Button size="sm" variant="outline" onClick={() => submit("deposit")} disabled={!amt}>
        <Plus className="w-3 h-3" />
        Deposit
      </Button>
      <Button size="sm" variant="outline" onClick={() => submit("withdraw")} disabled={!amt}>
        <Minus className="w-3 h-3" />
        Withdraw
      </Button>
    </div>
  );
}
