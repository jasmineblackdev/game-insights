/**
 * Small, API-backed nudges to live home win % beyond raw score state.
 * Uses fields already on GamePrediction / model debug — no new network calls.
 */
import type { GamePrediction } from "@/data/mockGames";

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Extra percentage points (integer-ish) added to home win % before final clamp. */
export function sportSpecificLiveAugmentationPp(game: GamePrediction): number {
  const ls = game._meta?.liveState;
  if (!ls) return 0;

  const { periodNum, homeScore, awayScore } = ls;
  const scoreDiff = homeScore - awayScore;
  const frac =
    game.league === "mlb"
      ? clamp(periodNum / 9, 0, 1)
      : clamp(periodNum / 4, 0, 1);

  if (game.league === "nba") {
    const paceGap = game.homeTeam.pace - game.awayTeam.pace;
    const ortgEdge = game.homeTeam.offensiveRating - game.awayTeam.offensiveRating;
    const drtgEdge = game.awayTeam.defensiveRating - game.homeTeam.defensiveRating;
    const style = (paceGap / 8 + (ortgEdge + drtgEdge) / 40) * frac;
    const paceSign = Math.sign(scoreDiff) || (paceGap >= 0 ? 1 : -1);
    return clamp(Math.round(style * paceSign * 0.35), -3, 3);
  }

  if (game.league === "nfl") {
    const off = game.homeTeam.offensiveRating - game.awayTeam.offensiveRating;
    const def = game.awayTeam.defensiveRating - game.homeTeam.defensiveRating;
    const profile = (off + def) / 50;
    const sign = Math.sign(scoreDiff) || (profile >= 0 ? 1 : -1);
    return clamp(Math.round(profile * sign * frac * 2.2), -3, 3);
  }

  if (game.league === "mlb") {
    const bull = game.mlb?.modelOutput?._debug?.bullpenScore ?? 0;
    const inn = clamp(periodNum / 9, 0, 1);
    return clamp(Math.round(bull * 8 * inn), -4, 4);
  }

  return 0;
}
