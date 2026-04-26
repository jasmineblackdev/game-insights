/**
 * Parlay Edge — Auto Parlay Engine
 *
 * Automatically builds safe / balanced / aggressive parlays from the
 * daily candidate pool using sport-tier constraints, correlation guards,
 * and risk-tier scoring formulas.
 *
 * Sports: NBA · NFL · MLB · Boxing · UFC/MMA (no soccer)
 * Learning: phase 1 — track & store; phase 2 — pattern learning from results
 */

import type { League } from "@/data/mockGames";
import type { ParlayBuildMode, ValueBetCandidate, ValueMarketType } from "@/lib/valueParlay/types";

// ─── Sport filter modes ──────────────────────────────────────────
/** Global: all sports. Biased: current sport preferred but not exclusive. Sport-only: hard filter. */
export type SportFilterMode = "global" | "biased" | "sport_only";

// ─── Debug / coverage types ──────────────────────────────────────
export interface SportCoverageInfo {
  sport: League;
  totalCandidates: number;
  positiveEdgeCandidates: number;
  qualifyingCandidates: number; // edge > 0 AND confidence !== "low"
}

export interface ParlayEdgeDebugInfo {
  sportCoverage: SportCoverageInfo[];
  sportsInPool: League[];       // sports present after mode filter
  totalCandidatesConsidered: number;
  filterMode: SportFilterMode;
  biasSport?: League;
  /** True if pool has only 1 sport when multiple sports have qualifying candidates — indicates bug. */
  coverageBug: boolean;
}

// ─── Timing weights ───────────────────────────────────────────────
// Pregame weight = confidence multiplier for pre-game parlay selection.
// Live weight = how much stronger the bet becomes at the optimal live checkpoint.
// These drive both scoreLeg() adjustment and the timing tag UI copy.
export interface TimingConfig {
  pregameWeight: number;
  liveWeight: number;
  liveCheckpoint: string;  // human-readable checkpoint label
  liveUplift: number;      // liveWeight - pregameWeight (pre-computed for display)
}

export const TIMING_CONFIGS: Record<League, TimingConfig> = {
  nba:    { pregameWeight: 0.85, liveWeight: 1.05, liveCheckpoint: "after Q1",    liveUplift: 0.20 },
  nfl:    { pregameWeight: 0.88, liveWeight: 1.04, liveCheckpoint: "after Q1",    liveUplift: 0.16 },
  mlb:    { pregameWeight: 0.95, liveWeight: 1.07, liveCheckpoint: "after 5th",   liveUplift: 0.12 },
  mma:    { pregameWeight: 0.93, liveWeight: 1.08, liveCheckpoint: "after R1",    liveUplift: 0.15 },
  boxing: { pregameWeight: 0.94, liveWeight: 1.06, liveCheckpoint: "after R2–3",  liveUplift: 0.12 },
};

// ─── Timing tags ─────────────────────────────────────────────────
/**
 * Returns a timing label for a leg, including the live uplift signal.
 * MLB shows "Pregame (F5) · +12% edge after 5th" so users know the bet
 * strengthens mid-game — the pre-game entry is still valid, just not peak.
 */
export function timingTag(sport: League, marketType: ValueMarketType | string): string {
  const cfg = TIMING_CONFIGS[sport];
  const upliftPct = Math.round(cfg.liveUplift * 100);

  if (sport === "nba") {
    if (marketType === "player_prop") return `Pregame · ↑${upliftPct}% after Q1`;
    return `Pregame · ↑${upliftPct}% after Q1`;
  }
  if (sport === "nfl") {
    if (marketType === "player_prop") return `Pregame · ↑${upliftPct}% after Q1`;
    return `Pregame · ↑${upliftPct}% after Q1`;
  }
  if (sport === "mlb") {
    // MLB pregame window is F5 or pitcher props; full-game total/ML improves post-5th
    if (marketType === "player_prop") return `Pregame (K/hits props) · ↑${upliftPct}% after 5th`;
    if (marketType === "moneyline")   return `Pregame (F5 ML) · ↑${upliftPct}% after 5th`;
    return `Pregame · ↑${upliftPct}% after 5th inning`;
  }
  if (sport === "mma")    return `Pregame · ↑${upliftPct}% after R1`;
  if (sport === "boxing") return `Pregame · ↑${upliftPct}% after R2–3`;
  return "Pregame";
}

