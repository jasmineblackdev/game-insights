/**
 * Pro Mode trade queue — durable record of bets the Pro Mode pipeline
 * has emitted. One row per proposed bet; the user confirms or
 * dismisses, stale rows expire after 24h.
 *
 * State machine:
 *   ready     passed all filters; user can confirm
 *   wait      passed filters but bankroll discipline says WAIT
 *   blocked   failed at least one hard gate (stop_loss, sport avoid, etc)
 *   confirmed user confirmed → bridges to recommended_parlays.user_placed
 *   dismissed user dismissed
 *   expired   auto-rolled at >24h old without action
 */

import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import type { SmartParlayResult } from "@/lib/valueParlay/types";

export type ProTradeStatus = "ready" | "wait" | "blocked" | "confirmed" | "dismissed" | "expired";

export interface ProTradeRow {
  id: string;
  status: ProTradeStatus;
  parlay_id: string | null;
  parlay_snapshot: SmartParlayResult & { tier?: string; variant?: string };
  stake: number;
  mode: "pro_mode";
  reason: string | null;
  sport: string | null;
  ev: number | null;
  edge: number | null;
  created_at: string;
  confirmed_at: string | null;
  dismissed_at: string | null;
  extra: Record<string, unknown>;
}

export interface EnqueueProTradeArgs {
  status: Extract<ProTradeStatus, "ready" | "wait" | "blocked">;
  parlayId?: string | null;
  parlaySnapshot: SmartParlayResult & { tier?: string; variant?: string };
  stake: number;
  reason?: string;
  sport?: string;
  ev?: number;
  edge?: number;
  extra?: Record<string, unknown>;
}

/** Insert a fresh trade row. Returns the new row's id, or null on failure. */
export async function enqueueProTrade(args: EnqueueProTradeArgs): Promise<string | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from("pro_trade_queue")
      .insert({
        status: args.status,
        parlay_id: args.parlayId ?? null,
        parlay_snapshot: args.parlaySnapshot,
        stake: args.stake,
        mode: "pro_mode",
        reason: args.reason ?? null,
        sport: args.sport ?? null,
        ev: args.ev ?? null,
        edge: args.edge ?? null,
        extra: args.extra ?? {},
      })
      .select("id")
      .single();
    if (error) return null;
    return (data as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Most recent ACTIVE trade (ready / wait / blocked). The ProBetCard
 * shows the latest one — we don't queue multiple parallel trades.
 */
export async function loadActiveProTrade(): Promise<ProTradeRow | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from("pro_trade_queue")
      .select("*")
      .in("status", ["ready", "wait", "blocked"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !data?.length) return null;
    return data[0] as ProTradeRow;
  } catch {
    return null;
  }
}

export async function confirmProTrade(id: string): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  try {
    const { error } = await supabase
      .from("pro_trade_queue")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
      .eq("id", id);
    return !error;
  } catch {
    return false;
  }
}

export async function dismissProTrade(id: string): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  try {
    const { error } = await supabase
      .from("pro_trade_queue")
      .update({ status: "dismissed", dismissed_at: new Date().toISOString() })
      .eq("id", id);
    return !error;
  } catch {
    return false;
  }
}

/** Sweep ≥24h-old active rows to expired. Cheap to call on mount. */
export async function sweepExpiredProTrades(): Promise<void> {
  if (!isSupabaseConfigured || !supabase) return;
  try {
    await supabase.rpc("pro_trade_queue_sweep_expired");
  } catch {
    // Permissive — function may not exist if migration hasn't applied yet.
  }
}

/**
 * Today's trade for the user, regardless of status. Used to enforce
 * "max 1 Pro Mode trade per day" — the pipeline checks this before
 * emitting a new one.
 */
export async function todaysProTrade(): Promise<ProTradeRow | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const { data, error } = await supabase
      .from("pro_trade_queue")
      .select("*")
      .eq("mode", "pro_mode")
      .gte("created_at", startOfDay.toISOString())
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !data?.length) return null;
    return data[0] as ProTradeRow;
  } catch {
    return null;
  }
}
