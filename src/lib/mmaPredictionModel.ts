/**
 * UFC/MMA prediction model — v1 (2026).
 *
 * Factor weights (sum = 1.00):
 *   opponent_quality     0.20
 *   style_matchup        0.18
 *   cardio_and_pace      0.12
 *   grappling_control    0.12
 *   durability           0.10
 *   physical             0.08
 *   activity_layoff      0.08
 *   defense_efficiency   0.07
 *   market_movement      0.05
 *
 * Fighters are stored in Supabase mma_fighters; fetched via mmaFetch.ts.
 * Weights are stored in mma_learning_history (strictly separate from boxing/NBA/NFL/MLB).
 *
 * Live checkpoint fires after Round 1 completes (first opportunity to observe
 * striking output, takedown attempts, cardio, and pace).
 */

import type { MmaFighterProfile, MmaIntel, MmaModelOutput } from "@/data/mockGames";

// ── Default factor weights (sum to 1.0) ───────────────────────────────────────

export interface MmaFactorWeights {
  opponentQuality: number;
  styleMatchup: number;
  cardioAndPace: number;
  grapplingControl: number;
  durability: number;
  physical: number;
  activityLayoff: number;
  defenseEfficiency: number;
  marketMovement: number;
  learned: boolean;
  sampleSize: number;
}

export const DEFAULT_MMA_WEIGHTS: MmaFactorWeights = {
  opponentQuality: 0.20,
  styleMatchup: 0.18,
  cardioAndPace: 0.12,
  grapplingControl: 0.12,
  durability: 0.10,
  physical: 0.08,
  activityLayoff: 0.08,
  defenseEfficiency: 0.07,
  marketMovement: 0.05,
  learned: false,
  sampleSize: 0,
};

// ── Style matchup matrix ──────────────────────────────────────────────────────
//
// Rows = home style, Columns = away style.
// Values: +0.xx = home advantage, -0.xx = away advantage.

const MMA_STYLE_MATRIX: Record<string, Record<string, number>> = {
  striker: {
    striker: 0,
    grappler: 0.06,        // striker neutralizes grappler if takedowns stuffed
    wrestler: 0.04,
    submission_specialist: 0.05,
    well_rounded: -0.02,
    pressure_fighter: -0.03,
  },
  grappler: {
    striker: -0.06,
    grappler: 0,
    wrestler: -0.02,
    submission_specialist: 0.04,
    well_rounded: -0.03,
    pressure_fighter: 0.02,
  },
  wrestler: {
    striker: -0.04,
    grappler: 0.02,
    wrestler: 0,
    submission_specialist: -0.05, // wrestlers are vulnerable to subs off their back
    well_rounded: -0.01,
    pressure_fighter: 0.04,
  },
  submission_specialist: {
    striker: -0.05,
    grappler: -0.04,
    wrestler: 0.05,
    submission_specialist: 0,
    well_rounded: -0.03,
    pressure_fighter: -0.02,
  },
  well_rounded: {
    striker: 0.02,
    grappler: 0.03,
    wrestler: 0.01,
    submission_specialist: 0.03,
    well_rounded: 0,
    pressure_fighter: -0.02,
  },
  pressure_fighter: {
    striker: 0.03,
    grappler: -0.02,
    wrestler: -0.04,
    submission_specialist: 0.02,
    well_rounded: 0.02,
    pressure_fighter: 0,
  },
};

// ── Factor scoring functions ──────────────────────────────────────────────────

function scoreStyleMatchup(home: MmaFighterProfile, away: MmaFighterProfile): number {
  if (!home.styleTag || !away.styleTag) return 0;
  return MMA_STYLE_MATRIX[home.styleTag]?.[away.styleTag] ?? 0;
}

function scoreOpponentQuality(home: MmaFighterProfile, away: MmaFighterProfile): number {
  const h = home.opponentQualityScore ?? 50;
  const a = away.opponentQualityScore ?? 50;
  return Math.max(-0.15, Math.min(0.15, ((h - a) / 100) * 0.3));
}