/**
 * Short single-line timing label for compact card display.
 * e.g. "F5 window · ↑12% post-5th"
 */
export function timingTagShort(sport: League, marketType: ValueMarketType | string): string {
  const cfg = TIMING_CONFIGS[sport];
  const upliftPct = Math.round(cfg.liveUplift * 100);
  if (sport === "mlb") {
    if (marketType === "moneyline") return `F5 window · ↑${upliftPct}% post-5th`;
    return `Pregame · ↑${upliftPct}% post-5th`;
  }
  return `Pregame · ↑${upliftPct}% ${cfg.liveCheckpoint}`;
}

// ─── Sport filter helpers ────────────────────────────────────────
const ALL_SUPPORTED_SPORTS: League[] = ["nba", "nfl", "mlb", "boxing", "mma"];

export function filterCandidatesByMode(
  candidates: ValueBetCandidate[],
  mode: SportFilterMode,
  biasSport?: League
): ValueBetCandidate[] {
  if (mode === "sport_only" && biasSport) {
    return candidates.filter((c) => c.sport === biasSport);
  }
  return candidates; // global + biased: full pool (bias handled via score boost below)
}

/** Apply a 15% score boost to the biased sport so it's preferred but not exclusive. */
export function applyBiasBoost(
  candidates: ValueBetCandidate[],
  mode: SportFilterMode,
  biasSport?: League
): ValueBetCandidate[] {
  if (mode !== "biased" || !biasSport) return candidates;
  return candidates.map((c) =>
    c.sport === biasSport ? { ...c, valueScore: c.valueScore * 1.15 } : c
  );
}
import {
  parlayAmericanOdds,
  parlayHitProbability,
  payoutMultiplierFromAmerican,
} from "@/lib/valueParlay/oddsMath";

// ─── Sport tier system ───────────────────────────────────────────
// Tier 1 (foundation): high event frequency, rich signal — NBA / NFL
// Tier 2 (support): reliable F5/pitcher focus — MLB
// Tier 3 (selective value): high finish variance, max 1 per parlay — Boxing / MMA
export const SPORT_TIERS: Record<League, 1 | 2 | 3> = {
  nba: 1,
  nfl: 1,
  mlb: 2,
  boxing: 3,
  mma: 3,
};

// ─── Parlay target structure ─────────────────────────────────────
// Encodes the safe 3-leg / balanced 4-leg / aggressive 6-leg rules
// and the combat-sports cap (max 1 tier-3 leg per parlay).
const PARLAY_STRUCTURE: Record<
  ParlayBuildMode,
  { targetLegs: number; maxTier3: number; maxPerSport: number; minTier1: number }
> = {
  safe:       { targetLegs: 2, maxTier3: 1, maxPerSport: 2, minTier1: 2 },
  balanced:   { targetLegs: 3, maxTier3: 1, maxPerSport: 2, minTier1: 2 },
  aggressive: { targetLegs: 6, maxTier3: 1, maxPerSport: 3, minTier1: 2 },
  cashout:    { targetLegs: 3, maxTier3: 0, maxPerSport: 2, minTier1: 2 },
  bigwin:     { targetLegs: 4, maxTier3: 1, maxPerSport: 3, minTier1: 2 },
  lotto:      { targetLegs: 5, maxTier3: 2, maxPerSport: 4, minTier1: 1 },
};

