/**
 * Bankroll store — localStorage-first persistence.
 *
 * State shape:
 *   startingBankroll: number     — set once on first deposit / wizard
 *   events: BankrollEvent[]      — append-only ledger
 *
 * Current bankroll = balanceAfter of the last event (or startingBankroll
 * when no events yet). All mutations validate that the resulting
 * balance is non-negative.
 *
 * When a Supabase user is signed in, future PRs will sync events to
 * the bankroll_events table; for now this lib is local-only so the
 * feature works without auth.
 */

import type { BankrollEvent, BankrollEventType } from "./types";

const STORAGE_KEY = "gamelens-bankroll-v1";

interface BankrollSnapshot {
  startingBankroll: number;
  events: BankrollEvent[];
}

const EMPTY: BankrollSnapshot = { startingBankroll: 0, events: [] };

function readSnapshot(): BankrollSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as BankrollSnapshot;
    if (typeof parsed.startingBankroll !== "number" || !Array.isArray(parsed.events)) return EMPTY;
    return parsed;
  } catch {
    return EMPTY;
  }
}

function writeSnapshot(s: BankrollSnapshot): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Quota / private mode — ignore. State stays in memory for the session.
  }
}

export function loadBankroll(): BankrollSnapshot {
  return readSnapshot();
}

export function saveBankroll(s: BankrollSnapshot): void {
  writeSnapshot(s);
}

/** Current bankroll = last event's balanceAfter, or startingBankroll. */
export function currentBankroll(s: BankrollSnapshot): number {
  if (s.events.length === 0) return s.startingBankroll;
  return s.events[s.events.length - 1].balanceAfter;
}

/**
 * Set the starting bankroll. Allowed only when the ledger is empty —
 * otherwise the user must use deposit/withdrawal/adjustment.
 */
export function setStartingBankroll(s: BankrollSnapshot, amount: number): BankrollSnapshot {
  if (!Number.isFinite(amount) || amount < 0) return s;
  if (s.events.length > 0) return s;
  return { ...s, startingBankroll: Math.round(amount * 100) / 100 };
}

/**
 * Append an event. Validates the resulting balance:
 *   - withdrawals + bet_placed cannot drop balance below 0 (returns
 *     null with a reason; caller decides whether to warn the user).
 *   - bet_settled may carry net delta in either direction; net is
 *     `amount` for "win" / "push" / "loss" — caller passes the SIGNED
 *     net through `signedDelta`.
 */
export interface AppendInput {
  type: BankrollEventType;
  /** Always positive — direction comes from the type. */
  amount: number;
  /** For bet_settled, pass the signed net delta (+win, −loss, 0 push). */
  signedDelta?: number;
  betId?: string;
  notes?: string;
}

export interface AppendResult {
  ok: boolean;
  next?: BankrollSnapshot;
  event?: BankrollEvent;
  reason?: string;
}

export function appendEvent(s: BankrollSnapshot, input: AppendInput): AppendResult {
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    return { ok: false, reason: "Amount must be a non-negative number" };
  }

  const current = currentBankroll(s);
  let nextBalance = current;
  switch (input.type) {
    case "deposit":
      nextBalance = current + input.amount;
      break;
    case "withdrawal":
      nextBalance = current - input.amount;
      if (nextBalance < 0) return { ok: false, reason: "Withdrawal exceeds current bankroll" };
      break;
    case "bet_placed":
      // Stake locked in; balance drops. Allow it (per spec — never block
      // the user) but caller is expected to warn when over the 5% cap.
      nextBalance = current - input.amount;
      if (nextBalance < 0) return { ok: false, reason: "Stake exceeds current bankroll" };
      break;
    case "bet_settled": {
      // signedDelta is +win / −loss / 0 push. Amount is unused for
      // delta math but stored as |delta| for readability in the log.
      const delta = input.signedDelta ?? 0;
      nextBalance = current + delta;
      if (nextBalance < 0) return { ok: false, reason: "Loss exceeds current bankroll" };
      break;
    }
    case "adjustment":
      // Adjustments can be ± — we use signedDelta here too.
      nextBalance = current + (input.signedDelta ?? 0);
      if (nextBalance < 0) return { ok: false, reason: "Adjustment would drive bankroll negative" };
      break;
    case "reset":
      // Reset to a target amount (passed via `amount`).
      nextBalance = input.amount;
      break;
  }

  const event: BankrollEvent = {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    occurredAt: new Date().toISOString(),
    type: input.type,
    amount: Math.round(input.amount * 100) / 100,
    balanceAfter: Math.round(nextBalance * 100) / 100,
    betId: input.betId,
    notes: input.notes,
  };

  // For reset, also rebase startingBankroll so currentBankroll math
  // works after the user wipes history.
  const next: BankrollSnapshot = {
    startingBankroll: input.type === "reset" ? Math.round(input.amount * 100) / 100 : s.startingBankroll,
    events: input.type === "reset" ? [event] : [...s.events, event],
  };

  saveBankroll(next);
  return { ok: true, next, event };
}

