import type { GamePrediction } from "@/data/mockGames";

export interface LiveContext {
  /** Short badge label shown on the card e.g. "Q1 WATCH" */
  badge: string;
  /** Tooltip / subtitle explaining the accuracy signal */
  tip: string;
  /**
   * "rising"  — more data arriving, accuracy improving
   * "peak"    — optimal prediction window (most actionable)
   * "high"    — strong signal locked in, variance low
   */
  accuracy: "rising" | "peak" | "high";
}

/**
 * Returns a live game-state context object for cards with status === "live".
 * Returns null for upcoming / final games.
 *
 * Timing rationale (per sport):
 *  NBA  — Q1: foul trouble visible; Q2/Half: highest accuracy; Q3-Q4: score gap matters
 *  NFL  — Q1: injury/script setting; Halftime: highest accuracy; Q3+: comeback risk
 *  MLB  — 1-3: starter locking in; 4-5 (F5 window): command pattern clear; 6+: bullpen era
 *  Soccer — 1-45': starter lock; 45'+: halftime intel; 60'+: substitution impact clear
 */
export function getLiveContext(game: GamePrediction): LiveContext | null {
  if (game.status !== "live") return null;
  const ls = game._meta?.liveState;
  if (!ls) {
    // Fallback when liveState wasn't captured (mock data, etc.)
    return { badge: "LIVE", tip: "Game in progress — predictions update with live data.", accuracy: "rising" };
  }

  const { periodNum, periodLabel, homeScore, awayScore, isHalftime } = ls;
  const margin = Math.abs(homeScore - awayScore);
  const leader = homeScore >= awayScore ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
  const scoreStr = `${game.awayTeam.abbreviation} ${awayScore}–${homeScore} ${game.homeTeam.abbreviation}`;

  if (game.league === "nba") {
    if (isHalftime) {
      return {
        badge: "HALFTIME",
        tip: `${scoreStr} — halftime is the highest-accuracy NBA window. Rotation, foul trouble, and pace are all visible.`,
        accuracy: "peak",
      };
    }
    if (periodNum === 1) {
      return {
        badge: "Q1 WATCH",
        tip: `${scoreStr} — check foul trouble. Stars with 2 fouls in Q1 sit most of Q2, shifting win probability 5–8%.`,
        accuracy: "rising",
      };
    }
    if (periodNum === 2) {
      return {
        badge: "Q2 PEAK",
        tip: `${scoreStr} — approaching halftime peak accuracy. Rotation patterns and bench depth are emerging.`,
        accuracy: "peak",
      };
    }
    if (periodNum === 3) {
      return margin >= 15
        ? { badge: "Q3 LOCKED", tip: `${leader} +${margin} — comebacks from 15+ in Q3 occur <12% of the time.`, accuracy: "high" }
        : { badge: "Q3 LIVE", tip: `${scoreStr} — tight Q3, variance still meaningful. Watch closeout schemes.`, accuracy: "rising" };
    }
    if (periodNum >= 4) {
      return margin >= 10
        ? { badge: "Q4 DECIDED", tip: `${leader} +${margin} in Q4 — result highly locked.`, accuracy: "high" }
        : { badge: "Q4 WATCH", tip: `${scoreStr} — crunch time. Clutch shooting and foul game determine outcome.`, accuracy: "peak" };
    }
    return { badge: `${periodLabel} LIVE`, tip: `${scoreStr} — game in progress.`, accuracy: "rising" };
  }

  if (game.league === "nfl") {
    if (isHalftime) {
      return {
        badge: "HALFTIME",
        tip: `${scoreStr} — halftime is the peak NFL window. You can see true game script, injuries, and adjustment reads.`,
        accuracy: "peak",
      };
    }
    if (periodNum === 1) {
      return {
        badge: "Q1 SCRIPT",
        tip: `${scoreStr} — early game script setting. Watch which team abandons the run — it signals pass-heavy desperation.`,
        accuracy: "rising",
      };
    }
    if (periodNum === 2) {
      return {
        badge: "Q2 INTEL",
        tip: `${scoreStr} — injury visibility and game script are now clear. Approaching halftime peak accuracy.`,
        accuracy: "peak",
      };
    }
    if (periodNum === 3) {
      return margin >= 17
        ? { badge: "3Q LOCKED", tip: `${leader} +${margin} — 17-point 3rd quarter deficits convert less than 10% of the time.`, accuracy: "high" }
        : { badge: "Q3 LIVE", tip: `${scoreStr} — still a game. Adjusted game plan from halftime affects 2nd half variance.`, accuracy: "rising" };
    }
    if (periodNum >= 4) {
      return margin >= 14
        ? { badge: "4Q DECIDED", tip: `${leader} +${margin} in Q4 — result essentially locked.`, accuracy: "high" }
        : { badge: "Q4 WATCH", tip: `${scoreStr} — late game. Two-minute drill and clock management are now the swing factors.`, accuracy: "peak" };
    }
    return { badge: `${periodLabel} LIVE`, tip: `${scoreStr} — game in progress.`, accuracy: "rising" };
  }

  if (game.league === "mlb") {
    if (periodNum <= 3) {
      return {
        badge: `${periodLabel} EARLY`,
        tip: `${scoreStr} — starter's command pattern becoming visible. Pitch count and walks signal longevity.`,
        accuracy: "rising",
      };
    }
    if (periodNum <= 5) {
      return {
        badge: `${periodLabel} F5`,
        tip: `${scoreStr} — F5 window. Starter durability is now readable. High pitch count or 2+ walks signals early bullpen.`,
        accuracy: "peak",
      };
    }
    if (periodNum <= 7) {
      return {
        badge: `${periodLabel} BULLPEN`,
        tip: `${scoreStr} — starters likely exiting. Bullpen matchups and closer availability now drive late-game variance.`,
        accuracy: "peak",
      };
    }
    return margin >= 3
      ? { badge: `${periodLabel} LOCKED`, tip: `${leader} +${margin} — late-inning leads of 3+ hold ~85% of the time.`, accuracy: "high" }
      : { badge: `${periodLabel} CLOSE`, tip: `${scoreStr} — tight late game. Walk-off variance is real.`, accuracy: "rising" };
  }

  if (game.league === "soccer") {
    const minute = periodNum; // Soccer periodNum is treated as match minute when available
    if (isHalftime) {
      return {
        badge: "HALF",
        tip: `${scoreStr} — halftime. Tactical substitutions and shape adjustments are the key 2nd-half swing factor.`,
        accuracy: "peak",
      };
    }
    if (minute <= 30) {
      return {
        badge: `${periodLabel} EARLY`,
        tip: `${scoreStr} — early match. Red card or early goal shifts win probability significantly.`,
        accuracy: "rising",
      };
    }
    if (minute <= 60) {
      return {
        badge: `${periodLabel} MID`,
        tip: `${scoreStr} — substitution window active. Tactical changes and fitness drops become visible.`,
        accuracy: "peak",
      };
    }
    return margin >= 2
      ? { badge: `${periodLabel} LOCKED`, tip: `${leader} +${margin} with <30 min left — result near certain.`, accuracy: "high" }
      : { badge: `${periodLabel} LATE`, tip: `${scoreStr} — late pressure. Set pieces and individual quality determine outcome.`, accuracy: "rising" };
  }

  return { badge: "LIVE", tip: `${scoreStr} — game in progress.`, accuracy: "rising" };
}

/** Badge color class by accuracy level. */
export function liveAccuracyClass(accuracy: LiveContext["accuracy"]): string {
  if (accuracy === "high") return "text-confidence-high bg-confidence-high/15 border-confidence-high/25";
  if (accuracy === "peak") return "text-primary bg-primary/15 border-primary/25";
  return "text-hot-streak bg-hot-streak/15 border-hot-streak/25";
}