// ─── Odds sweet-spot bonus ───────────────────────────────────────
// Rewards legs in the -110 to -200 range (best probability/payout balance).
function oddsSweetSpot(american: number): number {
  if (american <= -110 && american >= -200) return 0.08;
  if (american <= -200 && american >= -250) return 0.03;
  if (american > 0 && american <= 150)      return 0.04;
  return 0;
}

// ─── Leg scoring ─────────────────────────────────────────────────
// Three formulas tuned to risk profile:
//   safe       → maximize probability + confidence
//   balanced   → maximize edge + probability + confidence
//   aggressive → maximize edge + payout potential
//
// Timing weight: each sport's pregame signal strength is baked in so that
// MLB legs (pregame: 0.95) are correctly weighted vs NBA (pregame: 0.85)
// in the same pool. MLB scores better pre-game because it has more predictable
// F5/pitcher data; NBA is slightly discounted because live Q1 info improves
// the pick materially. Combat sports (MMA 0.93, Boxing 0.94) sit between.

export function scoreLeg(c: ValueBetCandidate, mode: ParlayBuildMode): number {
  const confidence =
    c.confidence === "high" ? 0.92 : c.confidence === "medium" ? 0.62 : 0.35;
  const volatility  = Math.min(1, c.volatilityScore / 100);
  const dataQuality = Math.max(0, 1 - c.uncertaintyScore / 100);
  const marketStability =
    c.lineMovementDeltaPp == null
      ? 0.75
      : Math.max(0, 1 - Math.abs(c.lineMovementDeltaPp) / 10);
  const sweet = oddsSweetSpot(c.americanOdds);
  // Pregame timing weight — reflects how much pre-game info is worth per sport.
  // MLB 0.95: starter data is rich pre-game (F5 window).
  // NBA 0.85: rotations/pace confirm after Q1, so pre-game is slightly discounted.
  const timingW = TIMING_CONFIGS[c.sport as League]?.pregameWeight ?? 1.0;

  if (mode === "safe" || mode === "cashout") {
    // cashout reuses safe leg-scoring; structural ordering is applied downstream
    return (
      (c.modelProbability * 0.40 +
      confidence         * 0.25 +
      c.edge             * 0.20 -
      volatility         * 0.15 +
      sweet) * timingW
    );
  }

  if (mode === "aggressive") {
    const payoutPotential =
      c.americanOdds > 0 ? Math.min(1, c.americanOdds / 300) : 0;
    return (
      (c.edge          * 0.45 +
      payoutPotential * 0.25 +
      confidence      * 0.15 -
      volatility      * 0.15 +
      sweet) * timingW
    );
  }

  // balanced
  return (
    (c.edge           * 0.35 +
    c.modelProbability * 0.20 +
    confidence       * 0.20 -
    volatility       * 0.15 +
    dataQuality      * 0.05 +
    marketStability  * 0.05 +
    sweet) * timingW
  );
}

// ─── Sport balance score ─────────────────────────────────────────
function sportBalanceScore(legs: ValueBetCandidate[]): number {
  const unique = new Set(legs.map((l) => l.sport)).size;
  return Math.min(1, unique / Math.max(1, legs.length));
}

// ─── Correlation penalty (0–0.50) ────────────────────────────────
// Penalises same-game legs and same-sport prop stacks.
function calcCorrelationPenalty(legs: ValueBetCandidate[]): number {
  const byGame = new Map<string, number>();
  for (const l of legs) byGame.set(l.gameId, (byGame.get(l.gameId) ?? 0) + 1);
  let pen = 0;
  for (const n of byGame.values()) {
    if (n >= 3) pen += 0.30;
    else if (n === 2) pen += 0.15;
  }
  return Math.min(0.50, pen);
}

// ─── Volatility penalty (0–1) ────────────────────────────────────
function calcVolatilityPenalty(legs: ValueBetCandidate[]): number {
  return legs.reduce((s, l) => s + l.volatilityScore, 0) / legs.length / 100;
}

