import type { ConfidenceLevel } from "@/data/mockGames";
import { MIN_EDGE_RECOMMEND } from "@/lib/bettingIntelligence";
import {
  parlayAmericanOdds,
  payoutMultiplierFromAmerican,
} from "@/lib/valueParlay/oddsMath";
import { correlatedParlayHitProbability } from "@/lib/valueParlay/correlatedParlayProbability";
import type { ParlayBuildMode, ParlayTriple, SmartParlayResult, ValueBetCandidate } from "@/lib/valueParlay/types";
import {
  mlbPropCategory,
  mlbPropPriorityAdjustment,
  newHitterStackContext,
  recordHitterPick,
  sameTeamHitterPenaltyFor,
} from "@/lib/valueParlay/mlbPropRanking";
import {
  applyRiskRules,
  countByRiskLevel,
  getPropRiskLevel,
} from "@/lib/valueParlay/propRiskLevels";

/**
 * Same-game dependent stat pairs — when both are present in the same
 * gameId, the joint outcome is correlated (not independent), so the
 * optimizer rejects adding the second.
 */
const DEPENDENT_PAIRS_FLAT: Array<[string, string]> = [
  ["rbis", "runs"],
  ["home_runs", "rbis"],
  ["home_runs", "runs"],
  ["hits", "total_bases"],
  ["hits_runs", "hits_runs_rbis"],
  ["runs_rbis", "hits_runs_rbis"],
];
const DEPENDENT_PAIR_LOOKUP = new Set<string>(
  DEPENDENT_PAIRS_FLAT.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]),
);

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
  // Dependency-chain stacking — e.g. two same-team hitters in the same game.
  // Mild soft penalty: doesn't reject, just deprioritises. Hard rejection
  // happens only in the cash-out single-sport fallback builder.
  const chainInGame = new Map<string, number>();
  for (const l of legs) {
    const k = `${l.gameId}:${dependencyChainKey(l)}`;
    chainInGame.set(k, (chainInGame.get(k) ?? 0) + 1);
  }
  for (const n of chainInGame.values()) {
    if (n >= 2) pen += 10 * (n - 1);
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

/**
 * Strict per-leg quality required when a parlay exceeds 4 legs.
 * Five+ leg parlays only ship if every leg clears these gates — otherwise
 * the optimizer chops down to a 2-4 leg version. This codifies the
 * "prefer 2–4 strong legs over 5+ weak legs" rule.
 */
function legIsStrongFor5PlusParlay(c: ValueBetCandidate): boolean {
  if (c.confidence === "low") return false;
  if ((c.modelProbability ?? 0) < 0.55) return false;
  if (c.volatilityScore >= 60) return false;
  if (c.stabilityScore !== undefined && c.stabilityScore < 0.55) return false;
  if (c.timingUrgency === "wait") return false;
  if (c.recentHitRate != null
      && (c.recentHitRateSamples ?? 0) >= 3
      && c.recentHitRate < 0.45) return false;
  return true;
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

  // MLB player intelligence: additive priority adjustment for MLB market types.
  // Allows strong pitcher/hitter props to outrank weak full-game team bets.
  // Range: −0.04 to +0.05. No effect on non-MLB legs.
  let mlbPropAdj = 0;
  if ((c.sport ?? "").toLowerCase() === "mlb") {
    const cat = mlbPropCategory(c.statType, c.pickType, c.matchupLabel ?? "");
    mlbPropAdj = mlbPropPriorityAdjustment(cat, edge01);
  }

  // NFL injury position multiplier: adjusts legScore when OUT-status injuries
  // structurally affect expected opportunity or matchup quality.
  // Pre-computed in buildCandidates for NFL only; 0 for all other sports.
  // Clamped to ±0.08 at source; never overrides edge/ML/confidence.
  const injuryAdj = Math.min(0.08, Math.max(-0.08, c.injuryImpactAdj ?? 0));

  // Recent-performance adjustment: how often the player cleared the line in
  // the picked direction across their last ~5 games. Centered at 0.5; deviation
  // maps linearly to ±0.06. Undefined rate → 0 (no effect). Requires at least
  // 3 decided samples to count.
  const rhr      = c.recentHitRate;
  const samples  = c.recentHitRateSamples ?? 0;
  const recentAdj = (rhr != null && samples >= 3)
    ? Math.min(0.06, Math.max(-0.06, (rhr - 0.5) * 0.12))
    : 0;

  // Weight schedule: edge remains primary driver but ml_hit_probability and
  // stability_score get a slight bump so fragile legs are less likely to rank
  // into safe-tier parlays. Weights sum to ~1.0 with additive analytics adj.
  return (
    edge01         * 0.30 +
    hitProb01      * 0.24 +
    confAdjusted   * 0.17 +
    timing01       * 0.11 +
    stability01    * 0.10 +
    marketAdj      * 0.05 +
    sportAdj       * 0.03 +
    mlbPropAdj            + // additive; bounded by mlbPropPriorityAdjustment()
    injuryAdj             + // additive; bounded to ±0.08; NFL only
    recentAdj               // additive; bounded to ±0.06; player_prop only
  );
}

// ── Tier-aware leg filter ─────────────────────────────────────────────────────

/**
 * Per-tier minimum floors for individual legs.
 * A leg below any of these is rejected before it can enter the parlay pool.
 *
 * SAFE is the most selective — weakest-leg quality matters more than average
 * card quality, and tight floors prevent one fragile leg from contaminating
 * an otherwise strong card.
 *
 * Cash-Out uses safe-grade leg quality because early legs must resolve reliably
 * for cash-out offers to appear; the cash-out *structure* layer then re-orders.
 */
interface TierFloors {
  maxVolatility: number;
  minStability: number;     // requires c.stabilityScore when present
  minHitProb:   number;     // ml_hit_probability / modelProbability
  minLegScore:  number;     // target floor for computeLegScore
  allowWait:    boolean;
  waitMinEdge:  number;     // when allowWait=true and leg is wait-timing
  maxMediumConfidenceLegs: number;
  /**
   * Minimum recent-hit-rate for player props. Rejects props where the player
   * missed the line in most of their last 5 games. Only applied when the
   * candidate has a valid recentHitRate with ≥ 3 samples.
   */
  minRecentHitRate: number;
  /**
   * Minimum implied probability from the American odds. Prevents longshot
   * alt lines like "Rebounds 7+ at +270" (27% implied) from entering
   * high-confidence tiers even when the model sees edge. A positive-edge
   * longshot is still a longshot — this floor cuts them at the door.
   */
  minImpliedProbability: number;
}

function tierFloors(mode: ParlayBuildMode): TierFloors {
  if (mode === "safe") {
    // SAFE only accepts legs that imply ≥ 55% hit rate from the odds alone.
    // Roughly equivalent to "no worse than about -120 American".
    return {
      maxVolatility: 45,
      minStability:  0.62,
      minHitProb:    0.62,
      minLegScore:   0.60,
      allowWait:     false,
      waitMinEdge:   999,
      maxMediumConfidenceLegs: 1,
      minRecentHitRate: 0.45,
      minImpliedProbability: 0.55,
    };
  }
  if (mode === "balanced") {
    // BALANCED lets moderate underdogs in (≥ ~44% implied, i.e. -130 to +130).
    return {
      maxVolatility: 65,
      minStability:  0.52,
      minHitProb:    0.54,
      minLegScore:   0.54,
      allowWait:     true,
      waitMinEdge:   0.09,
      maxMediumConfidenceLegs: 2,
      minRecentHitRate: 0.35,
      minImpliedProbability: 0.44,
    };
  }
  if (mode === "cashout") {
    // Cash-out early legs must resolve reliably — same implied floor as SAFE.
    return {
      maxVolatility: 55,
      minStability:  0.58,
      minHitProb:    0.58,
      minLegScore:   0.56,
      allowWait:     false,
      waitMinEdge:   999,
      maxMediumConfidenceLegs: 1,
      minRecentHitRate: 0.40,
      minImpliedProbability: 0.52,
    };
  }
  if (mode === "bigwin") {
    // Big Win — strict per-leg quality so 4-leg cards reach +800 to +1200
    // without relying on longshot legs. Each leg still needs to hit at a
    // realistic clip; the upside comes from compounding good legs, not
    // praying on a +500 dog.
    return {
      maxVolatility: 55,
      minStability:  0.55,
      minHitProb:    0.50,
      minLegScore:   0.54,
      allowWait:     false,
      waitMinEdge:   999,
      maxMediumConfidenceLegs: 2,
      minRecentHitRate: 0.40,
      minImpliedProbability: 0.40,
    };
  }
  if (mode === "lotto") {
    // Lotto — clearly risky, anything goes. Still rejects negative edge
    // and ultra-low samples but otherwise no floors.
    return {
      maxVolatility: 100,
      minStability:  0,
      minHitProb:    0,
      minLegScore:   0,
      allowWait:     true,
      waitMinEdge:   0,
      maxMediumConfidenceLegs: Number.POSITIVE_INFINITY,
      minRecentHitRate: 0,
      minImpliedProbability: 0,
    };
  }
  // aggressive
  return {
    maxVolatility: 100,
    minStability:  0,
    minHitProb:    0,
    minLegScore:   0,
    allowWait:     true,
    waitMinEdge:   0,
    maxMediumConfidenceLegs: Number.POSITIVE_INFINITY,
    minRecentHitRate: 0,
    minImpliedProbability: 0,
  };
}

/**
 * Mode-aware leg gating.
 *
 * SAFE:       exclude wait-timing, volatility ≥ 50, stability < 0.58, hitProb < 0.54
 * BALANCED:   exclude volatility ≥ 65, stability < 0.50; wait allowed at edge ≥ 0.09
 * CASHOUT:    safe-grade gates; leg ordering handled separately
 * AGGRESSIVE: minimal hard filters — still blocks structurally bad legs
 */
function legPassesParlayBuildFilters(c: ValueBetCandidate, mode: ParlayBuildMode = "balanced"): boolean {
  return diagnoseLegRejection(c, mode) === null;
}

/**
 * Same gating as legPassesParlayBuildFilters, but returns the reason a leg
 * was rejected (or null when it passes). Exposed so ML logging can attribute
 * each exclusion to a specific rule.
 */
export function diagnoseLegRejection(
  c: ValueBetCandidate,
  mode: ParlayBuildMode = "balanced",
): string | null {
  if (c.edge <= 0) return "non_positive_edge";
  if (c.americanOdds <= -350 && c.edge < 0.07) return "heavy_favorite_low_edge";

  const floors = tierFloors(mode);

  if (c.volatilityScore >= floors.maxVolatility) return "tier_floor_volatility";
  if (c.stabilityScore !== undefined && c.stabilityScore < floors.minStability) return "tier_floor_stability";
  if ((c.modelProbability ?? 0) < floors.minHitProb) return "tier_floor_hit_prob";
  if ((c.impliedProbability ?? 0) < floors.minImpliedProbability) return "tier_floor_implied_prob";

  // Recent-performance gate — only applied when we have a real sample.
  // Rejects player props where the player has missed the line in most of
  // their last games. Game-level picks and unenriched props skip this.
  if (c.pickType === "player_prop"
      && floors.minRecentHitRate > 0
      && c.recentHitRate != null
      && (c.recentHitRateSamples ?? 0) >= 3
      && c.recentHitRate < floors.minRecentHitRate) {
    return "recent_hit_rate_too_low";
  }

  if (c.americanOdds > 0 && c.volatilityScore >= 55 && c.edge <= 0.08) return "underdog_volatility_trap";

  const timing = c.timingUrgency;
  if (timing === "wait") {
    if (!floors.allowWait) return "timing_wait_blocked";
    if (c.edge < floors.waitMinEdge) return "timing_wait_edge_insufficient";
  }

  if ((mode === "safe" || mode === "cashout")
      && (c.sport ?? "").toLowerCase() === "mlb"
      && c.pickType === "player_prop") {
    const cat = mlbPropCategory(c.statType, c.pickType, c.matchupLabel ?? "");
    if (cat === "hitter_high_vol") return "mlb_hitter_high_vol_safe_gate";
  }

  // Hard-block longshot-prone stat categories in SAFE / CASHOUT regardless
  // of how good the posted edge looks (triples, specific-inning markets,
  // "first-of-game" props, etc.). Balanced/Aggressive still allow them.
  if ((mode === "safe" || mode === "cashout") && isHighVarianceStatType(c.statType)) {
    return "longshot_stat_category";
  }

  return null;
}

// ── High-variance prop guardrails ─────────────────────────────────────────────
// Some stat_types are inherently longshot-prone regardless of the individual
// player (triples, stolen bases, specific-inning markets). Legs that hit these
// categories get an implicit volatility bump so SAFE / CASHOUT tier floors
// reject them automatically, while AGGRESSIVE still allows them.

const HIGH_VARIANCE_STAT_TYPES = new Set<string>([
  // MLB — covered additionally in MLB_STAT_VOLATILITY_FLOOR
  "triples", "reach_on_error",
  "first_hit", "first_rbi", "first_stolen_base", "first_run",
  // NBA — "only a guard's 7+ rebounds ever becomes a +270 price"
  // The stat_type itself isn't the problem; the threshold is. But when the
  // book line produces a > +200 line for a non-high-variance stat, the
  // implied-probability floor catches it. We keep this set minimal so we
  // don't block legitimate prime-line NBA points/rebounds props.
  "four_pt_made", "six_pt_play", "triple_double",
  // NFL
  "longest_completion", "longest_reception", "longest_rush",
  "interceptions_thrown_by_qb", // volatile single-event
]);

function isHighVarianceStatType(statType: string | undefined): boolean {
  if (!statType) return false;
  return HIGH_VARIANCE_STAT_TYPES.has(statType.toLowerCase());
}

// ── Preferred odds ranges per tier ────────────────────────────────────────────
// Soft preference — parlays with combined odds in the target range get a small
// structure bonus. Never blocks other payouts; just nudges ranking.

function targetParlayOddsRange(mode: ParlayBuildMode): { lo: number; hi: number } | null {
  if (mode === "safe")     return { lo: 120, hi: 320 };
  if (mode === "balanced") return { lo: 250, hi: 550 };
  if (mode === "cashout")  return { lo: 180, hi: 420 };
  if (mode === "bigwin")   return { lo: 800, hi: 1200 };
  if (mode === "lotto")    return { lo: 1500, hi: 5000 };
  return null; // aggressive: no preference
}

function oddsInRangeBonus(combinedAmerican: number, mode: ParlayBuildMode): number {
  const r = targetParlayOddsRange(mode);
  if (!r) return 0;
  if (combinedAmerican >= r.lo && combinedAmerican <= r.hi) return 1;
  // Soft roll-off: half credit within 20% outside the range
  const slack = (r.hi - r.lo) * 0.2;
  if (combinedAmerican >= r.lo - slack && combinedAmerican <= r.hi + slack) return 0.5;
  return 0;
}

function oddsInRangePerLeg(mode: ParlayBuildMode, odds: number): number {
  if (mode === "safe") {
    if (odds >= -180 && odds <= 130) return 1;
    return 0;
  }
  if (mode === "balanced" || mode === "cashout") {
    if (odds >= -160 && odds <= 180) return 1;
    return 0;
  }
  if (mode === "bigwin") {
    // Each leg should pay ~+150 to +250 so 4 legs compound into +800–1200
    if (odds >= 100 && odds <= 280) return 1;
    return 0;
  }
  return 1;
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

  // Structural risk rules: HIGH-risk leg cap, stat-type stacking,
  // dependent MLB pairs (RBI+Runs etc), variance flag.
  const r = applyRiskRules(legs);
  for (const msg of r.warnings) w.push(msg);

  return w;
}

// ── Fragility score ───────────────────────────────────────────────────────────

/**
 * Composite fragility 0–100. Drivers:
 *   - weakest leg quality vs tier floor (40%)
 *   - medium-confidence density (20%)
 *   - same-game exposure (20%)
 *   - volatility concentration (20%)
 */
function fragilityScore(
  legs: ValueBetCandidate[],
  mode: ParlayBuildMode,
  weights: AnalyticsWeights = {},
): { score: number; weakestLegScore: number } {
  if (!legs.length) return { score: 0, weakestLegScore: 0 };
  const floors = tierFloors(mode);
  const perLegScores = legs.map((l) => computeLegScore(l, weights));
  const weakest = Math.min(...perLegScores);

  // Weakest leg component — how far below the floor are we? 0 when at or above.
  const weakestDeficit = Math.max(0, floors.minLegScore - weakest);
  const weakestComponent = Math.min(1, weakestDeficit / 0.15) * 40;

  const mediumCount = legs.filter((l) => l.confidence === "medium").length;
  const mediumOver  = Math.max(0, mediumCount - floors.maxMediumConfidenceLegs);
  const mediumComponent = Math.min(1, mediumOver / 2) * 20;

  const gameCounts = new Map<string, number>();
  for (const l of legs) gameCounts.set(l.gameId, (gameCounts.get(l.gameId) ?? 0) + 1);
  let sameGameExcess = 0;
  for (const n of gameCounts.values()) if (n > 1) sameGameExcess += (n - 1);
  const sameGameComponent = Math.min(1, sameGameExcess / 2) * 20;

  const highVolCount = legs.filter((l) => l.volatilityScore >= 58).length;
  const volComponent = Math.min(1, highVolCount / 2) * 20;

  return {
    score: Math.round(weakestComponent + mediumComponent + sameGameComponent + volComponent),
    weakestLegScore: Math.round(weakest * 1000) / 1000,
  };
}

// ── Stagger score (cash-out helper) ───────────────────────────────────────────

/**
 * 0–1 diversity of start times across legs.
 * Uses gameTimeLabel when present; falls back to gameId distinctness.
 */
function staggerDiversity(legs: ValueBetCandidate[]): number {
  if (!legs.length) return 0;
  const labels = legs.map((l) => l.gameTimeLabel ?? `g:${l.gameId}`);
  const unique = new Set(labels);
  return unique.size / legs.length;
}

// ── Stat dependency chain ─────────────────────────────────────────────────────

/**
 * Classifies a leg by its outcome driver so we can block two legs that
 * depend on the same underlying event from sharing a single-sport parlay.
 *
 * Two legs with the same key + same gameId share a dependency chain (e.g.
 * two hitters on the same team in the same game). Two legs with the same
 * key but different gameIds are acceptable (e.g. two NFL rushing props
 * from different games).
 *
 * Key format:
 *   - MLB player prop → "mlb:pitcher" | "mlb:hitter"
 *   - NFL player prop → "nfl:pass" | "nfl:rush" | "nfl:receive" | "nfl:{stat}"
 *   - NBA player prop → "nba:score" | "nba:reb" | "nba:ast" | "nba:{stat}"
 *   - other player_prop → "{sport}:{statType}"
 *   - team bet → "{sport}:{pickType}"
 */
function dependencyChainKey(c: ValueBetCandidate): string {
  const sport = String(c.sport).toLowerCase();
  if (c.pickType !== "player_prop") {
    return `${sport}:${c.pickType}`;
  }
  const stat = (c.statType ?? "").toLowerCase();
  if (sport === "mlb") {
    const cat = mlbPropCategory(c.statType, c.pickType, c.matchupLabel ?? "");
    if (cat === "pitcher_strikeouts" || cat === "pitcher_other") return "mlb:pitcher";
    return "mlb:hitter";
  }
  if (sport === "nfl") {
    if (stat.includes("pass"))    return "nfl:pass";
    if (stat.includes("rush"))    return "nfl:rush";
    if (stat.includes("recept") || stat.includes("receiv")) return "nfl:receive";
    return `nfl:${stat}`;
  }
  if (sport === "nba") {
    if (stat.includes("point") || stat === "threes") return "nba:score";
    if (stat.includes("reb"))    return "nba:reb";
    if (stat.includes("assist")) return "nba:ast";
    if (stat === "pra")          return "nba:pra";
    return `nba:${stat}`;
  }
  return `${sport}:${stat || "prop"}`;
}

/**
 * True when two legs share the *same dependency chain AND the same game*.
 * That's the combo we need to block in single-sport fallback builds:
 *   - same game + same chain (e.g. two same-team hitters) → blocked
 *   - same game + different chain (pitcher K + hitter TB) → allowed
 *   - different game + same chain (rushing in two games)  → allowed
 */
function legsShareDependencyChainSameGame(
  a: ValueBetCandidate,
  b: ValueBetCandidate,
): boolean {
  if (a.gameId !== b.gameId) return false;
  return dependencyChainKey(a) === dependencyChainKey(b);
}

// ── Parlay scorer ─────────────────────────────────────────────────────────────

/**
 * Composite parlay quality score.
 *
 * parlayScore = avg_legScore*0.55 + timingQScore*0.12 + sportDivScore*0.08
 *             + marketStrScore*0.07 + confSpreadScore*0.06
 *             - corrPen*0.07 - volPen*0.05 - weakestLegPen*0.10 - fragPen*0.08
 *             + targetOddsBonus*0.03 + cashoutStructure*0.04  (cashout only)
 *
 * Weakest-leg and fragility penalties are tier-aware — stronger in safe/cashout,
 * milder in balanced, tolerated in aggressive. Stability and volatility get a
 * slight bump in safe/balanced via the penalty layer (not the leg-score layer)
 * to keep the leg-score API stable for callers.
 */
function scoreParlay(
  legs: ValueBetCandidate[],
  mode: ParlayBuildMode = "balanced",
  weights: AnalyticsWeights = {}
): SmartParlayResult {
  const odds     = legs.map((l) => l.americanOdds);
  const combined = parlayAmericanOdds(odds);
  const probs    = legs.map((l) => l.modelProbability);
  // Correlation-aware joint probability — accounts for same-game /
  // same-team movement instead of assuming leg independence. Falls back
  // to the naive product for single-leg or uncorrelated pools.
  const hit      = correlatedParlayHitProbability(legs, probs);
  const mult     = payoutMultiplierFromAmerican(combined);

  // Per-leg scores (reused across multiple components)
  const perLegScores = legs.map((l) => computeLegScore(l, weights));
  const avgLegScore  = perLegScores.reduce((s, x) => s + x, 0) / legs.length;
  const weakestLeg   = Math.min(...perLegScores);

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

  // Weakest-leg penalty: max(0, tierFloor − minLegScore). Matters most in safe/cashout.
  const floors = tierFloors(mode);
  const weakestDeficit   = Math.max(0, floors.minLegScore - weakestLeg);
  const weakestPenWeight = (mode === "safe" || mode === "cashout") ? 0.10
                         : (mode === "balanced") ? 0.06
                         : 0.02;

  // Fragility
  const frag = fragilityScore(legs, mode, weights);
  const fragPen01 = frag.score / 100;
  const fragPenWeight = (mode === "safe") ? 0.08
                      : (mode === "cashout") ? 0.07
                      : (mode === "balanced") ? 0.04
                      : 0.01;

  // Target-odds soft preference
  const targetOddsBonus = oddsInRangeBonus(combined, mode); // 0, 0.5, or 1
  const legOddsInRange  = legs.filter((l) => oddsInRangePerLeg(mode, l.americanOdds)).length / legs.length;

  // Stat-type diversity — discourages multiple legs that share the same
  // outcome driver (e.g. two pass-dependent props, two same-game hitters).
  // Pure player_prop legs diversify on statType; team bets on marketType+pickType.
  const driverKeys = legs.map((l) =>
    l.pickType === "player_prop"
      ? `prop:${(l.statType ?? "").toLowerCase()}`
      : `team:${l.pickType}`
  );
  const uniqueDrivers = new Set(driverKeys).size;
  const statTypeDiv   = uniqueDrivers / legs.length; // 1.0 = all different

  // Cash-out structure score — four equal-ish weighted terms per the spec.
  //
  //   cashoutScore = timeSeparation*0.30 + earlyLegStrength*0.30
  //                + independence*0.20   + payoutBalance*0.20
  //
  // Used as a secondary ranking signal via cashoutStructure * 0.04 below.
  // Does not influence Regular parlay scoring (mode !== "cashout" skips).
  let cashoutStructure = 0;
  if (mode === "cashout" && legs.length >= 2) {
    // (1) Time separation — legs spread across different start windows.
    //     Uses gameTimeLabel when present, falls back to gameId distinctness.
    const timeSeparation = staggerDiversity(legs);

    // (2) Early leg strength — the first leg must carry the card. Blend of
    //     its hit probability, inverse volatility, and stability.
    const first = legs[0];
    const earlyHit   = first.modelProbability ?? 0.5;
    const earlyVolOk = 1 - Math.min(100, first.volatilityScore ?? 50) / 100;
    const earlyStab  = first.stabilityScore ?? 0.5;
    const earlyLegStrength = earlyHit * 0.5 + earlyVolOk * 0.3 + earlyStab * 0.2;

    // (3) Independence — mean of per-axis diversity: games, teams, stat types.
    const gameDiv = new Set(legs.map((l) => l.gameId)).size / legs.length;
    const teamDiv = new Set(legs.map((l) => l.teamId ?? `g:${l.gameId}`)).size / legs.length;
    const statDiv = new Set(legs.map((l) => l.statType ?? l.marketType ?? "")).size / legs.length;
    const independence = (gameDiv + teamDiv + statDiv) / 3;

    // (4) Payout balance — reward "high-prob early + upside late" structure
    //     without drifting into all-longshot territory. Combines:
    //       a) final leg has higher odds than first (directional check)
    //       b) average implied probability sits in the 0.55–0.70 sweet spot
    const last = legs[legs.length - 1];
    const directional = last.americanOdds > first.americanOdds ? 1
                      : last.americanOdds === first.americanOdds ? 0.5 : 0;
    const avgImplied = legs.reduce((s, l) => s + (l.impliedProbability ?? 0.5), 0) / legs.length;
    const sweetSpotDeviation = Math.abs(avgImplied - 0.625);
    const balanceScore = Math.max(0, 1 - sweetSpotDeviation / 0.25);
    const payoutBalance = directional * 0.5 + balanceScore * 0.5;

    cashoutStructure =
      timeSeparation   * 0.30 +
      earlyLegStrength * 0.30 +
      independence     * 0.20 +
      payoutBalance    * 0.20;
  }

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
    // Slightly stronger volatility penalty so low-stability combinations
    // cost more at the parlay level (complements stability weight bump in
    // computeLegScore).
    volPen01        * 0.06 -
    // Weakest-leg penalty: normalized deficit scaled by tier weight.
    // Max effect at ~0.15 deficit (full floor miss) → weakestPenWeight*1.0
    Math.min(1, weakestDeficit / 0.15) * weakestPenWeight -
    fragPen01       * fragPenWeight +
    targetOddsBonus * 0.03 +
    legOddsInRange  * 0.02 +
    statTypeDiv     * 0.02 +
    cashoutStructure * 0.04;

  // Card confidence
  const avgConf = confSpreadScore;
  let cardConf: ConfidenceLevel = "high";
  if (avgConf < 0.55 || hit < 0.12) cardConf = "low";
  else if (avgConf < 0.72 || hit < 0.22) cardConf = "medium";

  // Strongest / weakest leg by computed leg score.
  let strongestIdx = 0, weakestIdx = 0;
  for (let i = 1; i < perLegScores.length; i++) {
    if (perLegScores[i] > perLegScores[strongestIdx]) strongestIdx = i;
    if (perLegScores[i] < perLegScores[weakestIdx])   weakestIdx   = i;
  }

  // Per-leg short reason (used by the UI to explain "why each leg was included")
  const legInclusionReasons = legs.map((l, i) => {
    const score = perLegScores[i];
    const parts: string[] = [];
    if (l.confidence === "high") parts.push("HIGH conf");
    if (l.edge >= 0.06)          parts.push(`edge +${(l.edge * 100).toFixed(1)}%`);
    if ((l.modelProbability ?? 0) >= 0.62) parts.push(`hit ${((l.modelProbability ?? 0) * 100).toFixed(0)}%`);
    if ((l.recentHitRate ?? 0) >= 0.6)     parts.push(`L5 ${Math.round((l.recentHitRate ?? 0) * 100)}%`);
    if (l.timingUrgency === "now")         parts.push("timing now");
    if (parts.length === 0) parts.push(`leg score ${score.toFixed(2)}`);
    return parts.join(" · ");
  });

  // "Would I personally take this?" — strict EV + quality check.
  // EV per $1: hit * payoutMult − 1. Positive EV is necessary but not
  // sufficient — also require fragility under threshold and at least
  // medium card confidence. Lotto mode is always "no" by design.
  const evPerDollar = hit * mult - 1;
  const okEV         = evPerDollar > 0.02;
  const okFragility  = frag.score < 55;
  const okConfidence = cardConf !== "low";
  const okWeakest    = perLegScores[weakestIdx] >= floors.minLegScore - 0.05;
  const noLowConf    = !legs.some((l) => l.confidence === "low");
  const wouldITakeIt = mode !== "lotto" && okEV && okFragility && okConfidence && okWeakest && noLowConf;
  const wouldITakeItReason = mode === "lotto"
    ? "Lotto mode is risky by design — never a personal-take recommendation"
    : !okEV         ? `EV/$1 = ${evPerDollar.toFixed(3)} — payout doesn't justify hit prob`
    : !okFragility  ? `Fragility ${frag.score} — too sensitive to one weak leg`
    : !okConfidence ? `Card confidence ${cardConf} — too uncertain to back`
    : !okWeakest    ? `Weakest leg below tier floor (${perLegScores[weakestIdx].toFixed(2)} vs ${floors.minLegScore})`
    : !noLowConf    ? "Includes a LOW confidence leg"
    : "Hit probability + payout + leg quality all clear";

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
    fragilityScore:            frag.score,
    weakestLegScore:           frag.weakestLegScore,
    strongestLegId:            legs[strongestIdx]?.id,
    weakestLegId:              legs[weakestIdx]?.id,
    legInclusionReasons,
    wouldITakeIt,
    wouldITakeItReason,
    riskLevelCounts:           countByRiskLevel(legs),
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
    /** Max legs from the same game/event. Defaults: safe=1, balanced=2, aggressive=2, cashout=1. */
    maxPerGame?: number;
    /** Max hitters from the same MLB team. Default: safe/cashout=1, balanced=2, aggressive=3. */
    maxHittersPerTeam?: number;
    /** Max player-prop legs for the same team. Default: safe/cashout=1, balanced=2, aggressive=3. */
    maxSameTeamProps?: number;
    /** Max medium-confidence legs total. Default: from tierFloors.maxMediumConfidenceLegs. */
    maxMediumConfLegs?: number;
    /**
     * When true, reject a candidate if it shares the same (gameId, dependencyChain)
     * as an already-picked leg. Loosens cross-sport requirement for single-sport
     * fallbacks while still blocking multiple same-team-same-game hitters, etc.
     */
    enforceDependencyChainDiversity?: boolean;
  }
): ValueBetCandidate[] {
  const weights       = opts.weights ?? {};
  const isSafeLike    = opts.mode === "safe" || opts.mode === "cashout";
  const maxCombatLegs = opts.maxCombatLegs ?? (opts.mode === "aggressive" ? 2 : 1);
  const maxPerGame    = opts.maxPerGame    ?? (isSafeLike ? 1 : 2);
  const maxHittersPerTeam = opts.maxHittersPerTeam
    ?? (isSafeLike ? 1 : opts.mode === "balanced" ? 2 : 3);
  const maxSameTeamProps  = opts.maxSameTeamProps
    ?? (isSafeLike ? 1 : opts.mode === "balanced" ? 2 : 3);
  const maxMediumConfLegs = opts.maxMediumConfLegs ?? tierFloors(opts.mode).maxMediumConfidenceLegs;

  // Stack context is built up as MLB hitters are picked, adding a small
  // correlation dampener (±0.02/step) on top of the stateless computeLegScore.
  // Does not modify edge/ML/calibration — only nudges greedy ordering.
  const stackCtx = newHitterStackContext();
  const keyFor = (c: ValueBetCandidate): number =>
    computeLegScore(c, weights) + sameTeamHitterPenaltyFor(c, stackCtx);

  const compare = (a: ValueBetCandidate, b: ValueBetCandidate): number => {
    if (opts.preferSafer) {
      const rd = a.riskScore - b.riskScore;
      if (Math.abs(rd) > 3) return rd;
    }
    if (opts.preferPayout) {
      const ad = b.americanOdds - a.americanOdds;
      if (Math.abs(ad) > 20) return ad;
    }
    return keyFor(b) - keyFor(a);
  };

  const remaining = [...pool];
  const picked: ValueBetCandidate[] = [];
  const gameCounts = new Map<string, number>();
  const sportC: Record<string, number> = {};
  const hittersByTeam = new Map<string, number>();
  const propsByTeam = new Map<string, number>();
  const statTypeCounts = new Map<string, number>();
  let combatCount = 0;
  let mediumConfCount = 0;
  let highRiskCount = 0;
  // Lotto mode is risky-on-purpose; everywhere else, hard cap at 1 HIGH-risk leg.
  const maxHighRiskLegs = opts.mode === "lotto" ? 99 : 1;
  // Stat-type stacking cap — never allow 3+ legs of identical stat in
  // any mode. Lotto allows 2 (lottery feel), others cap at 2.
  const maxSameStatType = opts.mode === "lotto" ? 3 : 2;

  const isMlbHitterProp = (c: ValueBetCandidate): boolean => {
    if ((c.sport ?? "").toLowerCase() !== "mlb") return false;
    if (c.pickType !== "player_prop") return false;
    const cat = mlbPropCategory(c.statType, c.pickType, c.matchupLabel ?? "");
    return cat === "hitter_total_bases" || cat === "hitter_hits" || cat === "hitter_high_vol";
  };

  const accept = (idx: number): boolean => {
    const c = remaining[idx];
    const gc = (gameCounts.get(c.gameId) ?? 0) + 1;
    if (gc > maxPerGame) return false;
    const sc = (sportC[c.sport] ?? 0) + 1;
    if (sc > opts.maxPerSport) return false;
    if (isCombatSport(c.sport) && combatCount >= maxCombatLegs) return false;
    if (c.confidence === "medium" && mediumConfCount >= maxMediumConfLegs) return false;

    // Risk-tier cap — at most 1 HIGH-risk leg per parlay (RBIs, runs,
    // home runs, stolen bases, blocks, steals, doubles, triples,
    // walks, leader bets, KO/Sub markets). Lotto mode bypasses.
    const risk = getPropRiskLevel(c);
    if (risk === "high" && highRiskCount >= maxHighRiskLegs) return false;

    // Stat-type stacking cap — block when adding this leg would create
    // 3+ legs of the same stat type. Stops "5 player-points props" parlays.
    const statKey = (c.statType ?? "").toLowerCase();
    if (statKey) {
      const next = (statTypeCounts.get(statKey) ?? 0) + 1;
      if (next > maxSameStatType) return false;
    }

    // Dependent-pair guard — block adding a leg whose stat forms a
    // known dependent pair with an already-picked leg in the same game
    // (RBI+Runs, HR+RBI, Hits+TB). Lotto bypasses.
    if (opts.mode !== "lotto" && statKey) {
      for (const p of picked) {
        if (p.gameId !== c.gameId) continue;
        const pStat = (p.statType ?? "").toLowerCase();
        if (!pStat) continue;
        if (DEPENDENT_PAIR_LOOKUP.has(`${statKey}|${pStat}`)) return false;
      }
    }

    // Same-team player-prop cap — all sports
    if (c.pickType === "player_prop" && c.teamId) {
      const teamKey = `${c.sport}:${c.teamId}`;
      const tp = (propsByTeam.get(teamKey) ?? 0) + 1;
      if (tp > maxSameTeamProps) return false;
    }

    // MLB hitter-per-team cap — separate from generic same-team-props.
    // Enforces max 1 hitter per team in SAFE/CASHOUT even if other same-team
    // props (e.g. pitcher K) also exist.
    if (isMlbHitterProp(c) && c.teamId) {
      const h = (hittersByTeam.get(c.teamId) ?? 0) + 1;
      if (h > maxHittersPerTeam) return false;
    }

    // Dependency-chain diversity (single-sport fallback guard): block if the
    // candidate shares both gameId AND dependency chain with any picked leg.
    if (opts.enforceDependencyChainDiversity) {
      for (const p of picked) {
        if (legsShareDependencyChainSameGame(c, p)) return false;
      }
    }

    picked.push(c);
    gameCounts.set(c.gameId, gc);
    sportC[c.sport] = sc;
    if (isCombatSport(c.sport)) combatCount++;
    if (c.confidence === "medium") mediumConfCount++;
    if (risk === "high") highRiskCount++;
    if (statKey) {
      statTypeCounts.set(statKey, (statTypeCounts.get(statKey) ?? 0) + 1);
    }
    if (c.pickType === "player_prop" && c.teamId) {
      const teamKey = `${c.sport}:${c.teamId}`;
      propsByTeam.set(teamKey, (propsByTeam.get(teamKey) ?? 0) + 1);
    }
    if (isMlbHitterProp(c) && c.teamId) {
      hittersByTeam.set(c.teamId, (hittersByTeam.get(c.teamId) ?? 0) + 1);
    }
    recordHitterPick(c, stackCtx);
    remaining.splice(idx, 1);
    return true;
  };

  const pickOne = (fallback: boolean): boolean => {
    remaining.sort(compare);
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      if (!fallback) {
        if (!opts.skipRecommendedFilter && !c.isRecommended) continue;
      } else {
        if (c.confidence === "low") continue;
        if (c.edge <= 0) continue;
        if (c.edge < MIN_EDGE_RECOMMEND) continue;
        if (!legPassesParlayBuildFilters(c, opts.mode)) continue;
      }
      if (accept(i)) return true;
    }
    return false;
  };

  // Pass 1: recommended-only (or skipRecommendedFilter)
  while (picked.length < targetLegs) {
    if (!pickOne(false)) break;
  }

  // Pass 2: fallback — relax isRecommended when pool is thin
  if (picked.length < Math.min(3, targetLegs)) {
    while (picked.length < targetLegs) {
      if (!pickOne(true)) break;
    }
  }

  return picked;
}

