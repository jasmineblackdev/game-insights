/**
 * Daily Plan generator — builds the three structured bets for the
 * /daily page from the same candidate pool the parlay builder uses.
 *
 * Tiers:
 *   primary   — 1–2 legs, lowest risk, highest confidence anchor
 *   balanced  — 2–3 legs, medium risk, best probability/payout blend
 *   upside    — 3–4 legs, higher payout, still passes risk rules
 *
 * Cross-tier dedup: legs picked into earlier tiers are excluded
 * from later tiers unless the user has locked them. Avoids the user
 * placing the "same parlay" three times under different names.
 *
 * Combat-sport guard: combat-sport legs (Boxing, MMA) are stripped
 * from the Primary pool unless their data quality is strong.
 */

import {
  optimizeFixedLegCount,
  optimizeForMode,
} from "@/lib/valueParlay/parlayOptimizer";
import type { SmartParlayResult, ValueBetCandidate } from "@/lib/valueParlay/types";
import { getPropRiskLevel } from "@/lib/valueParlay/propRiskLevels";
import type { StakeRiskLevel } from "@/lib/bankroll/types";

export type DailyPlanTier = "primary" | "balanced" | "upside";

export interface DailyPlanCard {
  tier: DailyPlanTier;
  legs: ValueBetCandidate[];
  result: SmartParlayResult | null;
  /** Risk tier feeding the bankroll stake suggestion. */
  stakeRisk: StakeRiskLevel;
  /** Short rationale for why this build was selected. */
  whyThisBet: string[];
  /** ID of the weakest leg in the result (mirror of result.weakestLegId). */
  weakestLegId?: string;
}

export interface DailyPlanInput {
  candidates: ValueBetCandidate[];
  /** Locked legs (from any tier) — kept across regenerations. */
  lockedLegIds?: Set<string>;
  /** Legs already used in earlier tiers, excluded from this tier. */
  exclude?: Set<string>;
}

/** Combat-sport candidates only pass into Primary if data quality is strong. */
function combatPassesPrimary(c: ValueBetCandidate): boolean {
  const sport = String(c.sport).toLowerCase();
  if (sport !== "boxing" && sport !== "mma") return true;
  if (c.confidence !== "high") return false;
  if ((c.modelProbability ?? 0) < 0.62) return false;
  return true;
}

/** Filter the pool down to "anchor-grade" candidates suitable for Primary. */
function anchorPool(candidates: ValueBetCandidate[]): ValueBetCandidate[] {
  return candidates.filter((c) => {
    if (!c.isRecommended) return false;
    if (c.confidence !== "high") return false;
    if (getPropRiskLevel(c) === "high") return false;
    if (!combatPassesPrimary(c)) return false;
    return true;
  });
}

/** Extract the strongest single leg as the Primary anchor. */
function buildPrimary(candidates: ValueBetCandidate[]): SmartParlayResult | null {
  const anchors = anchorPool(candidates).sort(
    (a, b) => (b.modelProbability ?? 0) - (a.modelProbability ?? 0),
  );
  if (anchors.length === 0) return null;

  // Try a 2-leg conservative build first (better EV than a single −250 fav).
  const twoLeg = optimizeFixedLegCount(anchors.slice(0, 12), 2, 2, "safe");
  if (twoLeg && twoLeg.legs.length === 2 && twoLeg.cardConfidence !== "low") {
    return twoLeg;
  }

  // Fall back to a single-leg "parlay" — same struct, just one leg.
  const top = anchors[0];
  return {
    legs: [top],
    projectedHitProbability: Math.round((top.modelProbability ?? 0.5) * 1000) / 1000,
    projectedPayoutMultiplier: top.americanOdds > 0
      ? 1 + top.americanOdds / 100
      : 1 + 100 / Math.abs(top.americanOdds),
    combinedAmericanOdds: top.americanOdds,
    cardConfidence: top.confidence,
    correlationPenalty: 0,
    volatilityPenalty: top.volatilityScore,
    uncertaintyPenalty: top.uncertaintyScore,
    smartParlayScore: top.valueScore,
    warnings: [],
    weakestLegId: top.id,
    strongestLegId: top.id,
    riskLevelCounts: {
      low: getPropRiskLevel(top) === "low" ? 1 : 0,
      medium: getPropRiskLevel(top) === "medium" ? 1 : 0,
      high: getPropRiskLevel(top) === "high" ? 1 : 0,
    },
  };
}

