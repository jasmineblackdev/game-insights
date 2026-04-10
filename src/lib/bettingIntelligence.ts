/**
 * VALUE EDGE layer: compare model probability vs sportsbook-implied probability.
 * Optimizes for betting value (EV), not raw win probability.
 */
import type { BettingIntelligenceMeta, GamePrediction } from "@/data/mockGames";
import { buildLiveBettingIntelBundle } from "@/lib/liveBettingIntelligence";
import {
  loadPregameSnapshot,
  maybeRecordFinalLiveBettingLearning,
  persistPregameSnapshot,
} from "@/lib/liveBettingPersistence";
import {
  computePickFlags,
  getFavoredSide,
  getWinProbForSide,
  type EdgeSide,
} from "@/lib/edgeCardScoring";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import { americanFromImpliedProb, americanToImpliedProb } from "@/lib/valueParlay/oddsMath";
import { computeValueScore, valueGrade } from "@/lib/valueParlay/valueScore";
import {
  americanOddsForPick,
  pickAbbrevForSide,
  primaryPickSide,
  type PickSide,
} from "@/lib/bettingPickUtils";

/** Minimum model win probability for ideal parlay legs (0–1). */
export const MIN_MODEL_PROB_FOR_IDEAL = 0.58;
/** Minimum edge to recommend (4%). */
export const MIN_EDGE_RECOMMEND = 0.04;
/** Heavy favorite exception: odds worse than -400 need at least this edge (6%). */
export const MIN_EDGE_HEAVY_FAVORITE = 0.06;
/** Sweet-spot moneyline range (American): between -110 and -220 inclusive. */
export const SWEET_SPOT_ODDS_MAX = -110;
export const SWEET_SPOT_ODDS_MIN = -220;
/** Below -350 generally avoid unless edge clears this bar. */
export const MIN_EDGE_FOR_MINUS_350 = 0.07;
/** Volatile underdog (plus money) needs stronger edge. */
export const MIN_EDGE_VOLATILE_DOG = 0.08;

export type { PickSide } from "@/lib/bettingPickUtils";
export { americanOddsForPick, primaryPickSide } from "@/lib/bettingPickUtils";

function volatilityNumeric(game: GamePrediction): number {
  const q = game._meta?.quality?.volatility?.volatility_score;
  if (typeof q === "number" && Number.isFinite(q)) return Math.min(100, Math.max(0, q));
  const lab = game._meta?.quality?.volatility?.volatility_label;
  if (lab === "high") return 72;
  if (lab === "medium") return 48;
  return 28;
}

function syntheticAmericanFromModel(p: number): number {
  const vigged = Math.min(0.94, Math.max(0.06, p * 0.97 + 0.015));
  return americanFromImpliedProb(vigged);
}

function modelProbabilityForPick(game: GamePrediction, side: PickSide): number {
  if (side === "draw" && game.threeWay) return game.threeWay.draw / 100;
  if (side === "home" || side === "away") return getWinProbForSide(game, side) / 100;
  return 0.5;
}

function betQualityFromSignals(args: {
  edge: number;
  modelP: number;
  american: number;
  inSweetSpot: boolean;
}): "A" | "B" | "C" {
  const { edge, modelP, american, inSweetSpot } = args;
  if (edge >= 0.06 && modelP >= MIN_MODEL_PROB_FOR_IDEAL && inSweetSpot) return "A";
  if (edge >= MIN_EDGE_RECOMMEND && modelP >= 0.52) return "B";
  return "C";
}

function valueRatingFrom(edge: number, quality: "A" | "B" | "C"): "low" | "medium" | "high" {
  if (quality === "A" || edge >= 0.06) return "high";
  if (quality === "B" || edge >= MIN_EDGE_RECOMMEND) return "medium";
  return "low";
}

function parlayFitScore(args: {
  edge: number;
  modelP: number;
  american: number;
  inSweetSpot: boolean;
  volatilityScore: number;
}): number {
  let s = 40;
  s += Math.min(30, args.edge * 200);
  s += Math.min(15, (args.modelP - 0.5) * 50);
  if (args.inSweetSpot) s += 18;
  else if (args.american <= SWEET_SPOT_ODDS_MIN && args.american >= -280) s += 6;
  if (args.american > 0 && args.american <= 160) s += 8;
  s -= Math.min(25, args.volatilityScore * 0.22);
  return Math.round(Math.min(100, Math.max(0, s)));
}

