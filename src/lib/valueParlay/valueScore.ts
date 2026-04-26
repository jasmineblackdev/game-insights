import type { ConfidenceLevel } from "@/data/mockGames";

function confidence01(c: ConfidenceLevel): number {
  if (c === "high") return 1;
  if (c === "medium") return 0.55;
  return 0.2;
}

/**
 * Average US-book vig on a two-way moneyline (~4.5%). Used as a
 * fallback when we don't have the opposite side's implied prob —
 * de-vigging with the average is closer to fair than not de-vigging
 * at all, and the error is bounded.
 */
const ASSUMED_VIG_RATIO = 0.045;

/**
 * Strip the bookmaker vig from the implied probability. When the
 * opposite side's implied is supplied, normalize: fair = p / (p + q).
 * When it's missing, divide by (1 + average vig) — gets us most of
 * the way there for the typical −110/−110 market. Either way the
 * caller compares model_prob to a fair number, which stops chalk
 * markets from being systematically underweighted by the score.
 */
function deVigImplied(implied: number, oppositeImplied?: number): number {
  if (!Number.isFinite(implied) || implied <= 0 || implied >= 1) return implied;
  if (oppositeImplied != null && oppositeImplied > 0 && oppositeImplied < 1) {
    const sum = implied + oppositeImplied;
    if (sum > 1.001) return implied / sum;
    return implied;
  }
  return implied / (1 + ASSUMED_VIG_RATIO);
}

/** 0–1: tighter book vs fair (de-vigged). */
function oddsEfficiency01(impliedProb: number, modelProb: number, oppositeImpliedProb?: number): number {
  const fair = deVigImplied(impliedProb, oppositeImpliedProb);
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

  return Math.round(raw * 1000) / 1000;
}

export function valueGrade(score: number): "A" | "B" | "C" | "D" {
  if (score >= 0.72) return "A";
  if (score >= 0.55) return "B";
  if (score >= 0.4) return "C";
  return "D";
}
