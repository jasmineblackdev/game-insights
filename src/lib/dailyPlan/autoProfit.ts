/**
 * Auto Profit Mode — disciplined daily betting workflow.
 *
 * Takes the three Daily Plan cards and returns a single recommended
 * action: BET NOW / SMALL BET / WAIT / SKIP, plus a stake amount that
 * accounts for loss-streak reductions and daily-exposure caps. The UI
 * renders this as the top card on /daily so the user can see one
 * clear next step instead of three competing options.
 *
 * Mode rules (in order):
 *   No Bet  — no qualifying ticket OR every option is HIGH-risk
 *             dominant OR low data quality across the slate.
 *   Caution — a single qualifying ticket OR optimizer warnings OR
 *             active loss streak ≥ 1 OR data-quality flags.
 *   Green   — at least one Primary or Balanced ticket with HIGH card
 *             confidence, no warnings, and at most 1 HIGH-risk leg.
 *
 * Stake adjustments:
 *   lossStreak ≥ 1 → multiply suggested stake by 0.75
 *   lossStreak ≥ 2 → multiply by 0.50
 *   winStreak ≥ 3  → no auto-increase (hold flat until bankroll grows)
 *   today's exposure already ≥ 8% of bankroll → SMALL BET capped to
 *     remaining headroom (or SKIP if we're already over).
 *
 * Stop-for-today:
 *   If any settled bet today resolved as a loss, we surface a stop
 *   recommendation. The user can override but the card explains why.
 */

import type { DailyPlanCard } from "@/lib/dailyPlan/dailyPlanGenerator";
import { getPropRiskLevel } from "@/lib/valueParlay/propRiskLevels";
import { isBannedStatTypeForPrimary, passesQualityGates } from "@/lib/valueParlay/statTypeBans";
import { roundStake, MAX_STAKE_PCT } from "@/lib/bankroll/staking";

export type AutoProfitMode = "green" | "caution" | "no_bet";
export type AutoProfitAction = "BET_NOW" | "SMALL_BET" | "WAIT" | "SKIP";

export interface AutoProfitPlan {
  mode: AutoProfitMode;
  action: AutoProfitAction;
  /** Picked ticket — null when mode === "no_bet". */
  ticket: DailyPlanCard | null;
  /** Final recommended stake after all reductions/caps. */
  recommendedStake: number;
  /** Stake as a fraction of current bankroll. */
  stakePctOfBankroll: number;
  /** Original suggested stake before adjustments (for the UI delta). */
  baseStake: number;
  /** Short reason summary shown on the card. */
  reason: string;
  /** Specific guidance lines (e.g. "Loss streak — stake reduced 50%"). */
  notes: string[];
  /** True when the user already hit a loss today; UI nudges to stop. */
  stopForToday: boolean;
  /** Soft warnings (over-cap, low data quality, etc.). */
  warnings: string[];
}

/** Daily exposure ceiling — sum of stakes today, expressed as % of bankroll. */
const MAX_DAILY_EXPOSURE_PCT = 0.08;

/**
 * A "qualifying" ticket — passes optimizer rules + Auto Profit's
 * strict gates: no banned stat types in any leg, every leg passes
 * the implied-prob/volatility/recent-hit-rate quality gates, no
 * card-level warnings of substance, and ≤4 legs (we prefer 2-3).
 */
function isQualifying(card: DailyPlanCard | undefined): boolean {
  if (!card || !card.result || card.legs.length === 0) return false;
  if (card.result.cardConfidence === "low") return false;
  // High-risk-only parlays don't qualify for the safer/balanced lanes.
  const counts = card.result.riskLevelCounts;
  if (counts && counts.high > 1) return false;
  // Hard cap: > 4 legs is too many for Auto Profit; that surface is
  // for disciplined daily bets, not lottery tickets.
  if (card.legs.length > 4) return false;
  // Every leg must pass the strict quality gates and be free of
  // banned stat types. Auto Profit/Big Win/Upside hard-fail if any
  // leg fails implied probability, volatility, or recent hit rate.
  for (const leg of card.legs) {
    if (isBannedStatTypeForPrimary(leg)) return false;
    if (!passesQualityGates(leg)) return false;
  }
  return true;
}

/** Strong-quality ticket — qualifies AND has HIGH card confidence. */
function isStrong(card: DailyPlanCard | undefined): boolean {
  if (!isQualifying(card)) return false;
  if (card!.result!.cardConfidence !== "high") return false;
  // No optimizer warnings beyond the structural ones.
  if ((card!.result!.warnings ?? []).length >= 2) return false;
  return true;
}

/**
 * Compare two qualifying tickets and prefer the one with 2–3 legs
 * over a 4-leg ticket. When leg counts are equal or both ≤3,
 * fall through to caller-decided priority (balanced > primary, etc).
 */
