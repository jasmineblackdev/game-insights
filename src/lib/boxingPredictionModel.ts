/**
 * Boxing prediction model.
 * Evaluates fights on: reach, age curve, stance matchup, KO%, inactivity,
 * opponent quality, style compatibility, and chin durability.
 *
 * Fighters are stored in Supabase boxing_fighters; fetched via boxingFetch.ts.
 * Weights are stored in boxing_learning_history (per-sport, never mixed with MLB/NBA).
 */

import type { BoxingFighterProfile, BoxingIntel, BoxingModelOutput } from "@/data/mockGames";

// ── Default factor weights (sum to 1.0) ───────────────────────────────────────

export interface BoxingFactorWeights {
  reach: number;
  age: number;
  stance: number;
  inactivity: number;
  opponentQuality: number;
  style: number;
  koPct: number;
  chin: number;
  learned: boolean;
  sampleSize: number;
}

export const DEFAULT_BOXING_WEIGHTS: BoxingFactorWeights = {
  reach: 0.12,
  age: 0.18,
  stance: 0.08,
  inactivity: 0.10,
  opponentQuality: 0.22,
  style: 0.14,
  koPct: 0.10,
  chin: 0.06,
  learned: false,
  sampleSize: 0,
};

// ── Factor scoring functions ──────────────────────────────────────────────────

/**
 * Reach advantage: each inch matters more in boxing than height.
 * Score range: [-0.15, +0.15] normalized to [-1, +1] factor unit before weighting.
 */
function scoreReach(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  if (home.reach == null || away.reach == null) return 0;
  const delta = home.reach - away.reach;
  // Each inch ~0.02 advantage; cap at 7 inches
  return Math.max(-0.14, Math.min(0.14, delta * 0.02));
}

/**
 * Age curve: fighters peak ~26-32, decline sharply after 35.
 * Applies penalty to the older fighter if they are past prime.
 */
function scoreAge(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  if (home.age == null && away.age == null) return 0;

  function ageCurveScore(age: number): number {
    if (age < 22) return -0.05; // too young / inexperienced
    if (age <= 28) return 0.08; // ascending
    if (age <= 32) return 0.05; // peak
    if (age <= 35) return 0;    // declining but manageable
    if (age <= 38) return -0.08; // significant decline
    return -0.15; // severe decline
  }

  const homeScore = home.age != null ? ageCurveScore(home.age) : 0;
  const awayScore = away.age != null ? ageCurveScore(away.age) : 0;
  return homeScore - awayScore;
}

/**
 * Stance matchup: southpaw vs orthodox creates angles the orthodox fighter rarely sees.
 * Score range: [-0.08, +0.08]
 */
function scoreStance(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  if (!home.stance || !away.stance) return 0;
  const homeIsSouthpaw = home.stance === "southpaw";
  const awayIsSouthpaw = away.stance === "southpaw";
  // Southpaw advantage vs orthodox
  if (homeIsSouthpaw && !awayIsSouthpaw) return 0.06;
  if (!homeIsSouthpaw && awayIsSouthpaw) return -0.06;
  // Same stance: slight advantage to the more experienced southpaw who knows mirror matchups
  if (homeIsSouthpaw && awayIsSouthpaw) {
    const homeW = home.wins ?? 0;
    const awayW = away.wins ?? 0;
    return homeW > awayW ? 0.02 : homeW < awayW ? -0.02 : 0;
  }
  return 0;
}

/**
 * Inactivity penalty: ring rust after extended layoff.
 * Score range: [-0.15, 0]
 */
function scoreInactivity(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  function layoffMonths(lastFight: string | undefined): number | null {
    if (!lastFight) return null;
    const last = new Date(lastFight);
    const now = new Date();
    const diffMs = now.getTime() - last.getTime();
    return diffMs / (1000 * 60 * 60 * 24 * 30.44);
  }

  function inactivityPenalty(months: number | null): number {
    if (months == null) return 0;
    if (months < 6) return 0;
    if (months < 12) return -0.03;
    if (months < 18) return -0.07;
    if (months < 24) return -0.11;
    return -0.15; // 2+ years away is severe ring rust
  }

  const homeMonths = layoffMonths(home.lastFightDate);
  const awayMonths = layoffMonths(away.lastFightDate);
  return inactivityPenalty(homeMonths) - inactivityPenalty(awayMonths);
}

/**
 * Opponent quality (schedule strength): fighters who faced tougher opposition deserve credit.
 * Score range: [-0.15, +0.15]
 */
