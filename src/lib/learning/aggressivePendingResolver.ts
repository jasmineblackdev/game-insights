/**
 * Aggressive pending-parlay resolver — fires from /parlays directly.
 *
 * The existing `resolveRecommendedParlays` resolver requires a
 * `GamePrediction[]` array (loaded from Index.tsx / DailyPlanPage) and
 * has a 7-day window. Result: when the user lands directly on
 * /parlays, nothing settles, and rows older than a week stay
 * "pending" forever even though the games are long final.
 *
 * This resolver fixes both:
 *   - No games-array dependency. Fetches ESPN summary endpoint per
 *     unique gameId on the fly.
 *   - No date cutoff. Walks every pending app_recommended /
 *     user_manual parlay and tries to settle each leg.
 *   - Supports moneyline / spread / total / player_prop. Falls
 *     back to "needs_review" — leaves leg pending — when data is
 *     ambiguous; never invents an outcome.
 *
 * Reuses existing helpers:
 *   - lookupAthleteStat + outcomeForOverUnder for player props
 *   - bridgeParlayLegs for prediction_history sync
 *   - rollupParlayOutcome (replicated locally; matches the original)
 */

import { supabase } from "@/lib/supabase";
import { bridgeParlayLegs } from "@/lib/learning/parlayLegBridge";
import {
  espnLabelsForStat,
  leaguePathFor,
  lookupAthleteStat,
  outcomeForOverUnder,
} from "@/lib/learning/espnBoxScoreLookup";

type LegOutcome = "win" | "loss" | "push" | "pending";

interface PendingLeg {
  id?: string;
  selection?: string;
  sport?: string;
  market_type?: string;
  pick_type?: string;
  stat_type?: string;
  line_value?: number | null;
  direction?: "MORE" | "LESS" | null;
  /** Sometimes spelled this way on legacy rows. */
  side?: "home" | "away" | null;
  team_id?: string | null;
  team_abbr?: string | null;
  american_odds?: number | null;
  leg_outcome?: LegOutcome;
  game_id?: string;
  actual_value?: number | null;
}

interface PendingParlay {
  id: string;
  source: string;
  date: string;
  recommended_at: string;
  resolved_at: string | null;
  user_id: string | null;
  legs: PendingLeg[];
  outcome: "pending" | "won" | "lost" | "push" | "partial";
}

export interface AggressiveResolverResult {
  scanned: number;
  resolved: number;          // parlays that flipped from pending → terminal
  legsSettled: number;       // individual legs that flipped
  bridgeInserted: number;
  /** Parlays force-voided via voidStaleBeforeDate. Always 0 unless the option is set. */
  staleVoided: number;
  errors: string[];
}

interface GameSummary {
  state: "pre" | "in" | "post" | "unknown";
  homeAbbr: string;
  awayAbbr: string;
  homeScore: number | null;
  awayScore: number | null;
}

const summaryCache = new Map<string, Promise<GameSummary | null>>();

