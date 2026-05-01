import type { GamePrediction, League } from "@/data/mockGames";
import { evaluateMoneylineForParlay } from "@/lib/bettingIntelligence";
import {
  computePickFlags,
  getFavoredSide,
  getWinProbForSide,
  type EdgeSide,
} from "@/lib/edgeCardScoring";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import { americanFromImpliedProb, americanToImpliedProb, parseAmericanOddsString } from "@/lib/valueParlay/oddsMath";
import { buildPlayerPropProjectionsForGame, propRowToAmericanOdds } from "@/lib/valueParlay/playerPropEngine";
import {
  compositeRiskScore,
  confidenceToUncertaintyBase,
  oddsExtremityRisk,
  riskBand,
  riskBandLabel,
} from "@/lib/valueParlay/riskScore";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";
import { attachSingleBetEligibility } from "@/lib/valueParlay/singleBetEligibility";
import { getConfidenceAdjustment } from "@/lib/ml/confidenceCalibrationMap";
import {
  mlbPropCategory,
  mlbPropPriorityAdjustment,
  mlbStatVolatilityFloor,
  mlbCorrelationGroup,
} from "@/lib/valueParlay/mlbPropRanking";
import {
  computeNflPropInjuryAdj,
  computeNflTeamInjuryAdj,
  computeNflTotalInjuryAdj,
  nflInjuryTimingBoost,
} from "@/lib/valueParlay/nflInjuryImpact";
import {
  computeNbaTeamInjuryAdj,
  computeMlbTeamInjuryAdj,
} from "@/lib/valueParlay/generalInjuryImpact";
import { calibrateProbability } from "@/lib/ml/plattCalibration";
import { computeValueScore, valueGrade } from "@/lib/valueParlay/valueScore";
import { computePatternBoostSync } from "@/lib/learning/userBettingPatterns";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function volatilityNumeric(game: GamePrediction): number {
  const q = game._meta?.quality?.volatility?.volatility_score;
  if (typeof q === "number" && Number.isFinite(q)) return Math.min(100, Math.max(0, q));
  const lab = game._meta?.quality?.volatility?.volatility_label;
  if (lab === "high") return 72;
  if (lab === "medium") return 48;
  return 28;
}

function injuryRiskScore(game: GamePrediction): number {
  const all = [...game.injuries.home, ...game.injuries.away];
  let s = 10;
  for (const i of all) {
    if (i.status === "OUT" && i.impactScore >= 7) s += 22;
    else if (i.status === "OUT") s += 10;
    else if (i.status === "QUESTIONABLE" || i.status === "GTD") s += 18;
  }
  return Math.min(100, s);
}

function lineupConfirmationRisk(game: GamePrediction, side: EdgeSide): number {
  if (game.league === "mlb" && game.mlb) {
    if (game.mlb.pitcherCertainty === "confirmed" && game.mlb.lineupConfirmed) return 12;
    if (game.mlb.pitcherCertainty === "confirmed") return 28;
    if (game.mlb.pitcherCertainty === "probable") return 48;
    return 72;
  }
  const inj = side === "home" ? game.injuries.home : game.injuries.away;
  const q = inj.filter((x) => x.status === "QUESTIONABLE" || x.status === "GTD").length;
  return Math.min(100, 22 + q * 18);
}

function marketDisagreement(game: GamePrediction): number {
  const m = game._meta?.quality?.market?.market_signal_strength;
  if (typeof m === "number" && Number.isFinite(m)) return Math.min(100, m);
  return showModelMarketDisagreement(game) ? 38 : 18;
}

function showModelMarketDisagreement(game: GamePrediction): boolean {
  const sharp = game._meta?.quality?.market?.sharp_move_hint;
  return Boolean(sharp);
}

function syntheticAmericanFromModel(p: number): number {
  const vigged = Math.min(0.94, Math.max(0.06, p * 0.97 + 0.015));
  return americanFromImpliedProb(vigged);
}

/**
 * Returns true when the MLB game's probable pitchers aren't confirmed yet.
 * All MLB candidates for such a game are tagged preConfirmationFlag=true,
 * with the *severity* of the downgrade graduated by certainty (see
 * applyPreConfirmationDowngrade). Used as a flag, not a hard gate.
 */
function isMlbPreConfirmation(game: GamePrediction): boolean {
  if (game.league !== "mlb") return false;
  if (!game.mlb) return true; // no mlb block at all → treat as pre-confirmation
  return game.mlb.pitcherCertainty !== "confirmed";
}