function scoreOpponentQuality(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  const homeQ = home.opponentQualityScore ?? 50;
  const awayQ = away.opponentQualityScore ?? 50;
  const delta = (homeQ - awayQ) / 100;
  return Math.max(-0.15, Math.min(0.15, delta * 0.3));
}

/**
 * Style compatibility: some styles match up poorly against others.
 * pressure_fighter > counterpuncher, boxer_puncher is balanced, brawler > boxer on inside.
 */
function scoreStyleMatchup(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  const STYLE_MATRIX: Record<string, Record<string, number>> = {
    pressure_fighter: {
      counterpuncher: 0.08,
      boxer_puncher: -0.03,
      brawler: 0.03,
      pressure_fighter: 0,
    },
    counterpuncher: {
      pressure_fighter: -0.08,
      boxer_puncher: 0.04,
      brawler: -0.04,
      counterpuncher: 0,
    },
    boxer_puncher: {
      pressure_fighter: 0.03,
      counterpuncher: -0.04,
      brawler: 0.06,
      boxer_puncher: 0,
    },
    brawler: {
      pressure_fighter: -0.03,
      counterpuncher: 0.04,
      boxer_puncher: -0.06,
      brawler: 0,
    },
  };

  const hs = home.styleTag ?? "";
  const as = away.styleTag ?? "";
  return STYLE_MATRIX[hs]?.[as] ?? 0;
}

/**
 * KO% differential: finishing ability vs chin durability.
 * High KO% attacker vs poor chin = significant edge.
 */
function scoreKoMatchup(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  const homeKo = home.koPct ?? 0.4;
  const awayChin = away.chinScore ?? 5;
  const awayKo = away.koPct ?? 0.4;
  const homeChin = home.chinScore ?? 5;

  // Home fighter's KO threat vs away's chin: normalize chin 0-10 → 0-1 scale inverted
  const homeAttack = homeKo * (1 - awayChin / 10);
  const awayAttack = awayKo * (1 - homeChin / 10);

  return Math.max(-0.12, Math.min(0.12, (homeAttack - awayAttack) * 0.5));
}

/**
 * Chin durability standalone score (separate from KO matchup).
 */
function scoreChin(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  const homeC = home.chinScore ?? 5;
  const awayC = away.chinScore ?? 5;
  return Math.max(-0.08, Math.min(0.08, ((homeC - awayC) / 10) * 0.8));
}

// ── Win probability calculation ───────────────────────────────────────────────

function deltaToProbability(delta: number): number {
  // Logistic sigmoid centered at 0.5
  const k = 6; // steepness
  return 1 / (1 + Math.exp(-k * delta));
}

// ── Method of victory probabilities ──────────────────────────────────────────

function estimateMethodProbabilities(
  home: BoxingFighterProfile,
  away: BoxingFighterProfile,
  winnerIsHome: boolean,
): { ko_tko: number; decision: number; draw: number } {
  const winner = winnerIsHome ? home : away;
  const loser = winnerIsHome ? away : home;

  const winnerKo = winner.koPct ?? 0.4;
  const loserChin = loser.chinScore ?? 5;
  const loserDecision = loser.decisionPct ?? 0.5;

  // Base KO probability from winner's finishing ability vs loser's chin
  const rawKo = winnerKo * (1 - loserChin / 10) * (1 - loserDecision * 0.3);
  const koProb = Math.max(0.1, Math.min(0.75, rawKo));
  const drawProb = 0.04; // boxing draws are rare (~4% at professional level)
  const decisionProb = 1 - koProb - drawProb;

  return {
    ko_tko: Math.round(koProb * 100) / 100,
    decision: Math.round(decisionProb * 100) / 100,
    draw: drawProb,
  };
}

// ── Edge text generation ──────────────────────────────────────────────────────

function reachEdgeText(home: BoxingFighterProfile, away: BoxingFighterProfile, score: number): string {
  if (home.reach == null || away.reach == null) return "Reach data unavailable";
  const delta = home.reach - away.reach;
  if (Math.abs(delta) < 1) return "Nearly identical reach";
  const longer = delta > 0 ? home.name : away.name;
  return `${longer} has ${Math.abs(delta).toFixed(1)}" reach advantage — ${Math.abs(score) > 0.08 ? "significant edge" : "slight edge"} in jab range`;
}

