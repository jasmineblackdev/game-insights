/**
 * App-recommended parlay outcome resolver.
 *
 * The parlay logger writes every variant the optimizer surfaces into
 * recommended_parlays with `outcome='pending'`. Without this resolver
 * those rows stay pending forever and analytics rollups can't measure
 * the engine's actual hit rate.
 *
 * On each game-list load, this walks pending app_recommended (and
 * user_manual when applicable) parlays, matches each leg's underlying
 * game to the games array, and:
 *   - flips leg.leg_outcome to win | loss | push from final score
 *   - rolls all settled legs up into the parlay-level outcome
 *     (all wins → won; any loss → lost; any pending leg → still pending)
 *   - writes back the updated legs jsonb + outcome + resolved_at
 *   - bridges newly settled legs into prediction_history via
 *     bridgeParlayLegs so the ML loop sees them
 *
 * Leg matching strategy
 *   Team moneyline legs from the parlay builder are tagged with id
 *   shaped `vp-${gameId}-ml-${side}` (see buildMoneylineLeg in
 *   buildCandidates.ts). The resolver parses the gameId out, looks up
 *   the game in the supplied array, compares the picked side to the
 *   actual winner. Spread / total / player_prop legs are out of scope
 *   for now — they need different scoring inputs (line cover for
 *   spread, stat for prop) and would mis-resolve if guessed.
 *
 * In-session dedupe set so the effect can fire on every render.
 */

import type { GamePrediction } from "@/data/mockGames";
import { supabase } from "@/lib/supabase";
import { bridgeParlayLegs } from "@/lib/learning/parlayLegBridge";
import { lookupAthleteStat, outcomeForOverUnder, espnLabelsForStat } from "@/lib/learning/espnBoxScoreLookup";

type LegOutcome = "win" | "loss" | "push" | "pending";

