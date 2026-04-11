/**
 * Layered prediction quality on top of the base + enrichment + advanced intelligence.
 * Does not replace the base model; adds calibration metadata, bounded probability nudges,
 * confidence discipline, and richer reasoning bullets. Safe when Supabase calibration is empty.
 */

import type {
  ConfidenceLevel,
  GamePrediction,
  MarketMlSnapshot,
  PredictionQualityMeta,
  VolatilityLabel,
} from "@/data/mockGames";
import { shiftThreeWayProb, shiftWinProbabilityTwoWay } from "@/lib/espnEnrichment";
import {
  calibrateConfidenceForSport,
  fetchConfidenceCalibration,
  type CalibrationRow,
} from "@/lib/confidenceCalibration";
import { parseRecord, winProbFromOdds } from "@/lib/espnShared";

const BLEND_WEIGHTS = {
  historical_baseline: 0.18,
  recent_trend: 0.12,
  matchup: 0.28,
  market: 0.27,
  live: 0.15,
} as const;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function downgradeConfidence(c: ConfidenceLevel): ConfidenceLevel {
  if (c === "high") return "medium";
  if (c === "medium") return "low";
  return "low";
}

function injuryImportanceMeta(g: GamePrediction): PredictionQualityMeta["injury"] {
  const scoreSide = (side: "home" | "away") => {
    const list = side === "home" ? g.injuries.home : g.injuries.away;
    let importance = 0;
    let replacement = 0;
    for (const i of list) {
      if (i.status === "OUT") {
        importance += i.impactScore * 1.1;
        replacement += Math.max(0, 10 - i.impactScore) * 0.3;
      } else if (i.status === "QUESTIONABLE" || i.status === "GTD") {
        importance += i.impactScore * 0.55;
      }
    }
    return { importance, replacement };
  };
  const h = scoreSide("home");
  const a = scoreSide("away");
  return {
    injury_importance_score: Math.round((h.importance + a.importance) * 10) / 10,
    replacement_penalty: Math.round((h.replacement + a.replacement) * 10) / 10,
    total_injury_impact_score: Math.round(Math.abs(h.importance - a.importance) * 10) / 10,
  };
}

function fatigueMeta(g: GamePrediction): PredictionQualityMeta["fatigue"] {
  const tags = g.situationalTags.join(" ");
  let score = 35;
  let travel = 0;
  if (tags.includes("AWAY B2B")) {
    score += 22;
    travel += 12;
  }
  if (tags.includes("HOME B2B")) score += 15;
  if (tags.includes("CONSEC")) score += 10;
  if (tags.includes("SHORT WEEK")) {
    score += 14;
    travel += 8;
  }
  if (g.mlb?.modelOutput?._debug?.layerDebug?.bullpenUsedFatigueRows) {
    score += 8;
  }
  score = clamp(Math.round(score), 0, 100);
  return {
    fatigue_score: score,
    fatigue_penalty: Math.round(score * 0.12),
    travel_penalty: travel,
  };
}

function styleMeta(g: GamePrediction): PredictionQualityMeta["style"] {
  const { homeTeam: h, awayTeam: a } = g;
  const paceGap = Math.abs(h.pace - a.pace);
  const hNet = h.offensiveRating - h.defensiveRating;
  const aNet = a.offensiveRating - a.defensiveRating;
  const mismatch = Math.abs(hNet - aNet);
  let score = 50 + clamp(paceGap * 1.2, 0, 25) + clamp(mismatch * 0.35, 0, 20);
  score = clamp(Math.round(score), 15, 95);
  const notes: string[] = [];
  if (paceGap >= 6) {
    notes.push(
      h.pace > a.pace
        ? `${h.abbreviation} plays faster than ${a.abbreviation} — tempo edge vs half-court defense.`
        : `${a.abbreviation} prefers a slower pace than ${h.abbreviation} — grind game risk.`
    );
  }
  if (g.league === "mlb" && g.mlb?.homePitcherHand && g.mlb?.awayPitcherHand) {
    notes.push(
      `Handedness matchup (${g.mlb.awayPitcherHand} starter @ ${g.mlb.homePitcherHand}) — lineup splits matter for contact vs power.`
    );
  }
  if (g.league === "nfl" && mismatch >= 8) {
    notes.push("One-sided efficiency profile — script can swing quickly if turnovers cluster.");
  }
  return {
    style_matchup_score: score,
    style_notes: notes.slice(0, 3),
    style_risk_flag: paceGap >= 8 || mismatch >= 12,
  };
}