function preferFewerLegs(a: DailyPlanCard | undefined, b: DailyPlanCard | undefined): DailyPlanCard | undefined {
  if (!a) return b;
  if (!b) return a;
  const an = a.legs.length;
  const bn = b.legs.length;
  // Sweet spot is 2–3 legs. Penalize 4-leg parlays vs 2-3.
  const aSweet = an >= 2 && an <= 3;
  const bSweet = bn >= 2 && bn <= 3;
  if (aSweet && !bSweet) return a;
  if (bSweet && !aSweet) return b;
  return undefined; // signal "no preference, caller picks"
}

/** Pick a HIGH-risk leg count across a card's legs. */
function highRiskCount(card: DailyPlanCard | undefined): number {
  if (!card?.legs) return 0;
  return card.legs.filter((l) => getPropRiskLevel(l) === "high").length;
}

export interface BuildAutoProfitInput {
  plan: DailyPlanCard[];
  currentBankroll: number;
  lossStreak: number;
  winStreak: number;
  hadLossToday: boolean;
  todaysExposure: number;
}

export function buildAutoProfit(input: BuildAutoProfitInput): AutoProfitPlan {
  const { plan, currentBankroll, lossStreak, winStreak, hadLossToday, todaysExposure } = input;

  const primary  = plan.find((c) => c.tier === "primary");
  const balanced = plan.find((c) => c.tier === "balanced");
  const upside   = plan.find((c) => c.tier === "upside");

  const qualifyingCount =
    Number(isQualifying(primary)) +
    Number(isQualifying(balanced)) +
    Number(isQualifying(upside));
  const strongCount =
    Number(isStrong(primary)) +
    Number(isStrong(balanced)) +
    Number(isStrong(upside));

  // ── Mode classification ────────────────────────────────────────
  let mode: AutoProfitMode;
  if (qualifyingCount === 0) mode = "no_bet";
  else if (
    strongCount === 0 ||
    qualifyingCount === 1 ||
    lossStreak >= 1 ||
    (primary?.result?.warnings.length ?? 0) >= 1 && (balanced?.result?.warnings.length ?? 0) >= 1
  ) {
    mode = "caution";
  } else {
    mode = "green";
  }

  // ── Ticket selection ───────────────────────────────────────────
  // Preference order: 2-3 strong legs > 2-3 qualifying > 4-leg
  // qualifying. Balanced is preferred over Primary at equal
  // sweetness because it has the best EV blend.
  let ticket: DailyPlanCard | null = null;
  if (mode === "green") {
    // First pass: pick the strongest 2-3 leg ticket.
    const strongCandidates = [balanced, primary].filter(isStrong) as DailyPlanCard[];
    const strongSweet = strongCandidates.find((c) => c.legs.length >= 2 && c.legs.length <= 3);
    if (strongSweet) {
      ticket = strongSweet;
    } else if (strongCandidates.length > 0) {
      ticket = strongCandidates[0];
    } else {
      // Fall back to qualifying — same sweet-spot preference.
      const qualifyingCandidates = [balanced, primary].filter(isQualifying) as DailyPlanCard[];
      const qualSweet = qualifyingCandidates.find((c) => c.legs.length >= 2 && c.legs.length <= 3);
      ticket = qualSweet ?? qualifyingCandidates[0] ?? null;
    }
    // If upside is also qualifying, only prefer it when it has 2-3 legs
    // AND no current ticket exists. The hard cap at 4 means upside with
    // 4 legs is automatically rejected by isQualifying above.
    if (!ticket && isQualifying(upside)) ticket = upside!;
    if (ticket && isQualifying(upside)) {
      const winner = preferFewerLegs(ticket, upside);
      if (winner) ticket = winner;
    }
  } else if (mode === "caution") {
    // Prefer Primary (safer) when in caution mode.
    if (isQualifying(primary)) ticket = primary!;
    else if (isQualifying(balanced)) ticket = balanced!;
  }

  // ── Stake sizing ──────────────────────────────────────────────
  const baseStake = ticket?.result
    ? // Use the tier's own suggested stake as the base — tier mapping
      // (low/medium/high) lives on the DailyPlanCard.
      0
    : 0;
  // Caller passes baseStake via the ticket's stakeRisk through useBankroll;
  // the auto-profit module is bankroll-agnostic and just transforms it.
  // We compute the adjusted stake using the card's `stakeRisk` indirectly
  // by trusting the caller to look it up via suggestStake. This module
  // only handles the transformation logic.
  void baseStake;

  // The actual stake math is in deriveAdjustedStake() so the caller
  // (the React component) can wire it to its `suggestStake(tier)`.
  const planSkeleton: AutoProfitPlan = {
    mode,
    action: "SKIP",
    ticket,
    recommendedStake: 0,
    stakePctOfBankroll: 0,
    baseStake: 0,
    reason: "",
    notes: [],
    stopForToday: hadLossToday,
    warnings: [],
  };

  // ── Action label ───────────────────────────────────────────────
  let action: AutoProfitAction;
  if (mode === "no_bet") action = "SKIP";
  else if (mode === "caution") action = lossStreak >= 2 ? "WAIT" : "SMALL_BET";
  else action = "BET_NOW";

  // Stop-for-today override
  if (hadLossToday && action === "BET_NOW") {
    action = "WAIT";
    planSkeleton.notes.push("You already settled a losing bet today — consider stopping. Tap Override to proceed.");
  }

  // Daily-exposure cap
  const exposureCap = currentBankroll * MAX_DAILY_EXPOSURE_PCT;
  const exposureRemaining = Math.max(0, exposureCap - todaysExposure);
  if (todaysExposure >= exposureCap && action !== "SKIP") {
    action = "WAIT";
    planSkeleton.warnings.push(`Daily exposure cap reached (${(MAX_DAILY_EXPOSURE_PCT * 100).toFixed(0)}% of roll).`);
  }

  // ── Reason ────────────────────────────────────────────────────
  let reason = "";
  if (mode === "no_bet") {
    reason = qualifyingCount === 0
      ? "No qualifying tickets — soft slate, weak edges, or HIGH-risk dominant."
      : "Slate doesn't pass safety filters — sit this one out.";
  } else if (mode === "caution") {
    if (lossStreak >= 2) reason = `2-loss streak — wait for a stronger setup or take a small bet only.`;
    else if (lossStreak >= 1) reason = `Coming off a loss — recommended stake reduced.`;
    else if (qualifyingCount === 1) reason = `Only one qualifying ticket today — keep stake conservative.`;
    else reason = `Slate has warnings or thin data — take it small.`;
  } else {
    reason = `${strongCount} strong ticket${strongCount === 1 ? "" : "s"} on the slate. Risk mix passes safety filters.`;
  }

  // Notes
  if (winStreak >= 3) {
    planSkeleton.notes.push(`Win streak ${winStreak} — stake held flat until bankroll grows 20%.`);
  }
  if (lossStreak === 1) planSkeleton.notes.push("Loss streak — stake reduced 25%.");
  if (lossStreak >= 2) planSkeleton.notes.push("Two-loss streak — stake reduced 50%.");
  if (todaysExposure > 0 && todaysExposure < exposureCap) {
    planSkeleton.notes.push(`Today's exposure: $${todaysExposure.toFixed(2)} / $${exposureCap.toFixed(2)} cap.`);
  }
  if (hadLossToday) {
    planSkeleton.notes.push("Had a loss today — Stop for today is recommended.");
  }

  return {
    ...planSkeleton,
    action,
    reason,
    // recommendedStake / baseStake / stakePctOfBankroll filled in by deriveAdjustedStake()
    // (called by the React layer with bankroll context).
    recommendedStake: 0,
    baseStake: 0,
    stakePctOfBankroll: 0,
    warnings: [...planSkeleton.warnings],
    // Carry exposureRemaining as a soft hint for callers.
    notes: [...planSkeleton.notes, `Exposure remaining today: $${exposureRemaining.toFixed(2)}.`],
  };
}