/**
 * Graduated MLB pitcher-certainty downgrade. Pre-game, "probable" is the
 * normal state — both starters are publicly announced and lineups
 * project off them. Treating probable identically to "unknown" used to
 * filter every pre-game MLB candidate out unless edge was extreme,
 * which left the system with nothing to recommend hours before first
 * pitch.
 *
 * New severity ladder:
 *   "confirmed"           → no downgrade
 *   "probable"            → cap confidence at "medium", stay recommendable
 *   "partial" / "unknown" → cap at "low", flip isRecommended=false
 *                           (existing harsh behavior — one or both SP TBD)
 */
function applyPreConfirmationDowngrade(
  candidate: ValueBetCandidate,
  game: GamePrediction,
): ValueBetCandidate {
  if (!isMlbPreConfirmation(game)) return candidate;
  const certainty = game.mlb?.pitcherCertainty;
  if (certainty === "probable") {
    return {
      ...candidate,
      preConfirmationFlag: true,
      // Don't promote a "low" pick to "medium" — only cap.
      confidence: candidate.confidence === "high" ? "medium" : candidate.confidence,
    };
  }
  // "partial" or "unknown" — one or both SP unknown, keep harsh gate.
  return {
    ...candidate,
    preConfirmationFlag: true,
    confidence: "low",
    isRecommended: false,
    exclusionReason: candidate.exclusionReason ?? "MLB pitchers not yet confirmed",
  };
}

/**
 * Hard accuracy gates applied to every emitted candidate. Two cases:
 *
 *  1. Stale bookmaker price — if `bookmakerLastUpdate` is older than
 *     STALE_LINE_MAX_AGE_MS the price we de-vigged against is no longer
 *     trustworthy. Edge inflates artificially against a moved market;
 *     do NOT recommend for parlays.
 *
 *  2. Late roster / lineup change — `late_change_flag` is set when the
 *     pre-game roster signature changed after the model scored. The
 *     pick was generated against a stale roster; invalidate hard
 *     instead of merely nudging confidence.
 *
 * Both cases preserve the candidate (so the UI can explain *why* it
 * was excluded) but force `isRecommended=false` with an explicit
 * `exclusionReason`. Parlay builders already filter on isRecommended.
 */
const STALE_LINE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

function applyIntegrityGates(
  candidate: ValueBetCandidate,
  game: GamePrediction,
  bundle: GameOddsBundle | undefined,
): ValueBetCandidate {
  let next = candidate;

  // (1) Staleness — only meaningful when we have a bookmaker timestamp.
  const lu = bundle?.bookmakerLastUpdate;
  if (lu) {
    const ageMs = Date.now() - new Date(lu).getTime();
    if (Number.isFinite(ageMs) && ageMs > STALE_LINE_MAX_AGE_MS) {
      next = {
        ...next,
        bookmakerLastUpdate: lu,
        staleLineFlag: true,
        isRecommended: false,
        exclusionReason: next.exclusionReason
          ?? `Stale price (${Math.round(ageMs / 60000)}m old)`,
      };
    } else {
      next = { ...next, bookmakerLastUpdate: lu };
    }
  }

  // (2) Late roster / lineup change — invalidates the model's input.
  if (game._meta?.quality?.predictionIntel?.late_change_flag) {
    next = {
      ...next,
      lateChangeInvalidated: true,
      isRecommended: false,
      exclusionReason: next.exclusionReason ?? "Late lineup / roster change after model scored",
    };
  }

  return next;
}

export function buildMoneylineLeg(
  game: GamePrediction,
  side: EdgeSide,
  bundle?: GameOddsBundle | undefined,
): ValueBetCandidate | null {
  return moneylineCandidate(game, side, bundle);
}

