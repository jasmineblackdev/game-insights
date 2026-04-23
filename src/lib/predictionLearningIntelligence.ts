/**
 * Server-backed learning layer (Phase 1–3). No UI.
 * Writes to Supabase via submit_prediction_learning_record; complements localStorage in predictionLearningStorage.
 */
import type { GamePrediction } from "@/data/mockGames";
import type { FinalPredictionContext } from "@/lib/liveGameState";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

export type LearningEnginePhase = 1 | 2 | 3;

export function getLearningEnginePhase(): LearningEnginePhase {
  const raw = import.meta.env.VITE_LEARNING_ENGINE_PHASE;
  const n = raw != null && raw !== "" ? Number(raw) : 1;
  if (n === 2) return 2;
  if (n >= 3) return 3;
  return 1;
}

export function oddsRangeBucket(american: number | null | undefined): string {
  if (american == null || !Number.isFinite(american)) return "unknown";
  if (american <= -250) return "heavy_favorite";
  if (american <= -150) return "favorite";
  if (american <= -110) return "pick_em_fav";
  if (american < 150) return "pick_em_dog";
  if (american < 250) return "underdog";
  return "longshot";
}

function riskScoreFromGame(game: GamePrediction): number {
  const v = game._meta?.quality?.volatility?.volatility_score;
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100) / 100;
  const lab = game._meta?.quality?.volatility?.volatility_label;
  if (lab === "high") return 72;
  if (lab === "medium") return 48;
  return 36;
}

function modelProbForPickedSide(game: GamePrediction, picked: "home" | "away" | "draw"): number {
  if (game.threeWay) {
    if (picked === "home") return game.threeWay.home / 100;
    if (picked === "away") return game.threeWay.away / 100;
    return game.threeWay.draw / 100;
  }
  const ph = game.winProbability.home / 100;
  const pa = game.winProbability.away / 100;
  return picked === "home" ? ph : pa;
}

function binaryHitOutcome(ctx: FinalPredictionContext): "win" | "loss" | "push" {
  if (ctx.outcome === "push") return "push";
  return ctx.correct ? "win" : "loss";
}

function errorSizeModel(ctx: FinalPredictionContext, game: GamePrediction): number {
  const p = modelProbForPickedSide(game, ctx.pickedSide);
  const y = ctx.outcome === "hit" ? 1 : ctx.outcome === "miss" ? 0 : 0.5;
  return Math.round(Math.abs(p - y) * 10000) / 10000;
}

function lastCheckpointStageId(game: GamePrediction): string | null {
  const cps = game._meta?.liveBetting?.checkpoints;
  if (!cps?.length) return null;
  return cps[cps.length - 1]!.stageId;
}

function predictionPhaseForGame(game: GamePrediction): "pregame" | "live" | "closing" {
  const cps = game._meta?.liveBetting?.checkpoints;
  if (cps && cps.length > 0) return "live";
  return "pregame";
}

/**
 * Map likely failure modes when the model missed (heuristic tags for learning).
 */
export function inferMissTagsForLearning(game: GamePrediction, hit: boolean): string[] {
  if (hit) return [];
  const tags = new Set<string>();

  if (game._meta?.quality?.predictionIntel?.late_change_flag) tags.add("lineup_change");

  const inj = [...game.injuries.home, ...game.injuries.away];
  if (inj.some((i) => i.status === "OUT" && i.impactScore >= 8)) tags.add("injury_surprise");
  if (inj.some((i) => (i.status === "QUESTIONABLE" || i.status === "GTD") && i.impactScore >= 7)) tags.add("injury_surprise");

  const vol = game._meta?.quality?.volatility?.volatility_label;
  if (vol === "high") tags.add("pace_misread");

  const blow = game._meta?.quality?.predictionIntel?.blowout_risk_score;
  if (typeof blow === "number" && blow >= 62) tags.add("blowout");

  if (game.league === "nba" && inj.some((i) => i.detail?.toLowerCase().includes("foul"))) tags.add("foul_trouble");

  if (game.league === "mlb") {
    if (game.mlb?.modelOutput?.riskFlag?.toLowerCase().includes("bullpen")) tags.add("bullpen_collapse");
    if (game.mlb?.pitcherCertainty !== "confirmed") tags.add("lineup_change");
  }

  if (game._meta?.quality?.market?.sharp_move_hint || game._meta?.quality?.market?.line_movement_home_pp != null) {
    tags.add("market_movement");
  }

  if (tags.size === 0) tags.add("unknown");
  return [...tags];
}

function learningExtra(game: GamePrediction): Record<string, unknown> {
  const blow = game._meta?.quality?.predictionIntel?.blowout_risk_score;
  return {
    blowout_risk: typeof blow === "number" && blow >= 58 ? "high" : "normal",
    lineup_confirmed: game.league === "mlb" ? Boolean(game.mlb?.lineupConfirmed) : undefined,
    volatility_label: game._meta?.quality?.volatility?.volatility_label ?? null,
  };
}

/**
 * Submit one settled team moneyline (or 1X2) row for analytics. Idempotent per game via RPC.
 */
export async function submitTeamMoneylineLearningRecord(
  game: GamePrediction,
  ctx: FinalPredictionContext
): Promise<void> {
  if (!isSupabaseConfigured || !supabase) return;

  const bi = game._meta?.bettingIntel;
  const useBi = bi && bi.pickSide === ctx.pickedSide;

  const american = useBi ? bi.americanOdds : null;
  const implied = useBi ? bi.impliedProbability : null;
  const modelP = useBi ? bi.modelProbability : modelProbForPickedSide(game, ctx.pickedSide);
  const edge = useBi ? bi.edge : null;

  const fh = game._meta?.finalHomeScore;
  const fa = game._meta?.finalAwayScore;

  const pickLabel =
    ctx.pickedSide === "home"
      ? game.homeTeam.abbreviation
      : ctx.pickedSide === "away"
        ? game.awayTeam.abbreviation
        : "Draw";

  const reasonTags = JSON.parse(JSON.stringify(game.topReasons.slice(0, 6))) as unknown;

  const p_history: Record<string, unknown> = {
    external_game_id: game.id,
    sport: game.league,
    market_type: "team_moneyline",
    pick_side: ctx.pickedSide,
    pick_label: pickLabel,
    american_odds: american != null ? String(Math.round(american)) : "",
    implied_probability: implied != null ? String(implied) : "",
    model_probability: String(modelP),
    edge: edge != null ? String(edge) : "",
    confidence: game.confidence,
    risk_score: String(riskScoreFromGame(game)),
    reason_tags: reasonTags,
    checkpoint_stage: lastCheckpointStageId(game) ?? "",
    prediction_phase: predictionPhaseForGame(game),
    final_home_score: fh != null ? String(fh) : "",
    final_away_score: fa != null ? String(fa) : "",
    outcome: binaryHitOutcome(ctx),
    error_size: String(errorSizeModel(ctx, game)),
    odds_range_bucket: oddsRangeBucket(american ?? undefined),
    source: "gamelens_web_v1",
    learning_phase: String(getLearningEnginePhase()),
    extra: learningExtra(game),
  };

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.user?.id) p_history.user_id = session.user.id;
  } catch {
    /* ignore */
  }

  const tags = inferMissTagsForLearning(game, ctx.outcome === "hit");

  try {
    const { error } = await supabase.rpc("submit_prediction_learning_record", {
      p_history,
      p_error_tags: tags,
    });
    if (error && import.meta.env.DEV) console.warn("[learning]", error.message);
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[learning]", e);
  }
}
