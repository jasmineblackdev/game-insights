/**
 * NFL Injury Position Multiplier
 *
 * Computes a small additive legScore adjustment when NFL injuries materially
 * affect expected opportunity or matchup quality.
 *
 * Design constraints:
 *  - NFL only. All other sports: adjustment is 0.
 *  - Maximum influence ±0.08 — edge, ml_hit_probability, and confidence
 *    remain the dominant scoring signals.
 *  - Activates only when OUT-status injuries affect positions that are
 *    structurally linked to the candidate's stat type.
 *
 * Call sites: buildCandidates.ts populates ValueBetCandidate.injuryImpactAdj
 * Consumer:   parlayOptimizer.ts adds injuryImpactAdj inside computeLegScore
 */

import type { PlayerInjury } from "@/data/mockGames";

// ── Position groups ───────────────────────────────────────────────────────────

const QB_POS   = new Set(["QB"]);
const OL_POS   = new Set(["C", "OC", "OG", "LG", "RG", "OT", "LT", "RT", "G", "T", "OL"]);
const WR_POS   = new Set(["WR"]);
const RB_POS   = new Set(["RB", "HB", "FB"]);
const CB_POS   = new Set(["CB", "DB", "S", "SS", "FS", "NCB"]);
const EDGE_POS = new Set(["DE", "EDGE", "OLB", "LOLB", "ROLB"]);

function posGroup(pos: string): string {
  const p = pos.toUpperCase().trim();
  if (QB_POS.has(p))   return "QB";
  if (OL_POS.has(p))   return "OL";
  if (WR_POS.has(p))   return "WR";
  if (RB_POS.has(p))   return "RB";
  if (CB_POS.has(p))   return "CB";
  if (EDGE_POS.has(p)) return "EDGE";
  return "OTHER";
}

function isOut(inj: PlayerInjury): boolean {
  return inj.status === "OUT";
}

function isHighImpact(inj: PlayerInjury): boolean {
  return isOut(inj) && inj.impactScore >= 7;
}

// ── Stat type classification ──────────────────────────────────────────────────

/**
 * Map an NFL stat_type string to an injury-routing class.
 * Exported for use in buildEnrichedPropCandidates timing boost logic.
 */
export function nflStatClass(statType: string): string {
  const s = statType.toLowerCase();
  if (s.includes("passing") || s === "completions" || s === "passing_tds" || s === "interceptions") {
    return "qb_stat";
  }
  if ((s.includes("rushing") && !s.startsWith("qb")) || s === "carries") {
    return "rb_rushing";
  }
  if (s.includes("receiv") || s === "receptions" || s === "targets") {
    return "receiving";
  }
  if (s.includes("sack")) return "sacks";
  return "other";
}

// ── Prop-level adjustment ─────────────────────────────────────────────────────

/**
 * Injury impact adjustment for an NFL player prop.
 *
 * @param statType  Prop stat type (e.g. "passing_yards", "rushing_yards")
 * @param ownInj    Injuries on the prop player's own team
 * @param oppInj    Injuries on the opponent
 * @returns Additive legScore delta clamped to [-0.08, +0.08]
 *
 * Examples:
 *  - RB2 rushing prop when RB1 is OUT → +0.05 (role elevation)
 *  - QB passing prop when 2 OL starters are OUT → −0.04 (pressure risk)
 *  - WR receiving prop when CB1 on opponent is OUT → +0.03 (coverage weakened)
 */
