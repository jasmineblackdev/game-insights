/**
 * BankrollPanel — expanded view shown inside BankrollWidget.
 * Renders the three-tier stake suggestion grid, deposit/withdraw form,
 * recent event log, and the (hidden) reset action.
 */

import { useMemo, useState } from "react";
import { useBankroll } from "@/context/BankrollContext";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { BankrollQuickActions } from "./BankrollWidget";
import { Trash2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

function fmt(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function BankrollPanel({ onClose }: { onClose?: () => void }) {
  const {
    startingBankroll,
    currentBankroll,
    todayPnl,
    totalPnl,
    events,
    stakeSuggestions,
    reset,
  } = useBankroll();
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetValue, setResetValue] = useState("");

  const recent = useMemo(() => [...events].reverse().slice(0, 8), [events]);

  return (
    <div className="space-y-4">
      {/* Top row — totals */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md border border-border bg-muted/40 p-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Starting</p>
          <p className="text-sm font-bold tabular-nums">{fmt(startingBankroll)}</p>
        </div>
        <div className="rounded-md border border-border bg-muted/40 p-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Today</p>
          <p
            className={cn(
              "text-sm font-bold tabular-nums",
              todayPnl > 0 && "text-emerald-600 dark:text-emerald-400",
              todayPnl < 0 && "text-red-500",
            )}
          >
            {fmt(todayPnl)}
          </p>
        </div>
        <div className="rounded-md border border-border bg-muted/40 p-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">All-time</p>
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
      </div>

      {/* Stake suggestions */}
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Suggested stake by risk</p>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2">
            <p className="text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400 font-bold">Low</p>
            <p className="text-base font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
              ${stakeSuggestions.low.stake}
            </p>
            <p className="text-[9px] text-muted-foreground">{pct(stakeSuggestions.low.pctOfBankroll)} of roll</p>
          </div>
          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2">
            <p className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400 font-bold">Medium</p>
            <p className="text-base font-bold tabular-nums text-amber-700 dark:text-amber-300">
              ${stakeSuggestions.medium.stake}
            </p>
            <p className="text-[9px] text-muted-foreground">{pct(stakeSuggestions.medium.pctOfBankroll)} of roll</p>
          </div>
          <div className="rounded-md border border-red-500/20 bg-red-500/5 p-2">
            <p className="text-[10px] uppercase tracking-wider text-red-600 dark:text-red-400 font-bold">High</p>
            <p className="text-base font-bold tabular-nums text-red-600 dark:text-red-300">
              ${stakeSuggestions.high.stake}
            </p>
            <p className="text-[9px] text-muted-foreground">{pct(stakeSuggestions.high.pctOfBankroll)} of roll</p>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Single-bet cap: 5% of current bankroll · base on current ({fmt(currentBankroll)}), not starting.
        </p>
      </div>

      {/* Quick deposit / withdraw */}
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Manage</p>
        <BankrollQuickActions />
      </div>

      {/* Recent events */}
      {recent.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Recent activity</p>
          <ul className="space-y-1 max-h-40 overflow-y-auto">
            {recent.map((e) => {
              const idx = events.indexOf(e);
              const prevBalance = idx > 0 ? events[idx - 1].balanceAfter : startingBankroll;
              const delta = e.balanceAfter - prevBalance;
              const positive = delta > 0;
              const negative = delta < 0;
              return (
                <li
                  key={e.id}
                  className="text-[11px] flex items-center justify-between gap-2 px-2 py-1 rounded bg-muted/30"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-foreground capitalize">
                      {e.type.replace(/_/g, " ")}
                    </span>
                    <span className="text-muted-foreground truncate">
                      {new Date(e.occurredAt).toLocaleString()}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "tabular-nums font-bold",
                      positive && "text-emerald-600 dark:text-emerald-400",
                      negative && "text-red-500",
                    )}
                  >
                    {positive ? "+" : ""}
                    {delta.toFixed(2)} → {fmt(e.balanceAfter)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Reset (collapsed by default) */}
      <Disclosure
        variant="dashed"
        className="p-3"
        summaryClassName="text-[11px] normal-case tracking-normal text-muted-foreground"
        title={
          <span className="inline-flex items-center gap-1.5">
            <Trash2 className="w-3 h-3" />
            Reset bankroll
          </span>
        }
      >
        <div className="space-y-2">
          <p className="text-[10px] text-amber-600 dark:text-amber-400 flex items-start gap-1">
            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
            Wipes all events and resets the starting bankroll to the value below.
          </p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                value={resetValue}
                onChange={(e) => setResetValue(e.target.value)}
                placeholder="50"
                className="w-full h-9 rounded-md border border-input bg-background pl-6 pr-2 text-sm"
              />
            </div>
            {confirmReset ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    const n = Number(resetValue);
                    reset(Number.isFinite(n) && n > 0 ? n : 0);
                    setConfirmReset(false);
                    setResetValue("");
                    onClose?.();
                  }}
                >
                  Confirm
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmReset(true)} disabled={!resetValue}>
                Reset
              </Button>
            )}
          </div>
        </div>
      </Disclosure>
    </div>
  );
}