/**
 * Cardio and pace: late-round output, round-by-round decline.
 * Higher cardioRating = less decline = more reliable in rounds 3–5.
 */
function scoreCardioAndPace(home: MmaFighterProfile, away: MmaFighterProfile): number {
  const h = home.cardioRating ?? 5;
  const a = away.cardioRating ?? 5;
  // Secondary: striking volume (high volume = more likely to gas)
  const hSlpm = home.sigStrikesLandedPerMin ?? 4.0;
  const aSlpm = away.sigStrikesLandedPerMin ?? 4.0;
  const volumePenalty = (Math.max(0, hSlpm - 5.0) - Math.max(0, aSlpm - 5.0)) * 0.01;
  return Math.max(-0.12, Math.min(0.12, (h - a) / 10 * 0.12 - volumePenalty));
}

/**
 * Grappling control: takedown accuracy, takedown defense, control time, submission threat.
 */
function scoreGrapplingControl(home: MmaFighterProfile, away: MmaFighterProfile): number {
  // Takedown offense differential
  const hTdAcc  = home.takedownAccuracy  ?? 0.40;
  const hTdPer  = home.avgTakedownsPer15 ?? 1.5;
  const hCtrl   = home.controlTimePer15  ?? 60;
  const hSub    = home.avgSubAttemptsPer15 ?? 0.5;

  const aTdAcc  = away.takedownAccuracy  ?? 0.40;
  const aTdPer  = away.avgTakedownsPer15 ?? 1.5;
  const aCtrl   = away.controlTimePer15  ?? 60;
  const aSub    = away.avgSubAttemptsPer15 ?? 0.5;

  // Home's grappling offense vs away's grappling defense
  const homeTdThreat = hTdAcc * hTdPer * 0.015 + hCtrl / 1200 + hSub * 0.02;
  const awayTdThreat = aTdAcc * aTdPer * 0.015 + aCtrl / 1200 + aSub * 0.02;

  // Takedown defense component (defender's perspective)
  const homeTdDef = home.takedownDefense ?? 0.60;
  const awayTdDef = away.takedownDefense ?? 0.60;
  const defComponent = (homeTdDef - awayTdDef) * 0.06;

  const raw = homeTdThreat - awayTdThreat + defComponent;
  return Math.max(-0.12, Math.min(0.12, raw));
}

/**
 * Durability: KO penalty, knockdowns received history, significant strikes absorbed.
 * Higher koPenalty = less durable = negative factor.
 */
function scoreDurability(home: MmaFighterProfile, away: MmaFighterProfile): number {
  const hPenalty = home.koPenalty ?? 3;
  const aPenalty = away.koPenalty ?? 3;
  const hKd = home.knockdownsReceived ?? 0;
  const aKd = away.knockdownsReceived ?? 0;
  // More absorbed strikes = higher durability concern
  const hAbsorb = home.sigStrikesAbsorbedPerMin ?? 3.5;
  const aAbsorb = away.sigStrikesAbsorbedPerMin ?? 3.5;
  const durHome = -(hPenalty / 10) * 0.06 - (hKd * 0.004) - (Math.max(0, hAbsorb - 4.5) * 0.01);
  const durAway = -(aPenalty / 10) * 0.06 - (aKd * 0.004) - (Math.max(0, aAbsorb - 4.5) * 0.01);
  return Math.max(-0.12, Math.min(0.12, durHome - durAway));
}

/** Physical advantage: reach + height. */
function scorePhysical(home: MmaFighterProfile, away: MmaFighterProfile): number {
  let reach = 0;
  if (home.reach != null && away.reach != null) {
    reach = Math.max(-0.08, Math.min(0.08, (home.reach - away.reach) * 0.02));
  }
  let height = 0;
  if (home.height != null && away.height != null) {
    height = Math.max(-0.03, Math.min(0.03, (home.height - away.height) * 0.006));
  }
  return reach + height;
}