export function computeNflPropInjuryAdj(
  statType: string,
  ownInj: PlayerInjury[],
  oppInj: PlayerInjury[],
): number {
  if (!ownInj.length && !oppInj.length) return 0;

  let adj = 0;
  const sc = nflStatClass(statType);

  const ownOut = ownInj.filter(isOut);
  const oppOut = oppInj.filter(isOut);

  const ownQBOut  = ownOut.some((i) => posGroup(i.position) === "QB");
  const ownWROut  = ownOut.filter((i) => posGroup(i.position) === "WR").length;
  const ownRBOut  = ownOut.some((i) => posGroup(i.position) === "RB");
  const ownOLOut  = ownOut.filter((i) => posGroup(i.position) === "OL").length;
  const ownHighOL = ownOut.some((i) => posGroup(i.position) === "OL" && isHighImpact(i));

  const oppCBOut   = oppOut.some((i) => posGroup(i.position) === "CB");
  const oppEdgeOut = oppOut.some((i) => posGroup(i.position) === "EDGE");
  const oppOLOut   = oppOut.filter((i) => posGroup(i.position) === "OL").length;

  switch (sc) {
    case "qb_stat":
      // OL cluster → increased pass-rush pressure → fewer clean-pocket yards
      if (ownOLOut >= 2)    adj -= 0.04;
      else if (ownHighOL)   adj -= 0.02;
      // Opponent missing edge rusher → cleaner pocket
      if (oppEdgeOut)       adj += 0.02;
      break;

    case "rb_rushing":
      // RB1 out → this player steps into the primary role
      if (ownRBOut)         adj += 0.05;
      // OL cluster → fewer rushing lanes
      if (ownOLOut >= 2)    adj -= 0.02;
      // Team goes run-heavy with backup QB
      if (ownQBOut)         adj += 0.02;
      break;

    case "receiving":
      // Backup QB → degraded passing attack
      if (ownQBOut)         adj -= 0.04;
      // WR1 out → targets redistribute to this player
      if (ownWROut >= 1)    adj += 0.04;
      if (ownWROut >= 2)    adj += 0.02;
      // Opponent missing CB/secondary → easier coverage matchup
      if (oppCBOut)         adj += 0.03;
      break;

    case "sacks":
      // Opponent OL depleted → more pass-rush opportunity
      if (oppOLOut >= 2)    adj += 0.03;
      else if (oppOLOut === 1) adj += 0.01;
      break;

    default:
      break;
  }

  return Math.min(0.08, Math.max(-0.08, adj));
}

// ── Team-level adjustment (moneyline / spread) ────────────────────────────────

/**
 * Injury impact adjustment for an NFL team-level bet (moneyline or spread).
 *
 * @param ownInj   Injuries on the picked team
 * @param oppInj   Injuries on the opponent
 * @returns Additive legScore delta clamped to [-0.08, +0.08]
 */
export function computeNflTeamInjuryAdj(
  ownInj: PlayerInjury[],
  oppInj: PlayerInjury[],
): number {
  if (!ownInj.length && !oppInj.length) return 0;

  let adj = 0;
  const ownOut = ownInj.filter(isOut);
  const oppOut = oppInj.filter(isOut);

  const ownQBOut   = ownOut.some((i) => posGroup(i.position) === "QB");
  const ownOLOut   = ownOut.filter((i) => posGroup(i.position) === "OL").length;
  const oppQBOut   = oppOut.some((i) => posGroup(i.position) === "QB");
  const oppOLOut   = oppOut.filter((i) => posGroup(i.position) === "OL").length;
  const oppEdgeOut = oppOut.some((i) => posGroup(i.position) === "EDGE");

  // Own team injuries weaken this pick
  if (ownQBOut)          adj -= 0.06;
  if (ownOLOut >= 2)     adj -= 0.03;
  else if (ownOLOut === 1) adj -= 0.01;

  // Opponent injuries strengthen this pick
  if (oppQBOut)          adj += 0.04;
  if (oppOLOut >= 2)     adj += 0.02;
  if (oppEdgeOut)        adj += 0.01;

  return Math.min(0.08, Math.max(-0.08, adj));
}

// ── Total adjustment (over / under) ──────────────────────────────────────────

/**
 * Injury impact adjustment for an NFL game total (over/under).
 * Uses a tighter clamp (±0.04) because we're combining both teams.
 *
 * @param homeInj  Home team injuries
 * @param awayInj  Away team injuries
 * @param side     "over" or "under"
 * @returns Additive legScore delta clamped to [-0.04, +0.04]
 */
export function computeNflTotalInjuryAdj(
  homeInj: PlayerInjury[],
  awayInj: PlayerInjury[],
  side: "over" | "under",
): number {
  if (!homeInj.length && !awayInj.length) return 0;

  // Negative value = injuries reduce expected combined scoring
  let scoringImpact = 0;
  for (const inj of [...homeInj, ...awayInj].filter(isOut)) {
    const g = posGroup(inj.position);
    if (g === "QB")  scoringImpact -= 0.03;
    else if (g === "OL") scoringImpact -= 0.01;
  }
  scoringImpact = Math.min(0.04, Math.max(-0.04, scoringImpact));

  // Over: fewer points hurt → scoringImpact is already negative
  // Under: fewer points help → negate
  return side === "over" ? scoringImpact : -scoringImpact;
}

// ── Enriched prop timing boost ────────────────────────────────────────────────

/**
 * Timing score boost for enriched NFL props where only has_injury_flag is known
 * (no positional context available).
 *
 * Returns 0.02 for role-sensitive stat types (rushing, receiving) — these are
 * the props where a teammate's injury creates a late-breaking edge window.
 * Returns 0 otherwise.
 */
export function nflInjuryTimingBoost(statType: string): number {
  const sc = nflStatClass(statType);
  return (sc === "rb_rushing" || sc === "receiving") ? 0.02 : 0;
}
