/**
 * PaperHeaderTiles — top-of-page paper bankroll dashboard.
 *
 * Four headline tiles per the redesign comp:
 *   • Bankroll       — current paper balance (subtitle: starting balance)
 *   • Open Slips     — count of currently-open bets
 *   • This Month     — pnl + ROI for bets resolved this calendar month
 *   • Win Rate       — wins / (wins + losses) for the lifetime
 *
 * The hit-rate breakdowns (by sport / market / type) and the bankroll
 * reset affordance live below the tiles in a collapsible disclosure
 * so they don't crowd the dashboard view.
 */

import { useState } from "react";
import { Wallet, TrendingUp, TrendingDown, Trophy, ListChecks, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setPaperBankrollStart } from "@/lib/paperBets/store";
import type { PaperBankroll, PaperBet } from "@/lib/paperBets/types";

interface Props {
  bankroll: PaperBankroll | null;
  bets: PaperBet[];
  onChanged?: () => void;
  /** True only when the underlying query is still in flight. */
  loading?: boolean;
}

export function PaperHeaderTiles({ bankroll, bets, onChanged, loading }: Props) {
  const [editing, setEditing] = useState(false);
  const [newStart, setNewStart] = useState("500");
  const [saving, setSaving] = useState(false);

  if (!bankroll) {
    if (loading) {
      return (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-lg border border-border/40 bg-muted/30 animate-pulse" />
          ))}
        </div>
      );
    }
    return null; // page-level banner explains why
  }

  const open = bets.filter((b) => b.status === "open" || b.status === "in_progress" || b.status === "needs_review");

  // "This Month" — bets resolved within the current calendar month (local time).
  const monthStart = (() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  })();
  const settledThisMonth = bets.filter(
    (b) =>
      (b.status === "won" || b.status === "lost" || b.status === "push")
      && b.resolvedAt
      && new Date(b.resolvedAt).getTime() >= monthStart,
  );
  const monthPnl = settledThisMonth.reduce((s, b) => s + (b.pnl ?? 0), 0);
  const monthStake = settledThisMonth.reduce((s, b) => s + b.stake, 0);
  const monthRoi = monthStake > 0 ? (monthPnl / monthStake) * 100 : 0;

  const settledLifetime = bankroll.betsWon + bankroll.betsLost + bankroll.betsPush;
  const winRate = (bankroll.betsWon + bankroll.betsLost) > 0
    ? bankroll.betsWon / (bankroll.betsWon + bankroll.betsLost)
    : 0;

  // Hit rate by sport/market/type (settled bets only).
  const settled = bets.filter((b) => b.status === "won" || b.status === "lost" || b.status === "push");
  const sportRates  = aggregateBy(settled, (b) => b.legs[0]?.sport ?? "—");
  const marketRates = aggregateBy(settled, (b) => b.legs[0]?.marketType ?? "—");
  const typeRates   = aggregateBy(settled, (b) => b.betType);

  const reset = async () => {
    const n = Number(newStart);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Enter a positive starting balance.");
      return;
    }
    setSaving(true);
    try {
      await setPaperBankrollStart(n);
      toast.success(`Paper bankroll reset to $${n}.`);
      setEditing(false);
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reset failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile
          label="Bankroll"
          value={`$${bankroll.currentBankroll.toFixed(2)}`}
          subtitle={`Starting $${bankroll.startingBankroll.toFixed(0)}`}
          icon={<Wallet className="w-3.5 h-3.5" />}
        />
        <Tile
          label="Open Slips"
          value={`${open.length}`}
          subtitle={open.length ? `$${bankroll.openRisk.toFixed(0)} at risk` : "—"}
          icon={<ListChecks className="w-3.5 h-3.5" />}
        />
        <Tile
          label="This Month"
          value={
            settledThisMonth.length
              ? `${monthPnl >= 0 ? "+" : "−"}$${Math.abs(monthPnl).toFixed(2)}`
              : "—"
          }
          subtitle={
            settledThisMonth.length
              ? `${monthRoi >= 0 ? "+" : ""}${monthRoi.toFixed(1)}% ROI`
              : "no settled bets"
          }
          tone={monthPnl > 0 ? "win" : monthPnl < 0 ? "loss" : "neutral"}
          icon={monthPnl >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
        />
        <Tile
          label="Win Rate"
          value={
            (bankroll.betsWon + bankroll.betsLost) > 0
              ? `${(winRate * 100).toFixed(0)}%`
              : "—"
          }
          subtitle={
            settledLifetime > 0
              ? `${bankroll.betsWon} of ${bankroll.betsWon + bankroll.betsLost}`
              : "no decisions yet"
          }
          tone={winRate >= 0.55 ? "win" : winRate > 0 && winRate < 0.45 ? "loss" : "neutral"}
          icon={<Trophy className="w-3.5 h-3.5" />}
        />
      </div>

      {/* Secondary actions + breakdowns — collapsed by default. */}
      <details className="rounded-md border border-border/40 bg-card/40 p-2 text-xs">
        <summary className="font-semibold text-foreground cursor-pointer select-none flex items-center gap-2">
          <Settings2 className="w-3 h-3" />
          Bankroll details
        </summary>
        <div className="mt-3 space-y-3">
          {editing ? (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">New starting balance</p>
                <Input value={newStart} onChange={(e) => setNewStart(e.target.value)} inputMode="decimal" className="h-9" />
              </div>
              <Button onClick={reset} disabled={saving} size="sm" className="h-9">
                {saving ? "Saving…" : "Reset"}
              </Button>
              <Button onClick={() => setEditing(false)} disabled={saving} variant="ghost" size="sm" className="h-9">
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setEditing(true)}>
              <Settings2 className="w-3 h-3" />
              Reset starting balance
            </Button>
          )}

          {settled.length ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
              <RateBlock title="By sport"    rows={sportRates} />
              <RateBlock title="By market"   rows={marketRates} />
              <RateBlock title="By bet type" rows={typeRates} />
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground italic">
              Settle at least one bet to see breakdowns.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}

function Tile({
  label, value, subtitle, tone = "neutral", icon,
}: {
  label: string;
  value: string;
  subtitle?: string;
  tone?: "win" | "loss" | "neutral";
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/60 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {icon}{label}
      </p>
      <p className={cn(
        "text-lg sm:text-xl font-bold tabular-nums leading-tight",
        tone === "win"  ? "text-emerald-600 dark:text-emerald-400"
        : tone === "loss" ? "text-red-600 dark:text-red-400"
        : "text-foreground",
      )}>
        {value}
      </p>
      {subtitle ? (
        <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5 truncate">{subtitle}</p>
      ) : null}
    </div>
  );
}

function RateBlock({ title, rows }: { title: string; rows: { key: string; w: number; l: number; p: number }[] }) {
  return (
    <div className="rounded-md border border-border/30 bg-muted/20 p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {rows.length === 0 ? (
          <li className="text-muted-foreground italic">No settled bets yet.</li>
        ) : rows.map((r) => {
          const total = r.w + r.l + r.p;
          const rate = total > 0 ? r.w / (r.w + r.l || 1) : 0;
          return (
            <li key={r.key} className="flex items-center justify-between gap-2">
              <span className="uppercase font-semibold text-foreground">{r.key}</span>
              <span className="tabular-nums text-muted-foreground">{r.w}-{r.l}-{r.p} ({(rate * 100).toFixed(0)}%)</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function aggregateBy(
  bets: PaperBet[],
  keyFn: (b: PaperBet) => string,
): { key: string; w: number; l: number; p: number }[] {
  const map = new Map<string, { w: number; l: number; p: number }>();
  for (const b of bets) {
    const k = String(keyFn(b)).toLowerCase();
    if (!map.has(k)) map.set(k, { w: 0, l: 0, p: 0 });
    const e = map.get(k)!;
    if (b.status === "won") e.w += 1;
    else if (b.status === "lost") e.l += 1;
    else if (b.status === "push") e.p += 1;
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => (b.w + b.l + b.p) - (a.w + a.l + a.p));
}