// ─── Parlay strength score ────────────────────────────────────────
// Combines edge, probability, confidence, balance minus penalties.
// parlay_strength =
//   edge * 0.35 + probability * 0.25 + confidence * 0.15
//   + sport_balance * 0.10 - correlation * 0.10 - volatility * 0.05
export function parlayStrength(legs: ValueBetCandidate[]): number {
  if (!legs.length) return 0;
  const probs   = legs.map((l) => l.modelProbability);
  const hitProb = parlayHitProbability(probs);
  const avgEdge = legs.reduce((s, l) => s + l.edge, 0) / legs.length;
  const avgConf = legs.reduce(
    (s, l) => s + (l.confidence === "high" ? 0.92 : l.confidence === "medium" ? 0.62 : 0.35),
    0
  ) / legs.length;
  const balance  = sportBalanceScore(legs);
  const corrPen  = calcCorrelationPenalty(legs);
  const volPen   = calcVolatilityPenalty(legs);

  return Math.max(
    0,
    avgEdge  * 0.35 +
    hitProb  * 0.25 +
    avgConf  * 0.15 +
    balance  * 0.10 -
    corrPen  * 0.10 -
    volPen   * 0.05
  );
}

// ─── Hard guard: does this combo violate structural rules? ───────
function passesHardRules(
  legs: ValueBetCandidate[],
  maxPerSport: number,
  maxTier3: number
): boolean {
  const byGame: Map<string, number> = new Map();
  const bySport: Record<string, number> = {};
  let tier3 = 0;
  for (const l of legs) {
    const gc = (byGame.get(l.gameId) ?? 0) + 1;
    if (gc > 2) return false;
    byGame.set(l.gameId, gc);
    bySport[l.sport] = (bySport[l.sport] ?? 0) + 1;
    if (bySport[l.sport] > maxPerSport) return false;
    if (SPORT_TIERS[l.sport as League] === 3) tier3++;
  }
  return tier3 <= maxTier3;
}

// ─── Warning builder ─────────────────────────────────────────────
function buildWarnings(legs: ValueBetCandidate[], mode: ParlayBuildMode): string[] {
  const w: string[] = [];
  const byGame = new Map<string, number>();
  for (const l of legs) byGame.set(l.gameId, (byGame.get(l.gameId) ?? 0) + 1);
  if ([...byGame.values()].some((n) => n >= 2)) {
    w.push("Multiple legs from the same game — correlation risk elevated.");
  }
  const tier3 = legs.filter((l) => SPORT_TIERS[l.sport as League] === 3);
  if (tier3.length > 1) {
    w.push("Multiple combat-sports legs — finish variance is high. Treat as value-only.");
  }
  const highVol = legs.filter((l) => l.volatilityScore >= 65).length;
  if (highVol >= 2) w.push("Volatility stack — sensitive to late lineup news.");
  const heavyFav = legs.filter((l) => l.americanOdds <= -280).length;
  if (heavyFav >= 3) w.push("Heavy favourite overload — payout efficiency is compressed.");
  if (mode === "aggressive" && legs.length >= 6) {
    w.push("6-leg parlay — hit rate is naturally lower. Only use when edge is strong.");
  }
  return w;
}