function moneylineCandidate(
  game: GamePrediction,
  side: EdgeSide,
  bundle: GameOddsBundle | undefined
): ValueBetCandidate | null {
  const ev = evaluateMoneylineForParlay(game, side, bundle);
  const { meta, flags, vol, unc, lineDelta, valueScore, valueGrade, isRecommended, implied, modelP, edge, american } =
    ev;
  const picked = side === "home" ? game.homeTeam : game.awayTeam;

  const corrId = `game-${game.id}-ml`;
  const risk = compositeRiskScore({
    volatilityScore: vol,
    uncertaintyScore: unc,
    correlationScore: 18,
    injuryRiskScore: injuryRiskScore(game),
    lineupConfirmationRisk: lineupConfirmationRisk(game, side),
    oddsExtremityRisk: oddsExtremityRisk({ americanOdds: american, modelProbability: modelP, edge }),
    marketDisagreementRisk: marketDisagreement(game),
  });

  const ownInj = side === "home" ? game.injuries.home : game.injuries.away;
  const oppInj = side === "home" ? game.injuries.away : game.injuries.home;
  const injuryImpactAdj =
    game.league === "nfl" ? computeNflTeamInjuryAdj(ownInj, oppInj)
    : game.league === "nba" ? computeNbaTeamInjuryAdj(ownInj, oppInj)
    : game.league === "mlb" ? computeMlbTeamInjuryAdj(ownInj, oppInj)
    : undefined;

  // Feature-vector integration: the injury delta now also nudges
  // modelProbability (clamped) so hitProbability reflects roster state,
  // not just the ranking layer. Range matches the per-sport clamp.
  const injuryAdjustedP = injuryImpactAdj != null
    ? Math.min(0.95, Math.max(0.05, modelP + injuryImpactAdj))
    : modelP;
  // Apply nightly-fitted Platt calibration (no-op when params missing or
  // sample size too small). Produces p_calibrated that matches observed
  // hit rates tighter than the raw blended model's output.
  const adjustedModelP = calibrateProbability(
    injuryAdjustedP, game.league, "moneyline", game.confidence,
  );
  const adjustedEdge = adjustedModelP - implied;

  const id = `vp-${game.id}-ml-${side}`;
  return {
    id,
    sport: game.league,
    gameId: game.id,
    pickType: "team_pick",
    marketType: "moneyline",
    selectionLabel: `${picked.abbreviation} ML`,
    teamId: picked.abbreviation,
    americanOdds: american,
    impliedProbability: implied,
    modelProbability: adjustedModelP,
    rawModelProbability: adjustedModelP !== modelP ? modelP : undefined,
    edge: adjustedEdge,
    edgeScore: Math.round(adjustedEdge * 1000) / 10,
    betQualityRating: meta.betQualityRating,
    valueRating: meta.valueRating,
    parlayFitScore: meta.parlayFitScore,
    parlaySafetyScore: meta.parlaySafetyScore,
    confidence: game.confidence,
    volatilityScore: vol,
    uncertaintyScore: unc,
    correlationGroupId: corrId,
    valueScore,
    valueGrade,
    riskScore: risk,
    riskBand: riskBand(risk),
    riskNote: buildRiskNote(game, flags, risk),
    isRecommended,
    sportsbookKey: meta.sportsbookKey,
    matchupLabel: `${game.awayTeam.abbreviation} @ ${game.homeTeam.abbreviation}`,
    lineMovementDeltaPp: lineDelta,
    gameTimeLabel: game.gameTime,
    injuryImpactAdj,
  };
}

function buildRiskNote(
  game: GamePrediction,
  flags: ReturnType<typeof computePickFlags>,
  risk: number
): string {
  const parts: string[] = [];
  if (flags.pitcherUnconfirmed) parts.push("Pitcher confirmation pending");
  if (flags.injuryUncertainty) parts.push("Injury tags still fluid");
  if (flags.highVolatility) parts.push("Elevated game volatility");
  parts.push(riskBandLabel(riskBand(risk)));
  return parts.slice(0, 3).join(" · ");
}

