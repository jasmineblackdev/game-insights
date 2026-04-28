/**
 * Bankroll discipline guardrails — Stop Loss, Profit Lock, trailing
 * drawdown. Composable with the existing autoProfit module's exposure
 * cap (8%/day) and loss-streak reductions.
 *
 * The status helper is read by the Sharp/Pro Mode banner + the
 * pickAction resolver to bias toward WAIT/SKIP when guardrails fire.
 *
 * Day boundary uses the same todayIsoDay() the bankroll store uses,
 * so exposures + PnL line up.
 */

export interface DisciplineInput {
  /** Bankroll at the START of today (currentBankroll − todayPnl). */
  startOfDayBankroll: number;
  /** Current bankroll right now. */
  currentBankroll: number;
  /** Net PnL today (positive = up). */
  todayPnl: number;
  /** Consecutive-loss count (reset on win). */
  lossStreak: number;
  /** Total stake committed today. */
  todaysExposure: number;
}

export type DisciplineState =
  | "ok"               // continue normally
  | "stop_loss_hit"    // daily loss ≥ 8% → SKIP rest of day
  | "profit_locked"    // ≥10% daily gain → reduce stakes
  | "profit_target";   // ≥20% daily gain → suggest stopping

export interface DisciplineStatus {
  state: DisciplineState;
  /** Human-readable reason for the banner. */
  reason: string;
  /** Multiplier callers can apply to suggested stake. 0 = no bet. */
  stakeMultiplier: number;
  /** True when no new bet should be opened today. */
  blockNewBets: boolean;
}

const STOP_LOSS_PCT      = 0.08;  // 8% daily down → stop
const PROFIT_LOCK_PCT    = 0.10;  // 10% daily up → reduce stakes (×0.5)
const PROFIT_TARGET_PCT  = 0.20;  // 20% daily up → suggest stop

export function computeDiscipline(input: DisciplineInput): DisciplineStatus {
  const start = Math.max(1, input.startOfDayBankroll);
  const dailyDownPct = input.todayPnl < 0 ? Math.abs(input.todayPnl) / start : 0;
  const dailyUpPct   = input.todayPnl > 0 ? input.todayPnl / start : 0;

  // Order matters — stop loss is the hardest guardrail; check first.
  if (dailyDownPct >= STOP_LOSS_PCT) {
    return {
      state: "stop_loss_hit",
      reason: `Daily stop-loss hit (-${(dailyDownPct * 100).toFixed(1)}% of start). No new bets today — ride out, regroup tomorrow.`,
      stakeMultiplier: 0,
      blockNewBets: true,
    };
  }
  if (dailyUpPct >= PROFIT_TARGET_PCT) {
    return {
      state: "profit_target",
      reason: `Up ${(dailyUpPct * 100).toFixed(1)}% — Profit Target reached. Locking in is the disciplined call.`,
      stakeMultiplier: 0.25,
      blockNewBets: false,
    };
  }
  if (dailyUpPct >= PROFIT_LOCK_PCT) {
    return {
      state: "profit_locked",
      reason: `Up ${(dailyUpPct * 100).toFixed(1)}% today — Profit Lock active, stakes halved to protect the gain.`,
      stakeMultiplier: 0.5,
      blockNewBets: false,
    };
  }
  return {
    state: "ok",
    reason: "",
    stakeMultiplier: 1,
    blockNewBets: false,
  };
}

export const DISCIPLINE_THRESHOLDS = {
  STOP_LOSS_PCT,
  PROFIT_LOCK_PCT,
  PROFIT_TARGET_PCT,
};