function volatilityFromGame(g: GamePrediction, fatigueScore: number): PredictionQualityMeta["volatility"] {
  let v = 28;
  const sp = g.lines?.spreadNum;
  if (sp != null && Math.abs(sp) <= 1.5) v += 14;
  if (g.threeWay && g.threeWay.draw >= 28) v += 16;
  const injQ =
    g.injuries.home.filter((i) => i.status === "QUESTIONABLE" || i.status === "GTD").length +
    g.injuries.away.filter((i) => i.status === "QUESTIONABLE" || i.status === "GTD").length;
  v += injQ * 5;
  if (g.mlb?.pitcherCertainty === "unknown" || g.mlb?.pitcherCertainty === "partial") v += 12;
  v += clamp(fatigueScore * 0.15, 0, 18);
  if (g._meta?.mlbWeather?.windMph != null && g._meta.mlbWeather.windMph >= 12) v += 10;
  v = clamp(Math.round(v), 0, 100);
  const label: VolatilityLabel = v >= 68 ? "high" : v >= 45 ? "medium" : "low";
  return { volatility_score: v, volatility_label: label };
}

function scheduleMeta(g: GamePrediction): PredictionQualityMeta["schedule"] {
  const hp = parseRecord(g.homeTeam.record).pct;
  const ap = parseRecord(g.awayTeam.record).pct;
  const favProb = Math.max(g.winProbability.home, g.winProbability.away);
  const weakOpponent = Math.min(hp, ap) < 0.38;
  const strongOpponent = Math.max(hp, ap) > 0.62;
  let diff = 50;
  if (weakOpponent && favProb >= 58) diff += 18;
  if (strongOpponent && favProb <= 52) diff += 12;
  diff = clamp(Math.round(diff), 0, 100);
  return {
    opponent_strength_score: Math.round(Math.max(hp, ap) * 100),
    recent_schedule_difficulty: diff,
  };
}

function parseFormScore(form: string): number {
  if (!form || form === "—") return 50;
  const parts = form.split("-");
  let w = 0;
  let t = 0;
  for (const p of parts) {
    const c = p.trim().charAt(0).toUpperCase();
    if (c === "W" || c === "L") {
      t++;
      if (c === "W") w++;
    }
  }
  if (!t) return 50;
  return clamp(30 + (w / t) * 55, 15, 85);
}

function impliedFromSnapshot(
  ml: NonNullable<GamePrediction["_meta"]>["marketMl"]
): { openH: number | null; closeH: number | null } {
  if (!ml) return { openH: null, closeH: null };
  const openP = winProbFromOdds(ml.homeOpen, ml.awayOpen);
  const closeP = winProbFromOdds(ml.homeClose ?? ml.homeOpen, ml.awayClose ?? ml.awayOpen);
  return {
    openH: openP?.home ?? null,
    closeH: closeP?.home ?? null,
  };
}

function liveSubScore(g: GamePrediction): number {
  const ls = g._meta?.liveState;
  if (!ls || g.status !== "live") return 50;
  const d = ls.homeScore - ls.awayScore;
  const cap = g.league === "mlb" ? 1.8 : 1.4;
  return clamp(50 + d * cap, 15, 85);
}

function applyBoundedProbShift(g: GamePrediction, homeDeltaPp: number): GamePrediction {
  const cap = 4;
  const d = clamp(homeDeltaPp, -cap, cap);
  if (Math.abs(d) < 0.25) return g;
  if (g.threeWay) {
    const tw = shiftThreeWayProb(g.threeWay, d);
    return {
      ...g,
      threeWay: tw,
      winProbability: { home: tw.home, away: tw.away },
    };
  }
  return { ...g, winProbability: shiftWinProbabilityTwoWay(g.winProbability, d) };
}