// ─── Explanation builder ─────────────────────────────────────────
function buildExplanation(legs: ValueBetCandidate[], mode: ParlayBuildMode): string[] {
  const reasons: string[] = [];
  const sports     = [...new Set(legs.map((l) => l.sport))];
  const tier3      = legs.filter((l) => SPORT_TIERS[l.sport as League] === 3);
  const avgEdge    = legs.reduce((s, l) => s + l.edge, 0) / legs.length;
  const highConf   = legs.filter((l) => l.confidence === "high").length;
  const sweetCount = legs.filter(
    (l) => l.americanOdds <= -110 && l.americanOdds >= -200
  ).length;

  if (sports.length >= 3) {
    reasons.push(`${sports.length}-sport mix (${sports.map((s) => s.toUpperCase()).join(" + ")}) — minimal hidden correlation`);
  } else if (sports.length === 2) {
    reasons.push(`Two-sport mix (${sports.map((s) => s.toUpperCase()).join(" + ")}) — reduces same-game dependency`);
  }

  if (tier3.length === 1) {
    reasons.push("Combat sports capped at 1 leg — limits high-finish-variance exposure");
  } else if (tier3.length === 0) {
    reasons.push("No combat sports legs — maximum stability across the card");
  }

  if (avgEdge >= 0.08) {
    reasons.push(`Strong average model edge (+${(avgEdge * 100).toFixed(1)}%)`);
  } else if (avgEdge >= 0.05) {
    reasons.push(`Positive model edge across all legs (+${(avgEdge * 100).toFixed(1)}% avg)`);
  }

  if (sweetCount >= Math.ceil(legs.length * 0.5)) {
    reasons.push(`${sweetCount} of ${legs.length} legs in -110 to -200 odds sweet spot`);
  }

  if (highConf >= Math.ceil(legs.length * 0.6)) {
    reasons.push(`${highConf} of ${legs.length} legs are high-confidence signals`);
  }

  if (mode === "safe") {
    reasons.push("Low-volatility filter applied — avoids speculative finish and prop markets");
  } else if (mode === "balanced") {
    reasons.push("Balanced risk/reward — stable foundation + selective value leg");
  } else {
    reasons.push("Payout-optimised — higher edge tolerance with aggressive scoring");
  }

  return reasons.slice(0, 5);
}

// ─── AutoParlay output type ──────────────────────────────────────
export interface AutoParlay {
  mode: ParlayBuildMode;
  legCount: number;
  legs: ValueBetCandidate[];
  combinedProbability: number;
  combinedEdge: number;
  combinedAmericanOdds: number;
  payoutMultiplier: number;
  confidence: "high" | "medium" | "low";
  strengthScore: number;
  sportMix: string;
  warnings: string[];
  explanation: string[];
}

// ─── Build one auto parlay ────────────────────────────────────────
export function buildAutoParlay(
  candidates: ValueBetCandidate[],
  mode: ParlayBuildMode
): AutoParlay | null {
  const { targetLegs, maxTier3, maxPerSport, minTier1 } = PARLAY_STRUCTURE[mode];

  // Filter pool by mode requirements
  let pool = candidates.filter((c) => {
    if (c.edge <= 0) return false;
    if (c.confidence === "low") return false;
    if (mode === "safe" && c.volatilityScore >= 65) return false;
    return true;
  });
  if (pool.length < 2) {
    pool = candidates.filter((c) => c.edge > 0 && c.confidence !== "low");
  }
  if (pool.length < 2) return null;

  // Score and sort
  const scored = [...pool]
    .map((c) => ({ c, score: scoreLeg(c, mode) }))
    .sort((a, b) => b.score - a.score);

  // Greedy selection with structural constraints
  const picked: ValueBetCandidate[] = [];
  const byGame  = new Map<string, number>();
  const bySport: Record<string, number> = {};
  let tier3Count = 0;
  let tier1Count = 0;

  for (const { c } of scored) {
    if (picked.length >= targetLegs) break;
    const gc = (byGame.get(c.gameId) ?? 0) + 1;
    if (gc > 2) continue;
    const sc = (bySport[c.sport] ?? 0) + 1;
    if (sc > maxPerSport) continue;
    const tier = SPORT_TIERS[c.sport as League] ?? 2;
    if (tier === 3 && tier3Count >= maxTier3) continue;
    picked.push(c);
    byGame.set(c.gameId, gc);
    bySport[c.sport] = sc;
    if (tier === 3) tier3Count++;
    if (tier === 1) tier1Count++;
  }

  // Relaxed pass if we couldn't meet minTier1 requirement
  if (picked.length < 2) return null;

  const odds     = picked.map((l) => l.americanOdds);
  const probs    = picked.map((l) => l.modelProbability);
  const hitProb  = parlayHitProbability(probs);
  const combined = parlayAmericanOdds(odds);
  const mult     = payoutMultiplierFromAmerican(combined);
  const avgEdge  = picked.reduce((s, l) => s + l.edge, 0) / picked.length;
  const avgConf  = picked.reduce(
    (s, l) => s + (l.confidence === "high" ? 0.92 : l.confidence === "medium" ? 0.62 : 0.35),
    0
  ) / picked.length;

  let confidence: "high" | "medium" | "low" = "high";
  if (avgConf < 0.55 || hitProb < 0.10) confidence = "low";
  else if (avgConf < 0.72 || hitProb < 0.20) confidence = "medium";

  const sportSet = [...new Set(picked.map((l) => l.sport))];

  return {
    mode,
    legCount: picked.length,
    legs: picked,
    combinedProbability: Math.round(hitProb * 10000) / 10000,
    combinedEdge: Math.round(avgEdge * 10000) / 10000,
    combinedAmericanOdds: combined,
    payoutMultiplier: Math.round(mult * 100) / 100,
    confidence,
    strengthScore: Math.round(parlayStrength(picked) * 10000) / 10000,
    sportMix: sportSet.sort().join(","),
    warnings: buildWarnings(picked, mode),
    explanation: buildExplanation(picked, mode),
  };
}