function totalCandidate(
  game: GamePrediction,
  bundle: GameOddsBundle | undefined,
  side: "over" | "under"
): ValueBetCandidate | null {
  const line = game.lines?.total ?? bundle?.total?.point;
  if (line == null || bundle?.total == null) return null;

  const o1 = game.homeTeam.offensiveRating;
  const o2 = game.awayTeam.offensiveRating;
  let proj = (o1 + o2) * (game.league === "nba" ? 1.02 : game.league === "nfl" ? 0.92 : 0.88);

  // NBA pace-pair adjustment: ORtg encodes points-per-100-possessions,
  // so a pair of fast teams with mid-tier ORtg still cooks a high
  // total via possession volume. League-average pace ≈ 99 POSS/48.
  // Each pace-pair-point above average adds ~0.4 expected combined
  // points; capped to ±6pts (avoids dominating the projection when
  // pace data is stale or missing).
  if (game.league === "nba" || game.league === "wnba") {
    const homePace = game.homeTeam.pace ?? 99;
    const awayPace = game.awayTeam.pace ?? 99;
    if (homePace > 0 && awayPace > 0) {
      const pairAvg = (homePace + awayPace) / 2;
      const leagueAvg = 99;
      const paceShift = Math.max(-6, Math.min(6, (pairAvg - leagueAvg) * 0.4));
      proj += paceShift;
    }
  }

  proj = Math.max(38, Math.min(280, proj));
  const z = (proj - line) / (game.league === "nba" ? 9 : 7);
  const pOver = sigmoid(z);
  const modelP = side === "over" ? pOver : 1 - pOver;
  const american = side === "over" ? bundle.total.over : bundle.total.under;
  const implied = americanToImpliedProb(american);
  const edge = modelP - implied;
  const vol = volatilityNumeric(game) + 6;
  const unc = confidenceToUncertaintyBase(game.confidence) + 8;

  const oppAmerican = side === "over" ? bundle.total.under : bundle.total.over;
  const oppImplied = americanToImpliedProb(oppAmerican);
  const valueScore = computeValueScore({
    edge,
    confidence: game.confidence,
    impliedProbability: implied,
    modelProbability: modelP,
    oppositeImpliedProbability: oppImplied,
    sport: game.league,
    marketKind: "total",
    volatilityScore: vol,
    uncertaintyScore: unc,
    lineMovementDeltaPp: game._meta?.quality?.market?.line_movement_home_pp,
    userPatternBoost: computePatternBoostSync({
      sport: game.league,
      marketType: "total",
      americanOdds: american,
    }),
  });

  const risk = compositeRiskScore({
    volatilityScore: vol,
    uncertaintyScore: unc,
    correlationScore: 24,
    injuryRiskScore: injuryRiskScore(game),
    lineupConfirmationRisk: lineupConfirmationRisk(game, getFavoredSide(game)),
    oddsExtremityRisk: oddsExtremityRisk({ americanOdds: american, modelProbability: modelP, edge }),
    marketDisagreementRisk: marketDisagreement(game),
  });

  const flags = computePickFlags(game, getFavoredSide(game));
  const eliteValue = valueScore >= 0.82 || edge >= 0.08;
  const recommended =
    edge >= 0.04 &&
    edge > 0 &&
    game.confidence !== "low" &&
    !flags.injuryUncertainty &&
    vol < 62 &&
    (american > -400 || eliteValue);

  const injuryImpactAdj = game.league === "nfl"
    ? computeNflTotalInjuryAdj(game.injuries.home, game.injuries.away, side)
    : undefined;

  const id = `vp-${game.id}-tot-${side}`;
  return {
    id,
    sport: game.league,
    gameId: game.id,
    pickType: "total",
    marketType: "total",
    selectionLabel: `${side === "over" ? "Over" : "Under"} ${line}`,
    lineValue: line,
    americanOdds: american,
    impliedProbability: implied,
    modelProbability: modelP,
    edge,
    edgeScore: Math.round(edge * 1000) / 10,
    confidence: game.confidence,
    volatilityScore: vol,
    uncertaintyScore: unc,
    correlationGroupId: `game-${game.id}-total`,
    valueScore,
    valueGrade: valueGrade(valueScore),
    riskScore: risk,
    riskBand: riskBand(risk),
    riskNote: buildRiskNote(game, flags, risk),
    isRecommended: recommended,
    matchupLabel: `${game.awayTeam.abbreviation} @ ${game.homeTeam.abbreviation}`,
    gameTimeLabel: game.gameTime,
    injuryImpactAdj,
  };
}

function spreadCandidate(
  game: GamePrediction,
  bundle: GameOddsBundle | undefined,
  side: EdgeSide
): ValueBetCandidate | null {
  const sn = game.lines?.spreadNum;
  if (sn == null || bundle?.spread == null) return null;

  const ph = getWinProbForSide(game, "home") / 100;
  const pa = getWinProbForSide(game, "away") / 100;
  const fav = ph >= pa ? "home" : "away";
  const margin = Math.abs(ph - pa);
  const favCoversBoost = sn < 0 ? (fav === "home" ? 0.12 : -0.08) : fav === "away" ? 0.12 : -0.08;
  const coverSide = side;
  const modelCover =
    coverSide === "home"
      ? sigmoid((ph - pa) * 6 + favCoversBoost - Math.abs(sn) * 0.02)
      : 1 -
        sigmoid((ph - pa) * 6 + favCoversBoost - Math.abs(sn) * 0.02);

  const american = coverSide === "home" ? bundle.spread.home : bundle.spread.away;
  const oppAmerican = coverSide === "home" ? bundle.spread.away : bundle.spread.home;
  const implied = americanToImpliedProb(american);
  const oppImplied = americanToImpliedProb(oppAmerican);
  const edge = modelCover - implied;
  const picked = coverSide === "home" ? game.homeTeam : game.awayTeam;
  const vol = volatilityNumeric(game) + 10;
  const unc = confidenceToUncertaintyBase(game.confidence) + 10;
  const valueScore = computeValueScore({
    edge,
    confidence: game.confidence,
    impliedProbability: implied,
    modelProbability: modelCover,
    oppositeImpliedProbability: oppImplied,
    sport: game.league,
    marketKind: "spread",
    userPatternBoost: computePatternBoostSync({
      sport: game.league,
      marketType: "spread",
      americanOdds: american,
      isHome: coverSide === "home",
    }),
    volatilityScore: vol,
    uncertaintyScore: unc,
  });
  const flags = computePickFlags(game, coverSide);
  const risk = compositeRiskScore({
    volatilityScore: vol,
    uncertaintyScore: unc,
    correlationScore: 28,
    injuryRiskScore: injuryRiskScore(game),
    lineupConfirmationRisk: lineupConfirmationRisk(game, coverSide),
    oddsExtremityRisk: oddsExtremityRisk({ americanOdds: american, modelProbability: modelCover, edge }),
    marketDisagreementRisk: marketDisagreement(game),
  });
  const eliteValue = valueScore >= 0.82 || edge >= 0.08;
  const recommended =
    edge >= 0.04 &&
    edge > 0 &&
    game.confidence !== "low" &&
    !flags.injuryUncertainty &&
    vol < 65 &&
    (american > -400 || eliteValue);

  const ownInjSpr = coverSide === "home" ? game.injuries.home : game.injuries.away;
  const oppInjSpr = coverSide === "home" ? game.injuries.away : game.injuries.home;
  const injuryImpactAdj = game.league === "nfl"
    ? computeNflTeamInjuryAdj(ownInjSpr, oppInjSpr)
    : undefined;

  return {
    id: `vp-${game.id}-spr-${coverSide}`,
    sport: game.league,
    gameId: game.id,
    pickType: "spread",
    marketType: "spread",
    selectionLabel: `${picked.abbreviation} ${sn > 0 ? "+" : ""}${sn}`,
    teamId: picked.abbreviation,
    lineValue: sn,
    americanOdds: american,
    impliedProbability: implied,
    modelProbability: modelCover,
    edge,
    edgeScore: Math.round(edge * 1000) / 10,
    confidence: game.confidence,
    volatilityScore: vol,
    uncertaintyScore: unc,
    correlationGroupId: `game-${game.id}-spread`,
    valueScore,
    valueGrade: valueGrade(valueScore),
    riskScore: risk,
    riskBand: riskBand(risk),
    riskNote: buildRiskNote(game, flags, risk),
    isRecommended: recommended,
    matchupLabel: `${game.awayTeam.abbreviation} @ ${game.homeTeam.abbreviation}`,
    gameTimeLabel: game.gameTime,
    injuryImpactAdj,
  };
}

