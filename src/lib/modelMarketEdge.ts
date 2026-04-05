import type { GamePrediction } from "@/data/mockGames";
import { winProbFromOdds } from "@/lib/espnShared";

/** Show ⚡ EDGE when |model home% − de-vig ML home%| exceeds this (two-way markets only). */
export const MODEL_MARKET_DIVERGENCE_THRESHOLD_PP = 7;

/**
 * Absolute gap in percentage points between model home win% and market (moneyline de-vig) home%.
 * Returns null when soccer 1X2 or moneylines are missing.
 */
export function modelMarketHomeDivergencePp(game: GamePrediction): number | null {
  if (game.threeWay) return null;
  const h = game.lines?.homeMl;
  const a = game.lines?.awayMl;
  if (!h || !a) return null;
  const m = winProbFromOdds(h, a);
  if (!m) return null;
  return Math.abs(game.winProbability.home - m.home);
}

export function showModelMarketEdgeBadge(game: GamePrediction): boolean {
  const d = modelMarketHomeDivergencePp(game);
  return d != null && d > MODEL_MARKET_DIVERGENCE_THRESHOLD_PP;
}
