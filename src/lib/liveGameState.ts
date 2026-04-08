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

// ── Final games: model vs result ─────────────────────────────────────────────

export interface FinalPredictionContext {
  badge: string;
  tip: string;
  pickedSide: "home" | "away" | "draw";
  correct: boolean;
  outcome: "hit" | "miss" | "push";
}

/**
 * When status is final and `_meta` has scores, compare pre-game lean to the result.
 * Two-way sports: home vs away win probability. Soccer: highest 1X2 bucket (home / draw / away).
 */
export function getFinalPredictionContext(game: GamePrediction): FinalPredictionContext | null {
  if (game.status !== "final") return null;
  const fh = game._meta?.finalHomeScore;
  const fa = game._meta?.finalAwayScore;
  if (fh == null || fa == null || !Number.isFinite(fh) || !Number.isFinite(fa)) return null;

  if (game.threeWay) {
    const tw = game.threeWay;
    type Side = "home" | "away" | "draw";
    let picked: Side = "home";
    let best = -1;
    for (const { side, pct } of [
      { side: "home" as const, pct: tw.home },
      { side: "away" as const, pct: tw.away },
      { side: "draw" as const, pct: tw.draw },
    ]) {
      if (pct > best) {
        best = pct;
        picked = side;
      }
    }
    const isDraw = fh === fa;
    const actual: Side = isDraw ? "draw" : fh > fa ? "home" : "away";
    const correct = picked === actual;
    const pct = picked === "home" ? tw.home : picked === "away" ? tw.away : tw.draw;
    const label = (s: Side) =>
      s === "home" ? game.homeTeam.abbreviation : s === "away" ? game.awayTeam.abbreviation : "Draw";
    return {
      badge: correct ? "MODEL ✓" : "UPSET",
      tip: correct
        ? `Final ${fh}–${fa}. 1X2 lean ${label(picked)} (${pct}%) matched ${label(actual)}.`
        : `Final ${fh}–${fa}. Result ${label(actual)}; model leaned ${label(picked)} (${pct}%).`,
      pickedSide: picked,
      correct,
      outcome: correct ? "hit" : "miss",
    };
  }

  const pickedHome = game.winProbability.home >= game.winProbability.away;
  const picked = pickedHome ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
  const pct = pickedHome ? game.winProbability.home : game.winProbability.away;

  if (fh === fa) {
    return {
      badge: "FINAL · TIE",
      tip: `Final ${fa}–${fh}. No win-side grade.`,
      pickedSide: pickedHome ? "home" : "away",
      correct: false,
      outcome: "push",
    };
  }

  const homeWon = fh > fa;
  const correct = (pickedHome && homeWon) || (!pickedHome && !homeWon);
  const winner = homeWon ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;

  return {
    badge: correct ? "MODEL ✓" : "UPSET",
    tip: correct
      ? `Final ${fa}–${fh}. Model leaned ${picked} (${pct}%) — matched winner ${winner}.`
      : `Final ${fa}–${fh}. ${winner} won; model favored ${picked} (${pct}%).`,
    pickedSide: pickedHome ? "home" : "away",
    correct,
    outcome: correct ? "hit" : "miss",
  };
}

export function finalPredictionAccuracyClass(ctx: FinalPredictionContext): string {
  if (ctx.outcome === "push") return "text-muted-foreground bg-muted/50 border-border";
  if (ctx.correct) return "text-confidence-high bg-confidence-high/15 border-confidence-high/25";
  return "text-amber-700 dark:text-amber-300 bg-amber-500/15 border-amber-500/30";
}

// ── Bet Window Signal ─────────────────────────────────────────────────────────

export type BetPhase = "wait" | "open" | "closing" | "closed";

export interface BetWindow {
  /** Current actionability of this game. */
  phase: BetPhase;
  /** Short badge label. */
  label: string;
  /** Why this window is (or isn't) open. */
  tip: string;
  /** When to act / what to wait for. */
  timing: string;
}

/**
 * Returns a bet window signal for live games.
 * Returns null for upcoming/final games.
 *
 * Rationale per sport:
 *  NBA  — Q1: wait (foul trouble unresolved) → Q2 start / Halftime: open (peak)
 *          Q3 tight: open · Q3 blowout (15+): closing · Q4: closing/closed
 *  NFL  — Q1: wait → Q2 / Halftime: open (peak)
 *          Q3 tight: open · Q3 blowout (17+): closing · Q4: closing/closed
 *  MLB  — innings 1–3: wait → innings 4–5 (F5): open (peak)
 *          innings 6–7: closing (bullpen era) · 8+: closed
 *  Soccer — <15': wait → 15'–45': open · halftime: open (peak)
 *           45'–65': open (subs window) · 65'+: closing/closed
 */
