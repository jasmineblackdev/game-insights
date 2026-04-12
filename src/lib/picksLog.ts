/**
 * Picks log — records every prop the user copies, tracks outcomes manually or
 * via ESPN box score resolution, and computes rolling accuracy stats.
 */

import { supabase } from "@/lib/supabase";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import { syncPickResolution } from "@/lib/ml/feedbackLoop";

// ── Types ────────────────────────────────────────────────────────────────────

export type PickOutcome = "win" | "loss" | "push" | null;

export interface PickLogRow {
  id: string;
  created_at: string;
  prop_id: string;
  player_name: string;
  sport: string;
  stat_type: string;
  line_value: number;
  projected_value: number;
  direction: "MORE" | "LESS";
  confidence: "HIGH" | "MED" | "LOW";
  game_id: string;
  game_time: string | null;
  team: string;
  opponent: string;
  actual_value: number | null;
  outcome: PickOutcome;
  resolved_at: string | null;
}

export interface AccuracyTier {
  wins: number;
  losses: number;
  pushes: number;
  total: number;
  winPct: number | null;
}

export interface AccuracyStats {
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
  total: number;
  winPct: number | null;
  byConfidence: Partial<Record<"HIGH" | "MED" | "LOW", AccuracyTier>>;
}

// ── Write: log a pick when the user copies it ─────────────────────────────────

export async function logPick(pred: PlayerEdgePrediction): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("picks_log").insert({
      prop_id:         pred.id,
      player_name:     pred.player_name,
      sport:           pred.sport,
      stat_type:       pred.stat_type,
      line_value:      pred.line_value,
      projected_value: pred.projected_value,
      direction:       pred.prediction_direction,
      confidence:      pred.confidence,
      game_id:         pred.game_id,
      game_time:       pred.game_time ?? null,
      team:            pred.team,
      opponent:        pred.opponent,
    });
  } catch {
    // Non-critical — silently skip
  }
}

// ── Read: fetch pick history ──────────────────────────────────────────────────

export async function fetchMyPicks(limit = 200): Promise<PickLogRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("picks_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as PickLogRow[];
}

// ── Read: rolling 30-day accuracy stats ──────────────────────────────────────

export async function fetchAccuracyStats(): Promise<AccuracyStats | null> {
  if (!supabase) return null;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("picks_log")
    .select("confidence, outcome")
    .gte("created_at", since);
  if (error || !data?.length) return null;

  let wins = 0, losses = 0, pushes = 0, pending = 0;
  const byConf: Record<string, { wins: number; losses: number; pushes: number; total: number }> = {};

  for (const row of data as { confidence: string; outcome: PickOutcome }[]) {
    const c = row.confidence as "HIGH" | "MED" | "LOW";
    if (!byConf[c]) byConf[c] = { wins: 0, losses: 0, pushes: 0, total: 0 };
    if (row.outcome === "win")       { wins++;   byConf[c].wins++;   byConf[c].total++; }
    else if (row.outcome === "loss") { losses++;  byConf[c].losses++; byConf[c].total++; }
    else if (row.outcome === "push") { pushes++;  byConf[c].pushes++; byConf[c].total++; }
    else { pending++; }
  }

  const resolved = wins + losses;
  const toTier = (c: typeof byConf[string] | undefined): AccuracyTier | undefined =>
    c ? {
      ...c,
      winPct: c.wins + c.losses > 0
        ? Math.round(c.wins / (c.wins + c.losses) * 100)
        : null,
    } : undefined;

  return {
    wins, losses, pushes, pending,
    total: wins + losses + pushes + pending,
    winPct: resolved > 0 ? Math.round((wins / resolved) * 100) : null,
    byConfidence: {
      HIGH: toTier(byConf["HIGH"]),
      MED:  toTier(byConf["MED"]),
      LOW:  toTier(byConf["LOW"]),
    },
  };
}

// ── Write: manually mark a pick's outcome ────────────────────────────────────

