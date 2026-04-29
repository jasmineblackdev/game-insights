/**
 * BankrollContext — single source of truth for bankroll state.
 *
 * Hydrates from localStorage on mount and exposes typed mutators that
 * append events and update the cached current balance. Components
 * read currentBankroll for display and call deposit/withdraw/recordBet
 * etc. for mutations.
 *
 * Designed so adding a Supabase sync layer later is a drop-in change
 * inside this provider — components don't need to change.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  appendEvent,
  currentBankroll,
  dailyPnl as dailyPnlFromStore,
  hasTodaysLoss,
  loadBankroll,
  resultStreaks,
  setStartingBankroll as setStartingBankrollStore,
  todaysExposure,
  wipeBankroll,
} from "@/lib/bankroll/store";
import { suggestAllStakes, suggestStakeForRisk, suggestSmartStake } from "@/lib/bankroll/staking";
import type { BankrollEvent, StakeRiskLevel } from "@/lib/bankroll/types";

interface BankrollContextValue {
  isInitialized: boolean;
  startingBankroll: number;
  currentBankroll: number;
  events: BankrollEvent[];
  /** Today's net profit/loss, in dollars. Negative = loss. */
  todayPnl: number;
  /** Total profit/loss since starting bankroll. */
  totalPnl: number;
  /** Initialize bankroll the first time. No-op if already set. */
  initStartingBankroll: (amount: number) => boolean;
  /** Add cash. Always succeeds. */
  deposit: (amount: number, notes?: string) => boolean;
  /** Remove cash. Fails if it would drive balance negative. */
  withdraw: (amount: number, notes?: string) => { ok: boolean; reason?: string };
  /** Mark a bet as placed (locks the stake). */
  recordBetPlaced: (stake: number, betId?: string, notes?: string) => { ok: boolean; reason?: string };
  /**
   * Record a bet result. Pass the SIGNED net delta:
   *   win  → +(payout − stake) … e.g. +$45 on a $5 bet that returned $50
   *   loss → −stake             … e.g. −$5
   *   push → 0
   */
  recordBetSettled: (signedDelta: number, betId?: string, notes?: string) => { ok: boolean; reason?: string };
  /** Manual ± correction. */
  adjust: (signedDelta: number, notes?: string) => { ok: boolean; reason?: string };
  /** Wipe ledger — sets bankroll to a new starting amount. */
  reset: (newStarting: number) => void;
  /** Suggested stakes per risk tier at current bankroll. */
  stakeSuggestions: ReturnType<typeof suggestAllStakes>;
  /** Suggest stake for a specific risk tier. */
  suggestStake: (risk: StakeRiskLevel) => ReturnType<typeof suggestStakeForRisk>;
  /** Current consecutive-win count from bet_settled events. */
  winStreak: number;
  /** Current consecutive-loss count. */
  lossStreak: number;
  /** Most recent settled-bet result (or null). */
  lastResult: "win" | "loss" | "push" | null;
  /** Sum of stakes on bet_placed events occurring today (ISO day). */
  todaysExposure: number;
  /** True when any settled bet today resolved as a loss. */
  hadLossToday: boolean;
}

const Ctx = createContext<BankrollContextValue | null>(null);

function todayIsoDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function BankrollProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(() => loadBankroll());
  const [isInitialized, setIsInitialized] = useState(false);

  // Re-hydrate after first render to avoid SSR mismatch.
  useEffect(() => {
    setSnapshot(loadBankroll());
    setIsInitialized(true);
  }, []);

  const balance = currentBankroll(snapshot);

  const initStartingBankroll = useCallback((amount: number): boolean => {
    if (snapshot.events.length > 0) return false;
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const next = setStartingBankrollStore(snapshot, amount);
    setSnapshot(next);
    return true;
  }, [snapshot]);

  const deposit = useCallback((amount: number, notes?: string): boolean => {
    const r = appendEvent(snapshot, { type: "deposit", amount, notes });
    if (!r.ok || !r.next) return false;
    setSnapshot(r.next);
    return true;
  }, [snapshot]);

  const withdraw = useCallback((amount: number, notes?: string): { ok: boolean; reason?: string } => {
    const r = appendEvent(snapshot, { type: "withdrawal", amount, notes });
    if (r.ok && r.next) {
      setSnapshot(r.next);
      return { ok: true };
    }
    return { ok: false, reason: r.reason };
  }, [snapshot]);

  const recordBetPlaced = useCallback((stake: number, betId?: string, notes?: string): { ok: boolean; reason?: string } => {
    const r = appendEvent(snapshot, { type: "bet_placed", amount: stake, betId, notes });
    if (r.ok && r.next) {
      setSnapshot(r.next);
      return { ok: true };
    }
    return { ok: false, reason: r.reason };
  }, [snapshot]);

  const recordBetSettled = useCallback((signedDelta: number, betId?: string, notes?: string): { ok: boolean; reason?: string } => {
    const r = appendEvent(snapshot, {
      type: "bet_settled",
      amount: Math.abs(signedDelta),
      signedDelta,
      betId,
      notes,
    });
    if (r.ok && r.next) {
      setSnapshot(r.next);
      return { ok: true };
    }
    return { ok: false, reason: r.reason };
  }, [snapshot]);

  const adjust = useCallback((signedDelta: number, notes?: string): { ok: boolean; reason?: string } => {
    const r = appendEvent(snapshot, {
      type: "adjustment",
      amount: Math.abs(signedDelta),
      signedDelta,
      notes,
    });
    if (r.ok && r.next) {
      setSnapshot(r.next);
      return { ok: true };
    }
    return { ok: false, reason: r.reason };
  }, [snapshot]);

  const reset = useCallback((newStarting: number) => {
    wipeBankroll();
    const fresh = { startingBankroll: 0, events: [] };
    const r = appendEvent(fresh, { type: "reset", amount: Math.max(0, newStarting) });
    if (r.ok && r.next) setSnapshot(r.next);
    else setSnapshot({ startingBankroll: Math.max(0, newStarting), events: [] });
  }, []);

  const todayPnl = useMemo(() => dailyPnlFromStore(snapshot, todayIsoDay()), [snapshot]);
  const totalPnl = useMemo(() => {
    if (snapshot.events.length === 0) return 0;
    return Math.round((balance - snapshot.startingBankroll) * 100) / 100;
  }, [balance, snapshot]);

  const stakeSuggestions = useMemo(() => suggestAllStakes(balance), [balance]);
  const suggestStake = useCallback((risk: StakeRiskLevel) => suggestStakeForRisk(balance, risk), [balance]);
  const streaks = useMemo(() => resultStreaks(snapshot), [snapshot]);
  const exposure = useMemo(() => todaysExposure(snapshot, todayIsoDay()), [snapshot]);
  const hadLossToday = useMemo(() => hasTodaysLoss(snapshot, todayIsoDay()), [snapshot]);

  const value = useMemo<BankrollContextValue>(() => ({
    isInitialized,
    startingBankroll: snapshot.startingBankroll,
    currentBankroll: balance,
    events: snapshot.events,
    todayPnl,
    totalPnl,
    initStartingBankroll,
    deposit,
    withdraw,
    recordBetPlaced,
    recordBetSettled,
    adjust,
    reset,
    stakeSuggestions,
    suggestStake,
    winStreak: streaks.winStreak,
    lossStreak: streaks.lossStreak,
    lastResult: streaks.lastResult,
    todaysExposure: exposure,
    hadLossToday,
  }), [
    isInitialized, snapshot, balance, todayPnl, totalPnl,
    initStartingBankroll, deposit, withdraw, recordBetPlaced, recordBetSettled,
    adjust, reset, stakeSuggestions, suggestStake,
    streaks.winStreak, streaks.lossStreak, streaks.lastResult,
    exposure, hadLossToday,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBankroll(): BankrollContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBankroll must be used inside BankrollProvider");
  return v;
}
