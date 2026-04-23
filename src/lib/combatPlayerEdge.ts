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

// ── Method props (KO/TKO · Submission · Decision · Draw) ──────────────────────

interface MethodContext {
  koProb: number;
  subProb: number;
  decProb: number;
  drawProb: number;
  hasRealStats: boolean;
  homeFighter: import("@/data/mockGames").MmaFighterProfile | undefined;
  awayFighter: import("@/data/mockGames").MmaFighterProfile | undefined;
  favFighter: { name: string; abbreviation: string };
  undFighter: { name: string; abbreviation: string };
}

function getMethodContext(game: GamePrediction): MethodContext | null {
  const boxing = game.boxing;
  const mma    = game.mma;
  const method = boxing?.modelOutput?.methodProbabilities ?? mma?.modelOutput?.methodProbabilities;
  if (!method) return null;

  // Both boxing and MMA profiles have different fields. When MMA is present,
  // use its richer fighter stats (koTkoPct, subPct). Boxing fighters fall back
  // to koPct and never have subPct.
  const mmaHome = mma?.homeFighter;
  const mmaAway = mma?.awayFighter;
  const boxingHome = boxing?.homeFighter;
  const boxingAway = boxing?.awayFighter;
  const hasRealStats =
    mmaHome?.koTkoPct != null || mmaAway?.koTkoPct != null ||
    mmaHome?.subPct != null   || mmaAway?.subPct != null   ||
    boxingHome?.koPct != null || boxingAway?.koPct != null;

  const koProb  = (method as Record<string, number>).ko_tko   ?? 0;
  const subProb = (method as Record<string, number>).submission ?? 0;
  const decProb = (method as Record<string, number>).decision  ?? 0;
  const drawProb = Math.max(0, 1 - koProb - subProb - decProb);

  const favHome = game.winProbability.home >= game.winProbability.away;
  // Downstream code expects MmaFighterProfile shape; use MMA profile when
  // available, otherwise fall back to a minimal adapter for boxing.
  const homeFighter = mmaHome;
  const awayFighter = mmaAway;
  return {
    koProb, subProb, decProb, drawProb,
    hasRealStats,
    homeFighter,
    awayFighter,
    favFighter: favHome ? game.homeTeam : game.awayTeam,
    undFighter: favHome ? game.awayTeam : game.homeTeam,
  };
}

/** KO/TKO — attributed to the fighter with the higher KO rate (or favored if no stats). */
function buildKoTkoProp(
  game: GamePrediction,
  sport: "Boxing" | "MMA",
  ctx: MethodContext,
  sortBase: number
): PlayerEdgePrediction | null {
  if (!ctx.hasRealStats) return null;
  if (ctx.koProb < 0.20) return null;

  // Which fighter is more likely to score the KO?
  const homeKoPct = ctx.homeFighter?.koTkoPct ?? 0;
  const awayKoPct = ctx.awayFighter?.koTkoPct ?? 0;
  const koFighter = homeKoPct >= awayKoPct ? game.homeTeam : game.awayTeam;
  const oppFighter = homeKoPct >= awayKoPct ? game.awayTeam : game.homeTeam;
  const koFighterPct = Math.max(homeKoPct, awayKoPct);

  const edgeAmt = ctx.koProb - 0.33; // vs 1-in-3 baseline for three-outcome market
  const confidence: "HIGH" | "MED" | "LOW" = ctx.koProb >= 0.50 ? "HIGH" : ctx.koProb >= 0.30 ? "MED" : "LOW";

  return {
    id: `${sport.toLowerCase()}-ko-${game.id}`,
    game_id: game.id,
    player_id: `${sport.toLowerCase()}-ko-${game.id}`,
    player_name: koFighter.name,
    sport,
    team: koFighter.abbreviation,
    opponent: oppFighter.name,
    game_time: game.gameTime,
    stat_type: "ko_tko",
    line_value: 33,
    projected_value: Math.round(ctx.koProb * 1000) / 10,
    prediction_direction: edgeAmt >= 0 ? "MORE" : "LESS",
    edge: Math.round(edgeAmt * 1000) / 10,
    confidence,
    reason_1: `Model projects ${Math.round(ctx.koProb * 100)}% KO/TKO probability — style matchup favors early finish`,
    reason_2: koFighterPct > 0
      ? `${koFighter.name} finishes ${Math.round(koFighterPct * 100)}% of wins by KO/TKO. ${game.keyMatchup}`
      : game.keyMatchup,
    risk_factor: "KO timing is unpredictable — a single takedown or clinch can nullify striking output.",
    game_sort: sortBase + 1,
    confidence_score_0_100: confidence === "HIGH" ? 68 : confidence === "MED" ? 55 : 42,
    risk_tier: riskTier(confidence),
    consistency_label: "medium",
    timing_note: timingNote(sport),
  };
}

