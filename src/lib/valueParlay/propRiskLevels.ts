/**
 * Prop risk-level classifier — central source of truth for which stat
 * types are LOW / MEDIUM / HIGH variance for parlay-construction
 * purposes. Used by the parlay optimizer to enforce structural rules
 * ("max 1 HIGH leg", "avoid stacking same stat", "RBI + Runs is a
 * dependent pair") and by the UI to surface per-leg risk badges and
 * card-level warnings.
 *
 * Rules embedded here:
 *   LOW    — outcomes resolve via accumulated singles (any contact /
 *            many touches), so individual events don't make/break the
 *            leg. Hits, total bases, NBA combined props.
 *   MEDIUM — outcomes scale with usage and team game-script but still
 *            need real volume. Points, rebounds, assists, threes,
 *            team moneyline.
 *   HIGH   — depend on rare or teammate-mediated events. Home runs,
 *            stolen bases, RBIs, runs scored, blocks, steals, doubles,
 *            triples, "leader of game" markets.
 */

import type { ValueBetCandidate, ValueMarketType } from "@/lib/valueParlay/types";

export type PropRiskLevel = "low" | "medium" | "high";

/** stat_type → risk level. Anything not listed defaults to "medium". */
const RISK_BY_STAT: Record<string, PropRiskLevel> = {
  // ── LOW ──────────────────────────────────────────────────────────────
  hits: "low",
  one_plus_hit: "low",
  total_bases: "low",
  pra: "low",
  pts_reb: "low",
  pts_ast: "low",
  reb_ast: "low",

  // ── MEDIUM ───────────────────────────────────────────────────────────
  points: "medium",
  rebounds: "medium",
  assists: "medium",
  threes: "medium",
  // NFL bulk-volume yardage props — many touches, similar variance
  passing_yards: "medium",
  rushing_yards: "medium",
  receiving_yards: "medium",
  receptions: "medium",
  // MLB pitcher props are usage-driven; treat as medium
  strikeouts: "medium",

  // ── HIGH ─────────────────────────────────────────────────────────────
  rbis: "high",
  runs: "high",
  home_runs: "high",
  stolen_bases: "high",
  doubles: "high",
  triples: "high",
  walks: "high",          // depends on opposing SP, not hitter skill
  blocks: "high",
  steals: "high",
  extra_base_hits: "high",
  // MLB combined picks rolling up dependent stats stay high
  hits_runs_rbis: "high",
  hits_runs: "high",
  runs_rbis: "high",
  hits_stolen_bases: "high",
  hits_walks_stolen_bases: "high",
  // Combat sports — single-event KO/Sub markets
  ko_tko: "high",
  submission: "high",
  draw: "high",
};

/**
 * Map a market_type to a default risk level when no stat_type is
 * present (team picks). Moneyline/Spread/Total are medium-default.
 */
const RISK_BY_MARKET: Record<ValueMarketType, PropRiskLevel> = {
  moneyline: "medium",
  spread: "medium",
  total: "medium",
  player_prop: "medium",
};

export function getPropRiskLevel(c: Pick<ValueBetCandidate, "statType" | "marketType" | "selectionLabel">): PropRiskLevel {
  const stat = c.statType?.toLowerCase();
  if (stat && stat in RISK_BY_STAT) return RISK_BY_STAT[stat];
  // Heuristic for "leader of game" / "first-of-game" markets surfaced
  // via selectionLabel (no canonical stat_type).
  const label = (c.selectionLabel ?? "").toLowerCase();
  if (label.includes("first ") || label.includes("leader")) return "high";
  return RISK_BY_MARKET[c.marketType] ?? "medium";
}

/**
 * Pairs of stat types whose hits depend on the same off-the-bat event
 * chain — running them together inflates implied combined probability
 * because the joint outcome is correlated, not independent. The
 * optimizer should reject any parlay containing two legs from a single
 * pair (or warn loudly when downstream of a manual add).
 */
const DEPENDENT_PAIRS: Array<[string, string]> = [
  ["rbis", "runs"],                 // a teammate scoring an RBI is the runner crossing
  ["runs", "rbis"],                 // same pair, mirrored for lookup convenience
  ["home_runs", "rbis"],            // HR by the player guarantees an RBI
  ["home_runs", "runs"],            // HR by the player guarantees a run
  ["hits", "total_bases"],          // TB is a strict superset of hits
  ["hits_runs", "hits_runs_rbis"],  // strict superset
  ["runs_rbis", "hits_runs_rbis"],  // strict superset
];

/**
 * Detect dependent stat pairs across legs of a parlay. Returns the
 * specific stat-type pairs found so the warning text can be specific.
 */
