/**
 * UFC/MMA prediction model — v2 (10-factor, 2026).
 *
 * Factor weights (sum = 1.00):
 *   style_matchup        0.20  ← primary discriminator for MMA
 *   opponent_quality     0.15
 *   striking_efficiency  0.12  ← slpm, sapm, accuracy, defense
 *   grappling_control    0.15  ← takedown %, defense, control, submissions
 *   cardio_pace          0.10
 *   durability           0.08  ← KO penalty, knockdowns, absorbed strikes
 *   physical_advantage   0.07  ← reach + height
 *   activity_layoff      0.06
 *   age_curve            0.04
 *   market_movement      0.03  ← supportive signal, not dominant
 *
 * Fighters are stored in Supabase mma_fighters; fetched via mmaFetch.ts.
 * Weights are stored in mma_learning_history (sport-isolated — never mixed
 * with boxing, NBA, NFL, MLB, or soccer learning tables).
 *
 * Live checkpoint fires after Round 1 completes (first opportunity to observe
 * striking output, takedown attempts, cardio, and pace). Blend: 70% pregame
 * + 30% live signals.
 */

import type { MmaFighterProfile, MmaIntel, MmaModelOutput } from "@/data/mockGames";
import { combatFighterWinProbAdj } from "@/lib/valueParlay/combatFighterFeatures";

// ── Default factor weights (sum to 1.0) ───────────────────────────────────────

export interface MmaFactorWeights {
  styleMatchup: number;
  opponentQuality: number;
  strikingEfficiency: number;
  grapplingControl: number;
  cardioAndPace: number;
  durability: number;
  physical: number;
  activityLayoff: number;
  ageCurve: number;
  marketMovement: number;
  learned: boolean;
  sampleSize: number;
}

export const DEFAULT_MMA_WEIGHTS: MmaFactorWeights = {
  styleMatchup: 0.20,
  opponentQuality: 0.15,
  strikingEfficiency: 0.12,
  grapplingControl: 0.15,
  cardioAndPace: 0.10,
  durability: 0.08,
  physical: 0.07,
  activityLayoff: 0.06,
  ageCurve: 0.04,
  marketMovement: 0.03,
  learned: false,
  sampleSize: 0,
};

// ── Style matchup matrix ──────────────────────────────────────────────────────
//
// Rows = home style, Columns = away style.
// Values: +0.xx = home advantage, -0.xx = away advantage.
// Reflects stylistic tendencies from historical UFC results.