/** Submission — only shown when real grappling stats exist. */
function buildSubmissionProp(
  game: GamePrediction,
  sport: "Boxing" | "MMA",
  ctx: MethodContext,
  sortBase: number
): PlayerEdgePrediction | null {
  if (!ctx.hasRealStats) return null;
  if (ctx.subProb < 0.12) return null; // submissions are rarer — lower threshold

  const homeSubPct = ctx.homeFighter?.subPct ?? 0;
  const awaySubPct = ctx.awayFighter?.subPct ?? 0;
  const subFighter = homeSubPct >= awaySubPct ? game.homeTeam : game.awayTeam;
  const oppFighter = homeSubPct >= awaySubPct ? game.awayTeam : game.homeTeam;
  const subFighterPct = Math.max(homeSubPct, awaySubPct);

  // Avg sub attempts per 15 min
  const homeSub15 = ctx.homeFighter?.avgSubAttemptsPer15 ?? 0;
  const awaySub15 = ctx.awayFighter?.avgSubAttemptsPer15 ?? 0;
  const subAttempts = Math.max(homeSub15, awaySub15);

  const edgeAmt = ctx.subProb - 0.20; // baseline ~20%
  const confidence: "HIGH" | "MED" | "LOW" = ctx.subProb >= 0.35 ? "HIGH" : ctx.subProb >= 0.20 ? "MED" : "LOW";

  return {
    id: `${sport.toLowerCase()}-sub-${game.id}`,
    game_id: game.id,
    player_id: `${sport.toLowerCase()}-sub-${game.id}`,
    player_name: subFighter.name,
    sport,
    team: subFighter.abbreviation,
    opponent: oppFighter.name,
    game_time: game.gameTime,
    stat_type: "submission",
    line_value: 20,
    projected_value: Math.round(ctx.subProb * 1000) / 10,
    prediction_direction: edgeAmt >= 0 ? "MORE" : "LESS",
    edge: Math.round(edgeAmt * 1000) / 10,
    confidence,
    reason_1: `Model projects ${Math.round(ctx.subProb * 100)}% submission probability — grappling style matchup`,
    reason_2: subFighterPct > 0
      ? `${subFighter.name} finishes ${Math.round(subFighterPct * 100)}% of wins by submission${subAttempts > 0 ? `, avg ${subAttempts.toFixed(1)} attempts/15 min` : ""}. ${game.keyMatchup}`
      : game.keyMatchup,
    risk_factor: "Submission odds swing sharply when fighters are taken down or clinch early.",
    game_sort: sortBase + 2,
    confidence_score_0_100: confidence === "HIGH" ? 65 : confidence === "MED" ? 52 : 40,
    risk_tier: riskTier(confidence),
    consistency_label: "medium",
    timing_note: timingNote(sport),
  };
}