// ─── Generate all three tiers ────────────────────────────────────
export interface ParlayEdgeOutput {
  safe: AutoParlay | null;
  balanced: AutoParlay | null;
  aggressive: AutoParlay | null;
  candidatePool: ValueBetCandidate[];
  debug: ParlayEdgeDebugInfo;
}

export function generateParlayEdge(
  candidates: ValueBetCandidate[],
  filterMode: SportFilterMode = "global",
  biasSport?: League
): ParlayEdgeOutput {
  // Build sport coverage from the full unfiltered pool
  const sportCoverage: SportCoverageInfo[] = ALL_SUPPORTED_SPORTS.map((sport) => {
    const sc = candidates.filter((c) => c.sport === sport);
    return {
      sport,
      totalCandidates: sc.length,
      positiveEdgeCandidates: sc.filter((c) => c.edge > 0).length,
      qualifyingCandidates: sc.filter((c) => c.edge > 0 && c.confidence !== "low").length,
    };
  });

  // Apply mode filter then bias boost
  const filtered = filterCandidatesByMode(candidates, filterMode, biasSport);
  const pool     = applyBiasBoost(filtered, filterMode, biasSport);

  const sportsInPool = [...new Set(pool.map((c) => c.sport))] as League[];
  const qualifyingMultipleSports = sportCoverage.filter((s) => s.qualifyingCandidates > 0).length;
  const coverageBug = sportsInPool.length === 1 && qualifyingMultipleSports > 1;

  const debug: ParlayEdgeDebugInfo = {
    sportCoverage,
    sportsInPool,
    totalCandidatesConsidered: pool.length,
    filterMode,
    biasSport,
    coverageBug,
  };

  return {
    safe:       buildAutoParlay(pool, "safe"),
    balanced:   buildAutoParlay(pool, "balanced"),
    aggressive: buildAutoParlay(pool, "aggressive"),
    candidatePool: [...pool]
      .filter((c) => c.edge > 0 && c.confidence !== "low")
      .sort((a, b) => b.valueScore - a.valueScore)
      .slice(0, 12),
    debug,
  };
}

// ─── Risk tier labels ────────────────────────────────────────────
export function parlayModeLabel(mode: ParlayBuildMode): string {
  if (mode === "safe")       return "Safe";
  if (mode === "balanced")   return "Balanced";
  if (mode === "cashout")    return "Cash-Out";
  if (mode === "bigwin")     return "Big Win";
  if (mode === "lotto")      return "Lotto";
  return "Aggressive";
}