async function fetchGameSummary(sport: string, gameId: string): Promise<GameSummary | null> {
  const path = leaguePathFor(sport);
  if (!path) return null;
  const key = `${path}:${gameId}`;
  if (summaryCache.has(key)) return summaryCache.get(key)!;
  const p = (async (): Promise<GameSummary | null> => {
    try {
      const res = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${encodeURIComponent(gameId)}`,
      );
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
      return {
        state: stateRaw as GameSummary["state"],
        homeAbbr: ((home?.team as { abbreviation?: string } | undefined)?.abbreviation) ?? "",
        awayAbbr: ((away?.team as { abbreviation?: string } | undefined)?.abbreviation) ?? "",
        homeScore: home?.score != null ? Number(home.score) : null,
        awayScore: away?.score != null ? Number(away.score) : null,
      };
    } catch {
      return null;
    }
  })();
  summaryCache.set(key, p);
  return p;
}

/**
 * Extract { gameId, side } from a moneyline leg id. The optimizer
 * emits two patterns over the project's history; both are handled.
 */
function parseMoneylineLeg(leg: PendingLeg): { gameId: string; side: "home" | "away" } | null {
  if (leg.market_type !== "moneyline") return null;
  const id = leg.id ?? "";
  // Modern: vp-{gameId}-ml-{side}
  let m = /^vp-(.+)-ml-(home|away)$/.exec(id);
  if (m) return { gameId: m[1], side: m[2] as "home" | "away" };
  // Legacy: ml-{gameId}-{side}
  m = /^ml-(.+)-(home|away)$/.exec(id);
  if (m) return { gameId: m[1], side: m[2] as "home" | "away" };
  // Last resort: leg carries side directly
  if (leg.side && leg.game_id) return { gameId: leg.game_id, side: leg.side };
  return null;
}

/**
 * Extract { gameId, side, line } from a spread leg. Pattern from
 * buildCandidates: vp-{gameId}-spread-{home|away}. The line is on the
 * leg row.
 */
function parseSpreadLeg(leg: PendingLeg): { gameId: string; side: "home" | "away" } | null {
  if (leg.market_type !== "spread") return null;
  const id = leg.id ?? "";
  const m = /^vp-(.+)-spread-(home|away)$/.exec(id);
  if (m) return { gameId: m[1], side: m[2] as "home" | "away" };
  if (leg.side && leg.game_id) return { gameId: leg.game_id, side: leg.side };
  return null;
}

function parseTotalLeg(leg: PendingLeg): { gameId: string; side: "over" | "under" } | null {
  if (leg.market_type !== "total") return null;
  const id = leg.id ?? "";
  const m = /^vp-(.+)-total-(over|under)$/.exec(id);
  if (m) return { gameId: m[1], side: m[2] as "over" | "under" };
  if (leg.direction && leg.game_id) {
    const side = leg.direction === "MORE" ? "over" : "under";
    return { gameId: leg.game_id, side };
  }
  return null;
}

/**
 * The same prop-id parser the original resolver uses. Two patterns:
 *   ml-prop-espn-{sport}-{gameId}-{athleteId}-{stat}
 *   pe-espn-{sport}-{gameId}-{athleteId}-{stat}
 */
function parsePropLeg(leg: PendingLeg): { sport: string; gameId: string; athleteId: string } | null {
  if (leg.market_type !== "player_prop") return null;
  const id = leg.id ?? "";
  const m = /^(?:ml-prop|pe)-espn-([a-z]+)-(\d+)-(\d+)-/i.exec(id);
  if (!m) return null;
  return { sport: m[1].toLowerCase(), gameId: m[2], athleteId: m[3] };
}

function legOutcomeFromMoneyline(g: GameSummary, side: "home" | "away"): LegOutcome | null {
  if (g.state !== "post") return null;
  if (g.homeScore == null || g.awayScore == null) return null;
  if (g.homeScore === g.awayScore) return "push";
  const homeWon = g.homeScore > g.awayScore;
  return (side === "home" && homeWon) || (side === "away" && !homeWon) ? "win" : "loss";
}

function legOutcomeFromSpread(g: GameSummary, side: "home" | "away", line: number | null | undefined): LegOutcome | null {
  if (g.state !== "post") return null;
  if (g.homeScore == null || g.awayScore == null) return null;
  if (line == null || !Number.isFinite(line)) return null;
  // line is signed for THIS side. side=home + line=-3.5 means home is -3.5.
  const teamScore = side === "home" ? g.homeScore : g.awayScore;
  const oppScore = side === "home" ? g.awayScore : g.homeScore;
  const margin = teamScore - oppScore;
  const adjusted = margin + line;
  if (Math.abs(adjusted) < 0.001) return "push";
  return adjusted > 0 ? "win" : "loss";
}

function legOutcomeFromTotal(g: GameSummary, side: "over" | "under", line: number | null | undefined): LegOutcome | null {
  if (g.state !== "post") return null;
  if (g.homeScore == null || g.awayScore == null) return null;
  if (line == null || !Number.isFinite(line)) return null;
  const total = g.homeScore + g.awayScore;
  if (total === line) return "push";
  const isOver = total > line;
  return (isOver && side === "over") || (!isOver && side === "under") ? "win" : "loss";
}

function rollupParlayOutcome(legs: PendingLeg[]): "pending" | "won" | "lost" | "push" {
  let anyPending = false;
  let anyLoss = false;
  let allPush = true;
  for (const l of legs) {
    if (!l.leg_outcome || l.leg_outcome === "pending") { anyPending = true; allPush = false; continue; }
    if (l.leg_outcome === "loss") anyLoss = true;
    if (l.leg_outcome !== "push") allPush = false;
  }
  if (anyLoss) return "lost";
  if (anyPending) return "pending";
  if (allPush) return "push";
  return "won";
}

interface ResolveOptions {
  /**
   * Filter by source. Defaults to ["app_recommended", "user_manual"]
   * — settles both the optimizer's auto-saved variants AND parlays
   * the user logged manually on /parlays.
   */
  sources?: string[];
  /** Cap how many pending parlays we touch per call (network polite). */
  maxParlays?: number;
  /** Optional progress callback for UI surfaces. */
  onProgress?: (done: number, total: number) => void;
  /**
   * When set (YYYY-MM-DD), any parlay still "pending" after the
   * resolution attempt AND whose `date` is strictly earlier than
   * this cutoff gets force-voided: outcome flipped to "push"
   * (the closest no-decision state the schema's CHECK constraint
   * allows) with a transparent user_notes flag explaining the action.
   *
   * Pure cleanup mechanism — only call from an explicit user action,
   * never from a silent sweep. Idempotent.
   */
  voidStaleBeforeDate?: string;
}

export async function aggressivelyResolvePendingParlays(
  options: ResolveOptions = {},
): Promise<AggressiveResolverResult> {
  const result: AggressiveResolverResult = {
    scanned: 0,
    resolved: 0,
    legsSettled: 0,
    bridgeInserted: 0,
    staleVoided: 0,
    errors: [],
  };
  if (!supabase) {
    result.errors.push("Supabase not configured.");
    return result;
  }

  const sources = options.sources ?? ["app_recommended", "user_manual"];
  const maxParlays = options.maxParlays ?? 200;

  // Pull every pending parlay across the requested sources. No date
  // cutoff — old "pending" rows are exactly what this resolver exists
  // to clean up.
  let pending: PendingParlay[] = [];
  try {
    const { data, error } = await supabase
      .from("recommended_parlays")
      .select("id, source, date, recommended_at, resolved_at, user_id, legs, outcome")
      .in("source", sources)
      .eq("outcome", "pending")
      .order("recommended_at", { ascending: false })
      .limit(maxParlays);
    if (error) {
      result.errors.push(error.message);
      return result;
    }
    pending = (data as PendingParlay[]) ?? [];
  } catch (e) {
    result.errors.push(String(e));
    return result;
  }

  result.scanned = pending.length;
  if (pending.length === 0) return result;

  let progressDone = 0;
  for (const parlay of pending) {
    progressDone++;
    options.onProgress?.(progressDone, pending.length);

    const updatedLegs: PendingLeg[] = parlay.legs.map((l) => ({ ...l }));
    let touchedAnyLeg = false;

    for (const leg of updatedLegs) {
      if (leg.leg_outcome && leg.leg_outcome !== "pending") continue;
      const sport = (leg.sport ?? "").toLowerCase();

      // ── Moneyline ───────────────────────────────────────────────
      const ml = parseMoneylineLeg(leg);
      if (ml) {
        const summary = await fetchGameSummary(sport, ml.gameId);
        if (!summary) continue;
        const out = legOutcomeFromMoneyline(summary, ml.side);
        if (out) {
          leg.leg_outcome = out;
          leg.game_id = ml.gameId;
          touchedAnyLeg = true;
          result.legsSettled++;
        }
        continue;
      }

      // ── Spread ──────────────────────────────────────────────────
      const sp = parseSpreadLeg(leg);
      if (sp) {
        const summary = await fetchGameSummary(sport, sp.gameId);
        if (!summary) continue;
        const out = legOutcomeFromSpread(summary, sp.side, leg.line_value);
        if (out) {
          leg.leg_outcome = out;
          leg.game_id = sp.gameId;
          touchedAnyLeg = true;
          result.legsSettled++;
        }
        continue;
      }

      // ── Total ───────────────────────────────────────────────────
      const tot = parseTotalLeg(leg);
      if (tot) {
        const summary = await fetchGameSummary(sport, tot.gameId);
        if (!summary) continue;
        const out = legOutcomeFromTotal(summary, tot.side, leg.line_value);
        if (out) {
          leg.leg_outcome = out;
          leg.game_id = tot.gameId;
          touchedAnyLeg = true;
          result.legsSettled++;
        }
        continue;
      }

      // ── Player prop ─────────────────────────────────────────────
      const prop = parsePropLeg(leg);
      if (prop && leg.line_value != null && leg.direction && leg.stat_type) {
        if (!espnLabelsForStat(leg.stat_type)) continue;
        try {
          const lookup = await lookupAthleteStat({
            sport: prop.sport,
            gameId: prop.gameId,
            athleteId: prop.athleteId,
            playerName: playerNameFromSelection(leg.selection),
            statType: leg.stat_type,
          });
          if (lookup.value == null) continue;
          const out = outcomeForOverUnder(lookup.value, leg.line_value, leg.direction);
          leg.leg_outcome = out;
          leg.game_id = prop.gameId;
          leg.actual_value = lookup.value;
          touchedAnyLeg = true;
          result.legsSettled++;
        } catch {
          // box not yet posted — leave pending
        }
      }
    }

    const rolled = rollupParlayOutcome(updatedLegs);
    let newOutcome: "pending" | "won" | "lost" | "push" = rolled;
    let stalenessVoided = false;

    // Stale-void path — explicit cleanup. Only fires when caller opted
    // in via voidStaleBeforeDate AND the parlay is still pending after
    // leg resolution AND parlay.date is strictly earlier than the
    // cutoff. Never fires from silent sweeps.
    if (
      options.voidStaleBeforeDate
      && newOutcome === "pending"
      && parlay.date
      && parlay.date < options.voidStaleBeforeDate
    ) {
      newOutcome = "push";
      stalenessVoided = true;
    }

    if (!touchedAnyLeg && !stalenessVoided) continue;

    const fullySettled = newOutcome !== "pending";

    try {
      const updates: Record<string, unknown> = {
        legs: updatedLegs,
        outcome: newOutcome,
        resolved_at: fullySettled ? new Date().toISOString() : null,
      };
      if (stalenessVoided) {
        updates.user_notes = `Auto-voided ${new Date().toISOString().slice(0, 10)}: data unavailable for resolution after cutoff.`;
      }
      const { error: upErr } = await supabase
        .from("recommended_parlays")
        .update(updates)
        .eq("id", parlay.id);
      if (upErr) {
        result.errors.push(`${parlay.id}: ${upErr.message}`);
        continue;
      }
      if (fullySettled && !stalenessVoided) result.resolved++;
      if (stalenessVoided) result.staleVoided++;

      // Skip the prediction_history bridge for stale-voided rows —
      // no real outcomes were observed, so writing them in would
      // pollute ML training as artificial pushes.
      if (stalenessVoided) continue;

      // Bridge into prediction_history for ML loop. Idempotent.
      const bridge = await bridgeParlayLegs({
        id: parlay.id,
        source: parlay.source,
        date: parlay.date,
        recommended_at: parlay.recommended_at,
        resolved_at: parlay.resolved_at,
        user_id: parlay.user_id,
        legs: updatedLegs,
      });
      result.bridgeInserted += bridge.inserted;
    } catch (e) {
      result.errors.push(`${parlay.id}: ${String(e)}`);
    }
  }

  return result;
}

function playerNameFromSelection(selection: string | undefined | null): string | null {
  if (!selection) return null;
  const m = /^([^\d]+?)\s+(?:Over|Under|O\/U|\d)/i.exec(selection.trim());
  return m ? m[1].trim() : null;
}