/** Activity and layoff penalty. Short-notice flag applies an additional penalty. */
function scoreActivityLayoff(home: MmaFighterProfile, away: MmaFighterProfile): number {
  function months(d: string | undefined): number | null {
    if (!d) return null;
    return (Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  }
  function penalty(m: number | null, shortNotice: boolean | undefined): number {
    let p = 0;
    if (m != null) {
      if (m < 4) p = 0;
      else if (m < 9) p = -0.02;
      else if (m < 14) p = -0.05;
      else if (m < 20) p = -0.09;
      else p = -0.13;
    }
    // Short notice: ~-0.05 additional (preparation deficit)
    if (shortNotice) p -= 0.05;
    return p;
  }
  return penalty(months(home.lastFightDate), home.shortNotice)
       - penalty(months(away.lastFightDate), away.shortNotice);
}

/**
 * Defense efficiency: striking defense + takedown defense combined.
 */
function scoreDefenseEfficiency(home: MmaFighterProfile, away: MmaFighterProfile): number {
  const hStr = home.strikeDefense ?? 0.55;
  const aStr = away.strikeDefense ?? 0.55;
  const hTd  = home.takedownDefense ?? 0.60;
  const aTd  = away.takedownDefense ?? 0.60;
  const composite = (hStr + hTd * 0.8) - (aStr + aTd * 0.8);
  return Math.max(-0.10, Math.min(0.10, composite * 0.28));
}

/** Market movement: line move toward or against fighter. */
function scoreMarketMovement(homeOpenImplied?: number, homeCurrentImplied?: number): number {
  if (homeOpenImplied == null || homeCurrentImplied == null) return 0;
  const movePp = homeCurrentImplied - homeOpenImplied;
  return Math.max(-0.08, Math.min(0.08, movePp * 0.4));
}

// ── Win probability ───────────────────────────────────────────────────────────

function deltaToProbability(delta: number): number {
  return 1 / (1 + Math.exp(-6 * delta));
}

// ── Method of victory ─────────────────────────────────────────────────────────

function estimateMethodProbabilities(
  home: MmaFighterProfile,
  away: MmaFighterProfile,
  winnerIsHome: boolean,
): { ko_tko: number; submission: number; decision: number } {
  const winner = winnerIsHome ? home : away;
  const loser  = winnerIsHome ? away : home;

  const winnerKo  = winner.koTkoPct ?? 0.30;
  const winnerSub = winner.subPct ?? 0.20;
  const loserPenalty = (loser.koPenalty ?? 3) / 10;

  const rawKo = winnerKo * (0.5 + loserPenalty * 0.5);
  const rawSub = winnerSub * (1 - (loser.takedownDefense ?? 0.60) * 0.5);
  const koProb  = Math.max(0.05, Math.min(0.65, rawKo));
  const subProb = Math.max(0.05, Math.min(0.40, rawSub));
  const decProb = Math.max(0.10, 1 - koProb - subProb);
  // Renormalize
  const sum = koProb + subProb + decProb;
  return {
    ko_tko:     Math.round((koProb / sum) * 100) / 100,
    submission: Math.round((subProb / sum) * 100) / 100,
    decision:   Math.round((decProb / sum) * 100) / 100,
  };
}

// ── Edge text generation ──────────────────────────────────────────────────────

function styleEdgeText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (!home.styleTag || !away.styleTag) return "Style data unavailable";
  if (Math.abs(score) < 0.01) return `${home.styleTag} vs ${away.styleTag} — even matchup`;
  const favored = score > 0 ? home.name : away.name;
  const fStyle  = score > 0 ? home.styleTag : away.styleTag;
  const aStyle  = score > 0 ? away.styleTag : home.styleTag;
  return `${fStyle} stylistically exploits ${aStyle} — ${favored} style edge`;
}

function opponentQualityText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Similar competition level";
  return `${score > 0 ? home.name : away.name} has faced consistently tougher opponents`;
}

function cardioText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Cardio and pace appear even";
  const better = score > 0 ? home.name : away.name;
  const worse  = score > 0 ? away.name : home.name;
  return `${better} shows superior late-round output — ${worse} may fade after round 2`;
}

function grapplingText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Grappling control is neutral";
  const better = score > 0 ? home.name : away.name;
  return `${better} grappling and control time edge — cage work and ground-and-pound advantage`;
}