function ageEdgeText(home: BoxingFighterProfile, away: BoxingFighterProfile, score: number): string {
  if (home.age == null && away.age == null) return "Age data unavailable";
  if (Math.abs(score) < 0.02) return "Both fighters in similar age window";
  const favored = score > 0 ? home.name : away.name;
  const other = score > 0 ? away.name : home.name;
  const otherAge = score > 0 ? away.age : home.age;
  if (otherAge != null && otherAge > 35) return `${other} (${otherAge}) past prime — ${favored} age advantage`;
  if (otherAge != null && otherAge < 24) return `${other} (${otherAge}) still developing — ${favored} experience edge`;
  return `${favored} in better age window`;
}

function stanceEdgeText(home: BoxingFighterProfile, away: BoxingFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Stance matchup is neutral";
  const southpaw = home.stance === "southpaw" ? home.name : away.name;
  const orthodox = home.stance === "southpaw" ? away.name : home.name;
  return `${southpaw} southpaw creates unorthodox angles for ${orthodox}`;
}

function activityEdgeText(home: BoxingFighterProfile, away: BoxingFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Both fighters similarly active";
  const rusty = score < 0 ? home.name : away.name;
  const active = score < 0 ? away.name : home.name;
  return `${rusty} ring rust concern — ${active} has recency advantage`;
}

function styleEdgeText(home: BoxingFighterProfile, away: BoxingFighterProfile, score: number): string {
  if (!home.styleTag || !away.styleTag) return "Style data unavailable";
  if (Math.abs(score) < 0.02) return `${home.styleTag} vs ${away.styleTag} — even matchup`;
  const favored = score > 0 ? home.name : away.name;
  const fStyle = score > 0 ? home.styleTag : away.styleTag;
  const aStyle = score > 0 ? away.styleTag : home.styleTag;
  return `${fStyle} style exploits ${aStyle} tendencies — ${favored} style edge`;
}

function opponentQualityEdgeText(
  home: BoxingFighterProfile,
  away: BoxingFighterProfile,
  score: number,
): string {
  if (Math.abs(score) < 0.02) return "Similar opposition quality";
  const better = score > 0 ? home.name : away.name;
  return `${better} tested against higher-caliber opponents`;
}

function koPctText(home: BoxingFighterProfile, away: BoxingFighterProfile): string {
  const homeKo = home.koPct != null ? `${Math.round(home.koPct * 100)}%` : "?";
  const awayKo = away.koPct != null ? `${Math.round(away.koPct * 100)}%` : "?";
  return `KO rates — ${home.name}: ${homeKo} / ${away.name}: ${awayKo}`;
}

// ── Main model function ───────────────────────────────────────────────────────

export function scoreBoxingFight(
  home: BoxingFighterProfile,
  away: BoxingFighterProfile,
  weights: BoxingFactorWeights = DEFAULT_BOXING_WEIGHTS,
): BoxingModelOutput {
  const reachScore = scoreReach(home, away);
  const ageScore = scoreAge(home, away);
  const stanceScore = scoreStance(home, away);
  const inactivityScore = scoreInactivity(home, away);
  const opponentQualityScore = scoreOpponentQuality(home, away);
  const styleScore = scoreStyleMatchup(home, away);
  const koScore = scoreKoMatchup(home, away);
  const chinScore = scoreChin(home, away);

  const combinedDelta =
    reachScore * weights.reach +
    ageScore * weights.age +
    stanceScore * weights.stance +
    inactivityScore * weights.inactivity +
    opponentQualityScore * weights.opponentQuality +
    styleScore * weights.style +
    koScore * weights.koPct +
    chinScore * weights.chin;

  const riskFlag = buildRiskFlag(home, away);

  const methodProbs = estimateMethodProbabilities(home, away, combinedDelta >= 0);

  // Estimated average rounds: base on scheduled rounds and KO probability
  const scheduledRoundsEstimate = 12;
  const avgRounds = Math.round(
    scheduledRoundsEstimate * (1 - methodProbs.ko_tko * 0.6),
  );

  return {
    reachEdge: reachEdgeText(home, away, reachScore),
    ageEdge: ageEdgeText(home, away, ageScore),
    stanceEdge: stanceEdgeText(home, away, stanceScore),
    activityEdge: activityEdgeText(home, away, inactivityScore),
    styleEdge: styleEdgeText(home, away, styleScore),
    opponentQualityEdge: opponentQualityEdgeText(home, away, opponentQualityScore),
    koPctNote: koPctText(home, away),
    methodProbabilities: methodProbs,
    overUnderRoundsPivot: avgRounds,
    riskFlag,
    _debug: {
      reachDelta: home.reach != null && away.reach != null ? home.reach - away.reach : null,
      ageDelta: home.age != null && away.age != null ? home.age - away.age : null,
      stanceAdvantage: stanceScore,
      inactivityPenalty: inactivityScore,
      styleMatchup: styleScore,
      opponentQuality: opponentQualityScore,
      combinedDelta,
    },
  };
}

