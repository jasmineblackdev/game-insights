/**
 * Replace-weakest-leg helper — surgical swap that keeps the rest of
 * the parlay intact (including locked legs) and substitutes only the
 * lowest-quality leg with the next-best eligible candidate.
 *
 * Eligibility rules mirror what the optimizer enforces during build:
 *   - Must beat the leg being removed on edge × confidence
 *   - Cannot push the parlay over 1 HIGH-risk leg
 *   - Cannot stack 3+ of the same stat type
 *   - Cannot form a dependent pair with any retained leg in the
 *     same game (RBI+Runs, HR+RBI, Hits+Total Bases, etc.)
 *   - Cannot duplicate an already-used leg id (caller passes the
 *     exclusion set — locked legs from this card AND legs already
 *     used in other Daily Plan tiers)
 *   - Prefers the same sport as the removed leg, then same stat
 *     category, then any otherwise-valid leg.
 */

import type { ParlayBuildMode, SmartParlayResult, ValueBetCandidate } from "@/lib/valueParlay/types";
import { rescoreParlay } from "@/lib/valueParlay/parlayOptimizer";
import { getPropRiskLevel } from "@/lib/valueParlay/propRiskLevels";

const DEPENDENT_PAIRS: Array<[string, string]> = [
  ["rbis", "runs"],
  ["home_runs", "rbis"],
  ["home_runs", "runs"],
  ["hits", "total_bases"],
  ["hits_runs", "hits_runs_rbis"],
  ["runs_rbis", "hits_runs_rbis"],
];
const DEPENDENT_LOOKUP = new Set<string>(
  DEPENDENT_PAIRS.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]),
);

export interface ReplaceWeakestArgs {
  legs: ValueBetCandidate[];
  /** Full candidate pool to search for replacements. */
  pool: ValueBetCandidate[];
  /** Leg id that should be removed (caller usually passes weakestLegId). */
  weakestLegId: string;
  /** Legs the user has locked — must remain in the parlay. */
  lockedLegIds?: Set<string>;
  /** Leg ids already used elsewhere — excluded from replacement. */
  excludeIds?: Set<string>;
  /** Tier we're building for, drives risk rules. */
  mode?: ParlayBuildMode;
}

export interface ReplaceWeakestResult {
  ok: boolean;
  /** Reason a swap couldn't be made (when ok=false). */
  reason?: string;
  /** New parlay legs, weakest swapped. */
  legs?: ValueBetCandidate[];
  /** Re-scored result for the new parlay. */
  result?: SmartParlayResult;
  /** Removed leg (for the UI's "Removed: X" toast/explanation). */
  removed?: ValueBetCandidate;
  /** Added leg (for the UI's "Added: Y" toast/explanation). */
  added?: ValueBetCandidate;
  /** Why we picked this replacement. */
  whyAdded?: string;
}

function legScore(c: ValueBetCandidate): number {
  // Lightweight ranking score — higher is better. Mirrors the
  // optimizer's intuition without re-running the full scorer.
  const confBoost = c.confidence === "high" ? 0.20 : c.confidence === "medium" ? 0.08 : 0;
  const stabilityBoost = (c.stabilityScore ?? 0.5) * 0.10;
  const recentBoost = (c.recentHitRate ?? 0) * 0.08;
  const riskPenalty = getPropRiskLevel(c) === "high" ? 0.05 : 0;
  return c.edge + confBoost + stabilityBoost + recentBoost - riskPenalty;
}

export function replaceWeakestLeg(args: ReplaceWeakestArgs): ReplaceWeakestResult {
  const {
    legs,
    pool,
    weakestLegId,
    lockedLegIds = new Set<string>(),
    excludeIds = new Set<string>(),
    mode = "balanced",
  } = args;

  if (legs.length === 0) {
    return { ok: false, reason: "Parlay has no legs" };
  }
  if (lockedLegIds.has(weakestLegId)) {
    return { ok: false, reason: "Weakest leg is locked — unlock to swap" };
  }
  const removed = legs.find((l) => l.id === weakestLegId);
  if (!removed) {
    return { ok: false, reason: "Weakest leg not found in parlay" };
  }

  // Retained legs after we strip the weakest one.
  const retained = legs.filter((l) => l.id !== removed.id);

  // Pre-compute constraints from retained legs.
  const retainedIds = new Set<string>(retained.map((l) => l.id));
  const highRiskCount = retained.filter((l) => getPropRiskLevel(l) === "high").length;
  const statCounts = new Map<string, number>();
  for (const l of retained) {
    const s = (l.statType ?? "").toLowerCase();
    if (!s) continue;
    statCounts.set(s, (statCounts.get(s) ?? 0) + 1);
  }
  const dependentBlockers = new Map<string, string[]>(); // gameId → list of statTypes
  for (const l of retained) {
    const s = (l.statType ?? "").toLowerCase();
    if (!s) continue;
    const arr = dependentBlockers.get(l.gameId) ?? [];
    arr.push(s);
    dependentBlockers.set(l.gameId, arr);
  }

  const isEligible = (c: ValueBetCandidate): boolean => {
    if (c.id === removed.id) return false;
    if (retainedIds.has(c.id)) return false;
    if (excludeIds.has(c.id)) return false;
    if (c.edge <= 0) return false;
    if (c.confidence === "low") return false;
    // Risk-tier cap
    if (getPropRiskLevel(c) === "high" && highRiskCount >= 1) return false;
    // Stat-type stacking — never let same stat appear 3+ times
    const stat = (c.statType ?? "").toLowerCase();
    if (stat && (statCounts.get(stat) ?? 0) >= 2) return false;
    // Dependent-pair guard inside the same game
    const sameGame = dependentBlockers.get(c.gameId);
    if (sameGame && stat) {
      for (const otherStat of sameGame) {
        if (DEPENDENT_LOOKUP.has(`${stat}|${otherStat}`)) return false;
      }
    }
    return true;
  };

  // Tiered preference: same sport+stat → same sport → any.
  const sameSportStat = pool
    .filter((c) => isEligible(c) && c.sport === removed.sport && c.statType === removed.statType)
    .sort((a, b) => legScore(b) - legScore(a));
  const sameSport = pool
    .filter((c) => isEligible(c) && c.sport === removed.sport && c.statType !== removed.statType)
    .sort((a, b) => legScore(b) - legScore(a));
  const anyEligible = pool
    .filter((c) => isEligible(c))
    .sort((a, b) => legScore(b) - legScore(a));

  const replacement = sameSportStat[0] ?? sameSport[0] ?? anyEligible[0];
  if (!replacement) {
    return { ok: false, reason: "No eligible replacement found in the candidate pool" };
  }
  // Sanity floor: only swap when the replacement actually scores
  // better than the leg we're removing. Otherwise leave the parlay
  // alone — a "replacement" that's worse is just shuffling.
  if (legScore(replacement) <= legScore(removed)) {
    return { ok: false, reason: "No replacement scored better than the current weakest leg" };
  }

  const newLegs = [...retained, replacement];
  const result = rescoreParlay(newLegs, mode);

  const whyAdded = [
    `${replacement.confidence.toUpperCase()} confidence`,
    `edge +${(replacement.edge * 100).toFixed(1)}%`,
    `${getPropRiskLevel(replacement).toUpperCase()} risk`,
  ].join(" · ");

  return {
    ok: true,
    legs: newLegs,
    result,
    removed,
    added: replacement,
    whyAdded,
  };
}
