/**
 * Recent-form multiplier — blends a player's last-N-game per-game
 * average with their season-per-game baseline so projections track
 * current form, not just the long-run mean.
 *
 * Why blended (and not raw last-N): a 5-game window is ~10% of an MLB
 * season; one big game can pull the mean far enough to over- or
 * under-project the next outing. Bayesian-style shrinkage toward the
 * season baseline keeps the signal real without amplifying the noise.
 *
 * Blend formula:
 *   weight   = min(sample_size, 5) / 7.5      // 5g → 0.667, 3g → 0.4, 2g → 0.267
 *   ratio    = recent_avg / season_per_game
 *   blended  = weight * ratio + (1 - weight) * 1.0
 *   clamped  = clamp(blended, 0.6, 1.4)        // cap extreme prints
 *
 * Returns a multiplier you can apply to any per-game projection on
 * the same stat — the ratio cancels out the scale.
 */

import { fetchPlayerLastGames, type GameLogSport } from "@/lib/playerGameLog";

export interface RecentFormResult {
  /** Multiplier vs the season baseline, clamped to [0.6, 1.4]. 1.0 = neutral. */
  multiplier: number;
  /** Number of games used in the recent window. 0 → no signal. */
  sampleSize: number;
  /** Per-game average across the recent window. */
  recentAvg: number;
  /** Short reason note (empty string when sample is too small to surface). */
  note: string;
}

const NEUTRAL: RecentFormResult = {
  multiplier: 1.0,
  sampleSize: 0,
  recentAvg: 0,
  note: "",
};

/**
 * Map an espnPlayerStats stat_type ("rbis", "rebounds", etc.) to the
 * stat key playerGameLog.ts understands. Keep the espn-side names as
 * canonical and translate here.
 */
const STAT_TYPE_GAMELOG_KEY: Record<string, string> = {
  rbis: "rbi",
  // The rest pass through unchanged. Items missing from playerGameLog
  // (e.g. "steals", "blocks", "doubles", "walks") fall through and
  // fetchPlayerLastGames returns [] — neutral multiplier.
};

export async function getAthleteRecentForm(args: {
  sport: string;
  athleteId: string | undefined;
  statType: string;
  /**
   * Season per-game baseline. Must be on the same scale as the
   * recent-game values (e.g. 1.2 H/game, not 30 H total). For MLB
   * binary/continuous-season stats, divide season total by
   * estimated games played before passing in.
   */
  seasonPerGame: number;
  limit?: number;
}): Promise<RecentFormResult> {
  if (!args.athleteId) return NEUTRAL;
  if (!Number.isFinite(args.seasonPerGame) || args.seasonPerGame <= 0) return NEUTRAL;

  const sportUpper = args.sport.toUpperCase() as GameLogSport;
  const gamelogKey = STAT_TYPE_GAMELOG_KEY[args.statType] ?? args.statType;
  const limit = args.limit ?? 5;

  const rows = await fetchPlayerLastGames(sportUpper, args.athleteId, gamelogKey, limit);
  if (rows.length < 2) return NEUTRAL;

  const recentAvg = rows.reduce((s, r) => s + r.value, 0) / rows.length;
  const ratio = recentAvg / args.seasonPerGame;
  const weight = Math.min(rows.length, 5) / 7.5;
  const blended = weight * ratio + (1 - weight) * 1.0;
  const multiplier = Math.max(0.6, Math.min(1.4, blended));

  // Surface a note only when the sample is meaningful (≥3 games)
  // and the move is large enough to matter (≥10% off baseline).
  const moveAbs = Math.abs(multiplier - 1);
  const note = rows.length >= 3 && moveAbs >= 0.1
    ? `Last ${rows.length}g ${recentAvg.toFixed(1)} vs ${args.seasonPerGame.toFixed(1)} season — ${multiplier > 1 ? "form trending up" : "form trending down"}.`
    : "";

  return { multiplier, sampleSize: rows.length, recentAvg, note };
}
