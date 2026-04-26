/**
 * Settler for the team-moneyline learning loop.
 *
 * Pick-time snapshots live in `prediction_history_pending` (see
 * stagePendingTeamMoneyline). When a game finals with a valid score,
 * this settler:
 *   1. Selects the pending rows for that game
 *   2. Computes outcome (win / loss / push) by comparing each row's
 *      pick_side to the actual winner from the final score
 *   3. Builds the same p_history payload that
 *      submitTeamMoneylineLearningRecord would have built — but using
 *      the *staged* model_probability/edge/odds, not whatever the
 *      model now says — so Brier scoring honours pick-time inputs
 *   4. Calls submit_prediction_learning_record (the inserter RPC)
 *   5. Deletes the pending row on success
 *
 * Idempotent at the prediction_history level via the unique
 * (external_game_id, market_type='team_moneyline') index. The pending
 * delete only runs if the RPC succeeded so retries are safe.
 *
 * Called fire-and-forget from the Index / DailyPlan game-load paths
 * with an in-session dedupe set so we don't re-hit the DB on every
 * render.
 */

import type { GamePrediction } from "@/data/mockGames";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

interface PendingRow {
  external_game_id: string;
  sport: string;
  market_type: string;
  pick_side: string;
  pick_label: string;
  american_odds: number | null;
  implied_probability: number | null;
  model_probability: number | null;
  edge: number | null;
  confidence: string;
  risk_score: number | null;
  reason_tags: unknown;
  prediction_phase: string;
  extra: Record<string, unknown> | null;
  user_id: string | null;
}

/** Actual winner from a final score; "draw" when threeWay and tied. */
function actualSideFromScore(
  game: GamePrediction,
  fh: number,
  fa: number
): "home" | "away" | "draw" {
  if (game.threeWay && fh === fa) return "draw";
  if (fh > fa) return "home";
  if (fa > fh) return "away";
  return "draw";
}

function outcomeFor(pickSide: string, actual: "home" | "away" | "draw"): "win" | "loss" | "push" {
  if (pickSide === actual) return "win";
  // Two-way market with a tie (rare but possible in mocks/bad data) → push.
  if (actual === "draw" && (pickSide === "home" || pickSide === "away")) return "push";
  return "loss";
}

function errorSize(modelProb: number | null, outcome: "win" | "loss" | "push"): number {
  if (modelProb == null || !Number.isFinite(modelProb)) return 0;
  const y = outcome === "win" ? 1 : outcome === "loss" ? 0 : 0.5;
  return Math.round(Math.abs(modelProb - y) * 10000) / 10000;
}

function oddsRangeBucket(american: number | null): string {
  if (american == null || !Number.isFinite(american)) return "unknown";
  if (american <= -250) return "heavy_favorite";
  if (american <= -150) return "favorite";
  if (american <= -110) return "pick_em_fav";
  if (american < 150) return "pick_em_dog";
  if (american < 250) return "underdog";
  return "longshot";
}

/** Settled-game IDs already swept this session — avoids re-hitting the DB. */
const swept = new Set<string>();

export async function settleFinalGames(games: GamePrediction[]): Promise<void> {
  if (!isSupabaseConfigured || !supabase) return;

  const finals = games.filter((g) => {
    if (g.status !== "final") return false;
    if (swept.has(g.id)) return false;
    const fh = g._meta?.finalHomeScore;
    const fa = g._meta?.finalAwayScore;
    return fh != null && fa != null && Number.isFinite(fh) && Number.isFinite(fa);
  });
  if (!finals.length) return;

  for (const game of finals) {
    swept.add(game.id);
    const fh = game._meta!.finalHomeScore!;
    const fa = game._meta!.finalAwayScore!;
    const actual = actualSideFromScore(game, fh, fa);

    let pending: PendingRow[] | null = null;
    try {
      const { data, error } = await supabase
        .from("prediction_history_pending")
        .select("*")
        .eq("external_game_id", game.id);
      if (error) {
        if (import.meta.env.DEV) console.warn("[settler][select]", error.message);
        continue;
      }
      pending = (data as PendingRow[]) ?? [];
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[settler][select]", e);
      continue;
    }
    if (!pending.length) continue;

    for (const row of pending) {
      const outcome = outcomeFor(row.pick_side, actual);

      const p_history: Record<string, unknown> = {
        external_game_id: row.external_game_id,
        sport: row.sport,
        market_type: row.market_type,
        pick_side: row.pick_side,
        pick_label: row.pick_label,
        american_odds: row.american_odds != null ? String(row.american_odds) : "",
        implied_probability: row.implied_probability != null ? String(row.implied_probability) : "",
        model_probability: row.model_probability != null ? String(row.model_probability) : "",
        edge: row.edge != null ? String(row.edge) : "",
        confidence: row.confidence,
        risk_score: row.risk_score != null ? String(row.risk_score) : "",
        reason_tags: row.reason_tags ?? [],
        checkpoint_stage: "",
        prediction_phase: row.prediction_phase,
        final_home_score: String(fh),
        final_away_score: String(fa),
        outcome,
        error_size: String(errorSize(row.model_probability, outcome)),
        odds_range_bucket: oddsRangeBucket(row.american_odds),
        source: "gamelens_settler_v1",
        learning_phase: "1",
        extra: row.extra ?? {},
      };
      if (row.user_id) p_history.user_id = row.user_id;

      try {
        const { error: rpcErr } = await supabase.rpc("submit_prediction_learning_record", {
          p_history,
          p_error_tags: [],
        });
        if (rpcErr) {
          if (import.meta.env.DEV) console.warn("[settler][rpc]", rpcErr.message);
          continue;
        }
        await supabase
          .from("prediction_history_pending")
          .delete()
          .eq("external_game_id", row.external_game_id)
          .eq("market_type", row.market_type)
          .eq("pick_side", row.pick_side);
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[settler][rpc]", e);
      }
    }
  }
}

/** Test-only — clears the in-session dedupe so retries can replay. */
export function _resetSettlerCacheForTests() {
  swept.clear();
}