function parlaySafetyScore(args: { modelP: number; american: number; volatilityScore: number; flags: ReturnType<typeof computePickFlags> }): number {
  let s = 55;
  s += Math.min(25, (args.modelP - 0.5) * 45);
  if (args.american <= SWEET_SPOT_ODDS_MAX && args.american >= SWEET_SPOT_ODDS_MIN) s += 12;
  if (args.american <= -400) s -= 22;
  if (args.american >= 200) s -= 10;
  s -= Math.min(30, args.volatilityScore * 0.28);
  if (args.flags.highVolatility) s -= 12;
  if (args.flags.injuryUncertainty) s -= 14;
  return Math.round(Math.min(100, Math.max(0, s)));
}

export function computeBettingIntelligenceMeta(
  game: GamePrediction,
  side: PickSide,
  bundle: GameOddsBundle | undefined
): BettingIntelligenceMeta {
  const modelP = modelProbabilityForPick(game, side);
  let american = americanOddsForPick(game, side, bundle);
  const bookKey = bundle?.h2h?.bookKey;
  if (american == null) {
    american = syntheticAmericanFromModel(modelP);
  }

  const implied = americanToImpliedProb(american);
  const edge = modelP - implied;
  const edgeScore = Math.round(edge * 1000) / 10;

  const flags =
    side === "draw"
      ? computePickFlags(game, getFavoredSide(game))
      : computePickFlags(game, side as EdgeSide);
  const vol = volatilityNumeric(game);

  const inSweetSpot = american <= SWEET_SPOT_ODDS_MAX && american >= SWEET_SPOT_ODDS_MIN;

  const lineMv = game._meta?.quality?.market?.line_movement_home_pp;
  let lineMovementSharpTowardPick: boolean | null = null;
  if (lineMv != null && Number.isFinite(lineMv)) {
    if (side === "home") lineMovementSharpTowardPick = lineMv >= 1;
    else if (side === "away") lineMovementSharpTowardPick = lineMv <= -1;
    else lineMovementSharpTowardPick = null;
  }

  const quality = betQualityFromSignals({ edge, modelP, american, inSweetSpot });
  const vRating = valueRatingFrom(edge, quality);
  const fit = parlayFitScore({ edge, modelP, american, inSweetSpot, volatilityScore: vol });
  const safety = parlaySafetyScore({ modelP, american, volatilityScore: vol, flags });

  const filterNotes: string[] = [];

  if (edge < 0) filterNotes.push("Negative edge vs book — not a value bet.");
  if (modelP < MIN_MODEL_PROB_FOR_IDEAL) filterNotes.push(`Model below ${MIN_MODEL_PROB_FOR_IDEAL * 100}% threshold for ideal legs.`);
  if (game.confidence === "low") filterNotes.push("Model confidence is low.");
  if (flags.injuryUncertainty) filterNotes.push("Injury tags still uncertain.");
  if (flags.pitcherUnconfirmed) filterNotes.push("Starting pitcher not fully confirmed.");
  if (flags.highVolatility || vol >= 58) filterNotes.push("High volatility board.");
  if (american <= -400 && edge < MIN_EDGE_HEAVY_FAVORITE) {
    filterNotes.push(`Heavy favorite — need ≥${MIN_EDGE_HEAVY_FAVORITE * 100}% edge.`);
  }
  if (american <= -350 && edge < MIN_EDGE_FOR_MINUS_350) {
    filterNotes.push("Steep chalk — edge too thin for parlay fit.");
  }
  if (american > 0 && vol >= 55 && edge < MIN_EDGE_VOLATILE_DOG) {
    filterNotes.push("Volatile dog — need stronger edge.");
  }
  if (!inSweetSpot && american < SWEET_SPOT_ODDS_MIN && american < -220) {
    filterNotes.push("Outside sweet-spot odds range (-110 to -220).");
  }

  let recommendedForParlay = true;
  if (edge < MIN_EDGE_RECOMMEND) recommendedForParlay = false;
  if (edge < 0) recommendedForParlay = false;
  if (modelP < MIN_MODEL_PROB_FOR_IDEAL) recommendedForParlay = false;
  if (game.confidence === "low") recommendedForParlay = false;
  if (flags.injuryUncertainty) recommendedForParlay = false;
  if (flags.pitcherUnconfirmed) recommendedForParlay = false;
  if (flags.highVolatility || vol >= 58) recommendedForParlay = false;
  if (american <= -400 && edge < MIN_EDGE_HEAVY_FAVORITE) recommendedForParlay = false;
  if (american <= -350 && edge < MIN_EDGE_FOR_MINUS_350) recommendedForParlay = false;
  if (american > 0 && vol >= 55 && edge < MIN_EDGE_VOLATILE_DOG) recommendedForParlay = false;

  return {
    pickSide: side,
    pickAbbrev: pickAbbrevForSide(game, side),
    americanOdds: american,
    modelProbability: modelP,
    impliedProbability: implied,
    sportsbookProbability: implied,
    edge,
    edgeScore,
    betQualityRating: quality,
    valueRating: vRating,
    parlayFitScore: fit,
    parlaySafetyScore: safety,
    recommendedForParlay,
    sportsbookKey: bookKey,
    lineMovementSharpTowardPick,
    filterNotes: filterNotes.slice(0, 5),
  };
}