export function findDependentPairs(legs: Pick<ValueBetCandidate, "statType" | "playerId" | "teamId" | "gameId">[]): Array<{ a: string; b: string; samePlayer: boolean; sameTeam: boolean }> {
  const out: Array<{ a: string; b: string; samePlayer: boolean; sameTeam: boolean }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = (legs[i].statType ?? "").toLowerCase();
      const b = (legs[j].statType ?? "").toLowerCase();
      if (!a || !b) continue;
      const match = DEPENDENT_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
      if (!match) continue;
      const samePlayer = !!(legs[i].playerId && legs[j].playerId && legs[i].playerId === legs[j].playerId);
      const sameTeam   = !!(legs[i].teamId && legs[j].teamId && legs[i].teamId === legs[j].teamId);
      // Same-game dependent pairs are the strongest signal; cross-game
      // is acceptable. Skip the latter.
      if (legs[i].gameId !== legs[j].gameId) continue;
      const key = [a, b].sort().join(":") + ":" + legs[i].gameId;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a, b, samePlayer, sameTeam });
    }
  }
  return out;
}

/** Count how many legs at each risk tier. */
export function countByRiskLevel(legs: ValueBetCandidate[]): Record<PropRiskLevel, number> {
  const out: Record<PropRiskLevel, number> = { low: 0, medium: 0, high: 0 };
  for (const l of legs) out[getPropRiskLevel(l)]++;
  return out;
}

/** Detect same-stat-type stacking (3+ legs of same stat is an anti-pattern). */
export function findStatTypeStacks(legs: ValueBetCandidate[]): Array<{ statType: string; count: number }> {
  const counts = new Map<string, number>();
  for (const l of legs) {
    const k = (l.statType ?? "").toLowerCase();
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .map(([statType, count]) => ({ statType, count }));
}

/**
 * Card-level rule check — runs every parlay-build rule and returns a
 * list of human-readable warnings + a hard-failure flag for the
 * optimizer's hard cap on HIGH-risk legs.
 */
export interface RiskRuleResult {
  /** True when card violates a hard structural rule (max 1 HIGH-risk leg). */
  hardFail: boolean;
  /** Reason when hardFail is true. */
  hardFailReason?: string;
  /** Soft warnings to surface in the UI. */
  warnings: string[];
}

export function applyRiskRules(legs: ValueBetCandidate[]): RiskRuleResult {
  const warnings: string[] = [];
  const counts = countByRiskLevel(legs);

  // Hard cap: max 1 HIGH-risk leg
  if (counts.high >= 2) {
    return {
      hardFail: true,
      hardFailReason: `${counts.high} HIGH-risk legs — limit is 1 per parlay`,
      warnings: [],
    };
  }

  // Stat-type stacking
  const stacks = findStatTypeStacks(legs);
  for (const s of stacks) {
    warnings.push(`${s.count} legs share stat type "${s.statType}" — outcomes are partially correlated.`);
  }

  // Dependent MLB pairs
  const pairs = findDependentPairs(legs);
  for (const p of pairs) {
    if (p.a === "rbis" || p.b === "rbis") {
      warnings.push("RBI and Runs props depend on teammates getting on base — these resolve together more often than independently.");
    } else if ((p.a === "home_runs" || p.b === "home_runs") && (p.a === "rbis" || p.b === "rbis" || p.a === "runs" || p.b === "runs")) {
      warnings.push("Home runs guarantee runs/RBIs — these legs aren't independent.");
    } else if ((p.a === "hits" && p.b === "total_bases") || (p.a === "total_bases" && p.b === "hits")) {
      warnings.push("Hits and Total Bases overlap — total bases include all hits.");
    } else {
      warnings.push(`Dependent pair: ${p.a} + ${p.b} resolve together.`);
    }
  }

  // Suggest replacement for common upgrades
  const has2PlusHits = legs.some(
    (l) => (l.statType ?? "").toLowerCase() === "hits"
      && (l.lineValue ?? 0) >= 2
      && l.selectionLabel.toLowerCase().includes("over"),
  );
  if (has2PlusHits) {
    warnings.push("Consider replacing 2+ hits with 1+ hit — higher hit rate, similar correlation.");
  }

  // Variance flag — only when the parlay isn't already small
  if (counts.high === 1 && counts.medium >= 2 && legs.length >= 4) {
    warnings.push("This parlay has multiple high-variance legs — better as a small-stake upside play.");
  }

  return {
    hardFail: false,
    warnings,
  };
}

/** Risk-level → short label for badges. */
export function riskLevelLabel(r: PropRiskLevel): string {
  return r === "low" ? "LOW" : r === "medium" ? "MED" : "HIGH";
}

/** Risk-level → tailwind classes for badges. */
export function riskLevelClass(r: PropRiskLevel): string {
  if (r === "low")    return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/20";
  if (r === "medium") return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/20";
  return "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/20";
}
