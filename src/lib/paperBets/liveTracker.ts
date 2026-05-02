/**
 * Live-bet tracking — periodic ESPN polling for open paper bets
 * marked bet_timing="live".
 *
 * Approved scope (no optimizer / schema / ML changes):
 *   • Poll the ESPN summary endpoint every 60s while the user has
 *     paper open AND there's at least one open live bet.
 *   • Update live_state JSONB on each bet with current score / period
 *     / game clock when state is "in".
 *   • When state flips to "post", run the existing resolver and
 *     settle the bet via resolved_via='espn'.
 *   • Player-prop legs in live games surface a "settles when box
 *     score is published" tooltip — ESPN's athlete gamelog is not
 *     real-time, so we never claim a live in-game stat. The leg
 *     auto-resolves through the existing resolver path once the
 *     box score lands.
 *
 * Not in this module:
 *   • Server-side cron polling (would let live bets resolve while
 *     the user is offline). Phase-2-of-this-feature, deferred.
 *   • Player-prop live stat fabrication (deliberately out of scope).
 *   • Optimizer or learning-loop wiring.
 */

import { resolvePaperBet } from "./resolver";
import { settlePaperBet, updatePaperBetLegs, markPaperBetNeedsReview } from "./store";
import type { PaperBet, PaperLiveState } from "./types";

const SUMMARY_URLS: Record<string, (eventId: string) => string> = {
  MLB: (id) => `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${id}`,
  NBA: (id) => `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`,
  WNBA:(id) => `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/summary?event=${id}`,
  NFL: (id) => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${id}`,
};

export interface LiveSummary {
  state: "pre" | "in" | "post" | "unknown";
  homeScore: number | null;
  awayScore: number | null;
  /** Display clock e.g. "8:42" or null in baseball halves. */
  clock: string | null;
  /** "Q3", "5th", "Top 7th" — verbatim ESPN label. */
  period: string | null;
}

export async function fetchLiveSummary(sport: string, gameId: string): Promise<LiveSummary | null> {
  const urlFn = SUMMARY_URLS[sport.toUpperCase()];
  if (!urlFn) return null;
  try {
    const res = await fetch(urlFn(gameId));
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const header = (j.header as { competitions?: unknown[] } | undefined);
    const competitions = header?.competitions ?? (j as { competitions?: unknown[] }).competitions;
    const comp = (competitions?.[0] ?? null) as Record<string, unknown> | null;
    if (!comp) return null;
    const status = (comp.status as {
      type?: { state?: string; shortDetail?: string; description?: string };
      displayClock?: string;
      period?: number;
    } | undefined) ?? {};
    const stateRaw = status.type?.state ?? "unknown";
    const clock    = status.displayClock ?? null;
    // Period label — prefer ESPN's shortDetail when present (it
    // already formats periods correctly per sport, e.g. "Top 7th",
    // "Q3 8:42", "End 2nd"); fall back to "P{n}" if missing.
    const period   = status.type?.shortDetail
      ?? (status.period != null ? `P${status.period}` : null);
    const competitors = (comp.competitors as Array<Record<string, unknown>>) ?? [];
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");
    const homeScore = home?.score != null ? Number(home.score) : null;
    const awayScore = away?.score != null ? Number(away.score) : null;
    return {
      state: stateRaw as LiveSummary["state"],
      homeScore,
      awayScore,
      clock,
      period,
    };
  } catch {
    return null;
  }
}

/**
 * Update one live paper bet against ESPN. Branches by game state:
 *   "post" → run the existing resolver + settle (settles via
 *            resolved_via='espn').
 *   "in"   → write live_state snapshot to the bet's row so the UI
 *            can show "LIVE — 67-58 Q3 8:42".
 *   "pre"  → no-op (game hasn't started; nothing to update).
 *
 * Returns the action taken so the caller can roll up counts.
 */
export type LiveTickAction = "settled" | "live_updated" | "needs_review" | "noop" | "error";

export async function tickLiveBet(bet: PaperBet): Promise<LiveTickAction> {
  // Pick a representative gameId — for parlays with mixed games we
  // only update the first leg's state in the live_state snapshot.
  // Resolution still iterates every leg via resolvePaperBet.
  const lead = bet.legs[0];
  const gameId = lead?.gameId;
  const sport = lead?.sport;
  if (!gameId || !sport) return "noop";

  const summary = await fetchLiveSummary(sport, gameId);
  if (!summary) return "error";

  if (summary.state === "post") {
    try {
      const r = await resolvePaperBet(bet);
      const isTerminal =
        r.status === "won" || r.status === "lost" ||
        r.status === "push" || r.status === "voided";
      if (isTerminal) {
        await settlePaperBet({
          betId: bet.id,
          status: r.status,
          pnl: r.pnl ?? 0,
          legs: r.legs,
          resolvedVia: "espn",
        });
        return "settled";
      }
      if (r.status === "needs_review") {
        await markPaperBetNeedsReview(bet.id, r.legs);
        return "needs_review";
      }
      // Game is post but resolver couldn't settle (rare). Persist
      // updated legs so per-leg diagnosis surfaces.
      await updatePaperBetLegs(bet.id, r.legs).catch(() => {});
      return "noop";
    } catch (e) {
      console.warn("[liveTracker] settle failed:", bet.id, e);
      return "error";
    }
  }

  if (summary.state === "in") {
    // Refresh live_state on the bet so the card shows current
    // score/period/clock. We DO NOT touch leg.resolvedActual here —
    // ESPN gamelog is not real-time for player props, and we never
    // fabricate live stats.
    const next: PaperLiveState = {
      scoreHome: summary.homeScore,
      scoreAway: summary.awayScore,
      period:    summary.period,
      gameClock: summary.clock,
      // Preserve entry-time snapshot fields.
      playerStatAtEntry: bet.liveState?.playerStatAtEntry ?? null,
      modelProbAtEntry:  bet.liveState?.modelProbAtEntry ?? null,
    };
    try {
      await writeLiveState(bet.id, next);
      return "live_updated";
    } catch (e) {
      console.warn("[liveTracker] live_state write failed:", bet.id, e);
      return "error";
    }
  }

  return "noop";
}

/** Direct PATCH of paper_bets.live_state for the given bet. */
async function writeLiveState(betId: string, liveState: PaperLiveState): Promise<void> {
  const { isSupabaseConfigured, supabase } = await import("@/lib/supabase");
  if (!isSupabaseConfigured || !supabase) return;
  const payload = {
    score_home:           liveState.scoreHome,
    score_away:           liveState.scoreAway,
    period:               liveState.period,
    game_clock:           liveState.gameClock,
    player_stat_at_entry: liveState.playerStatAtEntry,
    model_prob_at_entry:  liveState.modelProbAtEntry,
  };
  const { error } = await supabase
    .from("paper_bets")
    .update({ live_state: payload })
    .eq("id", betId);
  if (error) throw error;
}

/**
 * Render-time helper: format a paper bet's live_state for display
 * on the card. Returns null when the bet has no useful state to
 * show (pregame or no live data captured).
 */
export function formatLiveStateLine(bet: PaperBet): string | null {
  if (bet.betTiming !== "live") return null;
  const ls = bet.liveState;
  if (!ls) return null;
  const parts: string[] = [];
  if (ls.scoreHome != null && ls.scoreAway != null) {
    parts.push(`${ls.scoreAway}–${ls.scoreHome}`);
  }
  if (ls.period) parts.push(ls.period);
  else if (ls.gameClock) parts.push(ls.gameClock);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}