/** Decision — shown when fight is projected to go to the judges. */
function buildDecisionProp(
  game: GamePrediction,
  sport: "Boxing" | "MMA",
  ctx: MethodContext,
  sortBase: number
): PlayerEdgePrediction | null {
  if (!ctx.hasRealStats) return null;
  if (ctx.decProb < 0.40) return null;

  const fightLabel = `${ctx.favFighter.name} vs ${ctx.undFighter.name}`;
  const edgeAmt = ctx.decProb - 0.40; // baseline ~40% for decision
  const confidence: "HIGH" | "MED" | "LOW" = ctx.decProb >= 0.60 ? "HIGH" : ctx.decProb >= 0.45 ? "MED" : "LOW";

  return {
    id: `${sport.toLowerCase()}-dec-${game.id}`,
    game_id: game.id,
    player_id: `${sport.toLowerCase()}-dec-${game.id}`,
    player_name: fightLabel,
    sport,
    team: ctx.favFighter.abbreviation,
    opponent: ctx.undFighter.abbreviation,
    game_time: game.gameTime,
    stat_type: "decision",
    line_value: 40,
    projected_value: Math.round(ctx.decProb * 1000) / 10,
    prediction_direction: edgeAmt >= 0 ? "MORE" : "LESS",
    edge: Math.round(edgeAmt * 1000) / 10,
    confidence,
    reason_1: `Model projects ${Math.round(ctx.decProb * 100)}% probability fight goes to decision — defensive styles clash`,
    reason_2: game.keyMatchup,
    risk_factor: "A single big punch or takedown can turn a projected points fight into an early finish.",
    game_sort: sortBase + 3,
    confidence_score_0_100: confidence === "HIGH" ? 66 : confidence === "MED" ? 53 : 41,
    risk_tier: riskTier(confidence),
    consistency_label: confidence === "HIGH" ? "stable" : "medium",
    timing_note: timingNote(sport),
  };
}

/** Draw — only shown when draw probability > 4% (rare but high value when it hits). */
function buildDrawProp(
  game: GamePrediction,
  sport: "Boxing" | "MMA",
  ctx: MethodContext,
  sortBase: number
): PlayerEdgePrediction | null {
  // Draws are very rare in MMA — only surface when probability is meaningful
  if (ctx.drawProb < 0.04) return null;
  // Require at least some real stats so we're not showing noise from default model
  if (!ctx.hasRealStats) return null;

  const fightLabel = `${ctx.favFighter.name} vs ${ctx.undFighter.name}`;
  const edgeAmt = ctx.drawProb - 0.02; // baseline ~2% for draws
  const confidence: "HIGH" | "MED" | "LOW" = ctx.drawProb >= 0.08 ? "MED" : "LOW";

  return {
    id: `${sport.toLowerCase()}-draw-${game.id}`,
    game_id: game.id,
    player_id: `${sport.toLowerCase()}-draw-${game.id}`,
    player_name: fightLabel,
    sport,
    team: ctx.favFighter.abbreviation,
    opponent: ctx.undFighter.abbreviation,
    game_time: game.gameTime,
    stat_type: "draw",
    line_value: 2,
    projected_value: Math.round(ctx.drawProb * 1000) / 10,
    prediction_direction: "MORE",
    edge: Math.round(edgeAmt * 1000) / 10,
    confidence,
    reason_1: `Draw probability at ${Math.round(ctx.drawProb * 100)}% — evenly matched styles, potential scorecards split`,
    reason_2: game.keyMatchup,
    risk_factor: "Draws require judges to score identically — exact round-by-round breakdowns matter.",
    game_sort: sortBase + 4,
    confidence_score_0_100: confidence === "MED" ? 50 : 38,
    risk_tier: "longshot",
    consistency_label: "volatile",
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
    const ctx = getMethodContext(game);
    if (ctx) {
      const ko  = buildKoTkoProp(game, "Boxing", ctx, boxSort);
      if (ko) results.push(ko);
      const sub = buildSubmissionProp(game, "Boxing", ctx, boxSort);
      if (sub) results.push(sub);
      const dec = buildDecisionProp(game, "Boxing", ctx, boxSort);
      if (dec) results.push(dec);
      const draw = buildDrawProp(game, "Boxing", ctx, boxSort);
      if (draw) results.push(draw);
    }
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
    const ctx = getMethodContext(game);
    if (ctx) {
      const ko  = buildKoTkoProp(game, "MMA", ctx, mmaSort);
      if (ko) results.push(ko);
      const sub = buildSubmissionProp(game, "MMA", ctx, mmaSort);
      if (sub) results.push(sub);
      const dec = buildDecisionProp(game, "MMA", ctx, mmaSort);
      if (dec) results.push(dec);
      const draw = buildDrawProp(game, "MMA", ctx, mmaSort);
      if (draw) results.push(draw);
    }
    const rounds = buildRoundsProp(game, "MMA", mmaSort);
    if (rounds) results.push(rounds);
    mmaSort += 10;
  }

  return results;
}
