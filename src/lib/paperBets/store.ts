/**
 * Paper Bets store — Supabase CRUD + bankroll updater.
 *
 * Single-user MVP: anon access via permissive RLS, single bankroll
 * row keyed on user_id=NULL. When auth lands later the same code
 * works — the supabase client just reports a different auth.uid().
 *
 * Mutations are intentionally narrow: place, settle, void. Anything
 * more elaborate (mass-delete, manual override) goes through SQL.
 */

import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { combineAmericanOdds, americanToPayoutMultiplier } from "./normalizer";
import type {
  PaperBankroll,
  PaperBet,
  PaperBetStatus,
  PaperLeg,
} from "./types";

// ── Row shape from Postgres ──────────────────────────────────────────

interface PaperBetRow {
  id: string;
  source: string;
  bet_type: string;
  legs: PaperLeg[];
  stake: number;
  combined_odds_american: number;
  potential_payout: number;
  status: string;
  pnl: number | null;
  app_recommendation_id: string | null;
  app_model_probability: number | null;
  app_edge: number | null;
  app_confidence: string | null;
  notes: string | null;
  placed_at: string;
  resolved_at: string | null;
}

interface PaperBankrollRow {
  starting_bankroll: number;
  current_bankroll: number;
  open_risk: number;
  total_pnl: number;
  bets_placed: number;
  bets_won: number;
  bets_lost: number;
  bets_push: number;
  updated_at: string;
}

function rowToBet(r: PaperBetRow): PaperBet {
  return {
    id: r.id,
    source: r.source as PaperBet["source"],
    betType: r.bet_type as PaperBet["betType"],
    legs: r.legs ?? [],
    stake: Number(r.stake),
    combinedOddsAmerican: Number(r.combined_odds_american ?? 0),
    potentialPayout: Number(r.potential_payout ?? 0),
    status: r.status as PaperBetStatus,
    pnl: r.pnl == null ? null : Number(r.pnl),
    appRecommendationId: r.app_recommendation_id,
    appModelProbability: r.app_model_probability == null ? null : Number(r.app_model_probability),
    appEdge: r.app_edge == null ? null : Number(r.app_edge),
    appConfidence: r.app_confidence as PaperBet["appConfidence"],
    notes: r.notes,
    placedAt: r.placed_at,
    resolvedAt: r.resolved_at,
  };
}

function rowToBankroll(r: PaperBankrollRow): PaperBankroll {
  return {
    startingBankroll: Number(r.starting_bankroll),
    currentBankroll: Number(r.current_bankroll),
    openRisk: Number(r.open_risk),
    totalPnl: Number(r.total_pnl),
    betsPlaced: Number(r.bets_placed),
    betsWon: Number(r.bets_won),
    betsLost: Number(r.bets_lost),
    betsPush: Number(r.bets_push),
    updatedAt: r.updated_at,
  };
}

// ── Bankroll ─────────────────────────────────────────────────────────

const DEFAULT_STARTING = 500;

/**
 * Read the current paper bankroll row. Creates the singleton row on
 * first read so the UI never has to handle a "not initialized" state.
 */
export async function getPaperBankroll(): Promise<PaperBankroll | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data, error } = await supabase
    .from("paper_bankroll")
    .select("*")
    .is("user_id", null)
    .maybeSingle();
  if (error) {
    console.error("paper_bankroll read failed:", error);
    return null;
  }
  if (data) return rowToBankroll(data as PaperBankrollRow);

  // Initialise the singleton anon row on first call.
  const { data: created, error: insErr } = await supabase
    .from("paper_bankroll")
    .insert({
      starting_bankroll: DEFAULT_STARTING,
      current_bankroll: DEFAULT_STARTING,
      open_risk: 0,
      total_pnl: 0,
    })
    .select("*")
    .single();
  if (insErr || !created) {
    console.error("paper_bankroll init failed:", insErr);
    return null;
  }
  return rowToBankroll(created as PaperBankrollRow);
}

/**
 * Reset the paper bankroll. Useful for first-visit onboarding (set
 * starting balance) and explicit user-driven resets in settings.
 */
export async function setPaperBankrollStart(amount: number): Promise<PaperBankroll | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const { data, error } = await supabase
    .from("paper_bankroll")
    .update({
      starting_bankroll: amount,
      current_bankroll: amount,
      open_risk: 0,
      total_pnl: 0,
      bets_placed: 0,
      bets_won: 0,
      bets_lost: 0,
      bets_push: 0,
      updated_at: new Date().toISOString(),
    })
    .is("user_id", null)
    .select("*")
    .maybeSingle();
  if (error || !data) {
    console.error("paper_bankroll reset failed:", error);
    return null;
  }
  return rowToBankroll(data as PaperBankrollRow);
}

// ── Bets ─────────────────────────────────────────────────────────────

export async function listPaperBets(args: {
  status?: "open" | "settled" | "all";
  limit?: number;
} = {}): Promise<PaperBet[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  const { status = "all", limit = 200 } = args;
  let q = supabase
    .from("paper_bets")
    .select("*")
    .order("placed_at", { ascending: false })
    .limit(limit);
  if (status === "open") {
    q = q.in("status", ["open", "in_progress", "needs_review"]);
  } else if (status === "settled") {
    q = q.in("status", ["won", "lost", "push", "voided"]);
  }
  const { data, error } = await q;
  if (error) {
    console.error("listPaperBets failed:", error);
    return [];
  }
  return (data as PaperBetRow[]).map(rowToBet);
}