function durabilityText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Durability appears even";
  const worse  = score > 0 ? away.name : home.name;
  const better = score > 0 ? home.name : away.name;
  return `${worse} KO/durability concern — ${better} chin and damage absorption edge`;
}

function physicalText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Physical measurements similar";
  const longer = score > 0 ? home.name : away.name;
  return `${longer} physical advantages (reach/height) extend range and striking lanes`;
}

function activityText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Both fighters similarly active";
  const rusty  = score < 0 ? home.name : away.name;
  const active = score < 0 ? away.name : home.name;
  const sn = score < 0 ? home.shortNotice : away.shortNotice;
  const snTag = sn ? " (short notice)" : "";
  return `${rusty}${snTag} ring rust or prep deficit — ${active} activity advantage`;
}

function defenseEffText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Defense efficiency is even";
  const better = score > 0 ? home.name : away.name;
  return `${better} superior defense (strike slipping + takedown stuffing)`;
}

function marketEdgeText(score: number): string {
  if (Math.abs(score) < 0.01) return "Market line stable — no material movement";
  return score > 0
    ? "Sharp money moving toward home fighter — market confirming model lean"
    : "Line movement against home fighter — market signal diverges from model";
}

// ── Risk flag ─────────────────────────────────────────────────────────────────

function buildRiskFlag(home: MmaFighterProfile, away: MmaFighterProfile): string | null {
  const flags: string[] = [];
  function mo(d: string | undefined): number | null {
    if (!d) return null;
    return (Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  }
  const hOut = mo(home.lastFightDate);
  const aOut = mo(away.lastFightDate);
  if (hOut != null && hOut > 16) flags.push(`${home.name} ${Math.round(hOut)}mo inactive`);
  if (aOut != null && aOut > 16) flags.push(`${away.name} ${Math.round(aOut)}mo inactive`);
  if (home.shortNotice) flags.push(`${home.name} short notice`);
  if (away.shortNotice) flags.push(`${away.name} short notice`);
  if (home.age != null && home.age > 36) flags.push(`${home.name} age ${home.age}`);
  if (away.age != null && away.age > 36) flags.push(`${away.name} age ${away.age}`);
  if (home.koPenalty != null && home.koPenalty >= 8)
    flags.push(`${home.name} KO durability risk`);
  if (away.koPenalty != null && away.koPenalty >= 8)
    flags.push(`${away.name} KO durability risk`);
  if ((home.weightClassMoves ?? 0) >= 2) flags.push(`${home.name} weight class instability`);
  if ((away.weightClassMoves ?? 0) >= 2) flags.push(`${away.name} weight class instability`);
  return flags.length ? flags.join(" · ") : null;
}

// ── Main model function ───────────────────────────────────────────────────────

export function scoreMmaFight(
  home: MmaFighterProfile,
  away: MmaFighterProfile,
  weights: MmaFactorWeights = DEFAULT_MMA_WEIGHTS,
  marketCtx?: { homeOpenImplied?: number; homeCurrentImplied?: number },
): MmaModelOutput {
  const qualityScore    = scoreOpponentQuality(home, away);
  const styleScore      = scoreStyleMatchup(home, away);
  const cardioScore     = scoreCardioAndPace(home, away);
  const grapplingScore  = scoreGrapplingControl(home, away);
  const durabilityScore = scoreDurability(home, away);
  const physicalScore   = scorePhysical(home, away);
  const activityScore   = scoreActivityLayoff(home, away);
  const defenseScore    = scoreDefenseEfficiency(home, away);
  const marketScore     = scoreMarketMovement(marketCtx?.homeOpenImplied, marketCtx?.homeCurrentImplied);

  const combinedDelta =
    qualityScore    * weights.opponentQuality +
    styleScore      * weights.styleMatchup +
    cardioScore     * weights.cardioAndPace +
    grapplingScore  * weights.grapplingControl +
    durabilityScore * weights.durability +
    physicalScore   * weights.physical +
    activityScore   * weights.activityLayoff +
    defenseScore    * weights.defenseEfficiency +
    marketScore     * weights.marketMovement;

  const riskFlag = buildRiskFlag(home, away);
  const methodProbs = estimateMethodProbabilities(home, away, combinedDelta >= 0);

  // Avg rounds estimate
  const scheduled = 3; // default regular bout; buildPrediction overrides from fight data
  const avgRounds = Math.max(1, Math.round(scheduled * (1 - (methodProbs.ko_tko + methodProbs.submission) * 0.55)));

  return {
    strikingEdge:        physicalText(home, away, physicalScore),
    grapplingEdge:       grapplingText(home, away, grapplingScore),
    cardioEdge:          cardioText(home, away, cardioScore),
    durabilityEdge:      durabilityText(home, away, durabilityScore),
    physicalEdge:        physicalText(home, away, physicalScore),
    opponentQualityEdge: opponentQualityText(home, away, qualityScore),
    activityEdge:        activityText(home, away, activityScore),
    marketEdge:          marketEdgeText(marketScore),
    methodProbabilities: methodProbs,
    overUnderRoundsPivot: avgRounds,
    riskFlag,
    _debug: {
      strikingScore:       physicalScore + defenseScore, // proxy
      grapplingScore,
      cardioScore,
      durabilityScore,
      physicalScore,
      opponentQualityScore: qualityScore,
      activityScore,
      marketScore,
      combinedDelta,
    },
  };
}

// ── Win probability ───────────────────────────────────────────────────────────

export function mmaWinProbability(
  home: MmaFighterProfile,
  away: MmaFighterProfile,
  weights: MmaFactorWeights = DEFAULT_MMA_WEIGHTS,
  marketCtx?: { homeOpenImplied?: number; homeCurrentImplied?: number },
): { home: number; away: number } {
  const output = scoreMmaFight(home, away, weights, marketCtx);
  const homeProb = Math.round(deltaToProbability(output._debug.combinedDelta) * 100);
  return { home: homeProb, away: 100 - homeProb };
}

// ── Confidence tier ───────────────────────────────────────────────────────────

export function mmaConfidence(
  home: MmaFighterProfile,
  away: MmaFighterProfile,
  winProb: { home: number; away: number },
): "high" | "medium" | "low" {
  const max = Math.max(winProb.home, winProb.away);
  const hasCore =
    home.opponentQualityScore != null &&
    away.opponentQualityScore != null &&
    (home.styleTag != null || home.koTkoPct != null) &&
    (away.styleTag != null || away.koTkoPct != null);
  if (!hasCore) return "low";
  if (max >= 68) return "high";
  if (max >= 58) return "medium";
  return "low";
}

// ── Parlay fit score ──────────────────────────────────────────────────────────

export function mmaParlayFitScore(params: {
  confidence: "high" | "medium" | "low";
  edge: number;
  volatilityScore: number;
  dataCompleteness: number;
  marketConfirmed: boolean;
}): number {
  if (params.confidence === "low") return 0;
  if (params.edge <= 0) return 0;
  if (params.volatilityScore >= 70) return 0;
  let score = 50;
  if (params.confidence === "high") score += 20;
  else score += 8;
  score += Math.min(20, Math.round(params.edge * 133));
  score -= Math.round(params.volatilityScore * 0.3);
  score += Math.round((params.dataCompleteness - 50) * 0.2);
  if (params.marketConfirmed) score += 10;
  return Math.max(0, Math.min(100, score));
}

// ── Model notes ───────────────────────────────────────────────────────────────

export function buildMmaModelNotes(output: MmaModelOutput): string[] {
  const notes: string[] = [];
  notes.push(output.opponentQualityEdge);
  notes.push(styleEdgeText(
    { name: "", styleTag: undefined } as unknown as MmaFighterProfile,
    { name: "", styleTag: undefined } as unknown as MmaFighterProfile,
    0,
  ));
  // Use the actual outputs directly
  notes.push(output.grapplingEdge);
  notes.push(output.cardioEdge);
  notes.push(output.durabilityEdge);
  notes.push(output.physicalEdge);
  if (output.activityEdge !== "Both fighters similarly active") notes.push(output.activityEdge);
  const m = output.methodProbabilities;
  notes.push(
    `Method — KO/TKO: ${Math.round(m.ko_tko * 100)}% · Sub: ${Math.round(m.submission * 100)}% · Decision: ${Math.round(m.decision * 100)}%`,
  );
  if (output.overUnderRoundsPivot != null) notes.push(`Model avg rounds: ~${output.overUnderRoundsPivot}`);
  return notes;
}

export function applyMmaModel(
  intel: MmaIntel,
  weights: MmaFactorWeights = DEFAULT_MMA_WEIGHTS,
  marketCtx?: { homeOpenImplied?: number; homeCurrentImplied?: number },
): MmaIntel {
  const { homeFighter, awayFighter } = intel;
  const modelOutput = scoreMmaFight(homeFighter, awayFighter, weights, marketCtx);
  // Override overUnderRoundsPivot with actual scheduled rounds context
  const avgRounds = Math.max(1, Math.round(
    intel.scheduledRounds * (1 - (modelOutput.methodProbabilities.ko_tko + modelOutput.methodProbabilities.submission) * 0.55)
  ));
  const finalOutput: MmaModelOutput = { ...modelOutput, overUnderRoundsPivot: avgRounds };

  const notes: string[] = [];
  notes.push(finalOutput.opponentQualityEdge);
  notes.push(finalOutput.grapplingEdge);
  notes.push(finalOutput.cardioEdge);
  notes.push(finalOutput.durabilityEdge);
  notes.push(finalOutput.physicalEdge);
  if (finalOutput.activityEdge !== "Both fighters similarly active") notes.push(finalOutput.activityEdge);
  const m = finalOutput.methodProbabilities;
  notes.push(
    `Method — KO/TKO: ${Math.round(m.ko_tko * 100)}% · Sub: ${Math.round(m.submission * 100)}% · Decision: ${Math.round(m.decision * 100)}%`,
  );
  if (finalOutput.overUnderRoundsPivot != null) notes.push(`Model avg rounds: ~${finalOutput.overUnderRoundsPivot}`);

  return { ...intel, modelOutput: finalOutput, modelNotes: notes };
}

// ── Live Round 1 checkpoint ───────────────────────────────────────────────────
//
// After Round 1 completes, recalculate with live signals.
// Used by predictionVersions.ts live_r1 trigger.

export function applyMmaLiveR1Adjustment(
  baseHomeProb: number,
  liveCtx: {
    homeStrikeSuccess: number;  // 0-1: fraction of strikes landed
    awayStrikeSuccess: number;
    homeTakedownSuccess: number;
    awayTakedownSuccess: number;
    homeControlTime: number;    // seconds in round 1
    awayControlTime: number;
    homePaceDropoff: boolean;   // visible cardio decline
    awayPaceDropoff: boolean;
    homeDamageTaken: "none" | "light" | "significant";
    awayDamageTaken: "none" | "light" | "significant";
  },
): number {
  let adj = 0;
  // Striking success differential
  adj += (liveCtx.homeStrikeSuccess - liveCtx.awayStrikeSuccess) * 6;
  // Takedown success
  adj += (liveCtx.homeTakedownSuccess - liveCtx.awayTakedownSuccess) * 5;
  // Control time (max 300s per round)
  adj += ((liveCtx.homeControlTime - liveCtx.awayControlTime) / 300) * 4;
  // Cardio
  if (liveCtx.homePaceDropoff && !liveCtx.awayPaceDropoff) adj -= 5;
  if (!liveCtx.homePaceDropoff && liveCtx.awayPaceDropoff) adj += 5;
  // Damage
  const damagePenalty = (d: "none" | "light" | "significant") =>
    d === "significant" ? -7 : d === "light" ? -2 : 0;
  adj += damagePenalty(liveCtx.awayDamageTaken) - damagePenalty(liveCtx.homeDamageTaken);
  // Blend: 70% base, 30% live signal
  const liveAdj = Math.max(-20, Math.min(20, adj));
  const blended = baseHomeProb * 0.70 + (baseHomeProb + liveAdj) * 0.30;
  return Math.max(5, Math.min(95, Math.round(blended)));
}