/** Per-game meta for the model’s primary pick (shown on cards / detail). */
export function bettingIntelForGame(game: GamePrediction, bundle: GameOddsBundle | undefined): BettingIntelligenceMeta {
  return computeBettingIntelligenceMeta(game, primaryPickSide(game), bundle);
}

export function enrichGamesWithBettingIntelligence(
  games: GamePrediction[],
  oddsMap: Map<string, GameOddsBundle>
): GamePrediction[] {
  return games.map((g) => {
    const bundle = oddsMap.get(g.id);
    const bettingIntel = bettingIntelForGame(g, bundle);
    persistPregameSnapshot(g, bettingIntel);
    const preSnap = loadPregameSnapshot(g.id);
    const liveBetting = buildLiveBettingIntelBundle(g, bundle, preSnap, bettingIntel);
    maybeRecordFinalLiveBettingLearning(g, liveBetting);
    return {
      ...g,
      _meta: {
        ...g._meta,
        bettingIntel,
        liveBetting,
        oddsApiEventId: bundle?.oddsApiEventId,
        bookmakerLastUpdate: bundle?.bookmakerLastUpdate,
        oddsFetchedAt: bundle?.oddsFetchedAt,
      },
    };
  });
}

/** Shared moneyline evaluation for value-parlay candidates (both sides). */
export function evaluateMoneylineForParlay(
  game: GamePrediction,
  side: EdgeSide,
  bundle: GameOddsBundle | undefined
) {
  const meta = computeBettingIntelligenceMeta(game, side, bundle);
  const flags = computePickFlags(game, side);
  const vol = volatilityNumeric(game);
  const uncBase = game.confidence === "high" ? 18 : game.confidence === "medium" ? 42 : 78;
  const unc = Math.min(
    100,
    uncBase +
      (flags.injuryUncertainty ? 14 : 0) +
      (flags.pitcherUnconfirmed ? 22 : 0) +
      (flags.highVolatility ? 10 : 0)
  );
  const lineMv = game._meta?.quality?.market?.line_movement_home_pp;
  const lineDelta = side === "home" ? lineMv : lineMv != null ? -lineMv : null;

  const valueScore = computeValueScore({
    edge: meta.edge,
    confidence: game.confidence,
    impliedProbability: meta.impliedProbability,
    modelProbability: meta.modelProbability,
    volatilityScore: vol,
    uncertaintyScore: unc,
    lineMovementDeltaPp: lineDelta,
    scheduleRestHint: game._meta?.quality?.fatigue
      ? 100 - (game._meta.quality.fatigue.fatigue_penalty ?? 30)
      : undefined,
  });

  const isRecommended = meta.recommendedForParlay;

  return {
    meta,
    flags,
    vol,
    unc,
    lineDelta,
    valueScore,
    valueGrade: valueGrade(valueScore),
    isRecommended,
    implied: meta.impliedProbability,
    modelP: meta.modelProbability,
    edge: meta.edge,
    american: meta.americanOdds,
    edgeScore: meta.edgeScore,
    parlayFitScore: meta.parlayFitScore,
    valueRating: meta.valueRating,
    betQualityRating: meta.betQualityRating,
    parlaySafetyScore: meta.parlaySafetyScore,
  };
}