const MMA_STYLE_MATRIX: Record<string, Record<string, number>> = {
  striker: {
    striker: 0,
    grappler: 0.07,        // striker exploits grappler on the feet if TDs stuffed
    wrestler: 0.05,        // striker uses footwork to stay away from shots
    submission_specialist: 0.06,  // striker avoids ground; sub-spec needs the takedown
    well_rounded: -0.02,
    pressure_fighter: -0.04,  // pressure cuts off the ring; bad for strikers who need space
  },
  grappler: {
    striker: -0.07,
    grappler: 0,
    wrestler: -0.02,
    submission_specialist: 0.05,  // pure grappler can counter sub-spec on the feet
    well_rounded: -0.03,
    pressure_fighter: 0.03,
  },
  wrestler: {
    striker: -0.05,
    grappler: 0.03,
    wrestler: 0,
    submission_specialist: -0.06, // wrestlers are exposed to rear-naked & triangle off their back
    well_rounded: -0.01,
    pressure_fighter: 0.05,       // wrestler controls pressure fighters in the clinch
  },
  submission_specialist: {
    striker: -0.06,
    grappler: -0.05,
    wrestler: 0.06,       // sub-spec thrives when wrestler brings them to the mat
    submission_specialist: 0,
    well_rounded: -0.04,
    pressure_fighter: -0.02,
  },
  well_rounded: {
    striker: 0.02,
    grappler: 0.03,
    wrestler: 0.01,
    submission_specialist: 0.04,
    well_rounded: 0,
    pressure_fighter: -0.02,
  },
  pressure_fighter: {
    striker: 0.04,         // smothers technical strikers
    grappler: -0.03,
    wrestler: -0.05,
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
 * Striking efficiency: significant strikes landed, absorbed, accuracy, and defense.
 * High slpm + high accuracy + low absorption = positive score.
 */
function scoreStrikingEfficiency(home: MmaFighterProfile, away: MmaFighterProfile): number {
  const hLand = home.sigStrikesLandedPerMin ?? 4.0;
  const aLand = away.sigStrikesLandedPerMin ?? 4.0;
  const hAbs  = home.sigStrikesAbsorbedPerMin ?? 3.5;
  const aAbs  = away.sigStrikesAbsorbedPerMin ?? 3.5;
  const hAcc  = home.strikeAccuracy ?? 0.43;
  const aAcc  = away.strikeAccuracy ?? 0.43;
  const hDef  = home.strikeDefense ?? 0.55;
  const aDef  = away.strikeDefense ?? 0.55;

  // Net striking output differential (volume × accuracy − absorbed)
  const homeNet = hLand * hAcc - hAbs * (1 - hDef);
  const awayNet = aLand * aAcc - aAbs * (1 - aDef);
  return Math.max(-0.12, Math.min(0.12, (homeNet - awayNet) * 0.06));
}

/**
 * Cardio and pace: late-round output, round-by-round decline.
 * Higher cardioRating = less decline = more reliable in rounds 3–5.
 */
function scoreCardioAndPace(home: MmaFighterProfile, away: MmaFighterProfile): number {
  const h = home.cardioRating ?? 5;
  const a = away.cardioRating ?? 5;
  // Secondary: very high volume fighters gas faster
  const hSlpm = home.sigStrikesLandedPerMin ?? 4.0;
  const aSlpm = away.sigStrikesLandedPerMin ?? 4.0;
  const volumePenalty = (Math.max(0, hSlpm - 5.5) - Math.max(0, aSlpm - 5.5)) * 0.01;
  return Math.max(-0.12, Math.min(0.12, (h - a) / 10 * 0.12 - volumePenalty));
}

/**
 * Grappling control: takedown accuracy, defense, control time, submission threat.
 */
function scoreGrapplingControl(home: MmaFighterProfile, away: MmaFighterProfile): number {
  const hTdAcc  = home.takedownAccuracy  ?? 0.40;
  const hTdPer  = home.avgTakedownsPer15 ?? 1.5;
  const hCtrl   = home.controlTimePer15  ?? 60;
  const hSub    = home.avgSubAttemptsPer15 ?? 0.5;

  const aTdAcc  = away.takedownAccuracy  ?? 0.40;
  const aTdPer  = away.avgTakedownsPer15 ?? 1.5;
  const aCtrl   = away.controlTimePer15  ?? 60;
  const aSub    = away.avgSubAttemptsPer15 ?? 0.5;

  const homeThreat = hTdAcc * hTdPer * 0.015 + hCtrl / 1200 + hSub * 0.02;
  const awayThreat = aTdAcc * aTdPer * 0.015 + aCtrl / 1200 + aSub * 0.02;

  // Takedown defense (who can stuff shots)
  const defComp = ((home.takedownDefense ?? 0.60) - (away.takedownDefense ?? 0.60)) * 0.06;

  return Math.max(-0.14, Math.min(0.14, homeThreat - awayThreat + defComp));
}

/**
 * Durability: KO penalty, knockdowns received, significant strikes absorbed trend.
 */
function scoreDurability(home: MmaFighterProfile, away: MmaFighterProfile): number {
  const hPen  = home.koPenalty ?? 3;
  const aPen  = away.koPenalty ?? 3;
  const hKd   = home.knockdownsReceived ?? 0;
  const aKd   = away.knockdownsReceived ?? 0;
  const hAbs  = home.sigStrikesAbsorbedPerMin ?? 3.5;
  const aAbs  = away.sigStrikesAbsorbedPerMin ?? 3.5;

  const durHome = -(hPen / 10) * 0.06 - hKd * 0.004 - Math.max(0, hAbs - 4.5) * 0.01;
  const durAway = -(aPen / 10) * 0.06 - aKd * 0.004 - Math.max(0, aAbs - 4.5) * 0.01;
  return Math.max(-0.12, Math.min(0.12, durHome - durAway));
}

/** Physical advantage: reach + height differential. */
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
      if (m < 4)       p = 0;
      else if (m < 9)  p = -0.02;
      else if (m < 14) p = -0.05;
      else if (m < 20) p = -0.09;
      else             p = -0.13;
    }
    if (shortNotice) p -= 0.05;
    return p;
  }
  return penalty(months(home.lastFightDate), home.shortNotice)
       - penalty(months(away.lastFightDate), away.shortNotice);
}

