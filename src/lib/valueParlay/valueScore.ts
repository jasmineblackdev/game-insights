import type { ConfidenceLevel, League } from "@/data/mockGames";

function confidence01(c: ConfidenceLevel): number {
  if (c === "high") return 1;
  if (c === "medium") return 0.55;
  return 0.2;
}

/**
 * Sport-aware vig assumptions. Calibrated against typical US-book
 * two-way moneyline overrounds. MLB/NHL run tight at popular books;
 * NFL/NBA mains sit near the canonical −110/−110; combat sports,
 * alt-lines, and props carry meaningfully wider vig.
 *
 * These are *fallbacks* used only when the opposite-side implied
 * probability is not provided. When the caller supplies the opposite
 * side, deVigImplied normalizes exactly (fair = p/(p+q)) and ignores
 * the table.
 *
 * Market-specific overrides (e.g. player props ~6–8% vig regardless of
 * sport) can be passed via `marketKind` to bias toward a wider book.
 */
const DEFAULT_VIG_RATIO = 0.045;

const SPORT_VIG_RATIO: Record<League, number> = {
  nba: 0.045,
  wnba: 0.05,
  nfl: 0.045,
  mlb: 0.038,
  boxing: 0.07,
  mma: 0.065,
};

export type ValueScoreMarketKind =
  | "moneyline"
  | "spread"
  | "total"
  | "player_prop"
  | "alt_line";

const MARKET_VIG_FLOOR: Partial<Record<ValueScoreMarketKind, number>> = {
  player_prop: 0.06,
  alt_line: 0.06,
};

function normalizeSportKey(sport: string | League | undefined): League | null {
  if (!sport) return null;
  const k = String(sport).toLowerCase();
  if (k === "nba" || k === "wnba" || k === "nfl" || k === "mlb" || k === "boxing" || k === "mma") {
    return k as League;
  }
  return null;
}

function vigRatioFor(sport: string | League | undefined, marketKind?: ValueScoreMarketKind): number {
  const league = normalizeSportKey(sport);
  const base = league ? SPORT_VIG_RATIO[league] : DEFAULT_VIG_RATIO;
  const floor = marketKind ? MARKET_VIG_FLOOR[marketKind] ?? 0 : 0;
  return Math.max(base, floor);
}

/**
 * Strip the bookmaker vig from the implied probability. When the
 * opposite side's implied is supplied, normalize: fair = p / (p + q).
 * When it's missing, divide by (1 + sport-specific vig) — gets us
 * most of the way there for the typical market. Either way the
 * caller compares model_prob to a fair number, which stops chalk
 * markets from being systematically underweighted by the score.
 */
function deVigImplied(implied: number, oppositeImplied?: number, vigRatio: number = DEFAULT_VIG_RATIO): number {
  if (!Number.isFinite(implied) || implied <= 0 || implied >= 1) return implied;
  if (oppositeImplied != null && oppositeImplied > 0 && oppositeImplied < 1) {
    const sum = implied + oppositeImplied;
    if (sum > 1.001) return implied / sum;
    return implied;
  }
  return implied / (1 + vigRatio);
}

/** 0–1: tighter book vs fair (de-vigged). */
function oddsEfficiency01(
  impliedProb: number,
  modelProb: number,
  oppositeImpliedProb: number | undefined,
  vigRatio: number,
): number {
  const fair = deVigImplied(impliedProb, oppositeImpliedProb, vigRatio);
  const gap = Math.abs(fair - modelProb);
  return Math.min(1, gap * 4 + 0.15);
}

function dataCertainty01(uncertaintyScore: number): number {
  return Math.max(0, Math.min(1, 1 - uncertaintyScore / 100));
}

function lowVolatility01(volatilityScore: number): number {
  return Math.max(0, Math.min(1, 1 - volatilityScore / 100));
}

function lineMovement01(deltaAbs: number | null | undefined): number {
  if (deltaAbs == null || !Number.isFinite(deltaAbs)) return 0.35;
  return Math.min(1, 0.25 + Math.min(1, deltaAbs / 8));
}

function scheduleRest01(restHint: number | undefined): number {
  if (restHint == null) return 0.4;
  return Math.min(1, 0.35 + restHint / 100);
}

/**
 * Weighted value score (higher = better). Components roughly 0–1.
 */
export function computeValueScore(args: {
  edge: number;
  confidence: ConfidenceLevel;
  impliedProbability: number;
  modelProbability: number;
  volatilityScore: number;
  uncertaintyScore: number;
  lineMovementDeltaPp?: number | null;
  scheduleRestHint?: number;
  /**
   * Opposite-side implied probability (the "other half" of the
   * two-way market). When supplied, oddsEfficiency01 de-vigs the
   * comparison so chalk markets aren't systematically underweighted.
   * Optional — the function falls back to an average-vig adjustment
   * when this isn't passed.
   */
  oppositeImpliedProbability?: number;
  /**
   * Additive nudge from the user pattern coach (see
   * src/lib/learning/userBettingPatterns.ts). Symmetric:
   *   +0.00..+0.05 for "hot" buckets (≥10 samples, shrunk win rate ≥ 58%)
   *   -0.05..-0.00 for "cold" buckets (≥10 samples, shrunk win rate ≤ 42%)
   *   0 otherwise (insufficient samples or middling performance)
   * Empirical-Bayes shrinkage protects against small-sample
   * overconfidence — a 2/2 streak doesn't trigger anything.
   */
  userPatternBoost?: number;
}): number {
  const edge01 = Math.max(0, Math.min(1, args.edge * 8));
  const conf01 = confidence01(args.confidence);
  const oddsEff = oddsEfficiency01(args.impliedProbability, args.modelProbability, args.oppositeImpliedProbability);
  const dataCert = dataCertainty01(args.uncertaintyScore);
  const lowVol = lowVolatility01(args.volatilityScore);
  const lineM = lineMovement01(args.lineMovementDeltaPp != null ? Math.abs(args.lineMovementDeltaPp) : null);
  const rest = scheduleRest01(args.scheduleRestHint);

  const raw =
    edge01 * 0.35 +
    conf01 * 0.2 +
    oddsEff * 0.15 +
    dataCert * 0.1 +
    lowVol * 0.1 +
    lineM * 0.05 +
    rest * 0.05;

  // Pattern-coach nudge is symmetric in [-0.05, +0.05].
  const nudge = Math.max(-0.05, Math.min(0.05, args.userPatternBoost ?? 0));
  return Math.round(Math.max(0, Math.min(1, raw + nudge)) * 1000) / 1000;
}

export function valueGrade(score: number): "A" | "B" | "C" | "D" {
  if (score >= 0.72) return "A";
  if (score >= 0.55) return "B";
  if (score >= 0.4) return "C";
  return "D";
}