/** Sum of net P/L for a given calendar day (YYYY-MM-DD, local). */
export function dailyPnl(s: BankrollSnapshot, isoDay: string): number {
  let pnl = 0;
  for (const e of s.events) {
    const day = e.occurredAt.slice(0, 10);
    if (day !== isoDay) continue;
    if (e.type === "bet_settled" || e.type === "adjustment") {
      // amount stored as |delta|; reconstruct sign from balance jump
      const idx = s.events.indexOf(e);
      const prev = idx > 0 ? s.events[idx - 1].balanceAfter : s.startingBankroll;
      pnl += e.balanceAfter - prev;
    }
  }
  return Math.round(pnl * 100) / 100;
}

/** Group events by ISO date for the daily history view. */
export function groupEventsByDay(s: BankrollSnapshot): Map<string, BankrollEvent[]> {
  const out = new Map<string, BankrollEvent[]>();
  for (const e of s.events) {
    const day = e.occurredAt.slice(0, 10);
    const arr = out.get(day) ?? [];
    arr.push(e);
    out.set(day, arr);
  }
  return out;
}

/**
 * Walk the settled-bet events backwards to find the current consecutive
 * win or loss streak. Pushes break neither streak. Returns 0/0 for a
 * fresh ledger.
 */
export function resultStreaks(s: BankrollSnapshot): {
  winStreak: number;
  lossStreak: number;
  lastResult: "win" | "loss" | "push" | null;
} {
  let winStreak = 0;
  let lossStreak = 0;
  let lastResult: "win" | "loss" | "push" | null = null;
  // Reconstruct each settlement's signed delta from balance jumps.
  for (let i = s.events.length - 1; i >= 0; i--) {
    const e = s.events[i];
    if (e.type !== "bet_settled") continue;
    const prev = i > 0 ? s.events[i - 1].balanceAfter : s.startingBankroll;
    const delta = e.balanceAfter - prev;
    const result: "win" | "loss" | "push" =
      delta > 0 ? "win" : delta < 0 ? "loss" : "push";
    if (lastResult === null) lastResult = result;
    if (result === "win") {
      if (lossStreak > 0) break;
      winStreak++;
    } else if (result === "loss") {
      if (winStreak > 0) break;
      lossStreak++;
    } else {
      // push neither extends nor breaks; keep walking
      continue;
    }
  }
  return { winStreak, lossStreak, lastResult };
}

/** Today's total stakes locked in (sum of bet_placed amounts). */
export function todaysExposure(s: BankrollSnapshot, isoDay: string): number {
  let total = 0;
  for (const e of s.events) {
    if (e.type !== "bet_placed") continue;
    if (e.occurredAt.slice(0, 10) !== isoDay) continue;
    total += e.amount;
  }
  return Math.round(total * 100) / 100;
}

/** True when at least one bet_settled today resolved as a loss. */
export function hasTodaysLoss(s: BankrollSnapshot, isoDay: string): boolean {
  for (let i = 0; i < s.events.length; i++) {
    const e = s.events[i];
    if (e.type !== "bet_settled") continue;
    if (e.occurredAt.slice(0, 10) !== isoDay) continue;
    const prev = i > 0 ? s.events[i - 1].balanceAfter : s.startingBankroll;
    if (e.balanceAfter < prev) return true;
  }
  return false;
}

/** Wipe everything — used by the dev "Reset bankroll" button. */
export function wipeBankroll(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
