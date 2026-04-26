/**
 * AutoProfitBuilderHint — banner inside the Parlay Builder that
 * evaluates the user's current slip against Auto Profit rules and
 * surfaces a one-line verdict: fits / exceeds / replace-suggested.
 *
 * Reuses applyRiskRules so the same hard-fail and soft-warning vocab
 * the optimizer enforces shows up here for the manual builder.
 */

import { Sparkles, ShieldAlert, Shuffle, CheckCircle2 } from "lucide-react";
import { useValueParlay } from "@/context/ValueParlayContext";
import { useBankroll } from "@/context/BankrollContext";
import { applyRiskRules, getPropRiskLevel } from "@/lib/valueParlay/propRiskLevels";
import { MAX_DAILY_EXPOSURE_PCT } from "@/lib/dailyPlan/autoProfit";
import { cn } from "@/lib/utils";

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function AutoProfitBuilderHint() {
  const { builderLegs, builderMetrics } = useValueParlay();
  const { currentBankroll, suggestStake, todaysExposure, lossStreak } = useBankroll();

  if (builderLegs.length === 0) return null;

  const rules = applyRiskRules(builderLegs);
  const overCap = builderMetrics
    ? false // The 5%-per-bet cap depends on user's intended stake, not the slip itself.
    : false;
  void overCap; // reserved for when stake input lands in the builder

  const exposureCap = currentBankroll * MAX_DAILY_EXPOSURE_PCT;
  const exposureRemaining = Math.max(0, exposureCap - todaysExposure);
  const exposureCapHit = currentBankroll > 0 && todaysExposure >= exposureCap;

  const hasHighRiskCount = builderLegs.filter((l) => getPropRiskLevel(l) === "high").length;

  // Slip's own risk tier for the suggested-stake hint.
  const slipRisk: "low" | "medium" | "high" = hasHighRiskCount > 0
    ? "high"
    : builderLegs.length > 2 ? "medium" : "low";
  const stakeRec = suggestStake(slipRisk);

  let verdict: "fits" | "exceeds" | "replace" = "fits";
  let line = "";
  let icon = <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />;
  let cls = "border-emerald-500/20 bg-emerald-500/5";

  if (rules.hardFail) {
    verdict = "exceeds";
    line = `⚠ ${rules.hardFailReason}. Auto Profit rules block this build.`;
    icon = <ShieldAlert className="w-4 h-4 text-red-500" />;
    cls = "border-red-500/30 bg-red-500/5";
  } else if (rules.warnings.length >= 1 || hasHighRiskCount === 1) {
    verdict = "replace";
    line = `Slip has ${rules.warnings.length} risk warning${rules.warnings.length === 1 ? "" : "s"}. Replace weakest leg recommended.`;
    icon = <Shuffle className="w-4 h-4 text-amber-600 dark:text-amber-400" />;
    cls = "border-amber-500/20 bg-amber-500/5";
  } else if (exposureCapHit) {
    verdict = "exceeds";
    line = `Daily exposure cap reached (${fmtMoney(todaysExposure)} / ${fmtMoney(exposureCap)}). Wait for tomorrow.`;
    icon = <ShieldAlert className="w-4 h-4 text-red-500" />;
    cls = "border-red-500/30 bg-red-500/5";
  } else if (lossStreak >= 2) {
    verdict = "replace";
    line = `Two-loss streak — keep this slip small or take a single safer leg.`;
    icon = <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400" />;
    cls = "border-amber-500/20 bg-amber-500/5";
  } else {
    line = `This slip fits Auto Profit rules. Suggested stake $${stakeRec.stake} (${(stakeRec.pctOfBankroll * 100).toFixed(1)}% of roll).`;
  }

  return (
    <div className={cn("rounded-lg border px-3 py-2.5 text-xs flex items-center gap-2", cls)}>
      <Sparkles className="w-3.5 h-3.5 shrink-0 text-primary" aria-hidden />
      {icon}
      <span className="text-foreground">{line}</span>
      {verdict === "fits" && currentBankroll > 0 ? (
        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
          Exposure left today: {fmtMoney(exposureRemaining)}
        </span>
      ) : null}
    </div>
  );
}
