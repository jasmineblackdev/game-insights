/**
 * Paper Bets store — Supabase CRUD + bankroll updater.
 *
 * Single-user MVP: anon access via permissive RLS, single bankroll
 * row keyed on user_id=NULL. When auth lands later the same code
 * works — the supabase client just reports a different auth.uid().
 *
 * Mutations are intentionally narrow: place, settle, void. Anything
 * more elaborate (mass-delete, manual override) goes through SQL.
 *
 * Error handling: all functions throw on Postgres error so callers
 * can surface the actual reason (table missing, RLS deny, network)
 * to the user instead of a generic "couldn't save" toast. The
 * migration not being applied is the most common failure mode and
 * needs to be visible — the table-missing error string is the
 * fastest signal that the migration needs deploying.
 */

import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { combineAmericanOdds, americanToPayoutMultiplier } from "./normalizer";
import type {
  PaperBankroll,
  PaperBet,
  PaperBetStatus,
  PaperBetTiming,
  PaperLeg,
  PaperLiveState,
} from "./types";

/**
 * Raised when the user's Supabase project doesn't have the paper_bets
 * migration deployed. Detected by Postgres "relation … does not exist"
 * errors. The page-level handler shows a CTA explaining how to apply
 * the migration.
 */
export class PaperBetsMigrationMissingError extends Error {
  constructor(detail: string) {
    super(`Paper Bets tables not found in Supabase. Apply migration 20260509000000_paper_bets.sql. (${detail})`);
    this.name = "PaperBetsMigrationMissingError";
  }
}

function classifyError(error: { message?: string; code?: string; details?: string } | null | undefined, fallback: string): Error {
  const msg = error?.message ?? "";
  const detail = error?.details ?? "";
  // Migration missing — multiple signal shapes:
  //   • Postgres "relation … does not exist" (SQLSTATE 42P01) — direct
  //     query path, when PostgREST forwards the raw error.
  //   • PostgREST "Could not find the table … in the schema cache"
  //     (PGRST205) — when the schema cache hasn't been refreshed yet
  //     and PostgREST short-circuits before hitting Postgres. This is
  //     the more common case in deployed environments.
  const looksLikeMigrationMissing =
    error?.code === "42P01" ||
    error?.code === "PGRST205" ||
    /relation .* does not exist/i.test(msg) ||
    /relation .* does not exist/i.test(detail) ||
    /could not find the table .* in the schema cache/i.test(msg) ||
    /could not find the table .* in the schema cache/i.test(detail);
  if (looksLikeMigrationMissing) {
    return new PaperBetsMigrationMissingError(msg || detail || "table not found");
  }
  return new Error(msg || fallback);
}

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
  /** New columns from 20260510000000_paper_bets_live_timing migration. */
  bet_timing?: string | null;
  live_state?: Record<string, unknown> | null;
  /** New column from 20260512000000_resolution_metadata migration. */
  resolved_via?: string | null;
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
  // Live state JSONB → typed object. snake_case → camelCase, keeping
  // all fields nullable since pre-migration rows lack the column.
  const ls = r.live_state ?? null;
  const liveState: PaperLiveState | null = ls
    ? {
        scoreHome:         (ls.score_home as number | null | undefined) ?? null,
        scoreAway:         (ls.score_away as number | null | undefined) ?? null,
        period:            (ls.period as string | null | undefined) ?? null,
        gameClock:         (ls.game_clock as string | null | undefined) ?? null,
        playerStatAtEntry: (ls.player_stat_at_entry as number | null | undefined) ?? null,
        modelProbAtEntry:  (ls.model_prob_at_entry as number | null | undefined) ?? null,
      }
    : null;
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
    betTiming: (r.bet_timing as PaperBetTiming) ?? "pregame",
    liveState,
    resolvedVia: (r.resolved_via as PaperBet["resolvedVia"]) ?? null,
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
 *
 * Throws if Supabase isn't configured or the migration isn't deployed.
 */
export async function getPaperBankroll(): Promise<PaperBankroll> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Supabase not configured (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY missing).");
  }
  const { data, error } = await supabase
    .from("paper_bankroll")
    .select("*")
    .is("user_id", null)
    .maybeSingle();
  if (error) throw classifyError(error, "Failed to read paper_bankroll.");
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
  if (insErr || !created) throw classifyError(insErr, "Failed to initialize paper_bankroll.");
  return rowToBankroll(created as PaperBankrollRow);
}

/**
 * Reset the paper bankroll. Useful for first-visit onboarding (set
 * starting balance) and explicit user-driven resets in settings.
 *
 * #166: before the reset writes, snapshot the current row into
 * paper_bankroll_archives so the user keeps a record of how the
 * prior session performed. The snapshot is non-fatal — if the
 * archive insert fails (e.g. the migration hasn't been applied
 * yet) the reset still proceeds. The user's intent to reset
 * outweighs the loss of one history row.
 */
