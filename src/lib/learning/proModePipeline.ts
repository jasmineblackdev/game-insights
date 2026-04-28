/**
 * Pro Mode pipeline — once-per-day, emits at most one trade decision
 * into the Pro Trade Queue.
 *
 * Order of operations:
 *   1. Sport Priority — drop avoid-tier sports from the pool
 *   2. Sharp filter — drop legs that don't pass edge/EV/sample/etc
 *   3. Rank by EV
 *   4. Build a 1-leg or best-2 parlay from the top candidates
 *   5. Bankroll discipline check — sets status (ready/wait/blocked)
 *   6. Scaling Ladder caps the stake
 *   7. Insert into pro_trade_queue
 *
 * Idempotent — bails when today already has a pro_mode trade row,
 * regardless of status. The user gets one decision per day; if they
 * dismiss it, no automatic replacement (don't fight the user).
 */

import type { ValueBetCandidate, SmartParlayResult } from "@/lib/valueParlay/types";
import { rankBySharpEv, computeEV, SHARP_DEFAULTS, type SharpThresholds } from "@/lib/learning/sharpMode";
import { getCachedSportPriority, isSportAvoided } from "@/lib/learning/sportPriority";
import { computeDiscipline, type DisciplineStatus } from "@/lib/bankroll/discipline";
import { stageMaxStakePctFor } from "@/lib/bankroll/scalingLadder";
import { roundStake } from "@/lib/bankroll/staking";
import {
  enqueueProTrade,
  todaysProTrade,
  type ProTradeStatus,
} from "@/lib/learning/proTradeQueue";

export interface ProModePipelineInput {
  candidates: ValueBetCandidate[];
  /** Bankroll snapshot for discipline + sizing. */
  bankroll: {
    currentBankroll: number;
    todayPnl: number;
    lossStreak: number;
    todaysExposure: number;
  };
  /** Sharp Mode thresholds (from SharpModeContext). */
  sharpThresholds?: SharpThresholds;
}

export interface ProModePipelineResult {
  emitted: boolean;
  reason: string;
  tradeId?: string | null;
  status?: ProTradeStatus;
}

function americanToDecimal(american: number): number {
  return american >= 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

/** Combine American odds across legs → single American odds. */
function combineAmerican(legs: ValueBetCandidate[]): number {
  if (!legs.length) return 0;
  let dec = 1;
  for (const l of legs) dec *= americanToDecimal(l.americanOdds);
  return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
}

function buildSnapshot(legs: ValueBetCandidate[]): SmartParlayResult & { tier: "safe"; variant: "best_value" } {
  const combined = combineAmerican(legs);
  let dec = 1;
  for (const l of legs) dec *= americanToDecimal(l.americanOdds);
  const probabilities = legs.map((l) => l.modelProbability ?? 0.5);
  const combinedProb = probabilities.reduce((a, b) => a * b, 1);
  return {
    legs,
    projectedHitProbability: Math.round(combinedProb * 1000) / 1000,
    projectedPayoutMultiplier: Math.round(dec * 100) / 100,
    combinedAmericanOdds: combined,
    cardConfidence: legs.every((l) => l.confidence === "high") ? "high" : "medium",
    correlationPenalty: 0,
    volatilityPenalty: 0,
    uncertaintyPenalty: 0,
    smartParlayScore: 0,
    warnings: [],
    weakestLegId: legs[legs.length - 1]?.id ?? "",
    strongestLegId: legs[0]?.id ?? "",
    riskLevelCounts: { low: 0, medium: 0, high: 0 },
    tier: "safe",
    variant: "best_value",
  };
}

export async function runProModePipeline(input: ProModePipelineInput): Promise<ProModePipelineResult> {
  // Idempotency — at most one Pro trade per day. Don't re-emit if a
  // trade already exists in any state, including dismissed: the user
  // explicitly closed it; we respect that.
  const today = await todaysProTrade();
  if (today) {
    return { emitted: false, reason: `today already has a pro_mode trade (${today.status})`, tradeId: today.id, status: today.status };
  }

  // 1. Sport priority — drop avoid-tier candidates entirely.
  let pool = input.candidates.filter((c) => !isSportAvoided(String(c.sport)));
  if (!pool.length) {
    return { emitted: false, reason: "no candidates after sport-priority filter" };
  }

  // 2. Sharp filter — strict gates.
  const ranked = rankBySharpEv(pool, input.sharpThresholds ?? SHARP_DEFAULTS);
  if (!ranked.length) {
    return { emitted: false, reason: "no candidates pass Sharp Mode filters" };
  }

  // 3. Top by EV.
  const top = ranked[0].candidate;

  // 4. Try a tight 2-leg parlay if the second-best is also strong AND
  // from a different game (avoid same-game correlation).
  const second = ranked.slice(1).find((r) => r.candidate.gameId !== top.gameId);
  const legs: ValueBetCandidate[] = second && second.evaluation.ev >= (input.sharpThresholds?.evThreshold ?? SHARP_DEFAULTS.evThreshold) * 1.5
    ? [top, second.candidate]
    : [top];

  // 5. Bankroll discipline.
  const discipline: DisciplineStatus = computeDiscipline({
    startOfDayBankroll: input.bankroll.currentBankroll - input.bankroll.todayPnl,
    currentBankroll: input.bankroll.currentBankroll,
    todayPnl: input.bankroll.todayPnl,
    lossStreak: input.bankroll.lossStreak,
    todaysExposure: input.bankroll.todaysExposure,
  });

  // 6. Scaling Ladder cap → final stake.
  const stagePct = stageMaxStakePctFor(input.bankroll.currentBankroll);
  const baseStake = input.bankroll.currentBankroll * stagePct * 0.6; // 60% of stage cap as the "headline" stake
  const adjustedStake = roundStake(baseStake * discipline.stakeMultiplier);

  let status: ProTradeStatus;
  let reason: string;
  if (discipline.blockNewBets) {
    status = "blocked";
    reason = discipline.reason;
  } else if (discipline.state !== "ok") {
    status = "wait";
    reason = discipline.reason;
  } else {
    status = "ready";
    reason = `Sharp pick: ${top.selectionLabel ?? "(leg)"} · EV ${ranked[0].evaluation.ev.toFixed(3)} · edge ${(ranked[0].evaluation.edge * 100).toFixed(1)}pp${legs.length === 2 ? ` (+1 cross-game leg)` : ""}.`;
  }

  // 7. Enqueue.
  const snapshot = buildSnapshot(legs);
  const sport = String(top.sport).toLowerCase();
  // Surface the pipeline's view of where this sport stands.
  const priority = getCachedSportPriority();
  const sportTier = priority?.bySport.get(sport)?.tier ?? null;

  const tradeId = await enqueueProTrade({
    status,
    parlaySnapshot: snapshot,
    stake: adjustedStake,
    reason,
    sport,
    ev: ranked[0].evaluation.ev,
    edge: ranked[0].evaluation.edge,
    extra: {
      sport_tier: sportTier,
      discipline_state: discipline.state,
      stage_pct: stagePct,
      candidates_considered: input.candidates.length,
      passed_sharp: ranked.length,
    },
  });

  return { emitted: true, reason, tradeId, status };
}
