/**
 * Converts boxing and MMA GamePrediction objects into PlayerEdgePrediction format
 * so they can appear in the Player Edge prop scanner alongside NBA/MLB players.
 *
 * Each fight generates up to 3 props:
 *  1. Fight winner (favored fighter) — if model edge ≥ 2%
 *  2. Method of victory (KO/TKO or Decision) — from model probabilities
 *  3. Total rounds over/under — from lines when available
 */

import type { GamePrediction } from "@/data/mockGames";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import { fetchBoxingPredictions } from "@/lib/boxingFetch";
import { fetchMmaPredictions } from "@/lib/mmaFetch";

// ── Helpers ────────────────────────────────────────────────────────────────────

function confUp(c: "high" | "medium" | "low"): "HIGH" | "MED" | "LOW" {
  if (c === "high") return "HIGH";
  if (c === "medium") return "MED";
  return "LOW";
}

function riskTier(c: "HIGH" | "MED" | "LOW"): "safe" | "balanced" | "high_upside" {
  if (c === "HIGH") return "safe";
  if (c === "MED") return "balanced";
  return "high_upside";
}

function mlToImplied(ml: string | undefined): number | null {
  if (!ml) return null;
  const n = parseInt(ml.replace("+", ""), 10);
  if (isNaN(n)) return null;
  if (n > 0) return 100 / (n + 100);
  const abs = Math.abs(n);
  return abs / (abs + 100);
}

function timingNote(sport: "Boxing" | "MMA"): string {
  return sport === "MMA" ? "Pregame · After R1" : "Pregame";
}

// ── Fight winner prop ──────────────────────────────────────────────────────────

function buildWinnerProp(
  game: GamePrediction,
  sport: "Boxing" | "MMA",
  sortBase: number
): PlayerEdgePrediction | null {
  const homeProb = game.winProbability.home / 100;
  const awayProb = game.winProbability.away / 100;

  // Pick the favored fighter (higher model probability)
  const favHome = homeProb >= awayProb;
  const favFighter = favHome ? game.homeTeam : game.awayTeam;
  const undFighter = favHome ? game.awayTeam : game.homeTeam;
  const favProb = favHome ? homeProb : awayProb;

  // Get implied probability from lines
  const favMl = favHome ? game.lines?.homeMl : game.lines?.awayMl;
  const favImplied = mlToImplied(favMl) ?? 0.5;
  const edgeAmt = favProb - favImplied;

  // Only include if model has meaningful edge
  if (Math.abs(edgeAmt) < 0.02) return null;

  const confidence = confUp(game.confidence);
  const edgePct = Math.round(edgeAmt * 1000) / 10; // e.g. 5.8
  const direction: "MORE" | "LESS" = edgeAmt >= 0 ? "MORE" : "LESS";

  const reason1 = game.topReasons[0] ?? `Model projects ${favFighter.name} at ${Math.round(favProb * 100)}% win probability`;
  const reason2 = game.topReasons[1] ?? game.keyMatchup;
  const risk = game.riskFactors[0] ?? game.upsetPath;

  return {
    id: `${sport.toLowerCase()}-winner-${game.id}`,
    game_id: game.id,
    player_id: `${sport.toLowerCase()}-${favFighter.abbreviation}`,
    player_name: favFighter.name,
    sport,
    team: favFighter.abbreviation,
    opponent: undFighter.name,
    game_time: game.gameTime,
    stat_type: "fight_winner",
    // line_value = implied probability as %, projected_value = model prob as %
    line_value: Math.round(favImplied * 1000) / 10,
    projected_value: Math.round(favProb * 1000) / 10,
    prediction_direction: direction,
    edge: edgePct,
    confidence,
    reason_1: reason1,
    reason_2: reason2,
    risk_factor: risk ?? "Fight outcomes are binary — any prop here is high variance.",
    game_sort: sortBase,
    confidence_score_0_100: confidence === "HIGH" ? 72 : confidence === "MED" ? 58 : 44,
    risk_tier: riskTier(confidence),
    consistency_label: confidence === "HIGH" ? "stable" : confidence === "MED" ? "medium" : "volatile",
    trend_note: game.situationalTags?.includes("TITLE FIGHT") || game.situationalTags?.includes("TITLE BOUT")
      ? "Title fight — elevated stakes, sharper market"
      : undefined,
    timing_note: timingNote(sport),
  };
}

// ── Method prop (KO/TKO or Decision) ──────────────────────────────────────────

