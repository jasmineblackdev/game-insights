import type { GamePrediction, League } from "@/data/mockGames";
import { winProbFromOdds } from "@/lib/espnShared";

/** Show ⚡ EDGE when model home% disagrees with market (ML and/or spread heuristic) by more than this. */
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

/** Rough implied home win % from point spread (negative spreadNum = home favored). Heuristic only. */
export function spreadImpliedHomeWinPct(game: GamePrediction): number | null {
  if (game.threeWay) return null;
  const sn = game.lines?.spreadNum;
  if (sn == null || !Number.isFinite(sn)) return null;
  const league: League = game.league;
  const ptsPerPct = league === "mlb" ? 1.12 : league === "nfl" ? 2.05 : league === "soccer" ? 1.65 : 2.28;
  const raw = 50 - sn * ptsPerPct;
  return Math.round(Math.min(90, Math.max(10, raw)));
}

export function modelMarketSpreadDivergencePp(game: GamePrediction): number | null {
  const implied = spreadImpliedHomeWinPct(game);
  if (implied == null) return null;
  return Math.abs(game.winProbability.home - implied);
}

/** Largest disagreement vs either de-vig ML or spread heuristic (when available). */
export function maxModelMarketDivergencePp(game: GamePrediction): number | null {
  const ml = modelMarketHomeDivergencePp(game);
  const sp = modelMarketSpreadDivergencePp(game);
  if (ml == null && sp == null) return null;
  if (ml == null) return sp;
  if (sp == null) return ml;
  return Math.max(ml, sp);
}

export function showModelMarketEdgeBadge(game: GamePrediction): boolean {
  const d = maxModelMarketDivergencePp(game);
  return d != null && d > MODEL_MARKET_DIVERGENCE_THRESHOLD_PP;
}
