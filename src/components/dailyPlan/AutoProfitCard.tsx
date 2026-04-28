/**
 * AutoProfitCard — top card on /daily that condenses the three-tier
 * Daily Plan into one disciplined recommendation: BET NOW / SMALL BET
 * / WAIT / SKIP plus a final stake amount.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Sparkles,
  CheckCircle2,
  Plus,
  ShieldAlert,
  Shuffle,
  TrendingUp,
  ExternalLink,
} from "lucide-react";
import { DraftKingsTicketModal } from "@/components/draftkings/DraftKingsTicketModal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildAutoProfit,
  deriveAdjustedStake,
  actionLabel,
  actionBadgeClass,
  modeLabel,
  modeBadgeClass,
  type AutoProfitPlan,
} from "@/lib/dailyPlan/autoProfit";
import type { DailyPlanCard } from "@/lib/dailyPlan/dailyPlanGenerator";
import { useBankroll } from "@/context/BankrollContext";
import { useValueParlay } from "@/context/ValueParlayContext";
import {
  getPropRiskLevel,
  riskLevelClass,
  riskLevelLabel,
} from "@/lib/valueParlay/propRiskLevels";
import {
  logRecommendedParlay,
} from "@/lib/parlayTracking/recommendedParlayLogger";

function formatAmerican(o: number): string {
  return o > 0 ? `+${o}` : `${o}`;
}

interface Props {
  plan: DailyPlanCard[];
  onReplaceWeakest: (tier: DailyPlanCard["tier"]) => void;
}

export function AutoProfitCard({ plan, onReplaceWeakest }: Props) {
  const { addValueLeg } = useValueParlay();
  const {
    currentBankroll,
    suggestStake,
    recordBetPlaced,
    lossStreak,
    winStreak,
    hadLossToday,
    todaysExposure,
  } = useBankroll();

  const [overrideStop, setOverrideStop] = useState(false);
  const [placed, setPlaced] = useState(false);
  const [dkOpen, setDkOpen] = useState(false);

  const skeleton = useMemo<AutoProfitPlan>(
    () =>
      buildAutoProfit({
        plan,
        currentBankroll,
        lossStreak,
        winStreak,
        hadLossToday,
        todaysExposure,
      }),
    [plan, currentBankroll, lossStreak, winStreak, hadLossToday, todaysExposure],
  );

  // The skeleton's action may be WAIT due to stop-for-today; if user
  // overrode, treat as if hadLossToday were false.
  const effectiveAction = useMemo(() => {
    if (overrideStop && skeleton.action === "WAIT" && hadLossToday) {
      // Reclassify based on plan/streak alone.
      return skeleton.mode === "green" ? "BET_NOW" : skeleton.mode === "caution" ? "SMALL_BET" : "SKIP";
    }
    return skeleton.action;
  }, [overrideStop, skeleton, hadLossToday]);

  const ticket = skeleton.ticket;
  const baseStake = ticket
    ? suggestStake(ticket.stakeRisk).stake
    : 0;
  const adjusted = useMemo(
    () => deriveAdjustedStake({
      baseStake,
      currentBankroll,
      lossStreak,
      todaysExposure,
      action: effectiveAction,
    }),
    [baseStake, currentBankroll, lossStreak, todaysExposure, effectiveAction],
  );

  const addAllToSlip = () => {
    if (!ticket) return;
    let added = 0;
    for (const l of ticket.legs) {
      const r = addValueLeg(l);
      if (r.ok) added++;
    }
    if (added) toast.success(`Added ${added} leg${added === 1 ? "" : "s"} to parlay slip`);
    else toast.message("All legs already on the slip");
  };

  const markPlaced = () => {
    if (placed || !ticket || !ticket.result) return;
    setPlaced(true);
    if (adjusted.stake > 0) {
      const r = recordBetPlaced(
        adjusted.stake,
        undefined,
        `Auto Profit · ${modeLabel(skeleton.mode)} · ${actionLabel(effectiveAction)}`,
      );
      if (!r.ok) toast.message(r.reason ?? "Could not record stake");
    }
    void logRecommendedParlay({
      tier: ticket.tier === "upside" ? "aggressive" : ticket.tier === "balanced" ? "balanced" : "safe",
      variant: "best_value",
      result: ticket.result,
      reasons: [
        `auto_profit_mode=${skeleton.mode}`,
        `auto_profit_action=${effectiveAction}`,
        skeleton.reason,
        ...skeleton.notes,
      ],
      modelVersion: "auto-profit-v1",
      source: "auto_profit",
    });
    toast.success(`Auto Profit ticket marked as placed`);
  };

  const showOverride = skeleton.action === "WAIT" && hadLossToday && !overrideStop;

  return (
    <div className="rounded-lg border border-primary/20 bg-gradient-to-br from-primary/5 to-card/60 p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-5 h-5 shrink-0 text-primary" />
          <div className="min-w-0">
            <h2 className="font-display font-bold text-base text-foreground">
              Today&rsquo;s Auto Profit Plan
            </h2>
            <p className="text-[11px] text-muted-foreground">
              One disciplined ticket sized to your bankroll
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full border uppercase",
              modeBadgeClass(skeleton.mode),
            )}
          >
            {modeLabel(skeleton.mode)}
          </span>
          <span
            className={cn(
              "text-xs font-black tracking-wide px-3 py-1 rounded-full uppercase shadow-sm",
              actionBadgeClass(effectiveAction),
            )}
          >
            {actionLabel(effectiveAction)}
          </span>
        </div>
      </div>

      {/* Reason */}
      <p className="text-sm text-foreground leading-snug">{skeleton.reason}</p>

      {/* Stop-for-today override */}
      {showOverride ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-[12px] space-y-2">
          <div className="flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0 text-red-500 mt-0.5" />
            <p className="text-red-700 dark:text-red-300 font-semibold">
              Stop for today recommended — you already settled a losing bet today.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setOverrideStop(true)}>
            Override and proceed
          </Button>
        </div>
      ) : null}

      {/* Ticket details */}
      {ticket && ticket.result ? (
        <div className="rounded-md border border-border bg-muted/30 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-display font-bold text-foreground capitalize">
              {ticket.tier} ticket · {ticket.legs.length} leg{ticket.legs.length === 1 ? "" : "s"}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {formatAmerican(ticket.result.combinedAmericanOdds)} · hit{" "}
              {Math.round((ticket.result.projectedHitProbability ?? 0) * 100)}%
            </span>
          </div>

          <ul className="space-y-1.5">
            {ticket.legs.map((l) => {
              const risk = getPropRiskLevel(l);
              const isWeakest = ticket.weakestLegId === l.id;
              const isStrongest = ticket.result?.strongestLegId === l.id;
              return (
                <li
                  key={l.id}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded px-2 py-1.5 text-[11px] border",
                    isWeakest ? "border-amber-500/30 bg-amber-500/5"
                    : isStrongest ? "border-emerald-500/20 bg-emerald-500/5"
                    : "border-border bg-card/40",
                  )}
                >
                  <span className="min-w-0 flex items-center gap-1.5 flex-wrap">
                    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-bold", riskLevelClass(risk))}>
                      {riskLevelLabel(risk)}
                    </span>
                    <span className="font-semibold text-foreground truncate">{l.selectionLabel}</span>
                    {isStrongest ? (
                      <span className="text-[9px] text-emerald-600 dark:text-emerald-400 font-bold uppercase">Strongest</span>
                    ) : null}
                    {isWeakest ? (
                      <span className="text-[9px] text-amber-600 dark:text-amber-400 font-bold uppercase">Weakest</span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground tabular-nums shrink-0">
                    {formatAmerican(l.americanOdds)}
                  </span>
                </li>
              );
            })}
          </ul>

          {/* Stake / payout grid */}
          <div className="grid grid-cols-3 gap-2 text-center pt-1 border-t border-border">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Stake</p>
              <p className="text-base font-bold tabular-nums text-foreground">
                ${adjusted.stake}
              </p>
              {baseStake !== adjusted.stake && adjusted.stake > 0 ? (
                <p className="text-[9px] text-amber-600 dark:text-amber-400">
                  was ${baseStake} · adjusted
                </p>
              ) : (
                <p className="text-[9px] text-muted-foreground">
                  {(adjusted.pctOfBankroll * 100).toFixed(1)}% of roll
                </p>
              )}
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Risk</p>
              <p className="text-base font-bold capitalize text-foreground">
                {ticket.stakeRisk}
              </p>
              <p className="text-[9px] text-muted-foreground capitalize">
                {ticket.result.cardConfidence} conf
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Pays</p>
              <p className="text-base font-bold tabular-nums text-foreground">
                ${(adjusted.stake * (ticket.result.projectedPayoutMultiplier ?? 1)).toFixed(2)}
              </p>
              <p className="text-[9px] text-muted-foreground">
                {(ticket.result.projectedPayoutMultiplier ?? 1).toFixed(2)}x
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
          <p className="font-semibold text-foreground mb-1">No ticket recommended today</p>
          <p>Slate doesn&rsquo;t pass the safety filters. Skip and check back later.</p>
        </div>
      )}

      {/* Notes + warnings */}
      {(skeleton.notes.length > 0 || skeleton.warnings.length > 0) ? (
        <ul className="text-[11px] text-muted-foreground space-y-0.5">
          {skeleton.notes.map((n) => (
            <li key={n} className="flex items-start gap-1.5">
              <TrendingUp className="w-3 h-3 shrink-0 mt-0.5 text-muted-foreground" />
              <span>{n}</span>
            </li>
          ))}
          {skeleton.warnings.map((w) => (
            <li key={w} className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
              <ShieldAlert className="w-3 h-3 shrink-0 mt-0.5" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Streak chips */}
      {(lossStreak > 0 || winStreak > 0) ? (
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-muted-foreground">Streak:</span>
          {winStreak > 0 ? (
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-bold">
              {winStreak}W
            </span>
          ) : null}
          {lossStreak > 0 ? (
            <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-700 dark:text-red-300 font-bold">
              {lossStreak}L
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Actions */}
      {ticket && (effectiveAction === "BET_NOW" || effectiveAction === "SMALL_BET") ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="default" className="flex-1" onClick={() => setDkOpen(true)} disabled={placed}>
            <ExternalLink className="w-3.5 h-3.5" />
            Place on DraftKings
          </Button>
          <Button size="sm" variant="outline" onClick={addAllToSlip}>
            <Plus className="w-3.5 h-3.5" />
            Add to slip
          </Button>
          <Button size="sm" variant="ghost" onClick={markPlaced} disabled={placed}>
            <CheckCircle2 className="w-3.5 h-3.5" />
            {placed ? "Placed" : "Mark placed"}
          </Button>
          {ticket.weakestLegId && ticket.legs.length > 1 ? (
            <Button size="sm" variant="ghost" onClick={() => onReplaceWeakest(ticket.tier)}>
              <Shuffle className="w-3.5 h-3.5" />
              Replace weakest
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* DraftKings manual-execution modal */}
      {ticket && ticket.result ? (
        <DraftKingsTicketModal
          open={dkOpen}
          onClose={() => setDkOpen(false)}
          legs={ticket.legs}
          result={ticket.result}
          suggestedStake={adjusted.stake}
          description={`Auto Profit · ${modeLabel(skeleton.mode)} · ${actionLabel(effectiveAction)}`}
          tier={ticket.tier === "upside" ? "aggressive" : ticket.tier === "balanced" ? "balanced" : "safe"}
          variant="best_value"
          onPlaced={() => {
            setPlaced(true);
          }}
        />
      ) : null}
    </div>
  );
}