/** Why-selected lines for a tier — kept short and concrete. */
function whyForTier(tier: DailyPlanTier, result: SmartParlayResult | null): string[] {
  if (!result || result.legs.length === 0) return [];
  const out: string[] = [];
  if (tier === "primary") {
    out.push("Highest-confidence anchor — minimum HIGH-risk legs and combat-sport guarded.");
  } else if (tier === "balanced") {
    out.push("Best probability vs payout balance after the optimizer's safety filters.");
  } else {
    out.push("Higher payout target while still inside parlay risk rules (max 1 HIGH-risk leg).");
  }
  if (result.cardConfidence) out.push(`Card confidence: ${result.cardConfidence}.`);
  if (result.weakestLegId) {
    const w = result.legs.find((l) => l.id === result.weakestLegId);
    if (w) out.push(`Weakest leg: ${w.selectionLabel} — first to swap if conditions shift.`);
  }
  if (result.warnings.length > 0) {
    out.push(`Heads-up: ${result.warnings[0]}`);
  }
  return out;
}

/** Stake-risk tier mapping. */
function stakeRiskFor(tier: DailyPlanTier): StakeRiskLevel {
  if (tier === "primary") return "low";
  if (tier === "balanced") return "medium";
  return "high";
}

/**
 * Generate the three daily-plan cards in one shot. Each tier excludes
 * the legs already picked by earlier tiers so the user isn't asked to
 * place the same leg in three parlays.
 */
export function generateDailyPlan(input: DailyPlanInput): DailyPlanCard[] {
  const lockedIds = input.lockedLegIds ?? new Set<string>();
  const excludeIds = new Set<string>(input.exclude ?? []);

  const filterPool = (extraExclude: Set<string>): ValueBetCandidate[] =>
    input.candidates.filter((c) => !extraExclude.has(c.id) && !excludeIds.has(c.id));

  // ── Primary ──────────────────────────────────────────────────────
  const primaryResult = buildPrimary(filterPool(new Set()));
  const primaryUsed = new Set<string>(primaryResult?.legs.map((l) => l.id) ?? []);

  // ── Balanced ─────────────────────────────────────────────────────
  // Exclude primary's legs unless the user locked them.
  const balExclude = new Set<string>(
    [...primaryUsed].filter((id) => !lockedIds.has(id)),
  );
  const balancedResult = optimizeForMode(filterPool(balExclude), "balanced");
  const balancedUsed = new Set<string>(balancedResult?.legs.map((l) => l.id) ?? []);

  // ── Upside ───────────────────────────────────────────────────────
  // Exclude both prior tiers' legs unless locked.
  const upExclude = new Set<string>(
    [...primaryUsed, ...balancedUsed].filter((id) => !lockedIds.has(id)),
  );
  const upsideResult = optimizeForMode(filterPool(upExclude), "aggressive");

  return [
    {
      tier: "primary",
      legs: primaryResult?.legs ?? [],
      result: primaryResult,
      stakeRisk: stakeRiskFor("primary"),
      whyThisBet: whyForTier("primary", primaryResult),
      weakestLegId: primaryResult?.weakestLegId,
    },
    {
      tier: "balanced",
      legs: balancedResult?.legs ?? [],
      result: balancedResult,
      stakeRisk: stakeRiskFor("balanced"),
      whyThisBet: whyForTier("balanced", balancedResult),
      weakestLegId: balancedResult?.weakestLegId,
    },
    {
      tier: "upside",
      legs: upsideResult?.legs ?? [],
      result: upsideResult,
      stakeRisk: stakeRiskFor("upside"),
      whyThisBet: whyForTier("upside", upsideResult),
      weakestLegId: upsideResult?.weakestLegId,
    },
  ];
}

export function tierLabel(t: DailyPlanTier): string {
  return t === "primary" ? "Primary Bet"
    : t === "balanced" ? "Balanced Parlay"
    : "Upside Parlay";
}

export function tierBadgeClass(t: DailyPlanTier): string {
  return t === "primary"  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/20"
    : t === "balanced" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/20"
    : "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/20";
}