export async function markPickOutcome(
  id: string,
  outcome: PickOutcome,
  actualValue?: number
): Promise<void> {
  if (!supabase) return;
  await supabase.from("picks_log").update({
    outcome,
    actual_value: actualValue ?? null,
    resolved_at: outcome != null ? new Date().toISOString() : null,
  }).eq("id", id);

  // Bridge to ML feedback loop: resolve prediction_history row so analytics
  // and recalibration have data to work with.
  if (outcome && outcome !== "push") {
    const { data: row } = await supabase
      .from("picks_log")
      .select("prop_id, sport")
      .eq("id", id)
      .single();
    if (row) {
      syncPickResolution(row.prop_id, outcome, actualValue ?? null, row.sport).catch(() => {});
    }
  }
}

// ── ESPN box score auto-resolver ──────────────────────────────────────────────
// Attempts to auto-resolve pending picks from ESPN summary endpoints.
// Stat indices are sport-specific; unknown sports are skipped.

const _resolvedGames = new Set<string>();

/** NBA stats array position by stat type (ESPN default box score layout). */
const NBA_STAT_IDX: Record<string, number> = {
  points: 13, rebounds: 6, assists: 7,
};

/** MLB batter stats array position. */
const MLB_BATTER_IDX: Record<string, number> = {
  hits: 1, total_bases: 5,
};

/** MLB pitcher stats array position (K is index 4 in standard ESPN pitcher box). */
const MLB_PITCHER_IDX: Record<string, number> = {
  strikeouts: 4,
};

function getStatIndex(sport: string, statType: string): number | null {
  if (sport === "NBA") return NBA_STAT_IDX[statType] ?? null;
  if (sport === "MLB") return MLB_BATTER_IDX[statType] ?? MLB_PITCHER_IDX[statType] ?? null;
  return null;
}

function leaguePath(sport: string): string | null {
  if (sport === "NBA") return "basketball/nba";
  if (sport === "MLB") return "baseball/mlb";
  if (sport === "NFL") return "football/nfl";
  return null;
}

export async function resolveOutcomes(): Promise<number> {
  if (!supabase) return 0;

  // Only attempt picks >3h old that are still pending
  const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { data: pending } = await supabase
    .from("picks_log")
    .select("id, prop_id, sport, game_id, player_name, line_value, direction, stat_type")
    .is("outcome", null)
    .lt("created_at", cutoff)
    .limit(30);

  if (!pending?.length) return 0;

  // Group by game_id
  const byGame = new Map<string, PickLogRow[]>();
  for (const p of pending as PickLogRow[]) {
    if (_resolvedGames.has(p.game_id)) continue;
    if (!byGame.has(p.game_id)) byGame.set(p.game_id, []);
    byGame.get(p.game_id)!.push(p);
  }

  let resolved = 0;

  for (const [gameId, picks] of byGame) {
    const sport = picks[0]?.sport ?? "";
    const path = leaguePath(sport);
    if (!path) continue;

    try {
      const res = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${gameId}`
      );
      if (!res.ok) continue;

      const json = (await res.json()) as {
        boxscore?: {
          players?: {
            statistics?: {
              athletes?: { athlete?: { displayName?: string }; stats?: string[] }[];
            }[];
          }[];
        };
      };

      const athletes =
        json.boxscore?.players?.flatMap((team) =>
          team.statistics?.flatMap((stat) => stat.athletes ?? []) ?? []
        ) ?? [];

      for (const pick of picks) {
        const idx = getStatIndex(sport, pick.stat_type);
        if (idx == null) continue;

        const athlete = athletes.find(
          (a) => a.athlete?.displayName?.toLowerCase() === pick.player_name.toLowerCase()
        );
        if (!athlete?.stats?.length) continue;

        const statVal = parseFloat(athlete.stats[idx] ?? "");
        if (!isFinite(statVal)) continue;

        const outcome: PickOutcome =
          pick.direction === "MORE"
            ? statVal > pick.line_value ? "win" : statVal === pick.line_value ? "push" : "loss"
            : statVal < pick.line_value ? "win" : statVal === pick.line_value ? "push" : "loss";

        await supabase!
          .from("picks_log")
          .update({ actual_value: statVal, outcome, resolved_at: new Date().toISOString() })
          .eq("id", pick.id);

        // Bridge to ML feedback loop
        if (outcome !== "push") {
          syncPickResolution(pick.prop_id, outcome, statVal, sport).catch(() => {});
        }

        resolved++;
      }
      _resolvedGames.add(gameId);
    } catch { /* silent */ }
  }

  return resolved;
}
