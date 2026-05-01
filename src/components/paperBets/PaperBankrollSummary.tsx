/**
 * PaperBankrollSummary — top-of-page paper bankroll card. Read-only
 * aggregates pulled from paper_bankroll + counts derived from
 * paper_bets. Includes a "Reset starting balance" affordance for
 * first-visit setup or manual rebase.
 */

import { useState } from "react";
import { Wallet, Trophy, TrendingDown, Settings2 } from "lucide-react";
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
}

export function PaperBankrollSummary({ bankroll, bets, onChanged }: Props) {
  const [editing, setEditing] = useState(false);
  const [newStart, setNewStart] = useState("500");
  const [saving, setSaving] = useState(false);

  if (!bankroll) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/40 p-4 text-sm text-muted-foreground">
        Paper bankroll initializing…
      </div>
    );
  }

  const total = bankroll.betsWon + bankroll.betsLost + bankroll.betsPush;
  const winRate = total > 0 ? bankroll.betsWon / (bankroll.betsWon + bankroll.betsLost || 1) : 0;
  const roi = bankroll.startingBankroll > 0 ? bankroll.totalPnl / bankroll.startingBankroll : 0;

  // Hit rate by sport (from settled tickets)
  const settled = bets.filter((b) => b.status === "won" || b.status === "lost" || b.status === "push");
  const sportRates = aggregateBy(settled, (b) => b.legs[0]?.sport ?? "—");
  const marketRates = aggregateBy(settled, (b) => b.legs[0]?.marketType ?? "—");
  const typeRates = aggregateBy(settled, (b) => b.betType);

  const reset = async () => {
    const n = Number(newStart);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Enter a positive starting balance.");
      return;
    }
    setSaving(true);
    try {
      const r = await setPaperBankrollStart(n);
      if (r) {
        toast.success(`Paper bankroll reset to $${n}.`);
        setEditing(false);
        onChanged?.();
      } else {
        toast.error("Reset failed.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.04] p-4 sm:p-5 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 font-bold text-[11px]">
          PAPER MODE — fake money only
        </span>
        <span className="text-[11px] text-muted-foreground">No DraftKings connection. Manual entry only.</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 gap-1 text-xs"
          onClick={() => setEditing((v) => !v)}
        >
          <Settings2 className="w-3 h-3" />
          {editing ? "Cancel" : "Reset"}
        </Button>
      </div>

      {editing ? (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">New starting balance</p>
            <Input value={newStart} onChange={(e) => setNewStart(e.target.value)} inputMode="decimal" className="h-9" />
          </div>
          <Button onClick={reset} disabled={saving} className="h-9">
            {saving ? "Saving…" : "Reset bankroll"}
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Current" value={`$${bankroll.currentBankroll.toFixed(2)}`} icon={<Wallet className="w-3.5 h-3.5" />} />
        <Stat label="Open risk" value={`$${bankroll.openRisk.toFixed(2)}`} />
        <Stat
          label="Total P/L"
          value={`${bankroll.totalPnl >= 0 ? "+" : "−"}$${Math.abs(bankroll.totalPnl).toFixed(2)}`}
          tone={bankroll.totalPnl > 0 ? "win" : bankroll.totalPnl < 0 ? "loss" : "neutral"}
          icon={bankroll.totalPnl >= 0 ? <Trophy className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
        />
        <Stat label="ROI" value={`${(roi * 100).toFixed(1)}%`} tone={roi > 0 ? "win" : roi < 0 ? "loss" : "neutral"} />
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="Settled" value={`${total}`} />
        <Stat label="Wins" value={`${bankroll.betsWon}`} />
        <Stat label="Win rate" value={`${(winRate * 100).toFixed(0)}%`} />
      </div>

      {settled.length ? (
        <details className="rounded-md border border-border/40 bg-background/40 p-2 text-xs">
          <summary className="font-semibold text-foreground cursor-pointer select-none">
            Hit rates by sport / market / bet type
          </summary>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
            <RateBlock title="By sport" rows={sportRates} />
            <RateBlock title="By market" rows={marketRates} />
            <RateBlock title="By bet type" rows={typeRates} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: string;
  tone?: "win" | "loss" | "neutral";
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/40 bg-background/40 px-2.5 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {icon}{label}
      </p>
      <p className={cn(
        "text-sm font-bold tabular-nums",
        tone === "win" ? "text-emerald-600 dark:text-emerald-400"
        : tone === "loss" ? "text-red-600 dark:text-red-400"
        : "text-foreground",
      )}>{value}</p>
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
