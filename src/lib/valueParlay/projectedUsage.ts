/**
 * Projected usage (minutes / snap share) scaling for player props.
 *
 * The current prop model blends last-5 and season averages and adjusts
 * for team pace. It assumes the player will log his season-average
 * workload. When a teammate is OUT / doubtful, minutes or snaps
 * actually shift — and so should the projection.
 *
 * This module returns a multiplicative scalar applied to the projected
 * stat BEFORE the over/under line is derived. It's intentionally small
 * (±15% max) so a missing-data case never blows up a projection.
 *
 * Sources of signal:
 *   NBA: injuries + position group (PG/SG/SF/PF/C) — a missing star at
 *        the same position pushes minutes up ~10%
 *   NFL: injuries at the same position group (QB/RB/WR/TE) — missing
 *        RB1 boosts RB2 touches, etc.
 *   MLB: lineup protection — weaker lineup around the hitter drops
 *        projected RBIs/Runs slightly
 */

import type { GamePrediction, PlayerInjury, PlayerTrendData } from "@/data/mockGames";

function isOutOrDoubtful(i: PlayerInjury): boolean {
  return i.status === "OUT" || i.status === "DOUBTFUL";
}

function positionGroup(pos: string | undefined): string {
  if (!pos) return "";
  const p = pos.toUpperCase();
  if (p.includes("QB")) return "QB";
  if (p.includes("RB") || p === "FB") return "RB";
  if (p.includes("WR")) return "WR";
  if (p.includes("TE")) return "TE";
  if (p === "PG" || p === "SG" || p === "G") return "G";
  if (p === "SF" || p === "PF" || p === "F") return "F";
  if (p === "C") return "C";
  return p;
}

/**
 * Minutes/snap usage scalar for a player in the context of the game's
 * roster. Returned as a multiplier in [0.85, 1.15]. 1.0 = baseline.
 */
export function projectedUsageMultiplier(
  game: GamePrediction,
  trend: PlayerTrendData,
  side: "home" | "away",
  statType: string,
): number {
  const ownInj = side === "home" ? game.injuries.home : game.injuries.away;
  const oppInj = side === "home" ? game.injuries.away : game.injuries.home;
  const playerGroup = positionGroup(trend.position);
  if (!playerGroup) return 1.0;

  const league = game.league;

  // ── NBA ─────────────────────────────────────────────────────────
  if (league === "nba") {
    const sameGroupOut = ownInj.filter(
      (i) => isOutOrDoubtful(i) && positionGroup(i.position) === playerGroup
            && i.impactScore >= 6,
    ).length;
    if (sameGroupOut >= 2) return 1.12;
    if (sameGroupOut === 1) return 1.08;
    // Any star out (not position-matched) bumps everyone a bit via pace
    const anyStarOut = ownInj.some((i) => isOutOrDoubtful(i) && i.impactScore >= 8);
    return anyStarOut ? 1.03 : 1.0;
  }

  // ── NFL ─────────────────────────────────────────────────────────
  if (league === "nfl") {
    // RB1 out → RB2 snaps/touches jump ~20%, but since we see only
    // this player's trend, we boost moderately.
    const sameGroupOut = ownInj.filter(
      (i) => isOutOrDoubtful(i) && positionGroup(i.position) === playerGroup
            && i.impactScore >= 7,
    ).length;
    if (sameGroupOut >= 1) {
      if (playerGroup === "RB" || playerGroup === "WR" || playerGroup === "TE") return 1.12;
      if (playerGroup === "QB") return 1.00; // backup QB rarely matches volume
      return 1.05;
    }
    // QB out hurts every non-QB skill player
    const qbOut = ownInj.some((i) => isOutOrDoubtful(i) && positionGroup(i.position) === "QB" && i.impactScore >= 7);
    if (qbOut && playerGroup !== "QB") return 0.92;
    return 1.0;
  }

  // ── MLB ─────────────────────────────────────────────────────────
  if (league === "mlb") {
    // Only lineup-based signals for now. Weak lineup = lower RBI / R.
    const lineupOuts = ownInj.filter((i) => isOutOrDoubtful(i) && i.impactScore >= 6).length;
    if (statType === "rbi" || statType === "runs") {
      if (lineupOuts >= 2) return 0.90;
      if (lineupOuts === 1) return 0.95;
    }
    // Opposing pitcher injury (rarely captured, but future-proof)
    const oppPitcherOut = oppInj.some((i) => isOutOrDoubtful(i) && positionGroup(i.position).includes("P"));
    if (oppPitcherOut && (statType === "hits" || statType === "total_bases")) return 1.05;
    return 1.0;
  }

  return 1.0;
}
