/**
 * Sport-scoped learning-driven adjustments for the prediction quality pipeline.
 * Uses rolling client state (per league, never mixed) with gradual bounded updates.
 * No UI; consumed only by predictionQualityPipeline.
 */
import type { GamePrediction, League } from "@/data/mockGames";
import { parseRecord } from "@/lib/espnShared";
import { getSportEngineLearningState, type SportEngineLearningState } from "@/lib/predictionLearningStorage";

const DEFAULT_BLEND = {
  historical_baseline: 0.18,
  recent_trend: 0.12,
  matchup: 0.28,
  market: 0.27,
  live: 0.15,
} as const;

type BlendKey = keyof typeof DEFAULT_BLEND;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function normalizeBlend(w: Record<BlendKey, number>): Record<BlendKey, number> {
  const keys = Object.keys(w) as BlendKey[];
  const sum = keys.reduce((s, k) => s + w[k], 0);
  if (sum <= 1e-6) return { ...DEFAULT_BLEND };
  const o = { ...w };
  for (const k of keys) o[k] = o[k] / sum;
  return o;
}

/** Mirrors pipeline form parsing — variance of recent W/L mix. */
function formPatternVariance(form: string): number {
  if (!form || form === "—") return 0;
  let wins = 0;
  let t = 0;
  for (const p of form.split("-")) {
    const c = p.trim().charAt(0).toUpperCase();
    if (c === "W" || c === "L") {
      t++;
      if (c === "W") wins++;
    }
  }
  if (t < 3) return 0;
  const p = wins / t;
  return Math.abs(p - 0.5) * 20;
}

function formWinRate(form: string): number | null {
  if (!form || form === "—") return null;
  let wins = 0;
  let t = 0;
  for (const p of form.split("-")) {
    const c = p.trim().charAt(0).toUpperCase();
    if (c === "W" || c === "L") {
      t++;
      if (c === "W") wins++;
    }
  }
  if (!t) return null;
  return wins / t;
}

export function computeContextAwareBlendWeights(
  league: League,
  g: GamePrediction,
  fat: { fatigue_score: number; travel_penalty: number },
  vol: { volatility_score: number; volatility_label: string },
  sch: { recent_schedule_difficulty: number }
): Record<BlendKey, number> {
  const s = getSportEngineLearningState(league);
  const ratio = clamp(s.recencyAlpha / 0.55, 0.72, 1.35);
  let w: Record<BlendKey, number> = {
    historical_baseline: DEFAULT_BLEND.historical_baseline * (2 - ratio),
    recent_trend: DEFAULT_BLEND.recent_trend * ratio,
    matchup: DEFAULT_BLEND.matchup,
    market: DEFAULT_BLEND.market,
    live: DEFAULT_BLEND.live,
  };

  if (fat.fatigue_score >= 58) {
    w.market *= 1.05;
    w.recent_trend *= 0.96;
    w.live *= 0.94;
  }
  if (fat.travel_penalty >= 10) {
    w.matchup *= 1.04;
  }

  const tags = g.situationalTags.join(" ");
  if (tags.includes("AWAY B2B")) {
    w.matchup *= 1.05;
    w.recent_trend *= 1.04;
  }
  if (tags.includes("HOME B2B")) {
    w.historical_baseline *= 1.03;
  }

  const sn = g.lines?.spreadNum;
  if (sn != null && Math.abs(sn) >= 10) {
    w.historical_baseline *= 1.06;
    w.live *= 0.9;
  }

  if (vol.volatility_label === "high") {
    w.market *= 1.04;
    w.recent_trend *= 1.03;
    w.historical_baseline *= 0.94;
  }

  if (sch.recent_schedule_difficulty >= 62) {
    w.historical_baseline *= 1.04;
    w.recent_trend *= 0.95;
  }

  if (league === "soccer") {
    const sc = g.soccer;
    const gapCount = sc?.dataGaps?.length ?? 0;
    if (gapCount >= 2) {
      w.market *= 1.12;
      w.matchup *= 0.93;
      w.historical_baseline *= 0.97;
    } else if (gapCount === 1) {
      w.market *= 1.05;
    }
    if (sc?.congestion) {
      const { homeLast7, awayLast7 } = sc.congestion;
      if (Math.abs(homeLast7 - awayLast7) >= 2) {
        w.recent_trend *= 1.06;
        w.matchup *= 1.04;
      }
      if (homeLast7 >= 3 || awayLast7 >= 3) {
        w.recent_trend *= 1.05;
        w.market *= 1.05;
      }
    }
    if (g.threeWay && g.threeWay.draw >= 26) {
      w.market *= 1.06;
      w.live *= 0.9;
      w.matchup *= 0.97;
    }
  }

  if (league === "mlb" && g.mlb) {
    const pc = g.mlb.pitcherCertainty;
    if (pc === "unknown" || pc === "partial") {
      w.market *= 1.14;
      w.matchup *= 0.9;
      w.historical_baseline *= 0.96;
    } else if (pc === "confirmed" && g.mlb.lineupConfirmed) {
      w.matchup *= 1.08;
      w.market *= 0.96;
    } else if (pc === "probable") {
      w.market *= 1.05;
    }
    const ld = g.mlb.modelOutput?._debug?.layerDebug;
    if (ld?.bullpenUsedFatigueRows) {
      w.recent_trend *= 1.05;
      w.matchup *= 1.04;
    }
    if (ld?.todayContext?.weatherVolatile || (g._meta?.mlbWeather?.windMph ?? 0) >= 12) {
      w.market *= 1.07;
      w.historical_baseline *= 0.96;
    }
  }

  return normalizeBlend(w);
}