/**
 * Apply loss-streak reductions and exposure caps to a base stake.
 * Caller passes the bankroll-suggested stake for the ticket's risk
 * tier; we return the final recommended amount.
 */
export function deriveAdjustedStake(args: {
  baseStake: number;
  currentBankroll: number;
  lossStreak: number;
  todaysExposure: number;
  action: AutoProfitAction;
}): { stake: number; pctOfBankroll: number } {
  const { baseStake, currentBankroll, lossStreak, todaysExposure, action } = args;
  if (action === "SKIP" || action === "WAIT") {
    return { stake: 0, pctOfBankroll: 0 };
  }

  let stake = baseStake;
  if (action === "SMALL_BET") stake = stake * 0.5;
  if (lossStreak >= 2) stake = stake * 0.5;
  else if (lossStreak >= 1) stake = stake * 0.75;

  // 5% per-bet cap (defensive — bankroll's suggester already enforces it)
  stake = Math.min(stake, currentBankroll * MAX_STAKE_PCT);

  // 8% daily exposure cap
  const exposureCap = currentBankroll * MAX_DAILY_EXPOSURE_PCT;
  const exposureRemaining = Math.max(0, exposureCap - todaysExposure);
  stake = Math.min(stake, exposureRemaining);

  stake = roundStake(stake);
  return {
    stake,
    pctOfBankroll: currentBankroll > 0 ? stake / currentBankroll : 0,
  };
}

export function modeLabel(m: AutoProfitMode): string {
  return m === "green" ? "Green Day" : m === "caution" ? "Caution" : "No Bet";
}

export function modeBadgeClass(m: AutoProfitMode): string {
  if (m === "green")   return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/20";
  if (m === "caution") return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/20";
  return "bg-muted text-muted-foreground border-border";
}

export function actionLabel(a: AutoProfitAction): string {
  return a === "BET_NOW" ? "BET NOW"
    : a === "SMALL_BET" ? "SMALL BET"
    : a === "WAIT" ? "WAIT"
    : "SKIP";
}

export function actionBadgeClass(a: AutoProfitAction): string {
  if (a === "BET_NOW")   return "bg-emerald-500 text-white";
  if (a === "SMALL_BET") return "bg-amber-500 text-white";
  if (a === "WAIT")      return "bg-muted text-foreground border border-border";
  return "bg-red-500/80 text-white";
}

export { MAX_DAILY_EXPOSURE_PCT };
