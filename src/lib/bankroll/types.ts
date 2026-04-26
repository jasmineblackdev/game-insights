/**
 * Bankroll types — shared between context, lib, and UI.
 *
 * BankrollEvent is the on-the-wire shape that maps 1:1 to the
 * `bankroll_events` Supabase table. The client store mirrors it.
 */

export type BankrollEventType =
  | "deposit"
  | "withdrawal"
  | "bet_placed"
  | "bet_settled"
  | "adjustment"
  | "reset";

export interface BankrollEvent {
  id: string;
  occurredAt: string;            // ISO timestamp
  type: BankrollEventType;
  /** Always positive; sign is implied by `type`. */
  amount: number;
  /** Balance after this event was applied. Never negative. */
  balanceAfter: number;
  /** Optional FK back to recommended_parlays.id. */
  betId?: string;
  notes?: string;
}

/** Risk levels driving auto-stake suggestions. Mirrors propRiskLevels.ts. */
export type StakeRiskLevel = "low" | "medium" | "high";
