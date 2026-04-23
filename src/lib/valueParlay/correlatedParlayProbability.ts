/**
 * Correlation-aware parlay hit probability.
 *
 * The naive product P(all hit) = Π p_i assumes the legs are independent.
 * Real parlays have correlated outcomes: e.g. two same-game player props
 * move together (if the game turns into a shootout, all offensive props
 * tilt the same way). The naive product *underestimates* hit probability
 * for positively correlated legs (good news) and *overestimates* for
 * negatively correlated pairs.
 *
 * We use a lightweight pairwise adjustment rather than a full copula:
 *
 *   P_corr(A ∩ B) ≈ P(A) * P(B) + ρ * σ_A * σ_B
 *
 * where σ_X = sqrt(P(X) * (1 - P(X))) (Bernoulli std dev) and ρ is the
 * pair correlation looked up from a small table keyed by the leg types.
 * For 3+ legs we chain pairwise: take the max-correlated pair, collapse
 * to a single joint prob, then multiply the next leg with its best
 * remaining pair correlation, and so on.
 *
 * ρ TABLE — conservative defaults. These can be replaced later with
 * values read from the parlay_correlation_matrix table (migration
 * 20260422000000_parlay_edge) without changing callers.
 */

import type { ValueBetCandidate } from "@/lib/valueParlay/types";

// Correlation floor to avoid overstating joint probability on wildly
// positive pairs we don't have real data for. Tune if real data lands.
const RHO_CAP = 0.45;

/**
 * Pair-type → rho lookup. Keys sorted so lookup is direction-agnostic.
 * Values approximate what empirical research shows:
 *   - Same-game same-side (team ML + spread) — strongly correlated
 *   - Same-game same-team props              — moderately correlated
 *   - Same-game different teams (H ML + A TB) — mildly correlated
 *   - Same-sport different games              — near-zero
 *   - Cross-sport                              — zero
 */
const PAIR_RHO: Record<string, number> = {
  "same_game:team:team":        0.55,   // ML + spread / ML + total over
  "same_game:prop:prop_same_team":   0.38,   // two Lakers scoring props
  "same_game:prop:prop_opp_team":    0.18,   // Lakers scoring + Nuggets defense impact
  "same_game:team:prop_same_team":   0.32,
  "same_game:team:prop_opp_team":    0.10,
  "same_game:prop:prop_pitcher":     -0.05,  // two pitchers in MLB — mildly negative
  "same_sport_diff_game":             0.04,
  "cross_sport":                      0.00,
};

function sigma(p: number): number {
  const clamped = Math.min(0.999, Math.max(0.001, p));
  return Math.sqrt(clamped * (1 - clamped));
}

/**
 * Infer the correlation category for two legs.
 */
function pairKey(a: ValueBetCandidate, b: ValueBetCandidate): string {
  const sameSport = String(a.sport).toLowerCase() === String(b.sport).toLowerCase();
  if (!sameSport) return "cross_sport";

  if (a.gameId !== b.gameId) return "same_sport_diff_game";

  const aTeamBet = a.pickType !== "player_prop";
  const bTeamBet = b.pickType !== "player_prop";
  if (aTeamBet && bTeamBet) return "same_game:team:team";

  // MLB pitcher-vs-pitcher special case
  if (
    String(a.sport).toLowerCase() === "mlb" &&
    a.pickType === "player_prop" && b.pickType === "player_prop" &&
    (a.statType ?? "").toLowerCase().includes("strike") &&
    (b.statType ?? "").toLowerCase().includes("strike")
  ) return "same_game:prop:prop_pitcher";

  if (a.pickType === "player_prop" && b.pickType === "player_prop") {
    return a.teamId && a.teamId === b.teamId
      ? "same_game:prop:prop_same_team"
      : "same_game:prop:prop_opp_team";
  }

  // Mixed: one team bet + one prop
  const prop = a.pickType === "player_prop" ? a : b;
  const team = a.pickType === "player_prop" ? b : a;
  return prop.teamId === team.teamId
    ? "same_game:team:prop_same_team"
    : "same_game:team:prop_opp_team";
}

function rhoFor(a: ValueBetCandidate, b: ValueBetCandidate): number {
  const rho = PAIR_RHO[pairKey(a, b)] ?? 0;
  return Math.max(-RHO_CAP, Math.min(RHO_CAP, rho));
}

/**
 * Pairwise correlation-adjusted joint probability.
 *
 * P(A ∩ B) = P(A) P(B) + ρ * σ(P(A)) * σ(P(B))
 *
 * Clamped to [0, min(P(A), P(B))] to stay valid — can't exceed the
 * smaller marginal.
 */
function pairwiseJoint(pA: number, pB: number, rho: number): number {
  const joint = pA * pB + rho * sigma(pA) * sigma(pB);
  const upper = Math.min(pA, pB);
  return Math.max(0.001, Math.min(upper, joint));
}

/**
 * Correlation-aware parlay hit probability.
 *
 * For 1 leg: returns p_0.
 * For 2 legs: exact pairwise adjustment.
 * For 3+ legs: greedy — collapse the most-correlated pair into their
 * joint first, then fold in remaining legs one-by-one using the max rho
 * against any already-collapsed leg. Approximation, but it matches a
 * full copula well enough for the small N (≤6) parlays we build.
 */
export function correlatedParlayHitProbability(
  legs: ValueBetCandidate[],
  modelProbs: number[],
): number {
  if (!legs.length) return 0;
  if (legs.length !== modelProbs.length) {
    // Degrade to naive product if caller misuses
    return modelProbs.reduce((acc, p) => acc * Math.min(0.999, Math.max(0.001, p)), 1);
  }
  if (legs.length === 1) return Math.min(0.999, Math.max(0.001, modelProbs[0]));

  // Build a working pool of (leg, cumulative probability).
  // "collapsed" array tracks legs that have been folded into joint pieces.
  // To keep bookkeeping simple we carry a list of anchors — one per
  // collapsed cluster — along with their current joint probability.
  const anchors: { leg: ValueBetCandidate; p: number }[] = legs.map((l, i) => ({
    leg: l,
    p:   Math.min(0.999, Math.max(0.001, modelProbs[i])),
  }));

  while (anchors.length > 1) {
    // Find the pair with the largest |rho|
    let bestI = 0, bestJ = 1, bestRho = 0, bestKeyRho = -1;
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const r = rhoFor(anchors[i].leg, anchors[j].leg);
        if (Math.abs(r) > bestKeyRho) {
          bestKeyRho = Math.abs(r);
          bestRho    = r;
          bestI      = i;
          bestJ      = j;
        }
      }
    }
    const a = anchors[bestI];
    const b = anchors[bestJ];
    const joint = pairwiseJoint(a.p, b.p, bestRho);
    // Merge into a single anchor — keep the "less-correlated" leg as
    // the representative, arbitrarily first.
    anchors.splice(bestJ, 1);
    anchors.splice(bestI, 1, { leg: a.leg, p: joint });
  }
  return anchors[0].p;
}