/**
 * Age curve: UFC fighters peak ~26–31, decline accelerates after 35.
 * Returns differential (home minus away).
 */
function scoreAgeCurve(home: MmaFighterProfile, away: MmaFighterProfile): number {
  function curve(age: number): number {
    if (age < 22) return -0.06;
    if (age <= 27) return 0.05;
    if (age <= 31) return 0.03;
    if (age <= 34) return 0;
    if (age <= 37) return -0.07;
    return -0.13;
  }
  const h = home.age != null ? curve(home.age) : 0;
  const a = away.age != null ? curve(away.age) : 0;
  return h - a;
}

/** Market movement: opening vs current implied probability. */
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

  const rawKo  = winnerKo * (0.5 + loserPenalty * 0.5);
  const rawSub = winnerSub * (1 - (loser.takedownDefense ?? 0.60) * 0.5);
  const koProb  = Math.max(0.05, Math.min(0.65, rawKo));
  const subProb = Math.max(0.05, Math.min(0.40, rawSub));
  const decProb = Math.max(0.10, 1 - koProb - subProb);
  const sum = koProb + subProb + decProb;
  return {
    ko_tko:     Math.round((koProb / sum) * 100) / 100,
    submission: Math.round((subProb / sum) * 100) / 100,
    decision:   Math.round((decProb / sum) * 100) / 100,
  };
}

/**
 * Goes-the-distance probability (0.0–1.0).
 * High when both fighters are durable + decision-pct history + championship rounds.
 */
function estimateGoesDistanceProb(
  home: MmaFighterProfile,
  away: MmaFighterProfile,
  scheduledRounds: number,
  methodProbs: { ko_tko: number; submission: number; decision: number },
): number {
  // Base from method probabilities — decision = goes distance
  let base = methodProbs.decision;

  // Durability bonus: low KO penalty on both sides increases GTD
  const homeDur = 1 - (home.koPenalty ?? 3) / 10;
  const awayDur = 1 - (away.koPenalty ?? 3) / 10;
  base += (homeDur + awayDur - 1.2) * 0.08;

  // Championship rounds (5R fights have more time to go the distance)
  if (scheduledRounds >= 5) base += 0.05;

  // Decision history bonus
  const homeDecPct = home.decisionPct ?? 0.40;
  const awayDecPct = away.decisionPct ?? 0.40;
  base += ((homeDecPct + awayDecPct) / 2 - 0.40) * 0.12;

  return Math.max(0.10, Math.min(0.90, Math.round(base * 100) / 100));
}

// ── Edge text generation ──────────────────────────────────────────────────────

function styleEdgeText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (!home.styleTag || !away.styleTag) return "Style data unavailable";
  if (Math.abs(score) < 0.01) return `${home.styleTag} vs ${away.styleTag} — even matchup`;
  const favored = score > 0 ? home.name : away.name;
  const fStyle  = score > 0 ? home.styleTag : away.styleTag;
  const aStyle  = score > 0 ? away.styleTag : home.styleTag;
  // Specialist descriptions
  const matchupNote: Partial<Record<string, string>> = {
    "striker_vs_grappler": "striker neutralizes grappler on the feet if takedowns stuffed",
    "wrestler_vs_submission_specialist": "wrestler feeds the sub-specialist; guard work is critical",
    "pressure_fighter_vs_striker": "pressure smothers technical boxing; range eliminated",
    "grappler_vs_striker": "grappler must close distance against striker",
  };
  const key = `${fStyle.replace(" ", "_")}_vs_${aStyle.replace(" ", "_")}`;
  const note = matchupNote[key] ?? `${fStyle} stylistically exploits ${aStyle}`;
  return `${favored} style edge — ${note}`;
}

function strikingEfficiencyText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  const hLand = home.sigStrikesLandedPerMin;
  const aLand = away.sigStrikesLandedPerMin;
  if (Math.abs(score) < 0.01) return "Striking efficiency is even";
  const better = score > 0 ? home.name : away.name;
  const worse  = score > 0 ? away.name : home.name;
  if (hLand != null && aLand != null) {
    const betterLand = score > 0 ? hLand : aLand;
    const worseLand  = score > 0 ? aLand : hLand;
    return `${better} lands ${betterLand.toFixed(1)} sig/min vs ${worseLand.toFixed(1)} for ${worse} — striking volume and accuracy edge`;
  }
  return `${better} striking efficiency advantage — higher output with better defense`;
}

