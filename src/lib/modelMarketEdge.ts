import type { GamePrediction, League } from "@/data/mockGames";

/**
 * ⚡ EDGE badge fires when the spread-implied win% and the moneyline-implied win%
 * disagree by more than this threshold. This is a REAL signal — it means the
 * spread market and the moneyline market have different opinions on the game,
 * which often indicates sharp action on one side, late injury news, or a line
 * that hasn't caught up to new information.
 *
 * NOTE: game.winProbability is derived from ESPN moneylines (de-vig), so
 * comparing winProbability back to moneylines is circular. Only the
 * spread-vs-moneyline divergence is a meaningful signal.
 */
export const MODEL_MARKET_DIVERGENCE_THRESHOLD_PP = 8;

/**
 * Points-to-probability conversion derived from historical ATS data per sport.
 *  NBA: ~2.3pp per point (based on historical ~55pp @ -10 spread)
 *  NFL: ~2.1pp per point (tighter market, each point more valuable)
 *  MLB: not meaningful (runline almost always 1.5, not a sliding scale)
 *  Soccer: ~1.7pp per Asian handicap equivalent
 */
const PTS_PER_PCT: Record<League, number | null> = {
  nba: 2.3,
  nfl: 2.1,
  mlb: null, // runline fixed at 1.5 — not a reliable conversion
  soccer: 1.7,
};

/** Spread-implied home win % from point spread (negative spreadNum = home favored). */
export function spreadImpliedHomeWinPct(game: GamePrediction): number | null {
  if (game.threeWay) return null;
  const sn = game.lines?.spreadNum;
  if (sn == null || !Number.isFinite(sn)) return null;
  const ptsPerPct = PTS_PER_PCT[game.league];
  if (!ptsPerPct) return null; // Skip MLB — runline isn't a sliding win% proxy
  const raw = 50 - sn * ptsPerPct;
  return Math.round(Math.min(90, Math.max(10, raw)));
}

/**
 * Gap between spread-implied home win% and moneyline-implied home win%.
 * When these diverge significantly, one market has information the other hasn't priced.
 * Returns null if spread or moneylines are missing, or for soccer 1X2 games.
 */
export function spreadVsMoneylineDivergencePp(game: GamePrediction): number | null {
  if (game.threeWay) return null;
  const spreadImplied = spreadImpliedHomeWinPct(game);
  if (spreadImplied == null) return null;
  // game.winProbability.home IS the moneyline de-vig — compare spread against it
  return Math.abs(spreadImplied - game.winProbability.home);
}

/**
 * Returns true when spread market and moneyline market disagree by >8pp.
 * This is a meaningful discrepancy — one of the two markets is likely stale
 * or reacting to information (injury, weather, sharp action) the other hasn't priced.
 */
export function showModelMarketEdgeBadge(game: GamePrediction): boolean {
  const d = spreadVsMoneylineDivergencePp(game);
  return d != null && d > MODEL_MARKET_DIVERGENCE_THRESHOLD_PP;
}

/** Exported for GameDetailView alignment indicator. */
export function maxModelMarketDivergencePp(game: GamePrediction): number | null {
  return spreadVsMoneylineDivergencePp(game);
}

/** @deprecated Use spreadVsMoneylineDivergencePp directly */
export function modelMarketHomeDivergencePp(game: GamePrediction): number | null {
  return spreadVsMoneylineDivergencePp(game);
}

/** @deprecated Use spreadVsMoneylineDivergencePp directly */
export function modelMarketSpreadDivergencePp(game: GamePrediction): number | null {
  return spreadVsMoneylineDivergencePp(game);
}