export async function setPaperBankrollStart(
  amount: number,
  options: { label?: string | null } = {},
): Promise<PaperBankroll> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Supabase not configured.");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Starting balance must be positive.");
  }
  // Read the soon-to-be-replaced row first. Doubles as the
  // "ensure row exists" guard the original implementation had.
  const prior = await getPaperBankroll();

  // Archive the prior session before clobbering it. Skipped only
  // when the row is in its initial untouched state — no point
  // archiving an empty session the user just minted.
  const priorTouched =
    prior.betsPlaced > 0 ||
    Math.abs(prior.totalPnl) > 0.001 ||
    prior.currentBankroll !== prior.startingBankroll;
  if (priorTouched) {
    try {
      await supabase.from("paper_bankroll_archives").insert({
        starting_bankroll:  prior.startingBankroll,
        ending_bankroll:    prior.currentBankroll,
        total_pnl:          prior.totalPnl,
        open_risk_at_close: prior.openRisk,
        bets_placed:        prior.betsPlaced,
        bets_won:           prior.betsWon,
        bets_lost:          prior.betsLost,
        bets_push:          prior.betsPush,
        // updated_at on paper_bankroll moves on every bet
        // settle, so it's not the session-start time. Best
        // effort: leave session_started_at null when we don't
        // have a reliable signal. Future enhancement could read
        // from the prior archive row's archived_at.
        session_started_at: null,
        label:              options.label?.trim() || null,
        reason:             "user_reset",
      });
    } catch (e) {
      console.warn("Bankroll archive insert failed (reset proceeding):", e);
    }
  }

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
  if (error || !data) throw classifyError(error, "Failed to reset paper_bankroll.");
  return rowToBankroll(data as PaperBankrollRow);
}

/**
 * Snapshot of a prior paper-trading session, captured at the moment
 * the user reset their bankroll. Append-only — the UI displays a
 * descending list under "Past sessions" so the user sees how each
 * cycle ended.
 */
export interface PaperBankrollArchive {
  id:                string;
  startingBankroll:  number;
  endingBankroll:    number;
  totalPnl:          number;
  openRiskAtClose:   number;
  betsPlaced:        number;
  betsWon:           number;
  betsLost:          number;
  betsPush:          number;
  archivedAt:        string;
  label:             string | null;
  reason:            string;
}

interface PaperBankrollArchiveRow {
  id: string;
  starting_bankroll: number;
  ending_bankroll: number;
  total_pnl: number;
  open_risk_at_close: number;
  bets_placed: number;
  bets_won: number;
  bets_lost: number;
  bets_push: number;
  archived_at: string;
  label: string | null;
  reason: string;
}

/**
 * Read the archived sessions, newest first. Capped at 50 — the
 * panel only ever shows the recent entries, and the user's
 * "lifetime" interest is captured by the running totals on the
 * active row.
 */
export async function listPaperBankrollArchives(): Promise<PaperBankrollArchive[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  const { data, error } = await supabase
    .from("paper_bankroll_archives")
    .select("*")
    .order("archived_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return (data as PaperBankrollArchiveRow[]).map((r) => ({
    id:               r.id,
    startingBankroll: Number(r.starting_bankroll),
    endingBankroll:   Number(r.ending_bankroll),
    totalPnl:         Number(r.total_pnl),
    openRiskAtClose:  Number(r.open_risk_at_close),
    betsPlaced:       Number(r.bets_placed),
    betsWon:          Number(r.bets_won),
    betsLost:         Number(r.bets_lost),
    betsPush:         Number(r.bets_push),
    archivedAt:       r.archived_at,
    label:            r.label,
    reason:           r.reason,
  }));
}

// ── Bets ─────────────────────────────────────────────────────────────