export function getBetWindow(game: GamePrediction): BetWindow | null {
  if (game.status !== "live") return null;
  const ls = game._meta?.liveState;
  if (!ls) return null;

  const { periodNum, isHalftime, homeScore, awayScore } = ls;
  const margin = Math.abs(homeScore - awayScore);
  const leader = homeScore >= awayScore ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;

  // ── NBA ────────────────────────────────────────────────────────────────────
  if (game.league === "nba") {
    if (periodNum === 1) {
      return {
        phase: "wait",
        label: "WAIT · Q1 LIVE",
        tip: "Q1 in progress — foul trouble and rotation depth aren't readable yet. Hold until the buzzer.",
        timing: "Window opens after Q1 buzzer",
      };
    }
    if (periodNum === 2 && !isHalftime) {
      return {
        phase: "open",
        label: "BET WINDOW OPEN",
        tip: "Q1 complete. Foul counts, rotation patterns, and early pace are locked in. Best pre-half live value.",
        timing: "Act before halftime",
      };
    }
    if (isHalftime) {
      return {
        phase: "open",
        label: "BET WINDOW OPEN · HALFTIME",
        tip: "Halftime is the highest-accuracy NBA window — true pace, foul totals, and bench depth are all visible.",
        timing: "Act before Q3 tip-off",
      };
    }
    if (periodNum === 3) {
      if (margin >= 15) {
        return {
          phase: "closing",
          label: "WINDOW CLOSING",
          tip: `${leader} +${margin} in Q3. Comebacks from 15+ occur <12% of the time — live value is shrinking.`,
          timing: "Marginal value remaining",
        };
      }
      return {
        phase: "open",
        label: "BET WINDOW OPEN",
        tip: "Tight Q3 — live spread reflects real uncertainty. Closeout schemes and foul pace still matter.",
        timing: "Act before Q4",
      };
    }
    if (periodNum >= 4) {
      if (margin >= 14) {
        return {
          phase: "closed",
          label: "WINDOW CLOSED",
          tip: `${leader} +${margin} in Q4. Line has fully corrected — no meaningful edge available.`,
          timing: "No value",
        };
      }
      return {
        phase: "closing",
        label: "WINDOW CLOSING",
        tip: "Q4 crunch time. Foul game and clutch rate still shift the live line — move now or skip.",
        timing: "Last chance",
      };
    }
  }

  // ── NFL ────────────────────────────────────────────────────────────────────
  if (game.league === "nfl") {
    if (periodNum === 1) {
      return {
        phase: "wait",
        label: "WAIT · Q1 LIVE",
        tip: "Game script still forming. Watch for early injury reports and which team abandons the run first.",
        timing: "Window opens after Q1",
      };
    }
    if (periodNum === 2 && !isHalftime) {
      return {
        phase: "open",
        label: "BET WINDOW OPEN",
        tip: "Q1 complete — game script, early injuries, and play-call tendencies are now visible. Best pre-half value.",
        timing: "Act before halftime",
      };
    }
    if (isHalftime) {
      return {
        phase: "open",
        label: "BET WINDOW OPEN · HALFTIME",
        tip: "Halftime: optimal NFL window. Injury updates, adjusted game script, and coaching read all factored in.",
        timing: "Act before 2nd-half kickoff",
      };
    }
    if (periodNum === 3) {
      if (margin >= 17) {
        return {
          phase: "closing",
          label: "WINDOW CLOSING",
          tip: `${leader} +${margin} in Q3. 17-pt deficits convert in under 10% of NFL games — value nearly gone.`,
          timing: "Marginal value only",
        };
      }
      return {
        phase: "open",
        label: "BET WINDOW OPEN",
        tip: "Game still in play. 3rd-quarter adjustments and time-of-possession are the live swing factors.",
        timing: "Act before Q4",
      };
    }
    if (margin >= 14) {
      return {
        phase: "closed",
        label: "WINDOW CLOSED",
        tip: `${leader} +${margin} in Q4. Line fully corrected — no value.`,
        timing: "No value",
      };
    }
    return {
      phase: "closing",
      label: "WINDOW CLOSING",
      tip: "Q4 two-minute drill. Clock management kills spread value fast — act now or skip.",
      timing: "Last chance",
    };
  }

  // ── MLB ────────────────────────────────────────────────────────────────────
  if (game.league === "mlb") {
    if (periodNum <= 3) {
      return {
        phase: "wait",
        label: "WAIT · EARLY INNINGS",
        tip: "Starter still settling in. Pitch count, walk rate, and velocity trend aren't readable before inning 4.",
        timing: "F5 window opens after inning 3",
      };
    }
    if (periodNum <= 5) {
      return {
        phase: "open",
        label: "BET WINDOW OPEN · F5",
        tip: "F5 window: starter durability, pitch count, and WHIP are now visible. Highest live value before bullpen switchover.",
        timing: "Act before inning 6",
      };
    }
    if (periodNum <= 7) {
      return {
        phase: "closing",
        label: "WINDOW CLOSING · BULLPEN",
        tip: "Starters likely exiting. Bullpen availability and matchup data still provide an edge — but it narrows each half-inning.",
        timing: "Last meaningful window",
      };
    }
    if (margin >= 3) {
      return {
        phase: "closed",
        label: "WINDOW CLOSED",
        tip: `${leader} +${margin} in the late innings. 3-run leads in 8th+ hold ~87% of the time — no value.`,
        timing: "No value",
      };
    }
    return {
      phase: "closing",
      label: "LAST CHANCE · WALK-OFF RANGE",
      tip: "Razor-thin margin in the 8th+. Line barely moves but walk-off variance is real — narrow window.",
      timing: "Narrow value only",
    };
  }

  // ── Soccer ────────────────────────────────────────────────────────────────
  if (game.league === "soccer") {
    const minute = periodNum;
    if (isHalftime) {
      return {
        phase: "open",
        label: "BET WINDOW OPEN · HALF",
        tip: "Halftime: substitution plans and 2nd-half shape are the most reliable predictor. Optimal window.",
        timing: "Act before 2nd-half kickoff",
      };
    }
    if (minute < 15) {
      return {
        phase: "wait",
        label: "WAIT · KICKOFF",
        tip: "Opening phase — too early to read shape or intent. Wait 15 minutes for the pattern to emerge.",
        timing: "Opens at ~15'",
      };
    }
    if (minute <= 45) {
      return {
        phase: "open",
        label: "BET WINDOW OPEN",
        tip: "Opening shape, press intensity, and set-piece threat are visible. Best pre-halftime live window.",
        timing: "Act before halftime",
      };
    }
    if (minute <= 65) {
      return {
        phase: "open",
        label: "BET WINDOW OPEN",
        tip: "Substitution window active — tactical changes and fitness drops are shifting the live odds.",
        timing: "Act before 70'",
      };
    }
    if (margin >= 2) {
      return {
        phase: "closed",
        label: "WINDOW CLOSED",
        tip: `${leader} +${margin} after 65' — two-goal lead conversion rate ~94%. No value.`,
        timing: "No value",
      };
    }
    return {
      phase: "closing",
      label: "WINDOW CLOSING",
      tip: "Late pressure in a close match. Odds move fast — act now or the line snaps shut.",
      timing: "Last chance",
    };
  }

  return null;
}

/**
 * For upcoming games: the optimal live timing window to return for a bet.
 * Shown as a subtle "come back at…" hint on pre-game cards.
 */
export function getUpcomingBetTip(game: GamePrediction): string | null {
  if (game.status !== "upcoming") return null;
  if (game.league === "nba") return "Best live window: after Q1 buzzer or at halftime";
  if (game.league === "nfl") return "Best live window: after Q1 or at halftime";
  if (game.league === "mlb") return "Best live window: innings 4–5 (F5 window)";
  if (game.league === "soccer") return "Best live window: 15'–45' or at halftime";
  return null;
}

/** Tailwind classes for a bet window phase. */
export function betWindowClass(phase: BetPhase): string {
  if (phase === "open")
    return "text-confidence-high bg-confidence-high/10 border-confidence-high/30";
  if (phase === "closing")
    return "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30";
  if (phase === "wait")
    return "text-muted-foreground bg-muted/60 border-border";
  return "text-muted-foreground/60 bg-muted/40 border-border/50";
}