function propCandidate(game: GamePrediction, row: ReturnType<typeof buildPlayerPropProjectionsForGame>[0]): ValueBetCandidate {
  const american = propRowToAmericanOdds(row);
  const implied = americanToImpliedProb(american);
  const modelP = row.recommendedSide === "OVER" ? row.overProbability : row.underProbability;
  const edge = modelP - implied;

  const blowout = game._meta?.quality?.predictionIntel?.blowout_risk_score ?? 0;
  const volB = blowout >= 58 ? row.volatilityScore + 14 : row.volatilityScore;
  const uncB = blowout >= 58 ? row.uncertaintyScore + 16 : row.uncertaintyScore;

  const valueScore = computeValueScore({
    edge,
    confidence: row.confidence,
    impliedProbability: implied,
    modelProbability: modelP,
    sport: game.league,
    marketKind: "player_prop",
    volatilityScore: Math.min(100, volB),
    uncertaintyScore: Math.min(100, uncB),
    userPatternBoost: computePatternBoostSync({
      sport: game.league,
      marketType: "player_prop",
      americanOdds: american,
    }),
  });

  const risk = compositeRiskScore({
    volatilityScore: row.volatilityScore,
    uncertaintyScore: row.uncertaintyScore,
    correlationScore: 22,
    injuryRiskScore: injuryRiskScore(game),
    lineupConfirmationRisk: lineupConfirmationRisk(game, getFavoredSide(game)),
    oddsExtremityRisk: oddsExtremityRisk({ americanOdds: american, modelProbability: modelP, edge }),
    marketDisagreementRisk: marketDisagreement(game),
  });

  const flags = computePickFlags(game, getFavoredSide(game));
  const eliteValue = valueScore >= 0.82 || edge >= 0.08;
  // MLB pitcher-certainty gate: "probable" (both starters announced) is
  // safe to recommend at normal edge thresholds; "partial"/"unknown"
  // still requires elite value to justify recommending without the
  // matchup confirmed.
  const mlbCertainty = game.league === "mlb" ? game.mlb?.pitcherCertainty : undefined;
  const mlbBlocksRecommend = mlbCertainty != null
    && mlbCertainty !== "confirmed"
    && mlbCertainty !== "probable"
    && !eliteValue;
  const recommended =
    edge >= 0.04 &&
    edge > 0 &&
    row.confidence !== "low" &&
    !flags.injuryUncertainty &&
    !mlbBlocksRecommend &&
    volB < 66 &&
    blowout < 72 &&
    (american > -400 || eliteValue);

  const label = `${row.playerName} ${row.recommendedSide} ${row.lineValue} ${row.statType.replace(/_/g, " ")}`;

  const isHomePlayer = row.teamAbbr === game.homeTeam.abbreviation;
  const ownInjProp = isHomePlayer ? game.injuries.home : game.injuries.away;
  const oppInjProp = isHomePlayer ? game.injuries.away : game.injuries.home;
  const injuryImpactAdj = game.league === "nfl"
    ? computeNflPropInjuryAdj(row.statType, ownInjProp, oppInjProp)
    : undefined;

  return {
    id: `vp-${game.id}-prop-${row.playerId}-${row.statType}`,
    sport: game.league,
    gameId: game.id,
    pickType: "player_prop",
    marketType: "player_prop",
    selectionLabel: label,
    teamId: row.teamAbbr,
    playerId: row.playerId,
    playerName: row.playerName,
    statType: row.statType,
    lineValue: row.lineValue,
    americanOdds: american,
    impliedProbability: implied,
    modelProbability: modelP,
    edge,
    edgeScore: Math.round(edge * 1000) / 10,
    confidence: row.confidence,
    volatilityScore: Math.min(100, volB),
    uncertaintyScore: Math.min(100, uncB),
    correlationGroupId: `game-${game.id}-prop-${row.statType}`,
    valueScore,
    valueGrade: valueGrade(valueScore),
    riskScore: risk,
    riskBand: riskBand(risk),
    riskNote: [row.riskFactor, riskBandLabel(riskBand(risk))].join(" · "),
    isRecommended: recommended,
    matchupLabel: `${game.awayTeam.abbreviation} @ ${game.homeTeam.abbreviation}`,
    gameTimeLabel: game.gameTime,
    injuryImpactAdj,
  };
}

