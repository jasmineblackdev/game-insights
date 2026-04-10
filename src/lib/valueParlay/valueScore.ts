import type { ConfidenceLevel } from "@/data/mockGames";

function confidence01(c: ConfidenceLevel): number {
  if (c === "high") return 1;
  if (c === "medium") return 0.55;
  return 0.2;
}

/** 0–1: tighter book vs fair. */
function oddsEfficiency01(impliedProb: number, modelProb: number): number {
  const gap = Math.abs(impliedProb - modelProb);
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
}): number {
  const edge01 = Math.max(0, Math.min(1, args.edge * 8));
  const conf01 = confidence01(args.confidence);
  const oddsEff = oddsEfficiency01(args.impliedProbability, args.modelProbability);
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