function opponentQualityText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Similar competition level";
  const better = score > 0 ? home.name : away.name;
  const worse  = score > 0 ? away.name : home.name;
  return `${better} has faced consistently tougher opponents — ${worse} schedule may be padded`;
}

function grapplingText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Grappling control is neutral";
  const better = score > 0 ? home.name : away.name;
  const hTdAcc = home.takedownAccuracy;
  const aTdAcc = away.takedownAccuracy;
  const betterAcc = score > 0 ? hTdAcc : aTdAcc;
  if (betterAcc != null) {
    return `${better} grappling edge — ${Math.round(betterAcc * 100)}% TD accuracy and control time advantage`;
  }
  return `${better} grappling control and cage work edge`;
}

function cardioText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Cardio and pace appear even";
  const better = score > 0 ? home.name : away.name;
  const worse  = score > 0 ? away.name : home.name;
  return `${better} superior late-round output — ${worse} pace may drop after round 2`;
}

function durabilityText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Durability appears even";
  const worse  = score > 0 ? away.name : home.name;
  const better = score > 0 ? home.name : away.name;
  const worseF = score > 0 ? away : home;
  const pen = worseF.koPenalty;
  if (pen != null && pen >= 7) {
    return `${worse} severe KO durability risk (penalty ${pen}/10) — ${better} chin and damage absorption edge`;
  }
  return `${worse} KO/durability concern — ${better} chin and damage absorption edge`;
}

function physicalText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Physical measurements similar";
  const longer = score > 0 ? home.name : away.name;
  if (home.reach != null && away.reach != null) {
    const d = Math.abs(home.reach - away.reach);
    if (d >= 2) return `${longer} ${d.toFixed(1)}" reach advantage — extends range and striking lanes`;
  }
  return `${longer} physical advantages (reach/height) extend range`;
}

function activityText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Both fighters similarly active";
  const rusty  = score < 0 ? home.name : away.name;
  const active = score < 0 ? away.name : home.name;
  const rustyF = score < 0 ? home : away;
  const sn = rustyF.shortNotice;
  if (sn) return `${rusty} short-notice prep deficit — ${active} full camp advantage`;
  return `${rusty} ring rust concern — ${active} recency advantage`;
}

function ageCurveText(home: MmaFighterProfile, away: MmaFighterProfile, score: number): string {
  if (home.age == null && away.age == null) return "Age data unavailable";
  if (Math.abs(score) < 0.02) return "Both fighters in similar age window";
  const favored = score > 0 ? home.name : away.name;
  const other   = score > 0 ? away : home;
  if (other.age != null && other.age > 36) {
    return `${other.name} (${other.age}) past UFC prime — decline risk accelerates after 36`;
  }
  if (other.age != null && other.age < 23) {
    return `${other.name} (${other.age}) still developing — ${favored} experience edge`;
  }
  return `${favored} in better age window`;
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
  if (home.age != null && home.age > 36) flags.push(`${home.name} age ${home.age} decline risk`);
  if (away.age != null && away.age > 36) flags.push(`${away.name} age ${away.age} decline risk`);
  if (home.koPenalty != null && home.koPenalty >= 8) flags.push(`${home.name} KO durability risk`);
  if (away.koPenalty != null && away.koPenalty >= 8) flags.push(`${away.name} KO durability risk`);
  if ((home.weightClassMoves ?? 0) >= 2) flags.push(`${home.name} weight class instability`);
  if ((away.weightClassMoves ?? 0) >= 2) flags.push(`${away.name} weight class instability`);
  return flags.length ? flags.join(" · ") : null;
}

// ── Main model function ───────────────────────────────────────────────────────

