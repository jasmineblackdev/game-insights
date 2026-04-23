/**
 * Boxing prediction model — v2 (9-factor, 2026).
 *
 * Factor weights (sum = 1.00):
 *   opponent_quality         0.20
 *   style_matchup            0.18
 *   recent_form              0.12
 *   ko_power_vs_durability   0.12
 *   reach_height             0.10
 *   activity_inactivity      0.08
 *   age_curve                0.08
 *   defense_efficiency       0.07
 *   market_movement          0.05
 *
 * Fighters are stored in Supabase boxing_fighters; fetched via boxingFetch.ts.
 * Weights are stored in boxing_learning_history (per-sport, never mixed with other sports).
 */

import type { BoxingFighterProfile, BoxingIntel, BoxingModelOutput } from "@/data/mockGames";
import { combatFighterWinProbAdj } from "@/lib/valueParlay/combatFighterFeatures";

// ── Default factor weights (sum to 1.0) ───────────────────────────────────────

export interface BoxingFactorWeights {
  opponentQuality: number;
  styleMatchup: number;
  recentForm: number;
  koPowerVsDurability: number;
  reachHeight: number;
  activityInactivity: number;
  ageCurve: number;
  defenseEfficiency: number;
  marketMovement: number;
  learned: boolean;
  sampleSize: number;
}

export const DEFAULT_BOXING_WEIGHTS: BoxingFactorWeights = {
  opponentQuality: 0.20,
  styleMatchup: 0.18,
  recentForm: 0.12,
  koPowerVsDurability: 0.12,
  reachHeight: 0.10,
  activityInactivity: 0.08,
  ageCurve: 0.08,
  defenseEfficiency: 0.07,
  marketMovement: 0.05,
  learned: false,
  sampleSize: 0,
};

// ── Factor scoring functions ──────────────────────────────────────────────────

/** Reach + height combined advantage. */
function scoreReachHeight(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  let reach = 0;
  if (home.reach != null && away.reach != null) {
    const delta = home.reach - away.reach;
    reach = Math.max(-0.10, Math.min(0.10, delta * 0.02));
  }
  let height = 0;
  if (home.height != null && away.height != null) {
    const delta = home.height - away.height;
    height = Math.max(-0.04, Math.min(0.04, delta * 0.008));
  }
  return Math.max(-0.12, Math.min(0.12, reach + height));
}

/**
 * Age curve: fighters peak ~26–32, decline sharply after 35.
 * Returns differential (home minus away).
 */
function scoreAgeCurve(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  function curve(age: number): number {
    if (age < 22) return -0.05;
    if (age <= 28) return 0.07;
    if (age <= 32) return 0.04;
    if (age <= 35) return 0;
    if (age <= 38) return -0.08;
    return -0.14;
  }
  const h = home.age != null ? curve(home.age) : 0;
  const a = away.age != null ? curve(away.age) : 0;
  return h - a;
}

/** Stance matchup: southpaw advantage vs orthodox. */
function scoreStance(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  if (!home.stance || !away.stance) return 0;
  if (home.stance === "southpaw" && away.stance !== "southpaw") return 0.06;
  if (away.stance === "southpaw" && home.stance !== "southpaw") return -0.06;
  if (home.stance === "southpaw" && away.stance === "southpaw") {
    return (home.wins ?? 0) > (away.wins ?? 0) ? 0.02 : -0.02;
  }
  return 0;
}

