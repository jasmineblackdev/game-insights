import type { GamePrediction, LiveBettingStageRow } from "@/data/mockGames";
import { isSupabaseConfigured } from "@/lib/supabase";

const FN = "persist-live-betting";

function pushStage(
  game: GamePrediction,
  stages: Record<string, unknown>[],
  kind: "pregame" | "live_checkpoint" | "final",
  row: LiveBettingStageRow,
  checkpointId: string | null,
  oddsEventId: string | null,
  schemaVersion: number
) {
  const id =
    kind === "final"
      ? `${game.id}:lb:final`
      : kind === "pregame"
        ? `${game.id}:lb:pregame`
        : `${game.id}:lb:${checkpointId ?? row.stageId}`;
  stages.push({
    id,
    game_id: game.id,
    league: game.league,
    stage_kind: kind,
    checkpoint_id: kind === "live_checkpoint" ? checkpointId : null,
    pick_side: row.pickSide,
    pick_abbrev: row.pickAbbrev,
    model_probability: row.modelProbability,
    implied_probability: row.impliedProbability,
    edge: row.edge,
    american_odds: row.americanOdds,
    confidence: row.confidence,
    recommended_action: row.recommendedAction,
    odds_source: row.oddsSource ?? null,
    sport_signals_json: row.sportSignals,
    live_state_json: row.liveStateSnapshot ?? null,
    odds_event_id: oddsEventId,
    schema_version: schemaVersion,
    client_captured_at: row.capturedAt,
  });
}

/** Upsert pregame / checkpoint / final rows (stable ids) via Edge + service role. */
export async function flushLiveBettingStagesToSupabase(games: GamePrediction[]): Promise<void> {
  if (!isSupabaseConfigured) return;
  const url = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return;

  const stages: Record<string, unknown>[] = [];

  for (const game of games) {
    const lb = game._meta?.liveBetting;
    if (!lb) continue;
    const oddsEventId = game._meta?.oddsApiEventId ?? null;
    const sv = lb.schemaVersion;

    pushStage(game, stages, "pregame", lb.pregame, null, oddsEventId, sv);
    for (const cp of lb.checkpoints) {
      pushStage(game, stages, "live_checkpoint", cp, cp.stageId, oddsEventId, sv);
    }
    if (lb.final) {
      pushStage(game, stages, "final", lb.final, null, oddsEventId, sv);
    }
  }

  if (!stages.length) return;

  try {
    const res = await fetch(`${url}/functions/v1/${FN}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ stages: stages.slice(0, 75) }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn("[live-betting-sync]", res.status, t);
    }
  } catch (e) {
    console.warn("[live-betting-sync]", e);
  }
}