export function buildAllValueCandidates(
  games: GamePrediction[],
  oddsMap: Map<string, GameOddsBundle>
): ValueBetCandidate[] {
  const out: ValueBetCandidate[] = [];
  const gate = (c: ValueBetCandidate, g: GamePrediction, b: GameOddsBundle | undefined) =>
    attachSingleBetEligibility(applyIntegrityGates(applyPreConfirmationDowngrade(c, g), g, b));
  for (const g of games) {
    const b = oddsMap.get(g.id);
    const h = moneylineCandidate(g, "home", b);
    const a = moneylineCandidate(g, "away", b);
    if (h) out.push(gate(h, g, b));
    if (a) out.push(gate(a, g, b));
    const to = totalCandidate(g, b, "over");
    const tu = totalCandidate(g, b, "under");
    if (to) out.push(gate(to, g, b));
    if (tu) out.push(gate(tu, g, b));
    const sh = spreadCandidate(g, b, "home");
    const sa = spreadCandidate(g, b, "away");
    if (sh) out.push(gate(sh, g, b));
    if (sa) out.push(gate(sa, g, b));
    const props = buildPlayerPropProjectionsForGame(g);
    for (const row of props) {
      out.push(gate(propCandidate(g, row), g, b));
    }
  }
  return out.sort((x, y) => y.valueScore - x.valueScore);
}

export function lineMovementAlerts(candidates: ValueBetCandidate[], limit = 5): ValueBetCandidate[] {
  return candidates
    .filter((c) => c.lineMovementDeltaPp != null && Math.abs(c.lineMovementDeltaPp) >= 1.5)
    .slice(0, limit);
}

export function topRecommended(candidates: ValueBetCandidate[], n = 5): ValueBetCandidate[] {
  return candidates.filter((c) => c.isRecommended).slice(0, n);
}

export function safestConfirmed(candidates: ValueBetCandidate[], n = 5): ValueBetCandidate[] {
  return [...candidates]
    .filter((c) => c.isRecommended && c.riskBand === "low")
    .sort((a, b) => a.riskScore - b.riskScore)
    .slice(0, n);
}

export function bestPropValues(candidates: ValueBetCandidate[], n = 5): ValueBetCandidate[] {
  const displayScore = (c: ValueBetCandidate): number => {
    if ((c.sport ?? "").toLowerCase() !== "mlb") return c.valueScore;
    const cat = mlbPropCategory(c.statType, c.pickType, c.matchupLabel ?? "");
    return c.valueScore + mlbPropPriorityAdjustment(cat, c.edge);
  };
  return candidates
    .filter((c) => c.pickType === "player_prop" && c.isRecommended)
    .sort((a, b) => displayScore(b) - displayScore(a))
    .slice(0, n);
}

// ── ML-enriched prop candidates ───────────────────────────────────────────────

const SPORT_TO_LEAGUE: Record<string, League> = {
  NBA: "nba", WNBA: "wnba", NFL: "nfl", MLB: "mlb", Boxing: "boxing", MMA: "mma",
};

