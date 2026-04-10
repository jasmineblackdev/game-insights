import type { GamePrediction } from "@/data/mockGames";
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
import { computeValueScore, valueGrade } from "@/lib/valueParlay/valueScore";

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
    modelProbability: modelP,
    edge,
    edgeScore: meta.edgeScore,
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
  proj = Math.max(38, Math.min(280, proj));
  const z = (proj - line) / (game.league === "nba" ? 9 : 7);
  const pOver = sigmoid(z);
  const modelP = side === "over" ? pOver : 1 - pOver;
  const american = side === "over" ? bundle.total.over : bundle.total.under;
  const implied = americanToImpliedProb(american);
  const edge = modelP - implied;
  const vol = volatilityNumeric(game) + 6;
  const unc = confidenceToUncertaintyBase(game.confidence) + 8;

  const valueScore = computeValueScore({
    edge,
    confidence: game.confidence,
    impliedProbability: implied,
    modelProbability: modelP,
    volatilityScore: vol,
    uncertaintyScore: unc,
    lineMovementDeltaPp: game._meta?.quality?.market?.line_movement_home_pp,
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
  const implied = americanToImpliedProb(american);
  const edge = modelCover - implied;
  const picked = coverSide === "home" ? game.homeTeam : game.awayTeam;
  const vol = volatilityNumeric(game) + 10;
  const unc = confidenceToUncertaintyBase(game.confidence) + 10;
  const valueScore = computeValueScore({
    edge,
    confidence: game.confidence,
    impliedProbability: implied,
    modelProbability: modelCover,
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
  };
}

function propCandidate(game: GamePrediction, row: ReturnType<typeof buildPlayerPropProjectionsForGame>[0]): ValueBetCandidate {
  const american = propRowToAmericanOdds(row);
  const implied = americanToImpliedProb(american);
  const modelP = row.recommendedSide === "OVER" ? row.overProbability : row.underProbability;
  const edge = modelP - implied;

  const valueScore = computeValueScore({
    edge,
    confidence: row.confidence,
    impliedProbability: implied,
    modelProbability: modelP,
    volatilityScore: row.volatilityScore,
    uncertaintyScore: row.uncertaintyScore,
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
  const recommended =
    edge >= 0.04 &&
    edge > 0 &&
    row.confidence !== "low" &&
    !flags.injuryUncertainty &&
    !(game.league === "mlb" && game.mlb && game.mlb.pitcherCertainty !== "confirmed" && !eliteValue) &&
    row.volatilityScore < 62 &&
    (american > -400 || eliteValue);

  const label = `${row.playerName} ${row.recommendedSide} ${row.lineValue} ${row.statType.replace(/_/g, " ")}`;

  return {
    id: `vp-${game.id}-prop-${row.playerId}-${row.statType}`,
    sport: game.league,
    gameId: game.id,
    pickType: "player_prop",
    marketType: "player_prop",
    selectionLabel: label,
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
    volatilityScore: row.volatilityScore,
    uncertaintyScore: row.uncertaintyScore,
    correlationGroupId: `game-${game.id}-prop-${row.statType}`,
    valueScore,
    valueGrade: valueGrade(valueScore),
    riskScore: risk,
    riskBand: riskBand(risk),
    riskNote: [row.riskFactor, riskBandLabel(riskBand(risk))].join(" · "),
    isRecommended: recommended,
    matchupLabel: `${game.awayTeam.abbreviation} @ ${game.homeTeam.abbreviation}`,
  };
}

export function buildAllValueCandidates(
  games: GamePrediction[],
  oddsMap: Map<string, GameOddsBundle>
): ValueBetCandidate[] {
  const out: ValueBetCandidate[] = [];
  for (const g of games) {
    const b = oddsMap.get(g.id);
    const h = moneylineCandidate(g, "home", b);
    const a = moneylineCandidate(g, "away", b);
    if (h) out.push(h);
    if (a) out.push(a);
    const to = totalCandidate(g, b, "over");
    const tu = totalCandidate(g, b, "under");
    if (to) out.push(to);
    if (tu) out.push(tu);
    const sh = spreadCandidate(g, b, "home");
    const sa = spreadCandidate(g, b, "away");
    if (sh) out.push(sh);
    if (sa) out.push(sa);
    const props = buildPlayerPropProjectionsForGame(g);
    for (const row of props) {
      out.push(propCandidate(g, row));
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
  return candidates
    .filter((c) => c.pickType === "player_prop" && c.isRecommended)
    .slice(0, n);
}