/**
 * Reorder picked legs for cash-out friendliness:
 *   - Highest hit-probability legs in early positions
 *   - Lowest-volatility legs in early positions (pushes HR/SB/long-shot style
 *     props out of leg 1 so the first leg is more likely to resolve cleanly)
 *   - Biggest-payout leg as the final "upside capper"
 *
 * Target structure: 2 high-probability / low-volatility legs + 1 moderate
 * probability / higher-payout leg last. Does not change which legs are
 * included — only their order.
 */
function orderLegsForCashout(legs: ValueBetCandidate[]): ValueBetCandidate[] {
  if (legs.length <= 2) return [...legs];

  // Combined ordering score for early-position preference.
  // hit_prob weight dominates; volatility applies a secondary nudge.
  const earlyRank = (c: ValueBetCandidate): number => {
    const hit = c.modelProbability ?? 0;
    const volPenalty = (c.volatilityScore ?? 0) / 100;     // 0–1
    return hit - volPenalty * 0.15;
  };

  const sorted = [...legs].sort((a, b) => {
    const delta = earlyRank(b) - earlyRank(a);
    if (Math.abs(delta) > 0.005) return delta;
    return a.americanOdds - b.americanOdds; // tiebreaker: favorites first
  });

  // Move the biggest-payout leg to the end as the upside capper, only when
  // doing so doesn't displace a genuinely higher-probability leg from the
  // final slot. Skips if the biggest payout is already first (keep anchor).
  let maxOddsIdx = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].americanOdds > sorted[maxOddsIdx].americanOdds) maxOddsIdx = i;
  }
  if (maxOddsIdx !== sorted.length - 1 && maxOddsIdx !== 0) {
    const big = sorted.splice(maxOddsIdx, 1)[0];
    sorted.push(big);
  }
  return sorted;
}