/** Map ML timing_urgency → continuous timingScore (0–1). */
function urgencyToTimingScore(urgency: string | undefined): number {
  if (urgency === "now")     return 0.85;
  if (urgency === "monitor") return 0.55;
  if (urgency === "wait")    return 0.15;
  return 0.55; // neutral default
}

/**
 * Explain why a candidate is not recommended (debug / UI).
 * Returns undefined when candidate IS recommended.
 */
function buildExclusionReason(
  edge: number,
  conf: import("@/data/mockGames").ConfidenceLevel,
  volatilityScore: number,
  timingUrgency?: "now" | "wait" | "monitor",
): string | undefined {
  if (conf === "low") return "Confidence: LOW — insufficient signal";
  if (timingUrgency === "wait") return "Timing: model signals to wait";
  if (edge < 0.04) return `Edge too small (${(edge * 100).toFixed(1)}% < 4.0% threshold)`;
  if (volatilityScore >= 66) return `Volatility too high (${volatilityScore.toFixed(0)} ≥ 66)`;
  return undefined;
}

/**
 * Convert ML-enriched PlayerEdgePrediction[] → ValueBetCandidate[].
 *
 * Timing and volatility are now first-class, separate dimensions:
 *   volatilityScore = pure variance signal (consistency + volatility_flag only)
 *   timingScore     = 0–1 timing quality  (now=0.85, monitor=0.55, wait=0.15)
 *   timingUrgency   = raw urgency enum for mode-aware parlay filtering
 *
 * The parlay optimizer applies timing bonus/penalty explicitly in scoreParlay()
 * and uses mode-aware thresholds in legPassesParlayBuildFilters():
 *   safe       → strictly exclude "wait" legs
 *   balanced   → allow "wait" only when edge ≥ 0.08
 *   aggressive → allow all timing states
 */