function mergeReasons(g: GamePrediction, extra: string[], risks: string[]): GamePrediction {
  const top = [...g.topReasons];
  for (const r of extra) {
    if (r && !top.some((x) => x.includes(r.slice(0, 28)))) top.push(r);
  }
  const rf = [...g.riskFactors];
  for (const r of risks) {
    if (r && !rf.some((x) => x.includes(r.slice(0, 28)))) rf.push(r);
  }
  return { ...g, topReasons: top.slice(0, 10), riskFactors: rf.slice(0, 8) };
}

function detectLateNews(g: GamePrediction, sharpMove: boolean): boolean {
  const starOut =
    [...g.injuries.home, ...g.injuries.away].some((i) => i.status === "OUT" && i.impactScore >= 9) ||
    [...g.injuries.home, ...g.injuries.away].filter((i) => i.status === "OUT").length >= 3;
  const qCluster =
    [...g.injuries.home, ...g.injuries.away].filter(
      (i) => (i.status === "QUESTIONABLE" || i.status === "GTD") && i.impactScore >= 6
    ).length >= 3;
  const mlbLate =
    g.league === "mlb" &&
    (g.mlb?.pitcherCertainty === "unknown" ||
      Boolean(g.mlb?.modelOutput?.pendingConfirmation && g.mlb?.modelOutput?.riskFlag));
  return starOut || qCluster || mlbLate || sharpMove;
}

