import type { ConfidenceLevel } from "@/data/mockGames";
import { MIN_EDGE_RECOMMEND } from "@/lib/bettingIntelligence";
import {
  parlayAmericanOdds,
  parlayHitProbability,
  payoutMultiplierFromAmerican,
} from "@/lib/valueParlay/oddsMath";
import type { ParlayBuildMode, ParlayTriple, SmartParlayResult, ValueBetCandidate } from "@/lib/valueParlay/types";

// ── Analytics weights ─────────────────────────────────────────────────────────

/**
 * Optional analytics-derived multipliers injected from Supabase RPCs.
 * Values come from analytics_roi_by_sport and analytics_roi_by_market_type.
 * Clamped to ±0.05 influence on legScore so they never overpower live signals.
 */
export interface AnalyticsWeights {
  /** sport.toUpperCase() → multiplier  e.g. { NBA: 1.06, MMA: 0.97 } */
  sportWeights?: Record<string, number>;
  /** "SPORT:stat_type" → multiplier  e.g. { "NBA:points": 1.08 } */
  marketWeights?: Record<string, number>;
  /**
   * Extra weight added to the sport-diversification score in scoreParlay.
   * Positive values reward cross-sport mixes more strongly.
   * Range: [0, 0.05] recommended. Default 0.
   *
   * Used by the Tomorrow tab (+0.02) where full slate visibility makes
   * cross-sport diversification easier to achieve and more valuable.
   */
  diversificationBoost?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function confidenceNumeric(c: ConfidenceLevel): number {
  if (c === "high")   return 0.92;
  if (c === "medium") return 0.62;
  return 0.35;
}

function isCombatSport(sport: string): boolean {
  const s = sport.toLowerCase();
  return s === "boxing" || s === "mma" || s === "ufc";
}

function diversificationScore(legs: ValueBetCandidate[]): number {
  const sports = new Set(legs.map((l) => l.sport));
  return Math.min(1, sports.size / 4);
}

function correlationPenalty(legs: ValueBetCandidate[]): number {
  const byGame = new Map<string, ValueBetCandidate[]>();
  for (const l of legs) {
    const arr = byGame.get(l.gameId) ?? [];
    arr.push(l);
    byGame.set(l.gameId, arr);
  }
  let pen = 0;
  for (const [, arr] of byGame) {
    const n = arr.length;
    if (n >= 3) pen += 32;
    else if (n === 2) {
      pen += 22;
      const types = new Set(arr.map((x) => x.pickType));
      if (types.size > 1) pen += 14;
    }
  }
  const byCorr = new Map<string, number>();
  for (const l of legs) {
    const g = l.correlationGroupId.split("-").slice(0, 3).join("-");
    byCorr.set(g, (byCorr.get(g) ?? 0) + 1);
  }
  for (const n of byCorr.values()) {
    if (n >= 2) pen += 8;
  }
  return Math.min(100, pen);
}

function sportCounts(legs: ValueBetCandidate[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const l of legs) {
    m[l.sport] = (m[l.sport] ?? 0) + 1;
  }
  return m;
}

function passesHardRules(legs: ValueBetCandidate[], maxPerSport: number): boolean {
  const byGame = new Map<string, number>();
  for (const l of legs) {
    const next = (byGame.get(l.gameId) ?? 0) + 1;
    byGame.set(l.gameId, next);
    if (next > 2) return false;
  }
  const sc = sportCounts(legs);
  for (const n of Object.values(sc)) {
    if (n > maxPerSport) return false;
  }
  for (const l of legs) {
    if (l.confidence === "low") return false;
    if (l.edge <= 0) return false;
    if (l.americanOdds <= -400 && l.edge < 0.06) return false;
  }
  return true;
}

// ── ML-aware leg score ────────────────────────────────────────────────────────

/**
 * Per-leg quality score combining live signals with optional analytics weights.
 *
 * Formula:
 *   legScore = edge*0.32 + ml_hit_prob*0.22 + confidence*0.18
 *            + timingScore*0.12 + stability*0.08
 *            + marketAdj*0.05  + sportAdj*0.03
 *
 * Analytics multipliers are clamped to ±0.08 so they never override live signals.
 * Without analytics data every multiplier defaults to 1.0 (no adjustment).
 */
export function computeLegScore(c: ValueBetCandidate, weights: AnalyticsWeights = {}): number {
  const edge01      = Math.min(1, Math.max(0, c.edge));
  const hitProb01   = Math.min(1, Math.max(0, c.modelProbability ?? 0.5));
  const conf01      = confidenceNumeric(c.confidence ?? "medium");
  const timing01    = c.timingScore ?? 0.55;
  const stability01 = c.stabilityScore ?? 0.5;

  // Calibration adjustment: additive offset to conf01 derived from historical
  // calibration data for this sport × market. Clamped to ±0.02 (max per-cycle
  // nudge) × multiple cycles, bounded overall to ±0.08.
  const rawCalAdj  = c.confidenceCalibrationAdjustment ?? 0;
  const calAdj     = Math.min(0.08, Math.max(-0.08, rawCalAdj));
  const confAdjusted = Math.min(1, Math.max(0, conf01 + calAdj));

  // Sport and market ROI multipliers are clamped to ±0.05 max influence on
  // legScore. Spec: "sport ROI multiplier: max ±0.05 influence on legScore".
  const sportKey  = (c.sport ?? "").toUpperCase();
  const rawSportW = (weights.sportWeights ?? {})[sportKey] ?? 1.0;
  const sportAdj  = Math.min(0.05, Math.max(-0.05, rawSportW - 1.0));

  const marketKey  = `${sportKey}:${(c.statType ?? c.marketType ?? "").toLowerCase()}`;
  const rawMarketW = (weights.marketWeights ?? {})[marketKey] ?? 1.0;
  const marketAdj  = Math.min(0.05, Math.max(-0.05, rawMarketW - 1.0));

  return (
    edge01         * 0.32 +
    hitProb01      * 0.22 +
    confAdjusted   * 0.18 +
    timing01       * 0.12 +
    stability01    * 0.08 +
    marketAdj      * 0.05 +
    sportAdj       * 0.03
  );
}

// ── Tier-aware leg filter ─────────────────────────────────────────────────────

/**
 * Mode-aware leg gating.
 *
 * SAFE:       exclude wait-timing, volatility ≥ 55, stability < 0.55
 * BALANCED:   exclude volatility ≥ 70, stability < 0.45; wait allowed at edge ≥ 0.09
 * AGGRESSIVE: minimal hard filters — still blocks structurally bad legs
 */
function legPassesParlayBuildFilters(c: ValueBetCandidate, mode: ParlayBuildMode = "balanced"): boolean {
  if (c.edge <= 0) return false;
  if (c.americanOdds <= -350 && c.edge < 0.07) return false;

  // Tier-specific volatility + stability gates
  if (mode === "safe") {
    if (c.volatilityScore >= 55) return false;
    const stab = c.stabilityScore;
    if (stab !== undefined && stab < 0.55) return false;
  } else if (mode === "balanced") {
    if (c.volatilityScore >= 70) return false;
    const stab = c.stabilityScore;
    if (stab !== undefined && stab < 0.45) return false;
  }

  // High-vol underdog with insufficient edge — noise trap
  if (c.americanOdds > 0 && c.volatilityScore >= 55 && c.edge <= 0.08) return false;

  // Timing gating
  const timing = c.timingUrgency;
  if (timing === "wait") {
    if (mode === "safe") return false;
    if (mode === "balanced" && c.edge < 0.09) return false;
    // aggressive: all timing states allowed
  }

  return true;
}

function buildWarnings(legs: ValueBetCandidate[]): string[] {
  const w: string[] = [];
  const byGame = new Map<string, number>();
  for (const l of legs) {
    byGame.set(l.gameId, (byGame.get(l.gameId) ?? 0) + 1);
  }
  if ([...byGame.values()].some((n) => n >= 2)) {
    w.push("Some legs may share the same game script — correlation elevated.");
  }
  const mlbPitch = legs.some(
    (l) => l.sport === "mlb" && l.riskNote.toLowerCase().includes("pitcher")
  );
  if (mlbPitch) w.push("MLB leg(s) may still be moving on pitcher confirmation.");
  const vol = legs.filter((l) => l.volatilityScore >= 58).length;
  if (vol >= 2) w.push("Volatility stack — card is sensitive to late news.");
  return w;
}

// ── Parlay scorer ─────────────────────────────────────────────────────────────

/**
 * Composite parlay quality score.
 *
 * parlayScore = avg_legScore*0.55 + timingQScore*0.12 + sportDivScore*0.08
 *             + marketStrScore*0.07 + confSpreadScore*0.06
 *             - corrPen*0.07 - volPen*0.05
 */
function scoreParlay(
  legs: ValueBetCandidate[],
  _mode: ParlayBuildMode = "balanced",
  weights: AnalyticsWeights = {}
): SmartParlayResult {
  const odds     = legs.map((l) => l.americanOdds);
  const combined = parlayAmericanOdds(odds);
  const probs    = legs.map((l) => l.modelProbability);
  const hit      = parlayHitProbability(probs);
  const mult     = payoutMultiplierFromAmerican(combined);

  // Average ML-aware leg quality (0–1)
  const avgLegScore = legs.reduce((s, l) => s + computeLegScore(l, weights), 0) / legs.length;

  // Timing quality — avg timingScore across legs (0–1, neutral = 0.55)
  const timingQScore = legs.reduce((s, l) => s + (l.timingScore ?? 0.55), 0) / legs.length;

  // Sport diversification bonus (0–1)
  const sportDivScore = diversificationScore(legs);

  // Market strength: analytics-adjusted quality, normalized to [0,1].
  // With no weights: all 0 adjustments → neutral 0.5
  const rawMarketAdj = legs.reduce((s, l) => {
    const k = `${(l.sport ?? "").toUpperCase()}:${(l.statType ?? l.marketType ?? "").toLowerCase()}`;
    const raw = (weights.marketWeights ?? {})[k] ?? 1.0;
    return s + Math.min(0.08, Math.max(-0.08, raw - 1.0));
  }, 0) / legs.length;
  const marketStrScore = 0.5 + rawMarketAdj / 0.16; // maps [-0.08, +0.08] → [0, 1]

  // Confidence spread (0–1)
  const confSpreadScore = legs.reduce((s, l) => s + confidenceNumeric(l.confidence), 0) / legs.length;

  // Penalties (0–1)
  const corrPen01 = correlationPenalty(legs) / 100;
  const volPen01  = legs.reduce((s, l) => s + l.volatilityScore, 0) / legs.length / 100;
  const uncPen01  = legs.reduce((s, l) => s + l.uncertaintyScore, 0) / legs.length / 100;

  // diversificationBoost shifts weight from timing → sport diversity.
  // Rationale: tomorrow's full slate makes cross-sport mixes more achievable,
  // while timing urgency matters less for pregame-only builds.
  const divBoost      = Math.min(0.05, Math.max(0, weights.diversificationBoost ?? 0));
  const smartParlayScore =
    avgLegScore     * 0.55 +
    timingQScore    * (0.12 - divBoost) +
    sportDivScore   * (0.08 + divBoost) +
    marketStrScore  * 0.07 +
    confSpreadScore * 0.06 -
    corrPen01       * 0.07 -
    volPen01        * 0.05;

  // Card confidence
  const avgConf = confSpreadScore;
  let cardConf: ConfidenceLevel = "high";
  if (avgConf < 0.55 || hit < 0.12) cardConf = "low";
  else if (avgConf < 0.72 || hit < 0.22) cardConf = "medium";

  return {
    legs,
    projectedHitProbability:   Math.round(hit * 1000) / 1000,
    projectedPayoutMultiplier: Math.round(mult * 100) / 100,
    combinedAmericanOdds:      combined,
    cardConfidence:            cardConf,
    correlationPenalty:        Math.round(corrPen01 * 100),
    volatilityPenalty:         Math.round(volPen01 * 100),
    uncertaintyPenalty:        Math.round(uncPen01 * 100),
    smartParlayScore:          Math.round(smartParlayScore * 1000) / 1000,
    warnings:                  buildWarnings(legs),
  };
}

// ── Greedy leg selector ───────────────────────────────────────────────────────

function greedyBuild(
  pool: ValueBetCandidate[],
  targetLegs: number,
  opts: {
    maxPerSport: number;
    preferSafer: boolean;
    preferPayout: boolean;
    mode: ParlayBuildMode;
    weights?: AnalyticsWeights;
    /** When true, first pass ignores isRecommended (ranked-live pool). */
    skipRecommendedFilter?: boolean;
    /** Max combat (boxing + MMA/UFC) legs total. Defaults: safe=1, balanced=1, aggressive=2. */
    maxCombatLegs?: number;
    /** Max legs from the same game/event. Defaults: safe=1, balanced=2, aggressive=2. */
    maxPerGame?: number;
  }
): ValueBetCandidate[] {
  const weights       = opts.weights ?? {};
  const maxCombatLegs = opts.maxCombatLegs ?? (opts.mode === "aggressive" ? 2 : 1);
  const maxPerGame    = opts.maxPerGame    ?? (opts.mode === "safe" ? 1 : 2);

  const sorted = [...pool].sort((a, b) => {
    if (opts.preferSafer) {
      const rd = a.riskScore - b.riskScore;
      if (Math.abs(rd) > 3) return rd;
    }
    if (opts.preferPayout) {
      const ad = b.americanOdds - a.americanOdds;
      if (Math.abs(ad) > 20) return ad;
    }
    return computeLegScore(b, weights) - computeLegScore(a, weights);
  });

  const picked: ValueBetCandidate[] = [];
  const gameCounts = new Map<string, number>();
  const sportC: Record<string, number> = {};
  let combatCount = 0;

  const tryAdd = (c: ValueBetCandidate): boolean => {
    const gc = (gameCounts.get(c.gameId) ?? 0) + 1;
    if (gc > maxPerGame) return false;
    const sc = (sportC[c.sport] ?? 0) + 1;
    if (sc > opts.maxPerSport) return false;
    if (isCombatSport(c.sport) && combatCount >= maxCombatLegs) return false;
    picked.push(c);
    gameCounts.set(c.gameId, gc);
    sportC[c.sport] = sc;
    if (isCombatSport(c.sport)) combatCount++;
    return true;
  };

  // Pass 1: recommended-only (or skipRecommendedFilter)
  for (const c of sorted) {
    if (picked.length >= targetLegs) break;
    if (!opts.skipRecommendedFilter && !c.isRecommended) continue;
    tryAdd(c);
  }

  // Pass 2: fallback — relax isRecommended when pool is thin
  if (picked.length < Math.min(3, targetLegs)) {
    for (const c of sorted) {
      if (picked.length >= targetLegs) break;
      if (picked.some((p) => p.id === c.id)) continue;
      if (c.confidence === "low") continue;
      if (c.edge <= 0) continue;
      if (c.edge < MIN_EDGE_RECOMMEND) continue;
      if (!legPassesParlayBuildFilters(c, opts.mode)) continue;
      tryAdd(c);
    }
  }

  return picked;
}

// ── Tier configuration ────────────────────────────────────────────────────────

function tierConfig(mode: ParlayBuildMode): {
  min: number; target: number; max: number;
  maxPerSport: number;
} {
  if (mode === "safe")       return { min: 2, target: 3, max: 4,  maxPerSport: 2 };
  if (mode === "balanced")   return { min: 3, target: 4, max: 5,  maxPerSport: 3 };
  return                            { min: 4, target: 5, max: 6,  maxPerSport: 4 };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function optimizeSmartParlays(
  candidates: ValueBetCandidate[],
  mode: ParlayBuildMode,
  weights: AnalyticsWeights = {}
): ParlayTriple {
  const { min, target, max, maxPerSport } = tierConfig(mode);

  let pool = candidates.filter(
    (c) =>
      c.edge >= MIN_EDGE_RECOMMEND &&
      c.edge > 0 &&
      c.confidence !== "low" &&
      legPassesParlayBuildFilters(c, mode)
  );
  if (!pool.length) {
    pool = candidates.filter((c) => c.edge > 0 && c.confidence !== "low" && c.edge >= 0.03);
  }

  // ── Best value: target legs, ML-ranked ───────────────────────────────────
  let legsBest = greedyBuild(pool, target, {
    maxPerSport,
    preferSafer: false,
    preferPayout: false,
    mode,
    weights,
  });
  while (legsBest.length > 2 && !passesHardRules(legsBest, maxPerSport)) {
    legsBest = legsBest.slice(0, -1);
  }
  if (legsBest.length < 2) {
    legsBest = pool.filter((c) => c.confidence !== "low").slice(0, Math.min(target, Math.max(2, pool.length)));
  }
  const bestValue = scoreParlay(
    legsBest.length ? legsBest : pool.slice(0, Math.min(3, pool.length)),
    mode,
    weights
  );

  // ── Safer: min legs, prioritise hit probability ───────────────────────────
  const legsSafe = greedyBuild(pool, min, {
    maxPerSport,
    preferSafer: true,
    preferPayout: false,
    mode,
    weights,
  });
  const safer = scoreParlay(legsSafe, mode, weights);

  // ── Higher payout: max legs, more underdogs ───────────────────────────────
  const legsPay = greedyBuild(pool, max, {
    maxPerSport: maxPerSport + 1,
    preferSafer: false,
    preferPayout: true,
    mode,
    weights,
  });
  const higherPayout = scoreParlay(legsPay, mode, weights);

  return { bestValue, safer, higherPayout };
}

export function optimizeForMode(
  candidates: ValueBetCandidate[],
  mode: ParlayBuildMode,
  weights: AnalyticsWeights = {}
): SmartParlayResult {
  return optimizeSmartParlays(candidates, mode, weights).bestValue;
}

/**
 * Best-effort fixed-size parlay from a pre-filtered pool (e.g. ranked-live presets).
 */
export function optimizeFixedLegCount(
  candidates: ValueBetCandidate[],
  legCount: number,
  maxPerSport = 4,
  mode: ParlayBuildMode = "balanced",
  weights: AnalyticsWeights = {}
): SmartParlayResult | null {
  const pool = candidates.filter(
    (c) => c.edge > 0 && c.confidence !== "low" && legPassesParlayBuildFilters(c, mode)
  );
  if (pool.length < legCount) return null;

  let legs = greedyBuild(pool, legCount, {
    maxPerSport,
    preferSafer: false,
    preferPayout: false,
    mode,
    weights,
    skipRecommendedFilter: true,
  });
  while (legs.length > 2 && !passesHardRules(legs, maxPerSport)) {
    legs = legs.slice(0, -1);
  }
  if (legs.length < legCount) {
    legs = greedyBuild(pool, legCount, {
      maxPerSport,
      preferSafer: true,
      preferPayout: false,
      mode,
      weights,
      skipRecommendedFilter: true,
    });
    while (legs.length > 2 && !passesHardRules(legs, maxPerSport)) {
      legs = legs.slice(0, -1);
    }
  }
  if (legs.length < legCount) return null;
  return scoreParlay(legs, mode, weights);
}