/** Cross-matchup style edge (home perspective), percentage points. */
export function computeOpponentStyleCompatibilityPp(g: GamePrediction): number {
  const h = g.homeTeam;
  const a = g.awayTeam;
  if (g.league === "nba" || g.league === "nfl") {
    const crossHome = h.offensiveRating - a.defensiveRating;
    const crossAway = a.offensiveRating - h.defensiveRating;
    const k = g.league === "nba" ? 0.07 : 0.065;
    return clamp((crossHome - crossAway) * k, -1.35, 1.35);
  }
  if (g.league === "mlb") {
    const hc = h.offensiveRating - h.defensiveRating;
    const ac = a.offensiveRating - a.defensiveRating;
    let pp = clamp((hc - ac) * 0.064, -1.22, 1.22);
    const hwp = h.homeWinPct;
    const awp = a.roadWinPct;
    if (hwp != null && awp != null && Number.isFinite(hwp) && Number.isFinite(awp)) {
      pp += clamp((hwp - awp) * 20, -0.42, 0.42);
    }
    if (g.mlb?.homePitcherHand && g.mlb?.awayPitcherHand) {
      if (g.mlb.homePitcherHand === "L" && g.mlb.awayPitcherHand === "R") pp += 0.09;
      if (g.mlb.homePitcherHand === "R" && g.mlb.awayPitcherHand === "L") pp -= 0.07;
    }
    const dbg = g.mlb?.modelOutput?._debug;
    if (dbg?.pitcherScore != null && dbg?.battingScore != null) {
      pp += clamp((dbg.pitcherScore - dbg.battingScore) * 0.028, -0.28, 0.28);
    }
    return clamp(pp, -1.45, 1.45);
  }
  const paceGap = Math.abs(h.pace - a.pace);
  const hNet = h.offensiveRating - h.defensiveRating;
  const aNet = a.offensiveRating - a.defensiveRating;
  const tempo = h.pace > a.pace ? paceGap * 0.028 : -paceGap * 0.023;
  let soccerPp = (hNet - aNet) * 0.072 + tempo;
  const tab = g.soccer?.table;
  if (tab?.homePosition != null && tab?.awayPosition != null) {
    const betterHome = tab.awayPosition - tab.homePosition;
    soccerPp += clamp(betterHome * 0.016, -0.24, 0.24);
  }
  return clamp(soccerPp, -1.38, 1.38);
}

/** 0–100: higher = more consistent recent outcomes vs season baseline. */
export function computeStatisticalStabilityScore(g: GamePrediction): number {
  const fv = (formPatternVariance(g.homeTeam.recentForm) + formPatternVariance(g.awayTeam.recentForm)) / 2;
  const hp = parseRecord(g.homeTeam.record).pct;
  const ap = parseRecord(g.awayTeam.record).pct;
  let s = 74 - fv * 1.05;
  const hf = formWinRate(g.homeTeam.recentForm);
  const af = formWinRate(g.awayTeam.recentForm);
  if (hf != null) s -= Math.abs(hf - hp) * 22;
  if (af != null) s -= Math.abs(af - ap) * 22;
  return Math.round(clamp(s, 8, 96) * 10) / 10;
}