export function scoreMmaFight(
  home: MmaFighterProfile,
  away: MmaFighterProfile,
  weights: MmaFactorWeights = DEFAULT_MMA_WEIGHTS,
  scheduledRounds = 3,
  marketCtx?: { homeOpenImplied?: number; homeCurrentImplied?: number },
): MmaModelOutput {
  const styleScore      = scoreStyleMatchup(home, away);
  const qualityScore    = scoreOpponentQuality(home, away);
  const strikingScore   = scoreStrikingEfficiency(home, away);
  const grapplingScore  = scoreGrapplingControl(home, away);
  const cardioScore     = scoreCardioAndPace(home, away);
  const durabilityScore = scoreDurability(home, away);
  const physicalScore   = scorePhysical(home, away);
  const activityScore   = scoreActivityLayoff(home, away);
  const ageCurveScore   = scoreAgeCurve(home, away);
  const marketScore     = scoreMarketMovement(marketCtx?.homeOpenImplied, marketCtx?.homeCurrentImplied);

  const combinedDelta =
    styleScore      * weights.styleMatchup +
    qualityScore    * weights.opponentQuality +
    strikingScore   * weights.strikingEfficiency +
    grapplingScore  * weights.grapplingControl +
    cardioScore     * weights.cardioAndPace +
    durabilityScore * weights.durability +
    physicalScore   * weights.physical +
    activityScore   * weights.activityLayoff +
    ageCurveScore   * weights.ageCurve +
    marketScore     * weights.marketMovement;

  const riskFlag = buildRiskFlag(home, away);
  const methodProbs = estimateMethodProbabilities(home, away, combinedDelta >= 0);
  const goesDistanceProb = estimateGoesDistanceProb(home, away, scheduledRounds, methodProbs);
  const avgRounds = Math.max(1, Math.round(
    scheduledRounds * (1 - (methodProbs.ko_tko + methodProbs.submission) * 0.55)
  ));

  return {
    styleMatchupEdge:        styleEdgeText(home, away, styleScore),
    opponentQualityEdge:     opponentQualityText(home, away, qualityScore),
    strikingEfficiencyEdge:  strikingEfficiencyText(home, away, strikingScore),
    grapplingEdge:           grapplingText(home, away, grapplingScore),
    cardioEdge:              cardioText(home, away, cardioScore),
    durabilityEdge:          durabilityText(home, away, durabilityScore),
    physicalEdge:            physicalText(home, away, physicalScore),
    activityEdge:            activityText(home, away, activityScore),
    ageCurveEdge:            ageCurveText(home, away, ageCurveScore),
    marketEdge:              marketEdgeText(marketScore),
    methodProbabilities:     methodProbs,
    overUnderRoundsPivot:    avgRounds,
    goesDistanceProb,
    riskFlag,
    _debug: {
      styleScore,
      strikingScore,
      grapplingScore,
      cardioScore,
      durabilityScore,
      physicalScore,
      opponentQualityScore: qualityScore,
      activityScore,
      ageCurveScore,
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
  scheduledRounds = 3,
  marketCtx?: { homeOpenImplied?: number; homeCurrentImplied?: number },
): { home: number; away: number } {
  const output = scoreMmaFight(home, away, weights, scheduledRounds, marketCtx);
  const baseHome = deltaToProbability(output._debug.combinedDelta);
  // Layoff + SOS adjustment. Runs on any fighter profile that carries
  // recentBouts / daysSinceLastFight / recentSosAvg — silently no-ops
  // when the feed hasn't populated them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const h = home as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = away as any;
  const homeAdj = combatFighterWinProbAdj(
    { recentBouts: h.recentBouts, daysSinceLastFight: h.daysSinceLastFight, recentSosAvg: h.recentSosAvg },
    { recentBouts: a.recentBouts, daysSinceLastFight: a.daysSinceLastFight, recentSosAvg: a.recentSosAvg },
  );
  const adjustedHome = Math.min(0.95, Math.max(0.05, baseHome + homeAdj));
  const homeProb = Math.round(adjustedHome * 100);
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

// ── Parlay fit score (spec formula) ──────────────────────────────────────────
//
// mma_parlay_fit_score =
//   (edge * 0.35) + (confidence_score * 0.25) + (low_volatility_score * 0.15) +
//   (data_completeness_score * 0.10) + (style_stability_score * 0.10) +
//   (market_confirmation_score * 0.05)

export function mmaParlayFitScore(params: {
  confidence: "high" | "medium" | "low";
  edge: number;               // model_prob - implied_prob (−1 to +1 scale)
  volatilityScore: number;    // 0–100
  dataCompleteness: number;   // 0–100
  styleStability: number;     // 0–100: 100 = both fighters have style tags + history
  marketConfirmed: boolean;
}): number {
  if (params.confidence === "low") return 0;
  if (params.edge <= 0) return 0;
  if (params.volatilityScore >= 70) return 0;

  // Each component scaled to 0–100 range before applying weights
  const edgeComponent         = Math.min(100, params.edge * 500);           // 0.20 edge → 100
  const confScore             = params.confidence === "high" ? 90 : 55;
  const lowVolatilityScore    = Math.max(0, 100 - params.volatilityScore);
  const dataScore             = params.dataCompleteness;
  const styleScore            = params.styleStability;
  const marketScore           = params.marketConfirmed ? 100 : 0;

  const raw =
    edgeComponent      * 0.35 +
    confScore          * 0.25 +
    lowVolatilityScore * 0.15 +
    dataScore          * 0.10 +
    styleScore         * 0.10 +
    marketScore        * 0.05;

  return Math.max(0, Math.min(100, Math.round(raw)));
}

// ── Apply model to MmaIntel ───────────────────────────────────────────────────

export function applyMmaModel(
  intel: MmaIntel,
  weights: MmaFactorWeights = DEFAULT_MMA_WEIGHTS,
  marketCtx?: { homeOpenImplied?: number; homeCurrentImplied?: number },
): MmaIntel {
  const { homeFighter, awayFighter, scheduledRounds } = intel;
  const modelOutput = scoreMmaFight(homeFighter, awayFighter, weights, scheduledRounds, marketCtx);

  const notes: string[] = [];
  notes.push(modelOutput.styleMatchupEdge);
  notes.push(modelOutput.opponentQualityEdge);
  notes.push(modelOutput.grapplingEdge);
  notes.push(modelOutput.cardioEdge);
  notes.push(modelOutput.durabilityEdge);
  notes.push(modelOutput.strikingEfficiencyEdge);
  if (modelOutput.activityEdge !== "Both fighters similarly active") notes.push(modelOutput.activityEdge);
  const m = modelOutput.methodProbabilities;
  notes.push(
    `Method — KO/TKO: ${Math.round(m.ko_tko * 100)}% · Sub: ${Math.round(m.submission * 100)}% · Decision: ${Math.round(m.decision * 100)}%`
  );
  notes.push(`Goes distance: ${Math.round(modelOutput.goesDistanceProb * 100)}%`);
  if (modelOutput.overUnderRoundsPivot != null) {
    notes.push(`Model avg rounds: ~${modelOutput.overUnderRoundsPivot} of ${scheduledRounds}`);
  }

  return { ...intel, modelOutput, modelNotes: notes };
}

// ── Live Round 1 checkpoint ───────────────────────────────────────────────────
//
// After Round 1 completes, recalculate with live signals.
// Used by predictionVersions.ts live_r1 trigger.
// Blend: 70% pregame + 30% live signals (preserves pregame snapshot).

export function applyMmaLiveR1Adjustment(
  baseHomeProb: number,
  liveCtx: {
    homeStrikeSuccess: number;   // 0–1: fraction of significant strikes landed
    awayStrikeSuccess: number;
    homeTakedownSuccess: number; // 0–1
    awayTakedownSuccess: number;
    homeControlTime: number;     // seconds in round 1 (0–300)
    awayControlTime: number;
    homePaceDropoff: boolean;    // visible cardio decline in R1
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
  // Control time (max ~300s per round)
  adj += ((liveCtx.homeControlTime - liveCtx.awayControlTime) / 300) * 4;
  // Cardio drop visible in R1
  if (liveCtx.homePaceDropoff && !liveCtx.awayPaceDropoff) adj -= 5;
  if (!liveCtx.homePaceDropoff && liveCtx.awayPaceDropoff) adj += 5;
  // Damage asymmetry
  const damagePenalty = (d: "none" | "light" | "significant") =>
    d === "significant" ? -7 : d === "light" ? -2 : 0;
  adj += damagePenalty(liveCtx.awayDamageTaken) - damagePenalty(liveCtx.homeDamageTaken);

  const liveAdj = Math.max(-20, Math.min(20, adj));
  const blended = baseHomeProb * 0.70 + (baseHomeProb + liveAdj) * 0.30;
  return Math.max(5, Math.min(95, Math.round(blended)));
}
