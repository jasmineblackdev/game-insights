/**
 * Paper Bets resolver — best-effort settlement using existing feeds.
 *
 * Strategy:
 *   - Moneyline / spread / total: pull final game scores from ESPN's
 *     scoreboard summary endpoint by gameId. Authoritative once
 *     the game state is "post" / "final".
 *   - Player props: pull final per-game stats from ESPN's athlete
 *     gamelog (existing playerGameLog.ts) and match by date+stat.
 *
 * If a leg can't be confidently resolved, mark it "needs_review"
 * and let the user settle manually. NEVER guess.
 */

import { fetchPlayerLastGames, type GameLogSport } from "@/lib/playerGameLog";
import { americanToPayoutMultiplier } from "./normalizer";
import {
  isTransient,
  type ResolutionDiagnosis,
} from "@/lib/learning/resolutionDiagnosis";
import type { PaperBet, PaperBetStatus, PaperLeg, PaperLegStatus } from "./types";

// ── ESPN game summary fetcher ────────────────────────────────────────

const SUMMARY_URLS: Record<string, (eventId: string) => string> = {
  MLB: (id) => `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${id}`,
  NBA: (id) => `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`,
  WNBA:(id) => `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/summary?event=${id}`,
  NFL: (id) => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${id}`,
};

interface GameSummary {
  state: "pre" | "in" | "post" | "unknown";
  homeAbbr: string;
  awayAbbr: string;
  homeScore: number | null;
  awayScore: number | null;
}

async function fetchGameSummary(sport: string, gameId: string): Promise<GameSummary | null> {
  const urlFn = SUMMARY_URLS[sport.toUpperCase()];
  if (!urlFn) return null;
  try {
    const res = await fetch(urlFn(gameId));
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const competitions = (j.header as { competitions?: unknown[] } | undefined)?.competitions
      ?? (j as { competitions?: unknown[] }).competitions;
    const comp = (competitions?.[0] ?? null) as Record<string, unknown> | null;
    if (!comp) return null;
    const stateRaw = (comp.status as { type?: { state?: string } } | undefined)?.type?.state ?? "unknown";
    const competitors = (comp.competitors as Array<Record<string, unknown>>) ?? [];
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");
    const homeScore = home?.score != null ? Number(home.score) : null;
    const awayScore = away?.score != null ? Number(away.score) : null;
    const homeAbbr = ((home?.team as { abbreviation?: string } | undefined)?.abbreviation) ?? "";
    const awayAbbr = ((away?.team as { abbreviation?: string } | undefined)?.abbreviation) ?? "";
    return {
      state: stateRaw as GameSummary["state"],
      homeAbbr,
      awayAbbr,
      homeScore,
      awayScore,
    };
  } catch {
    return null;
  }
}

// ── Per-leg resolvers ────────────────────────────────────────────────

interface LegResolution {
  status: PaperLegStatus;
  resolvedActual?: number | null;
  resolvedReason: string;
  /**
   * Canonical diagnosis enum. When status is "open" the resolver
   * tried but the game/box-score isn't ready (transient). When
   * status is "needs_review" the diagnosis pinpoints why a verified
   * resolution wasn't possible (terminal until manual action).
   */
  diagnosis?: ResolutionDiagnosis;
}

/**
 * Moneyline / spread / total — settles from final score when game is "post".
 *
 * Safety rule: if the score, team label, or market type can't be
 * verified, the leg returns needs_review with a diagnosis enum. The
 * resolver never guesses an outcome.
 */
async function resolveTeamLeg(leg: PaperLeg): Promise<LegResolution> {
  if (!leg.gameId) {
    return {
      status: "needs_review",
      resolvedReason: "No game id on leg.",
      diagnosis: "unparseable_id",
    };
  }
  const summary = await fetchGameSummary(leg.sport, leg.gameId);
  if (!summary) {
    return {
      status: "needs_review",
      resolvedReason: "Game summary fetch failed.",
      diagnosis: "box_score_missing",
    };
  }
  if (summary.state !== "post") {
    return {
      status: "open",
      resolvedReason: `Game state ${summary.state}.`,
      diagnosis: "game_not_final",
    };
  }
  if (summary.homeScore == null || summary.awayScore == null) {
    return {
      status: "needs_review",
      resolvedReason: "Final score missing.",
      diagnosis: "box_score_missing",
    };
  }

  const teamLabel = (leg.teamLabel ?? "").toUpperCase();
  const teamIsHome = teamLabel && teamLabel === summary.homeAbbr.toUpperCase();
  const teamIsAway = teamLabel && teamLabel === summary.awayAbbr.toUpperCase();
  if (!teamIsHome && !teamIsAway && leg.marketType !== "total") {
    return {
      status: "needs_review",
      resolvedReason: "Team label didn't match either side.",
      diagnosis: "team_label_unmatched",
    };
  }

  if (leg.marketType === "moneyline") {
    const teamScore = teamIsHome ? summary.homeScore : summary.awayScore;
    const oppScore = teamIsHome ? summary.awayScore : summary.homeScore;
    if (teamScore > oppScore) {
      return { status: "won", resolvedActual: teamScore, resolvedReason: `${teamLabel} won ${teamScore}-${oppScore}.` };
    }
    if (teamScore < oppScore) {
      return { status: "lost", resolvedActual: teamScore, resolvedReason: `${teamLabel} lost ${teamScore}-${oppScore}.` };
    }
    return { status: "push", resolvedActual: teamScore, resolvedReason: "Tied (rare)." };
  }

  if (leg.marketType === "spread" && leg.line != null) {
    const teamScore = teamIsHome ? summary.homeScore : summary.awayScore;
    const oppScore = teamIsHome ? summary.awayScore : summary.homeScore;
    const margin = teamScore - oppScore;
    const adjusted = margin + leg.line; // negative line = favourite
    if (adjusted > 0) return { status: "won", resolvedActual: margin, resolvedReason: `Cover by ${adjusted.toFixed(1)} (margin ${margin}, line ${leg.line}).` };
    if (adjusted < 0) return { status: "lost", resolvedActual: margin, resolvedReason: `Lost by ${Math.abs(adjusted).toFixed(1)} (margin ${margin}, line ${leg.line}).` };
    return { status: "push", resolvedActual: margin, resolvedReason: "Spread pushed exactly." };
  }

  if (leg.marketType === "total" && leg.line != null && leg.direction) {
    const total = summary.homeScore + summary.awayScore;
    if (total === leg.line) return { status: "push", resolvedActual: total, resolvedReason: `Total pushed at ${total}.` };
    const isOver = total > leg.line;
    const won = (isOver && leg.direction === "over") || (!isOver && leg.direction === "under");
    return {
      status: won ? "won" : "lost",
      resolvedActual: total,
      resolvedReason: `Final total ${total} vs ${leg.direction} ${leg.line}.`,
    };
  }

  return {
    status: "needs_review",
    resolvedReason: "Market not recognised by team resolver.",
    diagnosis: "stat_type_unsupported",
  };
}

/**
 * Player prop — resolves from athlete gamelog by playerId (never
 * name). Date must match the leg's gameTimeIso so we don't pick up
 * the wrong game's stat line. Otherwise mark needs_review.
 *
 * Safety rule: when a numeric stat can't be verified for the right
 * date, the resolver writes a diagnosis and stops. It never falls
 * back to the latest gamelog row.
 */
async function resolvePropLeg(leg: PaperLeg): Promise<LegResolution> {
  // Per-field diagnosis so the UI can tell the user what's missing.
  if (!leg.playerId) {
    return {
      status: "needs_review",
      resolvedReason: "Missing playerId — name-only matching is not allowed.",
      diagnosis: "unparseable_id",
    };
  }
  if (!leg.statType) {
    return {
      status: "needs_review",
      resolvedReason: "Missing stat type.",
      diagnosis: "stat_type_unsupported",
    };
  }
  if (leg.line == null || !leg.direction) {
    return {
      status: "needs_review",
      resolvedReason: "Missing line or direction.",
      diagnosis: "missing_direction",
    };
  }
  const sport = leg.sport.toUpperCase() as GameLogSport;
  const rows = await fetchPlayerLastGames(sport, leg.playerId, leg.statType, 5);
  if (!rows.length) {
    return {
      status: "needs_review",
      resolvedReason: "Athlete gamelog returned no rows.",
      diagnosis: "player_not_in_box_score",
    };
  }

  // Pick the row matching the leg's game date — never fall back to
  // the latest row. If we can't match, surface review rather than
  // guess at the wrong game's line.
  let target = rows[0];
  if (leg.gameTimeIso) {
    const targetDay = leg.gameTimeIso.slice(0, 10);
    const match = rows.find((r) => r.date === targetDay);
    if (!match) {
      return {
        status: "needs_review",
        resolvedReason: `No gamelog row for ${targetDay}; latest available ${rows[0].date}.`,
        diagnosis: "player_not_in_box_score",
      };
    }
    target = match;
  }

  const actual = target.value;
  if (!Number.isFinite(actual)) {
    return {
      status: "needs_review",
      resolvedReason: "Gamelog row has no numeric value for this stat.",
      diagnosis: "box_score_missing",
    };
  }
  if (actual === leg.line) {
    return { status: "push", resolvedActual: actual, resolvedReason: `Stat landed on the line (${actual}).` };
  }
  const isOver = actual > leg.line;
  const won = (isOver && leg.direction === "over") || (!isOver && leg.direction === "under");
  return {
    status: won ? "won" : "lost",
    resolvedActual: actual,
    resolvedReason: `${leg.playerName ?? "Player"} ${actual} vs ${leg.direction} ${leg.line}.`,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Attempt to resolve a single leg. Pure read-only; returns a new leg
 * object the caller can persist. Emits a single console.debug per
 * attempt with playerId / line_value / matched stat — so a failing
 * resolution is auditable without opening the JSONB.
 */
export async function resolveLeg(leg: PaperLeg): Promise<PaperLeg> {
  if (leg.status !== "open") return leg;
  const r = leg.marketType === "player_prop"
    ? await resolvePropLeg(leg)
    : await resolveTeamLeg(leg);

  // Centralize the "transient diagnosis → keep leg open" rule so the
  // parlay rollup doesn't paint a red NEEDS REVIEW pill on bets that
  // are just waiting for ESPN. Per-resolver sites historically were
  // inconsistent — game_not_final returned status="open" but
  // box_score_missing returned status="needs_review", so a parlay with
  // one in-progress game and one game-just-ended (box not yet
  // published) showed up as needs_review when neither leg actually
  // needs the user to do anything. isTransient() is the single source
  // of truth for which diagnoses can self-clear over time.
  const effective: LegResolution = (r.status === "needs_review" && isTransient(r.diagnosis))
    ? { ...r, status: "open" }
    : r;

  if (typeof console !== "undefined") {
    console.debug("[paperBets/resolver]", {
      sport:       leg.sport,
      market:      leg.marketType,
      stat:        leg.statType,
      playerId:    leg.playerId,
      gameId:      leg.gameId,
      line_value:  leg.line,
      direction:   leg.direction,
      next_status: effective.status,
      diagnosis:   effective.diagnosis ?? null,
      transient:   isTransient(effective.diagnosis),
      actual:      effective.resolvedActual ?? null,
    });
  }

  if (effective.status === "open") {
    // Game/box not ready yet — preserve diagnosis for the UI without
    // moving the leg to a terminal state.
    return { ...leg, resolutionDiagnosis: effective.diagnosis ?? null };
  }
  return {
    ...leg,
    status: effective.status,
    resolvedActual: effective.resolvedActual ?? null,
    resolvedReason: effective.resolvedReason,
    resolvedAt: new Date().toISOString(),
    resolutionDiagnosis: effective.status === "needs_review" ? (effective.diagnosis ?? null) : null,
  };
}

/**
 * Roll the per-leg resolutions into a parlay-level status + signed
 * P/L. Conventions:
 *   - any leg "lost" → bet "lost", pnl = -stake
 *   - any leg "needs_review" with no losses → bet "needs_review",
 *     pnl null, stake stays locked in open_risk
 *   - all legs "won" → bet "won", pnl = stake × (decimalMult - 1)
 *   - mix of won + push → recompute payout dropping the pushes (DK
 *     rule: pushes void that leg, parlay re-prices on the rest)
 *   - all legs "push" → bet "push", pnl = 0
 *   - all legs "voided" → bet "voided", pnl = 0
 */
export function rollUpParlayStatus(args: {
  legs: PaperLeg[];
  stake: number;
}): { status: PaperBetStatus; pnl: number | null } {
  const { legs, stake } = args;
  if (legs.some((l) => l.status === "lost")) {
    return { status: "lost", pnl: -stake };
  }
  if (legs.some((l) => l.status === "needs_review")) {
    return { status: "needs_review", pnl: null };
  }
  if (legs.some((l) => l.status === "open")) {
    return { status: legs.some((l) => l.status === "won" || l.status === "push") ? "in_progress" : "open", pnl: null };
  }

  // All resolved: combination of won / push / voided.
  const live = legs.filter((l) => l.status === "won" || l.status === "lost");
  if (!live.length) {
    // Everything pushed or voided.
    if (legs.every((l) => l.status === "voided")) return { status: "voided", pnl: 0 };
    return { status: "push", pnl: 0 };
  }
  if (live.every((l) => l.status === "won")) {
    const decimalMult = legs
      .filter((l) => l.status === "won")
      .reduce((m, l) => m * americanToPayoutMultiplier(l.americanOdds), 1);
    const pnl = Math.round(stake * (decimalMult - 1) * 100) / 100;
    return { status: "won", pnl };
  }
  return { status: "lost", pnl: -stake };
}

/**
 * Resolve every leg of a paper bet in parallel and roll up. Returns
 * a fresh bet snapshot ready for settlePaperBet().
 */
export async function resolvePaperBet(bet: PaperBet): Promise<{
  legs: PaperLeg[];
  status: PaperBetStatus;
  pnl: number | null;
}> {
  const resolvedLegs = await Promise.all(bet.legs.map((l) => resolveLeg(l)));
  const roll = rollUpParlayStatus({ legs: resolvedLegs, stake: bet.stake });
  return { legs: resolvedLegs, ...roll };
}