/** 0–100 data completeness for confidence (inverse of missing-critical-input risk). */
export function computeDataCompletenessScore(g: GamePrediction): number {
  let s = 88;
  if (g.league === "mlb" && g.mlb) {
    if (!g.mlb.lineupConfirmed) s -= 14;
    if (g.mlb.pitcherCertainty === "unknown") s -= 22;
    else if (g.mlb.pitcherCertainty === "partial") s -= 12;
    else if (g.mlb.pitcherCertainty === "probable") s -= 5;
  }
  const q = [...g.injuries.home, ...g.injuries.away].filter(
    (i) => i.status === "QUESTIONABLE" || i.status === "GTD"
  ).length;
  s -= Math.min(36, q * 9);
  if (!g.lines?.homeMl && !g.lines?.awayMl && !g._meta?.marketMl) s -= 8;
  if (g.league === "soccer" && g.soccer?.dataGaps?.length) {
    s -= Math.min(26, g.soccer.dataGaps.length * 8);
  }
  if (g.league === "soccer" && g.soccer && (g.soccer.table?.homePosition == null || g.soccer.table?.awayPosition == null)) {
    s -= 6;
  }
  return Math.round(clamp(s, 5, 100) * 10) / 10;
}

/** 0–100: elevated when key players show sharp recent vs season usage/heuristic. */
export function computeRoleChangeVolatilityScore(g: GamePrediction): number {
  let hit = 0;
  let n = 0;
  for (const side of [g.playerTrends.home, g.playerTrends.away]) {
    for (const p of side) {
      const base = Math.abs(p.seasonAvg) > 1e-6 ? Math.abs(p.seasonAvg) : null;
      if (base == null) continue;
      n++;
      const rel = Math.abs(p.last5Avg - p.seasonAvg) / base;
      if (rel >= 0.28) hit++;
    }
  }
  if (!n) return 18;
  const ratio = hit / n;
  return Math.round(clamp(22 + ratio * 68, 12, 94) * 10) / 10;
}

export function computeMarketSentimentSteamScore(
  lineMoveAbs: number | null,
  sharpMove: boolean,
  publicBiasScore: number
): number {
  if (lineMoveAbs == null) return Math.round(publicBiasScore * 0.35);
  const steam = lineMoveAbs * (sharpMove ? 4.5 : 11);
  return Math.round(clamp(steam * 0.45 + publicBiasScore * 0.38, 0, 100) * 10) / 10;
}

/**
 * Pull model toward closing line when movement looks sentiment-heavy vs sharp.
 */
export function computeMarketReactionProbPp(args: {
  league: League;
  modelHome: number;
  closeH: number | null;
  lineMove: number | null;
  sharpMove: boolean;
  sentimentSteamScore: number;
}): number {
  const { league, modelHome, closeH, lineMove, sharpMove, sentimentSteamScore } = args;
  if (closeH == null || lineMove == null) return 0;
  if (sharpMove) return 0;
  const steamFloor = league === "mlb" || league === "soccer" ? 48 : 52;
  const moveFloor = league === "mlb" || league === "soccer" ? 1.85 : 2.2;
  if (sentimentSteamScore < steamFloor) return 0;
  if (Math.abs(lineMove) < moveFloor) return 0;
  let pull = (closeH - modelHome) * 0.12 * clamp(sentimentSteamScore / 72, 0.35, 1);
  if (league === "mlb" || league === "soccer") pull *= 1.14;
  if (league === "nba" && sentimentSteamScore < 62) pull *= 0.88;
  return clamp(pull, -0.95, 0.95);
}

function interactionTiltFromState(state: SportEngineLearningState, tags: string[], league: League): number {
  let t = 0;
  const minRowN = league === "mlb" || league === "soccer" ? 20 : 24;
  for (const tag of tags) {
    const row = state.interactions[tag];
    if (row && row.n >= minRowN && typeof row.tiltPp === "number") t += row.tiltPp;
  }
  const cap = league === "mlb" || league === "soccer" ? 0.62 : 0.55;
  return clamp(t, -cap, cap);
}