export async function listPaperBets(args: {
  status?: "open" | "settled" | "all";
  limit?: number;
} = {}): Promise<PaperBet[]> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Supabase not configured.");
  }
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
  if (error) throw classifyError(error, "Failed to read paper_bets.");
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
  /** "pregame" (default) or "live". When "live", liveState should be populated. */
  betTiming?: PaperBetTiming;
  /** Game state captured at the moment of a live bet. */
  liveState?: PaperLiveState | null;
  /**
   * How the bet was created. Defaults to "manual_draftkings_entry"
   * for backwards compatibility with the slip builder. Set to
   * "app_recommendation_paper" when an auto-plan draft is being
   * submitted so analytics splits (#171) attribute the row to
   * the system rather than the user.
   */
  source?: PaperBet["source"];
}): Promise<PaperBet> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Supabase not configured.");
  }
  if (!args.legs.length) throw new Error("At least one leg required.");
  if (!Number.isFinite(args.stake) || args.stake <= 0) throw new Error("Stake must be positive.");

  const combined = combineAmericanOdds(args.legs.map((l) => l.americanOdds));
  const decimalMult = args.legs.reduce(
    (m, l) => m * americanToPayoutMultiplier(l.americanOdds),
    1,
  );
  const potentialPayout = Math.round(args.stake * decimalMult * 100) / 100;

  // Serialize live state into snake_case for the JSONB column. Nulls
  // are intentionally preserved so the DB row reflects "user did not
  // record this field" rather than "missing column".
  const liveStateRow = args.liveState
    ? {
        score_home:            args.liveState.scoreHome ?? null,
        score_away:            args.liveState.scoreAway ?? null,
        period:                args.liveState.period ?? null,
        game_clock:            args.liveState.gameClock ?? null,
        player_stat_at_entry:  args.liveState.playerStatAtEntry ?? null,
        model_prob_at_entry:   args.liveState.modelProbAtEntry ?? null,
      }
    : null;

  const { data: created, error: insErr } = await supabase
    .from("paper_bets")
    .insert({
      source: args.source ?? "manual_draftkings_entry",
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
      bet_timing: args.betTiming ?? "pregame",
      live_state: liveStateRow,
    })
    .select("*")
    .single();
  if (insErr || !created) throw classifyError(insErr, "Failed to insert paper bet.");

  // Update bankroll atomically via RPC would be cleaner, but for the
  // single-user MVP a read-modify-write is acceptable — collisions
  // require two simultaneous tabs, and we're optimistic about that.
  // Bankroll fetch failure is non-fatal — the bet is already saved.
  try {
    const br = await getPaperBankroll();
    await supabase
      .from("paper_bankroll")
      .update({
        open_risk: br.openRisk + args.stake,
        bets_placed: br.betsPlaced + 1,
        updated_at: new Date().toISOString(),
      })
      .is("user_id", null);
  } catch (e) {
    console.warn("Bankroll update failed (bet still saved):", e);
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
  /**
   * Tracks the resolution path. "espn" when the auto-resolver settled
   * the bet, "manual" when the user clicked Won/Lost/Push. Defaults
   * to "manual" if not specified — caller should pass "espn"
   * explicitly from the auto-resolver.
   */
  resolvedVia?: "espn" | "manual";
}): Promise<PaperBet> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Supabase not configured.");
  }

  // Read current row so we can release the right open_risk amount.
  const { data: existing, error: readErr } = await supabase
    .from("paper_bets")
    .select("stake, status")
    .eq("id", args.betId)
    .maybeSingle();
  if (readErr) throw classifyError(readErr, "Failed to read paper bet.");
  if (!existing) throw new Error(`Paper bet ${args.betId} not found.`);
  const wasOpen = ["open", "in_progress", "needs_review"].includes(existing.status as string);

  // Only set resolved_via for terminal statuses. needs_review / open
  // / in_progress are not "resolved" yet — the column stays null
  // until a real outcome lands.
  const isTerminal = ["won", "lost", "push", "voided"].includes(args.status);
  const updatePayload: Record<string, unknown> = {
    status: args.status,
    pnl: args.pnl,
    legs: args.legs,
    resolved_at: args.resolvedAt ?? new Date().toISOString(),
  };
  if (isTerminal) {
    updatePayload.resolved_via = args.resolvedVia ?? "manual";
  }
  const { data: updated, error } = await supabase
    .from("paper_bets")
    .update(updatePayload)
    .eq("id", args.betId)
    .select("*")
    .maybeSingle();
  if (error || !updated) throw classifyError(error, "Failed to update paper bet.");

  // Release stake from open_risk + apply delta to current_bankroll.
  // Non-fatal if it fails — the bet is already settled.
  try {
    const br = await getPaperBankroll();
    if (wasOpen) {
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
  } catch (e) {
    console.warn("Bankroll update on settle failed (bet still settled):", e);
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
): Promise<PaperBet> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Supabase not configured.");
  }
  const { data, error } = await supabase
    .from("paper_bets")
    .update({
      status: "needs_review",
      legs,
    })
    .eq("id", betId)
    .select("*")
    .maybeSingle();
  if (error || !data) throw classifyError(error, "Failed to mark needs_review.");
  return rowToBet(data as PaperBetRow);
}

/**
 * Update only the legs JSONB for a bet, preserving status. Used when
 * the auto-resolver tries a still-pending bet — the per-leg diagnosis
 * should surface in the UI ("Pending — game not final") even though
 * the bet stays open.
 */
export async function updatePaperBetLegs(
  betId: string,
  legs: PaperLeg[],
): Promise<PaperBet> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Supabase not configured.");
  }
  const { data, error } = await supabase
    .from("paper_bets")
    .update({ legs })
    .eq("id", betId)
    .select("*")
    .maybeSingle();
  if (error || !data) throw classifyError(error, "Failed to update paper bet legs.");
  return rowToBet(data as PaperBetRow);
}

/**
 * Void a paper bet — releases stake without applying any P/L. For
 * cancelled games / postponed events. Preserves legs as-is.
 */
export async function voidPaperBet(betId: string): Promise<PaperBet> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Supabase not configured.");
  }
  const { data: existing, error } = await supabase
    .from("paper_bets")
    .select("stake, status, legs")
    .eq("id", betId)
    .maybeSingle();
  if (error) throw classifyError(error, "Failed to read paper bet.");
  if (!existing) throw new Error(`Paper bet ${betId} not found.`);
  return settlePaperBet({
    betId,
    status: "voided",
    pnl: 0,
    legs: (existing.legs as PaperLeg[]) ?? [],
  });
}
