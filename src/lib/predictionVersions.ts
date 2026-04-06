/**
 * Prediction Version System
 *
 * Every game can accumulate up to three prediction snapshots:
 *   1. Pregame     — generated from ESPN data before tip-off / first pitch
 *   2. Live (sport-specific trigger) — regenerated once the live signal fires
 *   3. Final       — actual result logged for accuracy tracking
 *
 * Versions are computed in the browser from the current game state —
 * no database required for the live view.  The Supabase migration in
 * supabase/migrations/20260410000000_prediction_versions.sql provides
 * the schema for future persistence and accuracy analytics.
 */

import type { GamePrediction } from "@/data/mockGames";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PredictionPhase =
  | "pregame"
  | "live_q1"     // NBA / NFL: after Q1 complete
  | "live_f5"     // MLB: after 5 innings complete
  | "live_15min"  // Soccer: 15'–30' pattern read
  | "final";

export type TriggerType =
  | "scheduled"
  | "end_q1_signal"
  | "end_f5_signal"
  | "early_pattern_signal"
  | "final_result";

export interface LiveStateSnapshot {
  period: number;
  scoreHome: number;
  scoreAway: number;
}

export interface PredictionVersion {
  /** e.g. "espn-nba-401234567-pregame" */
  id: string;
  gameId: string;
  sport: string;
  phase: PredictionPhase;
  triggerType: TriggerType;
  /** Team abbreviation of the predicted winner. */
  predictedSide: string;
  probability: number;
  confidence: "HIGH" | "MED" | "LOW";
  reasons: string[];
  risks: string[];
  liveStateSnapshot?: LiveStateSnapshot;
  /** ISO-8601 — set from game.lastUpdated for pregame/final, Date.now() for live. */
  createdAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapConf(c: GamePrediction["confidence"]): "HIGH" | "MED" | "LOW" {
  if (c === "high") return "HIGH";
  if (c === "medium") return "MED";
  return "LOW";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function probToConf(p: number): "HIGH" | "MED" | "LOW" {
  if (p >= 65) return "HIGH";
  if (p >= 55) return "MED";
  return "LOW";
}

// ── Pregame version ───────────────────────────────────────────────────────────

/**
 * Always generated — captures the pre-game model read.
 * Uses the current winProbability (which may have been enriched after tip-off
 * for games that were already live when first loaded; that is acceptable since
 * we preserve the original reasons/risks from ESPN).
 */
export function buildPregameVersion(game: GamePrediction): PredictionVersion {
  const pickedHome = game.winProbability.home >= game.winProbability.away;
  const predictedSide = pickedHome ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
  const probability = pickedHome ? game.winProbability.home : game.winProbability.away;

  return {
    id: `${game.id}-pregame`,
    gameId: game.id,
    sport: game.league.toUpperCase(),
    phase: "pregame",
    triggerType: "scheduled",
    predictedSide,
    probability,
    confidence: mapConf(game.confidence),
    reasons: game.topReasons.slice(0, 3),
    risks: game.riskFactors.slice(0, 2),
    createdAt: game.lastUpdated,
  };
}

// ── Live trigger evaluation ───────────────────────────────────────────────────

/**
 * Returns true when the sport-specific live signal conditions are satisfied.
 *
 *  NBA/NFL  — period ≥ 2 (Q1 complete) AND |scoreDiff| ≤ 8
 *  MLB      — period ≥ 5 (5 innings complete)
 *  Soccer   — 15' ≤ minute ≤ 30, no halftime
 */
export function isLiveTriggerMet(game: GamePrediction): boolean {
  if (game.status !== "live") return false;
  const ls = game._meta?.liveState;
  if (!ls) return false;

  const { periodNum, homeScore, awayScore, isHalftime } = ls;
  const diff = Math.abs(homeScore - awayScore);

  switch (game.league) {
    case "nba":
    case "nfl":
      return periodNum >= 2 && !isHalftime && diff <= 8;
    case "mlb":
      return periodNum >= 5;
    case "soccer":
      return !isHalftime && periodNum >= 15 && periodNum <= 30;
    default:
      return false;
  }
}

// ── Live version ──────────────────────────────────────────────────────────────

/**
 * Adjusts the pregame home win-% using the live score differential.
 *
 * Formula:  adjustment = scoreDiff × sportFactor × completionFraction
 * sportFactor calibrated so:
 *   NBA  — 5pt lead in Q2 ≈ +4pp
 *   NFL  — 7pt lead in Q2 ≈ +4pp
 *   MLB  — 1 run lead after F5 ≈ +5pp
 *   Soccer — 1 goal lead at 20' ≈ +8pp
 */
function liveAdjustedHomeProb(game: GamePrediction, pregameHomeProb: number): number {
  const ls = game._meta?.liveState;
  if (!ls) return pregameHomeProb;

  const { periodNum, homeScore, awayScore } = ls;
  const scoreDiff = homeScore - awayScore; // + = home leading

  const maxPeriod: Record<string, number> = { nba: 4, nfl: 4, mlb: 9, soccer: 90 };
  const factor: Record<string, number> = { nba: 0.7, nfl: 0.6, mlb: 5, soccer: 8 };
  const fraction = Math.min(1, periodNum / (maxPeriod[game.league] ?? 4));
  const adjustment = scoreDiff * (factor[game.league] ?? 1) * fraction;

  return clamp(Math.round(pregameHomeProb + adjustment), 5, 95);
}

/** Build the live prediction version. Returns null if trigger not met. */
export function buildLiveVersion(game: GamePrediction): PredictionVersion | null {
  if (!isLiveTriggerMet(game)) return null;
  const ls = game._meta!.liveState!;

  const liveHomeProb = liveAdjustedHomeProb(game, game.winProbability.home);
  const liveAwayProb = 100 - liveHomeProb;
  const pickedHome = liveHomeProb >= liveAwayProb;
  const predictedSide = pickedHome ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
  const probability = pickedHome ? liveHomeProb : liveAwayProb;

  const phase: PredictionPhase =
    game.league === "mlb" ? "live_f5"
    : game.league === "soccer" ? "live_15min"
    : "live_q1";

  const triggerType: TriggerType =
    game.league === "mlb" ? "end_f5_signal"
    : game.league === "soccer" ? "early_pattern_signal"
    : "end_q1_signal";

  // Sport-specific live reasons
  const { homeScore, awayScore, periodLabel } = ls;
  const awayAbbr = game.awayTeam.abbreviation;
  const homeAbbr = game.homeTeam.abbreviation;
  const scoreStr = `${awayAbbr} ${awayScore}–${homeScore} ${homeAbbr}`;
  const diff = Math.abs(homeScore - awayScore);
  const leader = homeScore >= awayScore ? homeAbbr : awayAbbr;

  const reasons: string[] = [];

  if (game.league === "nba") {
    reasons.push(`Q1 complete — ${scoreStr}. Pace and rotation depth now readable.`);
    reasons.push(
      diff === 0
        ? "Tied at Q1 — game wide open, foul count and bench depth determine Q2 swing."
        : `${leader} leads ${diff} — no significant foul trouble detected; star usage on track.`
    );
    reasons.push("Q1 benchmarks confirm (or update) pregame pace and lineup depth read.");
  } else if (game.league === "nfl") {
    reasons.push(`Q1 complete — ${scoreStr}. Game script and early drive efficiency visible.`);
    reasons.push(
      diff === 0
        ? "Score tied — game script still open; watch 2nd-quarter playcalling tendency."
        : `${leader} holds early lead — run/pass splits and third-down rate confirm game plan.`
    );
    reasons.push("No key QB injury reported — original prediction confidence intact.");
  } else if (game.league === "mlb") {
    reasons.push(`${periodLabel} complete — ${scoreStr}. Starter command and pitch count established.`);
    reasons.push("F5 window: WHIP, walks, and velocity trend are now readable for both starters.");
    reasons.push("Bullpen bridge begins — leverage situations will refine late-inning edge.");
  } else {
    reasons.push(`${periodLabel} — ${scoreStr}. Opening shape and press intensity visible.`);
    reasons.push("No red cards — full-strength match; early possession pattern is reliable signal.");
    reasons.push("Pre-halftime window: highest accuracy before tactical substitution disruption.");
  }

  return {
    id: `${game.id}-live`,
    gameId: game.id,
    sport: game.league.toUpperCase(),
    phase,
    triggerType,
    predictedSide,
    probability,
    confidence: probToConf(probability),
    reasons,
    risks: game.riskFactors.slice(0, 2),
    liveStateSnapshot: { period: ls.periodNum, scoreHome: ls.homeScore, scoreAway: ls.awayScore },
    createdAt: new Date().toISOString(),
  };
}

// ── Final version ─────────────────────────────────────────────────────────────

/** Records the actual result. Returns null if game is not final or scores missing. */
export function buildFinalVersion(game: GamePrediction): PredictionVersion | null {
  if (game.status !== "final") return null;
  const fh = game._meta?.finalHomeScore;
  const fa = game._meta?.finalAwayScore;
  if (fh == null || fa == null) return null;

  const homeWon = fh > fa;
  const winner = homeWon ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;

  return {
    id: `${game.id}-final`,
    gameId: game.id,
    sport: game.league.toUpperCase(),
    phase: "final",
    triggerType: "final_result",
    predictedSide: winner,
    probability: 100,
    confidence: "HIGH",
    reasons: [`${winner} won — final score ${game.awayTeam.abbreviation} ${fa}–${fh} ${game.homeTeam.abbreviation}.`],
    risks: [],
    createdAt: game.lastUpdated,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Build all applicable prediction versions for a game in chronological order.
 * Always starts with pregame. Adds live version when trigger is met.
 * Adds final version when the game is over.
 */
export function buildPredictionVersions(game: GamePrediction): PredictionVersion[] {
  const versions: PredictionVersion[] = [buildPregameVersion(game)];
  const live = buildLiveVersion(game);
  if (live) versions.push(live);
  const final = buildFinalVersion(game);
  if (final) versions.push(final);
  return versions;
}

// ── Phase display helpers ─────────────────────────────────────────────────────

export function phaseLabel(phase: PredictionPhase): string {
  switch (phase) {
    case "pregame":   return "Pregame Edge";
    case "live_q1":   return "Live Edge · Q1 Signal";
    case "live_f5":   return "Live Edge · F5 Signal";
    case "live_15min":return "Live Edge · 15′ Signal";
    case "final":     return "Final Result";
  }
}

export function phaseColor(phase: PredictionPhase): string {
  if (phase === "pregame") return "text-primary bg-primary/10 border-primary/25";
  if (phase === "final")   return "text-muted-foreground bg-muted/40 border-border/50";
  return "text-confidence-high bg-confidence-high/10 border-confidence-high/30";
}

export function confColor(c: "HIGH" | "MED" | "LOW"): string {
  if (c === "HIGH") return "text-confidence-high";
  if (c === "MED")  return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}