interface PendingLeg {
  id?: string;
  selection?: string;
  sport?: string;
  market_type?: string;
  pick_type?: string;
  stat_type?: string;
  line_value?: number | null;
  /** "MORE" / "LESS" — direction for over/under markets. */
  direction?: "MORE" | "LESS" | null;
  american_odds?: number | null;
  leg_outcome?: LegOutcome;
  /** Set to game.id when the resolver matches the leg back to a game. */
  game_id?: string;
  /** Filled in when player-prop resolution succeeds. */
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

const swept = new Set<string>();

/**
 * Parse gameId from a parlay leg's id. Buildcandidates uses the
 * pattern `vp-${gameId}-ml-${side}`; gameId itself can contain
 * hyphens, so we anchor on the trailing `-ml-${side}` suffix.
 */
function gameIdFromLegId(legId: string | undefined, marketType: string | undefined): { gameId: string; side: "home" | "away" } | null {
  if (!legId || marketType !== "moneyline") return null;
  const m = /^vp-(.+)-ml-(home|away)$/.exec(legId);
  if (!m) return null;
  return { gameId: m[1], side: m[2] as "home" | "away" };
}

/**
 * Parse player-prop leg id into its ESPN identifiers. The optimizer's
 * enriched-prop builder produces ids shaped:
 *   ml-prop-espn-{sport}-{gameId}-{athleteId}-{stat}
 * Returns null when the id doesn't match — caller falls back to
 * matching by player name + game search if/when we ever support it.
 */
function parsePropLegId(legId: string | undefined): { sport: string; gameId: string; athleteId: string } | null {
  if (!legId) return null;
  const m = /^(?:ml-prop|pe)-espn-([a-z]+)-(\d+)-(\d+)-/i.exec(legId);
  if (!m) return null;
  return { sport: m[1].toLowerCase(), gameId: m[2], athleteId: m[3] };
}

/** Pull player name out of "Ramon Laureano Under 18.5 rbis"-style strings. */
function playerNameFromSelection(selection: string | undefined | null): string | null {
  if (!selection) return null;
  const m = /^([^\d]+?)\s+(?:Over|Under|O\/U|\d)/i.exec(selection.trim());
  return m ? m[1].trim() : null;
}

function legOutcomeFromGame(game: GamePrediction, picked: "home" | "away"): LegOutcome | null {
  if (game.status !== "final") return null;
  const fh = game._meta?.finalHomeScore;
  const fa = game._meta?.finalAwayScore;
  if (fh == null || fa == null || !Number.isFinite(fh) || !Number.isFinite(fa)) return null;
  if (fh === fa) return "push";
  const homeWon = fh > fa;
  return (picked === "home" && homeWon) || (picked === "away" && !homeWon) ? "win" : "loss";
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

export interface ResolverResult {
  parlays_scanned: number;
  parlays_resolved: number;
  legs_settled: number;
  bridge_inserted: number;
  errors: string[];
}

/**
 * Walk pending app_recommended parlays and update outcome fields when
 * their legs' games have finalled. Fire-and-forget — never throws.
 */
export async function resolveRecommendedParlays(games: GamePrediction[]): Promise<ResolverResult> {
  const result: ResolverResult = {
    parlays_scanned: 0,
    parlays_resolved: 0,
    legs_settled: 0,
    bridge_inserted: 0,
    errors: [],
  };
  if (!supabase) return result;

  // Index games by id for O(1) lookup. Skip the resolver entirely
  // when no finalized games are available — nothing to settle.
  const gameById = new Map<string, GamePrediction>();
  let anyFinal = false;
  for (const g of games) {
    gameById.set(g.id, g);
    if (g.status === "final") anyFinal = true;
  }
  if (!anyFinal) return result;

  // Pull pending app_recommended parlays from the last 7 days. We
  // don't sweep older rows on every render — let a separate manual
  // backfill handle long-history catch-up.
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  let pending: PendingParlay[] = [];
  try {
    const { data, error } = await supabase
      .from("recommended_parlays")
      .select("id, source, date, recommended_at, resolved_at, user_id, legs, outcome")
      .eq("source", "app_recommended")
      .eq("outcome", "pending")
      .gte("recommended_at", since)
      .limit(500);
    if (error) {
      result.errors.push(error.message);
      return result;
    }
    pending = (data as PendingParlay[]) ?? [];
  } catch (e) {
    result.errors.push(String(e));
    return result;
  }

  result.parlays_scanned = pending.length;
  if (pending.length === 0) return result;

  for (const parlay of pending) {
    if (swept.has(parlay.id)) continue;

    const updatedLegs: PendingLeg[] = parlay.legs.map((l) => ({ ...l }));
    let touchedAnyLeg = false;

    for (let i = 0; i < updatedLegs.length; i++) {
      const leg = updatedLegs[i];
      if (leg.leg_outcome && leg.leg_outcome !== "pending") continue;

      // ── Team moneyline: match against the games array we already have.
      const matched = gameIdFromLegId(leg.id, leg.market_type);
      if (matched) {
        const game = gameById.get(matched.gameId);
        if (!game) continue;
        const newOutcome = legOutcomeFromGame(game, matched.side);
        if (!newOutcome) continue;
        leg.leg_outcome = newOutcome;
        leg.game_id = matched.gameId;
        touchedAnyLeg = true;
        result.legs_settled++;
        continue;
      }

      // ── Player prop: parse the ESPN-style id, look up the box score.
      if (leg.market_type === "player_prop"
          && leg.line_value != null
          && leg.direction
          && leg.stat_type) {
        const propIds = parsePropLegId(leg.id);
        if (!propIds) continue;
        // Skip stats we don't know how to map to ESPN labels — better to
        // leave pending than to write a wrong outcome.
        if (!espnLabelsForStat(leg.stat_type)) continue;

        try {
          const lookup = await lookupAthleteStat({
            sport: propIds.sport,
            gameId: propIds.gameId,
            athleteId: propIds.athleteId,
            playerName: playerNameFromSelection(leg.selection),
            statType: leg.stat_type,
          });
          if (lookup.value == null) continue;

          const newOutcome = outcomeForOverUnder(lookup.value, leg.line_value, leg.direction);
          leg.leg_outcome = newOutcome;
          leg.game_id = propIds.gameId;
          leg.actual_value = lookup.value;
          touchedAnyLeg = true;
          result.legs_settled++;
        } catch {
          // ESPN unreachable / box not posted — leave pending, retry later.
        }
      }
    }

    if (!touchedAnyLeg) continue;

    const newParlayOutcome = rollupParlayOutcome(updatedLegs);
    const fullySettled = newParlayOutcome !== "pending";

    try {
      const { error: upErr } = await supabase
        .from("recommended_parlays")
        .update({
          legs: updatedLegs,
          outcome: newParlayOutcome,
          resolved_at: fullySettled ? new Date().toISOString() : null,
        })
        .eq("id", parlay.id);
      if (upErr) {
        result.errors.push(`${parlay.id}: ${upErr.message}`);
        continue;
      }
      if (fullySettled) {
        swept.add(parlay.id);
        result.parlays_resolved++;
      }

      // Bridge the newly-settled legs into prediction_history so the
      // ML loop sees them. The bridge is idempotent so re-bridging
      // already-settled legs is a cheap no-op.
      const bridge = await bridgeParlayLegs({
        id: parlay.id,
        source: parlay.source,
        date: parlay.date,
        recommended_at: parlay.recommended_at,
        resolved_at: parlay.resolved_at,
        user_id: parlay.user_id,
        legs: updatedLegs,
      });
      result.bridge_inserted += bridge.inserted;
    } catch (e) {
      result.errors.push(`${parlay.id}: ${String(e)}`);
    }
  }

  return result;
}

/** Test-only — clears the in-session dedupe so retries can replay. */
export function _resetRecommendedParlayResolverCacheForTests(): void {
  swept.clear();
}