export function buildEnrichedPropCandidates(
  enrichedProps: PlayerEdgePrediction[],
): ValueBetCandidate[] {
  const out: ValueBetCandidate[] = [];

  for (const pred of enrichedProps) {
    const sport = SPORT_TO_LEAGUE[pred.sport];
    if (!sport) continue;

    // Map confidence tier
    const conf: import("@/data/mockGames").ConfidenceLevel =
      pred.confidence === "HIGH" ? "high"
      : pred.confidence === "MED"  ? "medium"
      : "low";

    // Market probability proxy: best-guess of what the book implies
    const marketProb =
      pred.confidence === "HIGH" ? 0.595
      : pred.confidence === "MED" ? 0.538
      : 0.512;

    // Model probability: prefer ML hit probability, else derive from edge
    const maxEdge = pred.sport === "NFL" ? 30 : pred.sport === "MLB" ? 2 : 8;
    const edgeDerived = 0.50 + Math.min(Math.abs(pred.edge) / maxEdge * 0.40, 0.40);
    const rawModelP = Math.max(0.05, Math.min(0.95,
      pred.ml_hit_probability ?? edgeDerived
    ));
    // Apply nightly-fitted Platt calibration — no-op when params missing.
    const modelP = calibrateProbability(
      rawModelP, pred.sport, "player_prop", pred.confidence,
    );

    const edge = modelP - marketProb;

    // Synthesize American odds from market probability (adds standard vig)
    const vigged = Math.min(0.93, Math.max(0.07, marketProb * 1.047));
    const americanOdds = americanFromImpliedProb(vigged);

    // ── volatilityScore = PURE variance signal (timing removed) ───────────
    const consistencyBase =
      pred.consistency_label === "volatile" ? 62
      : pred.consistency_label === "medium"  ? 40
      : 24;
    const volatilityAdj = pred.volatility_flag ? +15 : 0;
    let volatilityScore = Math.max(0, Math.min(100, consistencyBase + volatilityAdj));

    // MLB player intelligence: apply stat-type-specific volatility floors.
    // Predictable stats (strikeouts, total_bases) are capped low; volatile
    // stats (HR, SB) are floored high regardless of consistency_label.
    if (pred.sport === "MLB") {
      const floor = mlbStatVolatilityFloor(pred.stat_type);
      if (floor !== null) {
        if (floor >= 55) {
          // High-volatility stat — enforce minimum floor (at least this noisy)
          volatilityScore = Math.max(volatilityScore, floor);
        } else {
          // Predictable stat — cap at floor + 10 to prevent over-penalising good props
          volatilityScore = Math.min(volatilityScore, floor + 10);
        }
      }
    }

    // ── timingScore = first-class timing dimension (0–1) ──────────────────
    const timingUrgency = pred.timing_urgency as "now" | "wait" | "monitor" | undefined;
    let timingScore = urgencyToTimingScore(timingUrgency);

    // NFL: when injury flag is set and stat type is role-sensitive (rushing /
    // receiving), apply a small timing boost to capture late injury → opportunity
    // windows. Positional context is unavailable for enriched props, so
    // injuryImpactAdj remains 0 — only timing is adjusted here.
    if (pred.sport === "NFL" && pred.has_injury_flag) {
      timingScore = Math.min(1, timingScore + nflInjuryTimingBoost(pred.stat_type));
    }

    // ── Uncertainty from confidence + injury ──────────────────────────────
    const uncertaintyScore = Math.min(100,
      confidenceToUncertaintyBase(conf) + (pred.has_injury_flag ? 15 : 0)
    );

    const vsCore = computeValueScore({
      edge,
      confidence: conf,
      impliedProbability: marketProb,
      modelProbability: modelP,
      sport: pred.sport,
      marketKind: "player_prop",
      volatilityScore,
      uncertaintyScore,
      lineMovementDeltaPp: pred.line_delta ?? null,
      userPatternBoost: computePatternBoostSync({
        sport: pred.sport,
        marketType: "player_prop",
        americanOdds: americanOdds,
      }),
    });

    const risk = compositeRiskScore({
      volatilityScore,
      uncertaintyScore,
      correlationScore: 20,
      injuryRiskScore:          pred.has_injury_flag ? 35 : 10,
      lineupConfirmationRisk:   18,
      oddsExtremityRisk:        oddsExtremityRisk({ americanOdds, modelProbability: modelP, edge }),
      marketDisagreementRisk:   18,
    });

    // "wait" props are never recommended (mode-aware gating happens in optimizer)
    const isRecommended =
      edge >= 0.04 &&
      edge > 0 &&
      conf !== "low" &&
      timingUrgency !== "wait" &&
      volatilityScore < 66;

    const exclusionReason = isRecommended
      ? undefined
      : buildExclusionReason(edge, conf, volatilityScore, timingUrgency);

    // Build a human-readable risk note (timing info surfaced here too)
    const timingNote = pred.best_time_to_bet
      ? pred.best_time_to_bet
      : timingUrgency === "now" ? "Bet now" : timingUrgency === "wait" ? "Wait — timing unfavorable" : "";
    const volatileNote = pred.volatility_flag ? "ML: volatile" : "";
    const riskNotes = [
      pred.risk_factor,
      timingNote,
      volatileNote,
      riskBandLabel(riskBand(risk)),
    ].filter(Boolean).slice(0, 3).join(" · ");

    const label = `${pred.player_name} ${pred.prediction_direction === "MORE" ? "Over" : "Under"} ${pred.line_value} ${pred.stat_type.replace(/_/g, " ")}`;

    out.push({
      id:                  `ml-prop-${pred.id}`,
      sport,
      gameId:              pred.game_id,
      pickType:            "player_prop",
      marketType:          "player_prop",
      selectionLabel:      label,
      playerId:            pred.player_id,
      playerName:          pred.player_name,
      statType:            pred.stat_type,
      lineValue:           pred.line_value,
      americanOdds,
      impliedProbability:  marketProb,
      modelProbability:    modelP,
      edge,
      edgeScore:           Math.round(edge * 1000) / 10,
      confidence:          conf,
      volatilityScore,
      uncertaintyScore,
      timingUrgency,
      timingScore,
      stabilityScore:      pred.ml_debug?.stability_score ?? 0.5,
      modelVariant:                 pred.ml_active ? "ml_blended" : "rules",
      confidenceCalibrationAdjustment: getConfidenceAdjustment(pred.sport, pred.stat_type),
      // MLB: separate pitcher vs hitter correlation groups so pitcher K +
      // hitter TB from the same game don't incur the same-group penalty.
      correlationGroupId:  pred.sport === "MLB"
        ? mlbCorrelationGroup(
            pred.game_id,
            pred.stat_type,
            mlbPropCategory(pred.stat_type, "player_prop"),
          )
        : `ml-prop-${pred.game_id}-${pred.stat_type}`,
      valueScore:          vsCore,
      valueGrade:          valueGrade(vsCore),
      riskScore:           risk,
      riskBand:            riskBand(risk),
      riskNote:            riskNotes,
      isRecommended,
      exclusionReason,
      matchupLabel:        `${pred.team} vs ${pred.opponent}`,
      // Pipe the opponent-context matchup note through so MatchupInsight
      // can surface it. NBA/WNBA = position-allowed defense, MLB = SP
      // weakness by stat, NFL = defense allowed by position. The
      // upstream classifier already crafted the line; we just preserve
      // the trip from PlayerEdgePrediction → ValueBetCandidate.
      matchupNote:         pred.matchup_note ?? undefined,
      lineMovementDeltaPp: pred.line_delta ?? null,
      gameTimeLabel:       pred.game_time,
    });
  }

  for (const c of out) attachSingleBetEligibility(c);
  return out;
}