function buildMethodProp(
  game: GamePrediction,
  sport: "Boxing" | "MMA",
  sortBase: number
): PlayerEdgePrediction | null {
  // Get method probabilities from boxing/MMA intel
  const boxing = game.boxing;
  const mma = game.mma;
  const method =
    boxing?.modelOutput?.methodProbabilities ??
    mma?.modelOutput?.methodProbabilities;

  if (!method) return null;

  const koProb = ("ko_tko" in method ? method.ko_tko : 0) as number;
  const decProb = ("decision" in method ? method.decision : 0) as number;

  // Pick the more likely method with >40% probability
  const useKo = koProb > decProb && koProb > 0.35;
  const useDecision = !useKo && decProb > 0.40;
  if (!useKo && !useDecision) return null;

  const favFighter = game.winProbability.home >= game.winProbability.away
    ? game.homeTeam : game.awayTeam;
  const undFighter = game.winProbability.home >= game.winProbability.away
    ? game.awayTeam : game.homeTeam;

  const methodProb = useKo ? koProb : decProb;
  const methodType = useKo ? "ko_tko" : "decision";
  const edgeAmt = methodProb - 0.5;  // vs 50/50 base
  const confidence = methodProb >= 0.60 ? "HIGH" : methodProb >= 0.45 ? "MED" : "LOW";

  return {
    id: `${sport.toLowerCase()}-method-${game.id}`,
    game_id: game.id,
    player_id: `${sport.toLowerCase()}-method-${game.id}`,
    player_name: favFighter.name,
    sport,
    team: favFighter.abbreviation,
    opponent: undFighter.name,
    game_time: game.gameTime,
    stat_type: methodType,
    line_value: 50,  // baseline 50%
    projected_value: Math.round(methodProb * 1000) / 10,
    prediction_direction: edgeAmt >= 0 ? "MORE" : "LESS",
    edge: Math.round(edgeAmt * 1000) / 10,
    confidence,
    reason_1: useKo
      ? `Model projects ${Math.round(koProb * 100)}% KO/TKO probability based on style matchup`
      : `Model projects ${Math.round(decProb * 100)}% decision probability — defensive styles clash`,
    reason_2: game.keyMatchup,
    risk_factor: "Method markets carry extra variance — late stoppages can shift outcomes unpredictably.",
    game_sort: sortBase + 1,
    confidence_score_0_100: confidence === "HIGH" ? 68 : confidence === "MED" ? 55 : 42,
    risk_tier: riskTier(confidence),
    consistency_label: confidence === "HIGH" ? "medium" : "volatile",
    timing_note: timingNote(sport),
  };
}

// ── Total rounds prop ──────────────────────────────────────────────────────────

function buildRoundsProp(
  game: GamePrediction,
  sport: "Boxing" | "MMA",
  sortBase: number
): PlayerEdgePrediction | null {
  const total = game.lines?.total;
  if (!total) return null;

  const favFighter = game.winProbability.home >= game.winProbability.away
    ? game.homeTeam : game.awayTeam;
  const undFighter = game.winProbability.home >= game.winProbability.away
    ? game.awayTeam : game.homeTeam;

  // Use method probs to lean over/under
  const boxing = game.boxing;
  const mma = game.mma;
  const koProb =
    (boxing?.modelOutput?.methodProbabilities?.ko_tko as number | undefined) ??
    (mma?.modelOutput?.methodProbabilities?.ko_tko as number | undefined) ??
    0.4;

  // High KO rate → lean under (fight ends early)
  const direction: "MORE" | "LESS" = koProb > 0.55 ? "LESS" : "MORE";
  const proj = direction === "LESS"
    ? Math.round(total * 0.85 * 10) / 10
    : Math.round(total * 1.08 * 10) / 10;
  const edge = Math.round((proj - total) * 10) / 10;

  if (Math.abs(edge) < 0.3) return null;

  return {
    id: `${sport.toLowerCase()}-rounds-${game.id}`,
    game_id: game.id,
    player_id: `${sport.toLowerCase()}-rounds-${game.id}`,
    player_name: `${favFighter.name} vs ${undFighter.name}`,
    sport,
    team: favFighter.abbreviation,
    opponent: undFighter.abbreviation,
    game_time: game.gameTime,
    stat_type: "total_rounds",
    line_value: total,
    projected_value: proj,
    prediction_direction: direction,
    edge,
    confidence: Math.abs(edge) >= 1.0 ? "HIGH" : "MED",
    reason_1: koProb > 0.55
      ? `High KO/TKO probability (${Math.round(koProb * 100)}%) suggests early finish`
      : `Style matchup favors a full-rounds battle`,
    reason_2: game.keyMatchup,
    risk_factor: "Rounds totals sensitive to early stoppages or fighter injuries.",
    game_sort: sortBase + 2,
    confidence_score_0_100: Math.abs(edge) >= 1.0 ? 64 : 52,
    risk_tier: "balanced",
    consistency_label: "medium",
    timing_note: sport === "MMA" ? "Pregame · After R1" : "Pregame",
  };
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Fetches boxing and MMA fight predictions and converts them into
 * PlayerEdgePrediction format for the Player Edge prop scanner.
 */
export async function fetchCombatPlayerEdgePredictions(): Promise<PlayerEdgePrediction[]> {
  const [boxingGames, mmaGames] = await Promise.all([
    fetchBoxingPredictions().catch(() => [] as GamePrediction[]),
    fetchMmaPredictions().catch(() => [] as GamePrediction[]),
  ]);

  const results: PlayerEdgePrediction[] = [];

  // Boxing props (upcoming + live only)
  let boxSort = 5000;
  for (const game of boxingGames) {
    if (game.status === "final") continue;
    const winner = buildWinnerProp(game, "Boxing", boxSort);
    if (winner) results.push(winner);
    const method = buildMethodProp(game, "Boxing", boxSort);
    if (method) results.push(method);
    const rounds = buildRoundsProp(game, "Boxing", boxSort);
    if (rounds) results.push(rounds);
    boxSort += 10;
  }

  // MMA props
  let mmaSort = 6000;
  for (const game of mmaGames) {
    if (game.status === "final") continue;
    const winner = buildWinnerProp(game, "MMA", mmaSort);
    if (winner) results.push(winner);
    const method = buildMethodProp(game, "MMA", mmaSort);
    if (method) results.push(method);
    const rounds = buildRoundsProp(game, "MMA", mmaSort);
    if (rounds) results.push(rounds);
    mmaSort += 10;
  }

  return results;
}