/** Static interaction priors per league (bounded); combined with learned tag tilts. */
function staticFeatureInteractionPp(g: GamePrediction, volLabel: string): number {
  const L = g.league;
  const fat = g.situationalTags.join(" ");
  let pp = 0;
  if (L === "nba" && volLabel === "high" && fat.includes("B2B")) pp -= 0.22;
  if (L === "nfl" && fat.includes("SHORT WEEK") && volLabel === "high") pp -= 0.2;
  if (L === "mlb" && g.mlb?.pitcherCertainty === "probable" && volLabel === "high") pp -= 0.24;
  if (L === "mlb" && g.mlb?.modelOutput?.pendingConfirmation && volLabel === "high") pp -= 0.2;
  if (
    L === "mlb" &&
    volLabel === "high" &&
    (g.mlb?.modelOutput?._debug?.layerDebug?.todayContext?.weatherVolatile ||
      (g._meta?.mlbWeather?.windMph ?? 0) >= 12)
  ) {
    pp -= 0.16;
  }
  if (L === "soccer" && g.threeWay && g.threeWay.draw >= 28 && volLabel === "high") pp -= 0.22;
  if (L === "soccer" && (g.soccer?.dataGaps?.length ?? 0) >= 2 && volLabel === "high") pp -= 0.18;
  const paceGap = Math.abs(g.homeTeam.pace - g.awayTeam.pace);
  if (L === "nba" && paceGap >= 8 && volLabel === "high") pp -= 0.12;
  return clamp(pp, -0.62, 0.15);
}

/**
 * Sport-isolated probability nudges: calibration tilt, drift, style, market steam, interactions.
 */
export function computeLearningProbabilityStackPp(args: {
  league: League;
  g: GamePrediction;
  modelHome: number;
  closeH: number | null;
  lineMove: number | null;
  sharpMove: boolean;
  publicBiasScore: number;
  volLabel: string;
}): number {
  const { league, g, modelHome, closeH, lineMove, sharpMove, publicBiasScore, volLabel } = args;
  const state = getSportEngineLearningState(league);
  const lineMoveAbs = lineMove != null ? Math.abs(lineMove) : null;
  const sentiment = computeMarketSentimentSteamScore(lineMoveAbs, sharpMove, publicBiasScore);

  const fav = modelHome >= 50 ? 1 : -1;
  const mag = Math.abs(modelHome - 50);
  const calMult =
    league === "mlb" || league === "soccer" ? 1.22 : league === "nba" ? 0.9 : 1.06;
  const calPull = -fav * clamp(mag * 0.018 * state.probTiltPp * calMult, -1.35, 1.35);

  const drift = clamp(state.driftBaselinePp, -0.38, 0.38);
  const driftMult = league === "mlb" || league === "soccer" ? 1.12 : league === "nba" ? 0.85 : 1;
  const driftAdj = clamp(drift * driftMult, -0.38, 0.38);

  const style = computeOpponentStyleCompatibilityPp(g);

  const marketReact = computeMarketReactionProbPp({
    league,
    modelHome,
    closeH,
    lineMove,
    sharpMove,
    sentimentSteamScore: sentiment,
  });

  const situ = g.situationalTags.join(" ");
  const tags: string[] = [];
  if (volLabel === "high") tags.push(`${league}:high_vol`);
  if (situ.includes("B2B")) tags.push(`${league}:b2b`);
  if (publicBiasScore >= 56) tags.push(`${league}:pub_bias`);
  if (g.lines?.spreadNum != null && Math.abs(g.lines.spreadNum) >= 9) tags.push(`${league}:large_spread`);
  if (g.threeWay && g.threeWay.draw >= 28) tags.push(`${league}:draw_heavy`);
  const pc = g.mlb?.pitcherCertainty;
  if (pc === "unknown" || pc === "partial") tags.push(`${league}:pitcher_uncertain`);
  if (situ.includes("SHORT WEEK")) tags.push(`${league}:short_week`);

  const learnedInteract = interactionTiltFromState(state, tags, league);
  const staticInteract = staticFeatureInteractionPp(g, volLabel);

  const sum = calPull + driftAdj + style + marketReact + learnedInteract + staticInteract;
  const cap = league === "mlb" || league === "soccer" ? 3.05 : 2.8;
  return clamp(sum, -cap, cap);
}

export function shouldDowngradeForPredictionStale(g: GamePrediction, staleMinutes = 52): boolean {
  if (g.status === "live" || g.status === "final") return false;
  const t = new Date(g.lastUpdated).getTime();
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) / 60_000 > staleMinutes;
}

export function shouldDowngradeForHighVariance(volatilityScore: number): boolean {
  return volatilityScore >= 76;
}
