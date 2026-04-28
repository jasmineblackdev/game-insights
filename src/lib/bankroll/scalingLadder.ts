/**
 * Scaling Ladder — bankroll-stage-aware stake sizing.
 *
 * Smaller bankrolls demand wider risk multipliers (you have to risk
 * more % to reach meaningful unit sizes), but they also have less
 * room for variance. Larger bankrolls earn the option to size flat
 * and let edge compound.
 *
 *   Beginner    < $50              max 3% / bet, suggest small builds
 *   Building    $50–$200           max 4% / bet
 *   Established $200–$1,000        max 5% / bet (current default)
 *   Pro         ≥ $1,000           max 4% / bet (less aggressive %; bigger units)
 *
 * The Pro stage is intentionally tighter than Established — once
 * you have a real bankroll, defending it matters more than chasing
 * percentage growth.
 *
 * Used by:
 *   - useBankroll().suggestStake (consumed via stageMaxStakePctFor)
 *   - BankrollWidget label
 *   - Pro Mode unification (next session)
 */

export type BankrollStage = "beginner" | "building" | "established" | "pro";

export interface BankrollStageInfo {
  stage: BankrollStage;
  /** Inclusive lower bound of the stage's bankroll band. */
  rangeMin: number;
  /** Exclusive upper bound; null when open-ended. */
  rangeMax: number | null;
  /** Max % of bankroll to risk per single bet. */
  maxStakePct: number;
  label: string;
  description: string;
}

const STAGES: BankrollStageInfo[] = [
  {
    stage:       "beginner",
    rangeMin:    0,
    rangeMax:    50,
    maxStakePct: 0.03,
    label:       "Beginner",
    description: "Small bankroll — keep tickets cheap (max 3%). Volume + variance can wipe a small starting roll fast.",
  },
  {
    stage:       "building",
    rangeMin:    50,
    rangeMax:    200,
    maxStakePct: 0.04,
    label:       "Building",
    description: "Working roll — max 4% per bet. Focus on ROI, not headline payouts.",
  },
  {
    stage:       "established",
    rangeMin:    200,
    rangeMax:    1000,
    maxStakePct: 0.05,
    label:       "Established",
    description: "Healthy roll — full 5% allowed on top picks.",
  },
  {
    stage:       "pro",
    rangeMin:    1000,
    rangeMax:    null,
    maxStakePct: 0.04,
    label:       "Pro",
    description: "Defend the roll — 4% caps even on top picks; bigger absolute units do the work.",
  },
];

export function stageForBankroll(bankroll: number): BankrollStageInfo {
  if (!Number.isFinite(bankroll) || bankroll < 0) return STAGES[0];
  for (const s of STAGES) {
    if (s.rangeMax == null || bankroll < s.rangeMax) {
      if (bankroll >= s.rangeMin) return s;
    }
  }
  return STAGES[STAGES.length - 1];
}

/** Max stake % override based on bankroll stage. */
export function stageMaxStakePctFor(bankroll: number): number {
  return stageForBankroll(bankroll).maxStakePct;
}

export const ALL_BANKROLL_STAGES: ReadonlyArray<BankrollStageInfo> = STAGES;
