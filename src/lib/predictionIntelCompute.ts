/**
 * Pure intelligence features for prediction quality — no I/O.
 */
import type { GamePrediction, League, PredictionIntelMeta, PredictionQualityMeta } from "@/data/mockGames";
import { LEARNING_STORE_KEYS } from "@/lib/predictionLearningStorage";
import { defaultMinEdgeForRecommend } from "@/lib/sportEdgeThresholds";

const PUBLIC_HEAVY_ABBR = new Set([
  "LAL",
  "NYK",
  "BOS",
  "DAL",
  "GB",
  "KC",
  "SF",
  "PHI",
  "NYY",
  "LAD",
  "NYM",
  "CHC",
  "HOU",
  "MIA",
  "LIV",
  "MUN",
  "ARS",
]);

export function computeModelDisagreementScore(blend: NonNullable<PredictionQualityMeta["modelBlend"]>): number {
  const v = [
    blend.historical_baseline,
    blend.recent_trend,
    blend.matchup,
    blend.market,
    blend.live,
  ];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length;
  const stdev = Math.sqrt(variance);
  return Math.round(Math.min(100, stdev * 1.35) * 10) / 10;
}

export function computeBlowoutRiskScore(g: GamePrediction): number {
  const sn = g.lines?.spreadNum;
  let s = 12;
  if (sn != null && Number.isFinite(sn)) {
    const mag = Math.abs(sn);
    if (g.league === "nba" || g.league === "nfl") {
      s += Math.min(38, mag * (g.league === "nba" ? 2.8 : 2.2));
    } else {
      s += Math.min(28, mag * 4);
    }
  }
  const hNet = g.homeTeam.offensiveRating - g.homeTeam.defensiveRating;
  const aNet = g.awayTeam.offensiveRating - g.awayTeam.defensiveRating;
  s += Math.min(22, Math.abs(hNet - aNet) * 0.45);
  const fh = parseFormVariance(g.homeTeam.recentForm);
  const fa = parseFormVariance(g.awayTeam.recentForm);
  s += Math.min(14, (fh + fa) * 0.5);
  return Math.round(Math.min(100, Math.max(0, s)) * 10) / 10;
}

function parseFormVariance(form: string): number {
  if (!form || form === "—") return 0;
  let w = 0;
  let t = 0;
  for (const p of form.split("-")) {
    const c = p.trim().charAt(0).toUpperCase();
    if (c === "W" || c === "L") {
      t++;
      if (c === "W") w++;
    }
  }
  if (t < 3) return 0;
  const p = w / t;
  return Math.abs(p - 0.5) * 20;
}

export function computeSeasonPhaseScore(league: League, now = new Date()): number {
  const m = now.getUTCMonth() + 1;
  let s = 40;
  if (league === "nba") {
    if (m <= 11 && m >= 10) s += 22;
    else if (m >= 1 && m <= 2) s += 18;
    else if (m >= 3 && m <= 4) s += 12;
  } else if (league === "nfl") {
    if (m >= 9 && m <= 10) s += 24;
    else if (m >= 11 && m <= 12) s += 10;
    else if (m >= 1 && m <= 2) s += 20;
  } else if (league === "mlb") {
    if (m >= 3 && m <= 5) s += 20;
    else if (m >= 9 && m <= 10) s += 16;
  } else {
    if (m >= 8 && m <= 10) s += 14;
  }
  return Math.round(Math.min(100, s));
}

export function computePublicBiasScore(g: GamePrediction): number {
  const ph = g.winProbability.home;
  const pa = g.winProbability.away;
  const favHome = ph >= pa;
  const favAbbr = favHome ? g.homeTeam.abbreviation : g.awayTeam.abbreviation;
  const favProb = Math.max(ph, pa);
  if (!PUBLIC_HEAVY_ABBR.has(favAbbr)) return Math.round(favProb * 0.15);
  const ml = g.lines?.homeMl && g.lines?.awayMl;
  if (!ml) return 18;
  const modelFadesPublic =
    (favHome && ph < 52) || (!favHome && pa < 52) || Math.abs(ph - pa) < 4;
  if (modelFadesPublic) return Math.round(28 + (52 - Math.max(ph, pa)) * 0.8);
  return 14;
}

export function computeInjuryUncertaintyScore(g: GamePrediction): number {
  const all = [...g.injuries.home, ...g.injuries.away];
  let s = 8;
  for (const i of all) {
    if (i.status === "QUESTIONABLE" || i.status === "GTD") s += 14 + i.impactScore * 0.35;
    if (i.status === "PROBABLE") s += 6 + i.impactScore * 0.2;
  }
  return Math.round(Math.min(100, s) * 10) / 10;
}

export function computeRoleStabilityScore(g: GamePrediction): number {
  let s = 62;
  if (g.league === "mlb") {
    if (g.mlb?.lineupConfirmed) s += 18;
    if (g.mlb?.pitcherCertainty === "confirmed") s += 14;
    else if (g.mlb?.pitcherCertainty === "probable") s += 4;
    else s -= 22;
  }
  if (g._meta?.nbaRatingsFromStats) s += 8;
  const q = [...g.injuries.home, ...g.injuries.away].filter(
    (x) => x.status === "QUESTIONABLE" || x.status === "GTD"
  ).length;
  s -= q * 9;
  return Math.round(Math.min(100, Math.max(5, s)));
}

export function computeLiveUpdateLatencyMs(g: GamePrediction): number {
  if (g.status !== "live") return 0;
  const t = new Date(g.lastUpdated).getTime();
  if (!Number.isFinite(t)) return 999_999;
  return Math.max(0, Date.now() - t);
}

export function buildPipelinePredictionIntel(
  g: GamePrediction,
  modelBlend: NonNullable<PredictionQualityMeta["modelBlend"]>,
  modelVsCloseHomePp: number | null | undefined
): PredictionIntelMeta {
  return {
    model_disagreement_score: computeModelDisagreementScore(modelBlend),
    blowout_risk_score: computeBlowoutRiskScore(g),
    season_phase_score: computeSeasonPhaseScore(g.league),
    public_bias_score: computePublicBiasScore(g),
    injury_uncertainty_score: computeInjuryUncertaintyScore(g),
    role_stability_score: computeRoleStabilityScore(g),
    edge_current_vs_open_pp:
      modelVsCloseHomePp != null && Number.isFinite(modelVsCloseHomePp)
        ? Math.round(modelVsCloseHomePp * 100) / 100
        : null,
    optimal_edge_threshold: defaultMinEdgeForRecommend(g.league),
    learning_store_keys: { ...LEARNING_STORE_KEYS },
  };
}