export function applyQualityToOneGame(g: GamePrediction, calibrationRows: CalibrationRow[]): GamePrediction {
  const rawConfidence = g.confidence;
  let next: GamePrediction = { ...g, _meta: g._meta ? { ...g._meta } : {} };

  const inj = injuryImportanceMeta(next);
  const fat = fatigueMeta(next);
  const sty = styleMeta(next);
  const vol = volatilityFromGame(next, fat.fatigue_score);
  const sch = scheduleMeta(next);

  const ml = next._meta?.marketMl;
  const { openH, closeH } = impliedFromSnapshot(ml);
  const modelHome = next.threeWay ? next.threeWay.home : next.winProbability.home;
  let lineMove: number | null = null;
  if (openH != null && closeH != null) lineMove = closeH - openH;

  const marketImpClose = closeH ?? openH;
  const marketSignalStrength =
    lineMove != null ? clamp(Math.abs(lineMove) * 8 + (marketImpClose != null ? Math.abs(marketImpClose - modelHome) * 0.35 : 0), 0, 100) : 0;

  const sharpMove = lineMove != null && Math.abs(lineMove) >= 4;

  const hist = clamp(50 + (parseRecord(next.homeTeam.record).pct - parseRecord(next.awayTeam.record).pct) * 38, 12, 88);
  const recent =
    (parseFormScore(next.homeTeam.recentForm) - parseFormScore(next.awayTeam.recentForm)) * 0.45 + 50;
  const hNet = next.homeTeam.offensiveRating - next.homeTeam.defensiveRating;
  const aNet = next.awayTeam.offensiveRating - next.awayTeam.defensiveRating;
  const match = clamp(50 + (hNet - aNet) * 1.15, 12, 88);
  const mkt = clamp(
    50 + (marketImpClose != null ? (marketImpClose - modelHome) * 1.1 : 0),
    12,
    88
  );
  const live = liveSubScore(next);

  const blended =
    BLEND_WEIGHTS.historical_baseline * hist +
    BLEND_WEIGHTS.recent_trend * recent +
    BLEND_WEIGHTS.matchup * match +
    BLEND_WEIGHTS.market * mkt +
    BLEND_WEIGHTS.live * live;

  const blended_adjustment_pp = clamp((blended - 50) * 0.065, -3, 3);
  next = applyBoundedProbShift(next, blended_adjustment_pp);
  const finalModelHome = next.threeWay ? next.threeWay.home : next.winProbability.home;

  let conf = rawConfidence;
  if (vol.volatility_label === "high") conf = downgradeConfidence(conf);
  if (marketImpClose != null && Math.abs(marketImpClose - finalModelHome) >= 9) conf = downgradeConfidence(conf);
  if (sch.recent_schedule_difficulty >= 65 && Math.max(next.winProbability.home, next.winProbability.away) >= 60) {
    conf = downgradeConfidence(conf);
  }
  const gtdHeavy =
    [...next.injuries.home, ...next.injuries.away].filter(
      (i) => (i.status === "GTD" || i.status === "QUESTIONABLE") && i.impactScore >= 7
    ).length >= 2;
  if (gtdHeavy) conf = downgradeConfidence(conf);

  const cal = calibrateConfidenceForSport(next.league, conf, calibrationRows);
  conf = cal.confidence;

  const agreeMove =
    lineMove != null &&
    ((lineMove > 1.5 && modelHome >= 52) || (lineMove < -1.5 && modelHome <= 48));
  const disagreeMove =
    lineMove != null &&
    ((lineMove > 2 && modelHome <= 48) || (lineMove < -2 && modelHome >= 52));

  const extraReasons: string[] = [...sty.style_notes];
  if (agreeMove) extraReasons.push("Line movement aligns with the model lean — slightly higher conviction.");
  if (disagreeMove) extraReasons.push("Line moved against the model lean — market may be pricing news we do not fully see.");
  if (openH != null && closeH != null && lineMove != null && Math.abs(lineMove) >= 2) {
    extraReasons.push(
      `Moneyline implied home % moved from ~${openH}% to ~${closeH}% (supporting signal only).`
    );
  }
  if (vol.volatility_label === "high") {
    extraReasons.push("Volatility flagged high — matchup has elevated variance (injuries, pace, or bullpen uncertainty).");
  }
  if (sch.recent_schedule_difficulty >= 65) {
    extraReasons.push("Schedule context: favorite may be propped up by softer opponents — strength-of-schedule caution.");
  }
  if (fat.fatigue_score >= 62) {
    extraReasons.push("Rest / congestion profile adds fatigue risk — projection confidence capped.");
  }

  const extraRisks: string[] = [];
  if (disagreeMove) extraRisks.push("Market disagreement: consider shrinking stake size.");
  if (sharpMove) extraRisks.push("Sharp line move detected (open vs close) — re-check news before lock.");
  if (sty.style_risk_flag) extraRisks.push("Style clash increases script volatility — same-game parlays carry extra correlation risk.");

  next = mergeReasons(next, extraReasons, extraRisks);
  next = { ...next, confidence: conf, lastUpdated: new Date().toISOString() };

  const clvDelta =
    openH != null && closeH != null ? clamp(finalModelHome - closeH, -25, 25) / 100 : null;

  const lateNews = detectLateNews(next, sharpMove);

  const quality: PredictionQualityMeta = {
    pipelineVersion: 1,
    modelBlend: {
      historical_baseline: Math.round(hist * 10) / 10,
      recent_trend: Math.round(recent * 10) / 10,
      matchup: Math.round(match * 10) / 10,
      market: Math.round(mkt * 10) / 10,
      live: Math.round(live * 10) / 10,
      blended_adjustment_pp: Math.round(blended_adjustment_pp * 100) / 100,
    },
    market: {
      opening_implied_home: openH,
      closing_implied_home: closeH,
      line_movement_home_pp: lineMove,
      model_implied_home: finalModelHome,
      clv_delta: clvDelta,
      market_signal_strength: Math.round(marketSignalStrength * 10) / 10,
      sharp_move_hint: sharpMove,
    },
    calibration: {
      raw_confidence: rawConfidence,
      bucket: conf,
      empirical_hit_rate: cal.empirical_hit_rate ?? null,
      calibration_window: cal.calibration_window,
    },
    injury: inj,
    fatigue: fat,
    style: sty,
    volatility: vol,
    schedule: sch,
    correlation: { correlation_score: 0, card_risk_penalty: 0 },
    risk_flags: [
      ...(vol.volatility_label === "high" ? ["high_volatility"] : []),
      ...(disagreeMove ? ["market_disagreement"] : []),
      ...(sharpMove ? ["line_move_sharp"] : []),
      ...(lateNews ? ["late_news_trigger"] : []),
    ],
    late_news_refresh: lateNews,
    version_timestamp: new Date().toISOString(),
  };

  next._meta!.quality = quality;
  return next;
}

export async function applyPredictionQualityPipeline(games: GamePrediction[]): Promise<GamePrediction[]> {
  const rows = await fetchConfidenceCalibration();
  return games.map((g) => applyQualityToOneGame(g, rows));
}