// ── Tier configuration ────────────────────────────────────────────────────────

function tierConfig(mode: ParlayBuildMode): {
  min: number; target: number; max: number;
  maxPerSport: number;
} {
  // SAFE targets 2-leg parlays at roughly +120 to +320 combined odds.
  // BALANCED targets 3-leg parlays at roughly +250 to +550.
  // BIG WIN targets 4-leg cards at +800 to +1200 with strict per-leg floors.
  // LOTTO is 5–7 legs of whatever the user wants, clearly risky.
  if (mode === "safe")       return { min: 2, target: 2, max: 3,  maxPerSport: 2 };
  if (mode === "balanced")   return { min: 3, target: 3, max: 4,  maxPerSport: 3 };
  if (mode === "cashout")    return { min: 3, target: 3, max: 4,  maxPerSport: 2 };
  if (mode === "bigwin")     return { min: 3, target: 4, max: 4,  maxPerSport: 3 };
  if (mode === "lotto")      return { min: 4, target: 5, max: 7,  maxPerSport: 4 };
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

  // SAFE hard-reject threshold on fragility. After scoring, if the parlay
  // has fragilityScore ≥ this value, drop the weakest leg and rescore.
  // Repeats until fragility is acceptable or legs fall below the tier min.
  const SAFE_FRAGILITY_REJECT = 55;
  const swapOutFragileLegs = (legs: ValueBetCandidate[], minLegs: number): ValueBetCandidate[] => {
    if (mode !== "safe") return legs;
    let current = [...legs];
    while (current.length > minLegs) {
      const scored = scoreParlay(current, mode, weights);
      if ((scored.fragilityScore ?? 0) < SAFE_FRAGILITY_REJECT) return current;
      // Drop the weakest leg by computeLegScore
      const perLeg = current.map((l) => ({ l, s: computeLegScore(l, weights) }));
      perLeg.sort((a, b) => a.s - b.s);
      const weakest = perLeg[0].l;
      current = current.filter((x) => x.id !== weakest.id);
    }
    return current;
  };

  // Cash-Out mode: prefer cross-sport diversity, but never return an empty
  // parlay on a single-sport slate. Three-stage fallback:
  //   1. Strict:   1 leg per sport (true multi-sport)
  //   2. Medium:   maxPerSportRelaxed per sport (usually 2)
  //   3. Loose:    single-sport allowed, but require either different games
  //                OR different dependency chains (no two hitters from the
  //                same team in the same game, etc.)
  const buildCashoutLegs = (
    legCount: number,
    preferSafer: boolean,
    preferPayout: boolean,
    maxPerSportRelaxed: number,
  ): ValueBetCandidate[] => {
    const strict = greedyBuild(pool, legCount, {
      maxPerSport: 1,
      preferSafer,
      preferPayout,
      mode,
      weights,
    });
    if (strict.length >= legCount) return strict;

    const medium = greedyBuild(pool, legCount, {
      maxPerSport: maxPerSportRelaxed,
      preferSafer,
      preferPayout,
      mode,
      weights,
    });
    if (medium.length >= legCount) return medium;

    // Loose fallback: allow all legs from one sport but enforce different
    // games OR different dependency chains. Also lift maxPerGame to legCount
    // so legs from the same game pass only when chains differ.
    const loose = greedyBuild(pool, legCount, {
      maxPerSport: legCount,
      maxPerGame: legCount,
      preferSafer,
      preferPayout,
      mode,
      weights,
      enforceDependencyChainDiversity: true,
    });
    // Return whichever fallback has the most legs (loose should win when the
    // pool is single-sport, medium may win when distinct-sport candidates
    // existed but not enough for strict).
    return loose.length > medium.length ? loose : medium;
  };

  // ── Best value: target legs, ML-ranked ───────────────────────────────────
  let legsBest = mode === "cashout"
    ? buildCashoutLegs(target, /*preferSafer*/ true, false, maxPerSport)
    : greedyBuild(pool, target, {
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
  // 5-leg quality gate: only keep ≥ 5 legs when every single leg passes the
  // strict "strong leg" check. Otherwise chop down — better to ship a 4-leg
  // card of strong legs than a 5-leg card with one weak leg.
  if (mode !== "lotto") {
    while (legsBest.length >= 5 && !legsBest.every(legIsStrongFor5PlusParlay)) {
      legsBest = legsBest.slice(0, -1);
    }
  }
  if (mode === "cashout") legsBest = orderLegsForCashout(legsBest);
  legsBest = swapOutFragileLegs(legsBest, min);
  const bestValue = scoreParlay(
    legsBest.length ? legsBest : pool.slice(0, Math.min(3, pool.length)),
    mode,
    weights
  );

  // ── Safer: min legs, prioritise hit probability ───────────────────────────
  let legsSafe = mode === "cashout"
    ? buildCashoutLegs(min, true, false, maxPerSport)
    : greedyBuild(pool, min, {
        maxPerSport,
        preferSafer: true,
        preferPayout: false,
        mode,
        weights,
      });
  if (mode === "cashout") legsSafe = orderLegsForCashout(legsSafe);
  legsSafe = swapOutFragileLegs(legsSafe, min);
  const safer = scoreParlay(legsSafe, mode, weights);

  // ── Higher payout: max legs, more underdogs ───────────────────────────────
  let legsPay = mode === "cashout"
    ? buildCashoutLegs(max, false, true, maxPerSport + 1)
    : greedyBuild(pool, max, {
        maxPerSport: maxPerSport + 1,
        preferSafer: false,
        preferPayout: true,
        mode,
        weights,
      });
  if (mode === "cashout") legsPay = orderLegsForCashout(legsPay);
  legsPay = swapOutFragileLegs(legsPay, min);
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
 * Re-score an arbitrary list of legs as if they were a parlay built
 * by the optimizer. Used by callers (e.g. /daily replace-weakest)
 * that swap one leg in an already-built card and need fresh metrics
 * (combined odds, hit prob, fragility, weakest-leg id, warnings).
 */
export function rescoreParlay(
  legs: ValueBetCandidate[],
  mode: ParlayBuildMode = "balanced",
  weights: AnalyticsWeights = {},
): SmartParlayResult {
  return scoreParlay(legs, mode, weights);
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