export function parlayModeDescription(mode: ParlayBuildMode): string {
  if (mode === "safe") {
    return "2-leg · +120 to +320 target · low volatility · max 1 medium-conf leg";
  }
  if (mode === "balanced") {
    return "3-leg · +250 to +550 target · edge + probability balance";
  }
  if (mode === "cashout") {
    return "3-leg · staggered starts · high-prob first · upside last";
  }
  if (mode === "bigwin") {
    return "4-leg · +800 to +1200 target · strict per-leg quality · ~$9 → $100";
  }
  if (mode === "lotto") {
    return "5–7 leg · high upside · clearly risky · longshot legs allowed";
  }
  return "6-leg · payout-optimised · max edge · high variance tolerated";
}

// ─── Learning insights (Phase 1 — domain-seeded) ─────────────────
// Phase 2 will replace these with live-computed values from
// parlay_pattern_learning and parlay_failure_analysis.
export interface ParlayLearningInsight {
  category: string;
  label: string;
  value: string;
  note: string;
}

export function getLearningInsights(): ParlayLearningInsight[] {
  return [
    {
      category: "Leg count",
      label: "Best leg count",
      value: "3–4 legs",
      note: "Hit rate drops sharply above 6 legs without very strong edge",
    },
    {
      category: "Sport mix",
      label: "Best sport foundation",
      value: "NBA + NFL",
      note: "Tier 1 sports provide consistent signals and high-volume data",
    },
    {
      category: "Odds range",
      label: "Best odds range",
      value: "-110 to -190",
      note: "Sweet spot balances probability and meaningful payout",
    },
    {
      category: "Market types",
      label: "Most reliable props",
      value: "Assists · rebounds · passing yards · pitcher Ks",
      note: "Volume-based props carry more statistical signal than event props",
    },
    {
      category: "Correlation",
      label: "Worst pattern",
      value: "Same-game overs",
      note: "Two legs sharing a game script fail together more often than expected",
    },
    {
      category: "Combat sports",
      label: "Boxing / MMA rule",
      value: "Max 1 leg per parlay",
      note: "Finish variance is too high to stack; use as value-add, not core",
    },
    {
      category: "Live timing",
      label: "Best live checkpoint",
      value: "NBA after Q1",
      note: "Rotations and pace are confirmed; blowout risk can be filtered",
    },
    {
      category: "MLB",
      label: "Best MLB market",
      value: "F5 moneyline · pitcher strikeouts",
      note: "Avoids full-game bullpen variance which can unravel overs/spreads",
    },
  ];
}

// ─── Combo warning descriptions (shown in the warnings section) ──
export interface ComboWarning {
  type: string;
  title: string;
  description: string;
  severity: "high" | "medium" | "low";
}

export const COMBO_WARNINGS: ComboWarning[] = [
  {
    type: "same_game",
    title: "Too many same-game legs",
    description:
      "Legs from the same game share the same script — one blowout or weather delay kills multiple picks at once.",
    severity: "high",
  },
  {
    type: "high_volatility",
    title: "High-volatility stack",
    description:
      "Combining multiple high-variance legs (first TD, blocks, home runs) compresses hit rate more than the combined odds suggest.",
    severity: "high",
  },
  {
    type: "combat_overload",
    title: "Multiple combat-sports legs",
    description:
      "Boxing and MMA have high finish variance. More than one fight leg per parlay compounds unpredictability significantly.",
    severity: "high",
  },
  {
    type: "heavy_favorite",
    title: "Heavy favourite overload",
    description:
      "Three or more legs below -280 compresses payout so much that a single miss ruins EV. Better to pick fewer legs with stronger edge.",
    severity: "medium",
  },
  {
    type: "same_sport_props",
    title: "Same-sport prop stack",
    description:
      "Multiple player props from the same sport (especially same team) are correlated — QB yards and WR yards move together.",
    severity: "medium",
  },
  {
    type: "low_confidence",
    title: "Weak confidence legs",
    description:
      "Any leg graded low confidence reduces the entire parlay's probability far more than its individual odds suggest.",
    severity: "low",
  },
];