/**
 * Place a paper bet. Computes combined odds + potential payout from
 * the legs, increments bankroll.open_risk by stake, and increments
 * bets_placed. Does NOT deduct from current_bankroll until the bet
 * settles — open_risk represents money "in flight" without changing
 * the headline balance.
 */
export async function placePaperBet(args: {
  betType: "single" | "parlay" | "sgp";
  legs: PaperLeg[];
  stake: number;
  appRecommendationId?: string;
  appModelProbability?: number;
  appEdge?: number;
  appConfidence?: "high" | "medium" | "low";
  notes?: string;
}): Promise<PaperBet | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  if (!args.legs.length || !Number.isFinite(args.stake) || args.stake <= 0) return null;

  const combined = combineAmericanOdds(args.legs.map((l) => l.americanOdds));
  const decimalMult = args.legs.reduce(
    (m, l) => m * americanToPayoutMultiplier(l.americanOdds),
    1,
  );
  const potentialPayout = Math.round(args.stake * decimalMult * 100) / 100;

  const { data: created, error: insErr } = await supabase
    .from("paper_bets")
    .insert({
      source: "manual_draftkings_entry",
      bet_type: args.betType,
      legs: args.legs,
      stake: args.stake,
      combined_odds_american: combined,
      potential_payout: potentialPayout,
      status: "open",
      app_recommendation_id: args.appRecommendationId ?? null,
      app_model_probability: args.appModelProbability ?? null,
      app_edge: args.appEdge ?? null,
      app_confidence: args.appConfidence ?? null,
      notes: args.notes ?? null,
    })
    .select("*")
    .single();
  if (insErr || !created) {
    console.error("placePaperBet failed:", insErr);
    return null;
  }

  // Update bankroll atomically via RPC would be cleaner, but for the
  // single-user MVP a read-modify-write is acceptable — collisions
  // require two simultaneous tabs, and we're optimistic about that.
  const br = await getPaperBankroll();
  if (br) {
    await supabase
      .from("paper_bankroll")
      .update({
        open_risk: br.openRisk + args.stake,
        bets_placed: br.betsPlaced + 1,
        updated_at: new Date().toISOString(),
      })
      .is("user_id", null);
  }

  return rowToBet(created as PaperBetRow);
}

/**
 * Settle a paper bet — applies a final status + per-leg results +
 * P/L delta, releases the open_risk, and updates win/loss counters.
 * pnl is the SIGNED net delta (positive on win, negative on loss,
 * 0 on push or void).
 */
export async function settlePaperBet(args: {
  betId: string;
  status: PaperBetStatus;
  pnl: number;
  legs: PaperLeg[];
  resolvedAt?: string;
}): Promise<PaperBet | null> {
  if (!isSupabaseConfigured || !supabase) return null;

  // Read current row so we can release the right open_risk amount.
  const { data: existing } = await supabase
    .from("paper_bets")
    .select("stake, status")
    .eq("id", args.betId)
    .maybeSingle();
  if (!existing) return null;
  const wasOpen = ["open", "in_progress", "needs_review"].includes(existing.status as string);

  const { data: updated, error } = await supabase
    .from("paper_bets")
    .update({
      status: args.status,
      pnl: args.pnl,
      legs: args.legs,
      resolved_at: args.resolvedAt ?? new Date().toISOString(),
    })
    .eq("id", args.betId)
    .select("*")
    .maybeSingle();
  if (error || !updated) {
    console.error("settlePaperBet failed:", error);
    return null;
  }

  // Release stake from open_risk + apply delta to current_bankroll.
  const br = await getPaperBankroll();
  if (br && wasOpen) {
    const stake = Number(existing.stake);
    const wonInc = args.status === "won" ? 1 : 0;
    const lostInc = args.status === "lost" ? 1 : 0;
    const pushInc = args.status === "push" ? 1 : 0;
    await supabase
      .from("paper_bankroll")
      .update({
        open_risk: Math.max(0, br.openRisk - stake),
        current_bankroll: br.currentBankroll + args.pnl,
        total_pnl: br.totalPnl + args.pnl,
        bets_won: br.betsWon + wonInc,
        bets_lost: br.betsLost + lostInc,
        bets_push: br.betsPush + pushInc,
        updated_at: new Date().toISOString(),
      })
      .is("user_id", null);
  }

  return rowToBet(updated as PaperBetRow);
}

/**
 * Mark a bet "needs_review" without applying P/L. Used when the
 * resolver can't confidently settle — the user can manually settle
 * later via the card buttons.
 */
export async function markPaperBetNeedsReview(
  betId: string,
  legs: PaperLeg[],
): Promise<PaperBet | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data, error } = await supabase
    .from("paper_bets")
    .update({
      status: "needs_review",
      legs,
    })
    .eq("id", betId)
    .select("*")
    .maybeSingle();
  if (error || !data) {
    console.error("markPaperBetNeedsReview failed:", error);
    return null;
  }
  return rowToBet(data as PaperBetRow);
}

/**
 * Void a paper bet — releases stake without applying any P/L. For
 * cancelled games / postponed events. Preserves legs as-is.
 */
export async function voidPaperBet(betId: string): Promise<PaperBet | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data: existing } = await supabase
    .from("paper_bets")
    .select("stake, status, legs")
    .eq("id", betId)
    .maybeSingle();
  if (!existing) return null;
  return settlePaperBet({
    betId,
    status: "voided",
    pnl: 0,
    legs: (existing.legs as PaperLeg[]) ?? [],
  });
}
