import type { ConfidenceLevel } from "@/data/mockGames";

export type RiskBand = "low" | "moderate" | "elevated" | "high";

export interface RiskComponents {
  volatilityScore: number;
  uncertaintyScore: number;
  correlationScore: number;
  injuryRiskScore: number;
  lineupConfirmationRisk: number;
  oddsExtremityRisk: number;
  marketDisagreementRisk: number;
}

/** 0–100, higher = riskier (worse). */
export function compositeRiskScore(c: RiskComponents): number {
  const raw =
    c.volatilityScore * 0.25 +
    c.uncertaintyScore * 0.2 +
    c.correlationScore * 0.2 +
    c.injuryRiskScore * 0.1 +
    c.lineupConfirmationRisk * 0.1 +
    c.oddsExtremityRisk * 0.1 +
    c.marketDisagreementRisk * 0.05;
  return Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10;
}

export function riskBand(score: number): RiskBand {
  if (score <= 24) return "low";
  if (score <= 49) return "moderate";
  if (score <= 69) return "elevated";
  return "high";
}

export function riskBandLabel(b: RiskBand): string {
  switch (b) {
    case "low":
      return "Low risk";
    case "moderate":
      return "Moderate";
    case "elevated":
      return "Elevated";
    default:
      return "High risk";
  }
}

export function confidenceToUncertaintyBase(conf: ConfidenceLevel): number {
  if (conf === "high") return 18;
  if (conf === "medium") return 42;
  return 78;
}

/**
 * Odds extremity: huge favorites with thin payout vs longshots without model support.
 * american < -400 or american > 280 → elevated when model prob doesn’t back it.
 */
export function oddsExtremityRisk(args: {
  americanOdds: number;
  modelProbability: number;
  edge: number;
}): number {
  const { americanOdds, modelProbability, edge } = args;
  let r = 12;
  if (americanOdds <= -400) {
    r += 35;
    if (edge < 0.06) r += 25;
  } else if (americanOdds <= -250) {
    r += 18;
    if (edge < 0.04) r += 12;
  }
  if (americanOdds >= 280) {
    r += 28;
    if (modelProbability < 0.32) r += 22;
  } else if (americanOdds >= 200) {
    r += 12;
    if (modelProbability < 0.38) r += 10;
  }
  return Math.min(100, r);
}