function buildRiskFlag(home: BoxingFighterProfile, away: BoxingFighterProfile): string | null {
  const flags: string[] = [];

  // Inactivity risk
  function monthsOut(lastFight: string | undefined): number | null {
    if (!lastFight) return null;
    return (Date.now() - new Date(lastFight).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  }
  const homeOut = monthsOut(home.lastFightDate);
  const awayOut = monthsOut(away.lastFightDate);
  if (homeOut != null && homeOut > 18) flags.push(`${home.name} ${Math.round(homeOut)}mo layoff`);
  if (awayOut != null && awayOut > 18) flags.push(`${away.name} ${Math.round(awayOut)}mo layoff`);

  // Age risk
  if (home.age != null && home.age > 37) flags.push(`${home.name} age ${home.age} — significant decline risk`);
  if (away.age != null && away.age > 37) flags.push(`${away.name} age ${away.age} — significant decline risk`);

  // Chin risk when facing a big KO puncher
  if (
    home.chinScore != null &&
    home.chinScore < 4 &&
    away.koPct != null &&
    away.koPct > 0.6
  ) {
    flags.push(`${home.name} chin suspect vs ${away.name}'s ${Math.round(away.koPct * 100)}% KO rate`);
  }
  if (
    away.chinScore != null &&
    away.chinScore < 4 &&
    home.koPct != null &&
    home.koPct > 0.6
  ) {
    flags.push(`${away.name} chin suspect vs ${home.name}'s ${Math.round(home.koPct * 100)}% KO rate`);
  }

  return flags.length > 0 ? flags.join(" · ") : null;
}

// ── Win probability ───────────────────────────────────────────────────────────

export function boxingWinProbability(
  home: BoxingFighterProfile,
  away: BoxingFighterProfile,
  weights: BoxingFactorWeights = DEFAULT_BOXING_WEIGHTS,
): { home: number; away: number } {
  const output = scoreBoxingFight(home, away, weights);
  const homeProb = Math.round(deltaToProbability(output._debug.combinedDelta) * 100);
  const awayProb = 100 - homeProb;
  return { home: homeProb, away: awayProb };
}

// ── Confidence tier ───────────────────────────────────────────────────────────

export function boxingConfidence(
  home: BoxingFighterProfile,
  away: BoxingFighterProfile,
  winProb: { home: number; away: number },
): "high" | "medium" | "low" {
  const max = Math.max(winProb.home, winProb.away);
  const hasGoodData =
    home.reach != null &&
    away.reach != null &&
    home.age != null &&
    away.age != null &&
    home.opponentQualityScore != null &&
    away.opponentQualityScore != null;

  if (!hasGoodData) return "low";
  if (max >= 68) return "high";
  if (max >= 58) return "medium";
  return "low";
}

// ── Build BoxingIntel model notes ─────────────────────────────────────────────

export function buildBoxingModelNotes(output: BoxingModelOutput): string[] {
  const notes: string[] = [];
  notes.push(output.reachEdge);
  notes.push(output.ageEdge);
  if (output.stanceEdge !== "Stance matchup is neutral") notes.push(output.stanceEdge);
  if (output.activityEdge !== "Both fighters similarly active") notes.push(output.activityEdge);
  notes.push(output.styleEdge);
  notes.push(output.opponentQualityEdge);
  notes.push(output.koPctNote);
  const m = output.methodProbabilities;
  notes.push(
    `Method odds — KO/TKO: ${Math.round(m.ko_tko * 100)}% · Decision: ${Math.round(m.decision * 100)}% · Draw: ${Math.round(m.draw * 100)}%`,
  );
  if (output.overUnderRoundsPivot != null) {
    notes.push(`Model avg rounds: ~${output.overUnderRoundsPivot}`);
  }
  return notes;
}

// ── Apply model to a BoxingIntel object ───────────────────────────────────────

export function applyBoxingModel(
  intel: BoxingIntel,
  weights: BoxingFactorWeights = DEFAULT_BOXING_WEIGHTS,
): BoxingIntel {
  const { homeFighter, awayFighter } = intel;
  const modelOutput = scoreBoxingFight(homeFighter, awayFighter, weights);
  const modelNotes = buildBoxingModelNotes(modelOutput);
  return { ...intel, modelOutput, modelNotes };
}