/** Inactivity (ring rust) penalty. */
function scoreActivityInactivity(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  function months(d: string | undefined): number | null {
    if (!d) return null;
    return (Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  }
  function penalty(m: number | null): number {
    if (m == null) return 0;
    if (m < 6) return 0;
    if (m < 12) return -0.03;
    if (m < 18) return -0.07;
    if (m < 24) return -0.11;
    return -0.14;
  }
  return penalty(months(home.lastFightDate)) - penalty(months(away.lastFightDate));
}

/** Opponent quality (schedule strength). */
function scoreOpponentQuality(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  const h = home.opponentQualityScore ?? 50;
  const a = away.opponentQualityScore ?? 50;
  return Math.max(-0.15, Math.min(0.15, ((h - a) / 100) * 0.3));
}

/** Style compatibility matrix. */
function scoreStyleMatchup(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  const MATRIX: Record<string, Record<string, number>> = {
    pressure_fighter: { counterpuncher: 0.08, boxer_puncher: -0.03, brawler: 0.03, pressure_fighter: 0 },
    counterpuncher:   { pressure_fighter: -0.08, boxer_puncher: 0.04, brawler: -0.04, counterpuncher: 0 },
    boxer_puncher:    { pressure_fighter: 0.03, counterpuncher: -0.04, brawler: 0.06, boxer_puncher: 0 },
    brawler:          { pressure_fighter: -0.03, counterpuncher: 0.04, boxer_puncher: -0.06, brawler: 0 },
  };
  return MATRIX[home.styleTag ?? ""]?.[away.styleTag ?? ""] ?? 0;
}

/**
 * KO power vs durability — merged single factor.
 * High KO% attacker vs poor chin = significant edge.
 */
function scoreKoPowerVsDurability(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  const homeKo = home.koPct ?? 0.40;
  const awayChin = away.chinScore ?? 5;
  const awayKo = away.koPct ?? 0.40;
  const homeChin = home.chinScore ?? 5;
  const homeAttack = homeKo * (1 - awayChin / 10);
  const awayAttack = awayKo * (1 - homeChin / 10);
  // Chin standalone component
  const chinDiff = (homeChin - awayChin) / 10 * 0.4;
  return Math.max(-0.14, Math.min(0.14, (homeAttack - awayAttack) * 0.6 + chinDiff));
}

/**
 * Recent form: wins in last 5 fights, weighted by recency.
 * Returns differential favoring better recent record.
 */
function scoreRecentForm(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  function formScore(f: BoxingFighterProfile): number {
    const rw = f.recentWins ?? null;
    const rf = f.recentFights ?? 5;
    if (rw == null) {
      // Fallback: use overall win pct with modest weight
      const total = (f.wins ?? 0) + (f.losses ?? 0);
      if (total === 0) return 0;
      const pct = (f.wins ?? 0) / total;
      return (pct - 0.5) * 0.04;
    }
    const pct = rw / Math.max(1, rf);
    if (pct >= 0.8) return 0.07;
    if (pct >= 0.6) return 0.03;
    if (pct >= 0.4) return -0.02;
    return -0.08;
  }
  return Math.max(-0.12, Math.min(0.12, formScore(home) - formScore(away)));
}

/**
 * Defense efficiency: punch defense percentage.
 * Higher defense% = harder to hit = better platform to execute game plan.
 */
function scoreDefenseEfficiency(home: BoxingFighterProfile, away: BoxingFighterProfile): number {
  const hd = home.strikesDefensePct;
  const ad = away.strikesDefensePct;
  if (hd == null && ad == null) return 0;
  const h = hd ?? 0.60; // 60% average
  const a = ad ?? 0.60;
  return Math.max(-0.10, Math.min(0.10, (h - a) * 0.5));
}

/**
 * Market movement confirmation: opening vs current implied probability.
 * Money moving toward a fighter is a mild confirming signal.
 * Score range: [-0.08, +0.08]; 0 when no movement data.
 */
function scoreMarketMovement(homeOpenImplied?: number, homeCurrentImplied?: number): number {
  if (homeOpenImplied == null || homeCurrentImplied == null) return 0;
  const movePp = homeCurrentImplied - homeOpenImplied; // + = money on home
  return Math.max(-0.08, Math.min(0.08, movePp * 0.4));
}

// ── Win probability calculation ───────────────────────────────────────────────

function deltaToProbability(delta: number): number {
  const k = 6;
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
  const winnerKo = winner.koPct ?? 0.40;
  const loserChin = loser.chinScore ?? 5;
  const loserDecision = loser.decisionPct ?? 0.50;
  const rawKo = winnerKo * (1 - loserChin / 10) * (1 - loserDecision * 0.3);
  const koProb = Math.max(0.10, Math.min(0.75, rawKo));
  const drawProb = 0.04;
  const decisionProb = 1 - koProb - drawProb;
  return {
    ko_tko: Math.round(koProb * 100) / 100,
    decision: Math.round(decisionProb * 100) / 100,
    draw: drawProb,
  };
}

// ── Edge text generation ──────────────────────────────────────────────────────

function reachHeightEdgeText(home: BoxingFighterProfile, away: BoxingFighterProfile, score: number): string {
  if (home.reach == null && home.height == null) return "Physical measurements unavailable";
  const parts: string[] = [];
  if (home.reach != null && away.reach != null) {
    const d = home.reach - away.reach;
    if (Math.abs(d) >= 1) parts.push(`${Math.abs(d).toFixed(1)}" reach ${d > 0 ? "advantage" : "disadvantage"} for ${d > 0 ? home.name : away.name}`);
  }
  if (home.height != null && away.height != null) {
    const d = home.height - away.height;
    if (Math.abs(d) >= 1) parts.push(`${Math.abs(d)}" height ${d > 0 ? "edge" : "disadvantage"}`);
  }
  if (!parts.length) return "Nearly identical physical measurements";
  const label = Math.abs(score) > 0.07 ? "significant physical edge" : "physical edge";
  return `${parts.join("; ")} — ${label}`;
}

function ageCurveEdgeText(home: BoxingFighterProfile, away: BoxingFighterProfile, score: number): string {
  if (home.age == null && away.age == null) return "Age data unavailable";
  if (Math.abs(score) < 0.02) return "Both fighters in similar age window";
  const favored = score > 0 ? home.name : away.name;
  const other = score > 0 ? away : home;
  if (other.age != null && other.age > 35) return `${other.name} (${other.age}) past prime — ${favored} age advantage`;
  if (other.age != null && other.age < 24) return `${other.name} (${other.age}) still developing — ${favored} experience edge`;
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

function opponentQualityEdgeText(home: BoxingFighterProfile, away: BoxingFighterProfile, score: number): string {
  if (Math.abs(score) < 0.02) return "Similar opposition quality";
  const better = score > 0 ? home.name : away.name;
  return `${better} tested against higher-caliber opponents`;
}

function recentFormEdgeText(home: BoxingFighterProfile, away: BoxingFighterProfile, score: number): string {
  if (Math.abs(score) < 0.01) return "Both fighters in similar recent form";
  const better = score > 0 ? home.name : away.name;
  const worse = score > 0 ? away.name : home.name;
  const betterF = score > 0 ? home : away;
  const rw = betterF.recentWins;
  const rf = betterF.recentFights ?? 5;
  if (rw != null) return `${better} ${rw}/${rf} in recent fights — better form than ${worse}`;
  return `${better} stronger recent form`;
}

function defenseEdgeText(home: BoxingFighterProfile, away: BoxingFighterProfile, score: number): string {
  if (home.strikesDefensePct == null && away.strikesDefensePct == null) return "Defense stats unavailable";
  if (Math.abs(score) < 0.02) return "Defense efficiency is even";
  const better = score > 0 ? home.name : away.name;
  const pct = score > 0 ? home.strikesDefensePct : away.strikesDefensePct;
  return `${better} ${pct != null ? Math.round(pct * 100) + "% " : ""}punch defense — harder platform to hit`;
}

function koPctText(home: BoxingFighterProfile, away: BoxingFighterProfile): string {
  const h = home.koPct != null ? `${Math.round(home.koPct * 100)}%` : "?";
  const a = away.koPct != null ? `${Math.round(away.koPct * 100)}%` : "?";
  return `KO rates — ${home.name}: ${h} / ${away.name}: ${a}`;
}

// ── Main model function ───────────────────────────────────────────────────────

export function scoreBoxingFight(
  home: BoxingFighterProfile,
  away: BoxingFighterProfile,
  weights: BoxingFactorWeights = DEFAULT_BOXING_WEIGHTS,
  marketCtx?: { homeOpenImplied?: number; homeCurrentImplied?: number },
): BoxingModelOutput {
  const reachScore      = scoreReachHeight(home, away);
  const ageScore        = scoreAgeCurve(home, away);
  const stanceScore     = scoreStance(home, away);
  const activityScore   = scoreActivityInactivity(home, away);
  const qualityScore    = scoreOpponentQuality(home, away);
  const styleScore      = scoreStyleMatchup(home, away);
  const koScore         = scoreKoPowerVsDurability(home, away);
  const formScore       = scoreRecentForm(home, away);
  const defenseScore    = scoreDefenseEfficiency(home, away);
  const marketScore     = scoreMarketMovement(marketCtx?.homeOpenImplied, marketCtx?.homeCurrentImplied);

  const combinedDelta =
    qualityScore  * weights.opponentQuality +
    styleScore    * weights.styleMatchup +
    formScore     * weights.recentForm +
    koScore       * weights.koPowerVsDurability +
    reachScore    * weights.reachHeight +
    activityScore * weights.activityInactivity +
    ageScore      * weights.ageCurve +
    defenseScore  * weights.defenseEfficiency +
    marketScore   * weights.marketMovement;

  const riskFlag = buildRiskFlag(home, away);
  const methodProbs = estimateMethodProbabilities(home, away, combinedDelta >= 0);
  const avgRounds = Math.round(12 * (1 - methodProbs.ko_tko * 0.6));

  return {
    reachEdge:            reachHeightEdgeText(home, away, reachScore),
    ageEdge:              ageCurveEdgeText(home, away, ageScore),
    stanceEdge:           stanceEdgeText(home, away, stanceScore),
    activityEdge:         activityEdgeText(home, away, activityScore),
    styleEdge:            styleEdgeText(home, away, styleScore),
    opponentQualityEdge:  opponentQualityEdgeText(home, away, qualityScore),
    recentFormEdge:       recentFormEdgeText(home, away, formScore),
    defenseEdge:          defenseEdgeText(home, away, defenseScore),
    koPctNote:            koPctText(home, away),
    methodProbabilities:  methodProbs,
    overUnderRoundsPivot: avgRounds,
    riskFlag,
    _debug: {
      reachDelta:      home.reach != null && away.reach != null ? home.reach - away.reach : null,
      ageDelta:        home.age != null && away.age != null ? home.age - away.age : null,
      stanceAdvantage: stanceScore,
      inactivityPenalty: activityScore,
      styleMatchup:    styleScore,
      opponentQuality: qualityScore,
      combinedDelta,
    },
  };
}

// ── Risk flag ─────────────────────────────────────────────────────────────────

function buildRiskFlag(home: BoxingFighterProfile, away: BoxingFighterProfile): string | null {
  const flags: string[] = [];
  function mo(d: string | undefined): number | null {
    if (!d) return null;
    return (Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  }
  const hOut = mo(home.lastFightDate);
  const aOut = mo(away.lastFightDate);
  if (hOut != null && hOut > 18) flags.push(`${home.name} ${Math.round(hOut)}mo layoff`);
  if (aOut != null && aOut > 18) flags.push(`${away.name} ${Math.round(aOut)}mo layoff`);
  if (home.age != null && home.age > 37) flags.push(`${home.name} age ${home.age} — decline risk`);
  if (away.age != null && away.age > 37) flags.push(`${away.name} age ${away.age} — decline risk`);
  if (home.chinScore != null && home.chinScore < 4 && away.koPct != null && away.koPct > 0.60)
    flags.push(`${home.name} chin suspect vs ${away.name}'s ${Math.round(away.koPct * 100)}% KO rate`);
  if (away.chinScore != null && away.chinScore < 4 && home.koPct != null && home.koPct > 0.60)
    flags.push(`${away.name} chin suspect vs ${home.name}'s ${Math.round(home.koPct * 100)}% KO rate`);
  if ((home.weightClassMoves ?? 0) >= 2) flags.push(`${home.name} weight class instability`);
  if ((away.weightClassMoves ?? 0) >= 2) flags.push(`${away.name} weight class instability`);
  return flags.length > 0 ? flags.join(" · ") : null;
}

// ── Win probability ───────────────────────────────────────────────────────────

export function boxingWinProbability(
  home: BoxingFighterProfile,
  away: BoxingFighterProfile,
  weights: BoxingFactorWeights = DEFAULT_BOXING_WEIGHTS,
  marketCtx?: { homeOpenImplied?: number; homeCurrentImplied?: number },
): { home: number; away: number } {
  const output = scoreBoxingFight(home, away, weights, marketCtx);
  const baseHome = deltaToProbability(output._debug.combinedDelta);
  // Combat-specific feature adjustments: layoff days + SOS deltas.
  // combatFighterWinProbAdj returns an additive delta applied to the
  // picked side; we mirror opposite sign on the other side.
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

export function boxingConfidence(
  home: BoxingFighterProfile,
  away: BoxingFighterProfile,
  winProb: { home: number; away: number },
): "high" | "medium" | "low" {
  const max = Math.max(winProb.home, winProb.away);
  const hasCore =
    home.opponentQualityScore != null &&
    away.opponentQualityScore != null &&
    (home.koPct != null || home.record) &&
    (away.koPct != null || away.record);
  if (!hasCore) return "low";
  if (max >= 68) return "high";
  if (max >= 58) return "medium";
  return "low";
}

// ── Boxing parlay fit score ───────────────────────────────────────────────────

/**
 * Returns 0–100 fit score for including this fight in a parlay.
 * Only recommend when confidence >= medium, positive edge, not extreme volatility.
 */
export function boxingParlayFitScore(params: {
  confidence: "high" | "medium" | "low";
  edge: number;               // model_prob - implied_prob (0–1 scale)
  volatilityScore: number;    // 0–100 from risk flags
  dataCompleteness: number;   // 0–100 (how many key fields are populated)
  marketConfirmed: boolean;   // line movement aligned with model
}): number {
  if (params.confidence === "low") return 0;
  if (params.edge <= 0) return 0;
  if (params.volatilityScore >= 70) return 0;

  let score = 50;
  // Confidence bonus
  if (params.confidence === "high") score += 20;
  else score += 8;
  // Edge bonus (capped at +0.15 edge)
  score += Math.min(20, Math.round(params.edge * 133));
  // Volatility penalty
  score -= Math.round(params.volatilityScore * 0.3);
  // Data completeness bonus
  score += Math.round((params.dataCompleteness - 50) * 0.2);
  // Market confirmation bonus
  if (params.marketConfirmed) score += 10;

  return Math.max(0, Math.min(100, score));
}

// ── Model notes ───────────────────────────────────────────────────────────────

export function buildBoxingModelNotes(output: BoxingModelOutput): string[] {
  const notes: string[] = [];
  notes.push(output.opponentQualityEdge);
  notes.push(output.styleEdge);
  notes.push(output.reachEdge);
  notes.push(output.ageEdge);
  if (output.activityEdge !== "Both fighters similarly active") notes.push(output.activityEdge);
  notes.push(output.koPctNote);
  const m = output.methodProbabilities;
  notes.push(
    `Method — KO/TKO: ${Math.round(m.ko_tko * 100)}% · Decision: ${Math.round(m.decision * 100)}% · Draw: ${Math.round(m.draw * 100)}%`,
  );
  if (output.overUnderRoundsPivot != null) notes.push(`Model avg rounds: ~${output.overUnderRoundsPivot}`);
  return notes;
}

export function applyBoxingModel(
  intel: BoxingIntel,
  weights: BoxingFactorWeights = DEFAULT_BOXING_WEIGHTS,
  marketCtx?: { homeOpenImplied?: number; homeCurrentImplied?: number },
): BoxingIntel {
  const modelOutput = scoreBoxingFight(intel.homeFighter, intel.awayFighter, weights, marketCtx);
  return { ...intel, modelOutput, modelNotes: buildBoxingModelNotes(modelOutput) };
}
