/**
 * ML Training Sample writer + outcome recorder.
 *
 * Every recommendation surface (Auto Profit, Daily Plan, manual entry,
 * DraftKings flow) calls writeTrainingSample() at the moment of
 * recommendation. Settlement surfaces (per-leg outcome buttons,
 * recommended_parlays outcome flips) call recordOutcome() to attach
 * the result.
 *
 * Both are fire-and-forget — never block UI on the ML pipeline.
 */

import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";

export type TrainingSampleSource =
  | "app_recommended"
  | "auto_profit"
  | "daily_plan"
  | "user_manual"
  | "draftkings_manual";

export interface TrainingSampleInput {
  sport: string;                              // "NBA" | "WNBA" | "NFL" | "MLB" | ...
  league: string;                             // lower-case version
  gameId?: string;
  eventDate?: string;                         // ISO date (YYYY-MM-DD)
  betType: string;                            // "moneyline" | "player_prop" | ...
  market?: string;                            // stat_type or market_type
  team?: string;
  player?: string;
  side?: string;                              // "home" / "OVER" / etc.
  line?: number;
  oddsAtRecommendation?: number;
  oddsAtPlacement?: number;
  impliedProbability?: number;
  modelProbability?: number;
  rulesScore?: number;
  finalScore?: number;
  confidence?: "high" | "medium" | "low";
  riskLevel?: "low" | "medium" | "high";
  dataQuality?: number;                       // 0–1
  matchupQuality?: string;
  matchupScore?: number;
  volatilityScore?: number;
  sportPriorityScore?: number;
  sportStreakState?: "hot" | "stable" | "cold" | "low_data";
  autoProfitMode?: "green" | "caution" | "no_bet";
  autoProfitAction?: "BET_NOW" | "SMALL_BET" | "WAIT" | "SKIP";
  bankrollStage?: string;
  suggestedStake?: number;
  actualStake?: number;
  placedByUser?: boolean;
  sportsbook?: string;
  source: TrainingSampleSource;
  modelVersion: string;
  featureVersion?: string;
  featuresSnapshot?: Record<string, unknown>;
  notes?: string;
}

/**
 * Fields we'd normally expect for an ML-quality sample. When any are
 * missing we still write the row but flag missing_fields so the
 * training pipeline can filter low-quality rows.
 */
const REQUIRED_FOR_ML: Array<keyof TrainingSampleInput> = [
  "betType",
  "market",
  "line",
  "oddsAtRecommendation",
  "modelProbability",
  "confidence",
];

function findMissingFields(input: TrainingSampleInput): string[] {
  const missing: string[] = [];
  for (const k of REQUIRED_FOR_ML) {
    const v = input[k];
    if (v === undefined || v === null || v === "" || (typeof v === "number" && !Number.isFinite(v))) {
      missing.push(String(k));
    }
  }
  // Player props need a player; team picks need a team.
  if (input.betType === "player_prop" && !input.player) missing.push("player");
  if (input.betType !== "player_prop" && !input.team) missing.push("team");
  return missing;
}

function inferRiskLevel(input: TrainingSampleInput): TrainingSampleInput["riskLevel"] {
  if (input.riskLevel) return input.riskLevel;
  // Conservative inference from confidence when caller didn't pass one.
  if (input.confidence === "high") return "low";
  if (input.confidence === "medium") return "medium";
  return "high";
}

/**
 * Append a training sample. Best-effort — returns false on any
 * failure (missing config, no signed-in user for RLS, network error,
 * dedup collision). Never throws.
 */
export async function writeTrainingSample(input: TrainingSampleInput): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  try {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    if (!userId) return false;
    const missing = findMissingFields(input);
    const row = {
      user_id:                  userId,
      sport:                    input.sport,
      league:                   input.league,
      game_id:                  input.gameId ?? null,
      event_date:               input.eventDate ?? null,
      bet_type:                 input.betType,
      market:                   input.market ?? null,
      team:                     input.team ?? null,
      player:                   input.player ?? null,
      side:                     input.side ?? null,
      line:                     input.line ?? null,
      odds_at_recommendation:   input.oddsAtRecommendation ?? null,
      odds_at_placement:        input.oddsAtPlacement ?? null,
      implied_probability:      input.impliedProbability ?? null,
      model_probability:        input.modelProbability ?? null,
      rules_score:              input.rulesScore ?? null,
      final_score:              input.finalScore ?? null,
      confidence:               input.confidence ?? null,
      risk_level:               inferRiskLevel(input) ?? null,
      data_quality:             input.dataQuality ?? null,
      matchup_quality:          input.matchupQuality ?? null,
      matchup_score:            input.matchupScore ?? null,
      volatility_score:         input.volatilityScore ?? null,
      sport_priority_score:     input.sportPriorityScore ?? null,
      sport_streak_state:       input.sportStreakState ?? null,
      auto_profit_mode:         input.autoProfitMode ?? null,
      auto_profit_action:       input.autoProfitAction ?? null,
      bankroll_stage:           input.bankrollStage ?? null,
      suggested_stake:          input.suggestedStake ?? null,
      actual_stake:             input.actualStake ?? null,
      placed_by_user:           input.placedByUser ?? false,
      sportsbook:               input.sportsbook ?? null,
      source:                   input.source,
      model_version:            input.modelVersion,
      feature_version:          input.featureVersion ?? "v1",
      features_snapshot:        input.featuresSnapshot ?? null,
      missing_fields:           missing,
      notes:                    input.notes ?? null,
    };
    const { error } = await supabase.from("ml_training_samples").upsert([row], {
      onConflict: "user_id,sport,bet_type,market,player,team,line,event_date,source",
      ignoreDuplicates: true,
    });
    if (error) {
      // Most likely cause: table doesn't exist yet (migration not run).
      // Log once-per-session and fall through silently.
      const msg = (error.message ?? "").toLowerCase();
      if (msg.includes("does not exist") || msg.includes("relation")) {
        return false;
      }
      console.warn("[ml-training] writeTrainingSample failed:", error.message);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Bulk-write samples derived from a parlay's legs. Used by the
 * parlay-tracking flow so every leg becomes a training sample at the
 * moment the user marks the ticket placed.
 */
export async function writeTrainingSamplesFromLegs(args: {
  legs: ValueBetCandidate[];
  source: TrainingSampleSource;
  modelVersion: string;
  autoProfitMode?: TrainingSampleInput["autoProfitMode"];
  autoProfitAction?: TrainingSampleInput["autoProfitAction"];
  suggestedStake?: number;
  actualStake?: number;
  sportsbook?: string;
  placedByUser?: boolean;
  featuresSnapshotPerLeg?: (l: ValueBetCandidate) => Record<string, unknown> | undefined;
}): Promise<number> {
  let written = 0;
  for (const l of args.legs) {
    const ok = await writeTrainingSample({
      sport: String(l.sport).toUpperCase(),
      league: String(l.sport).toLowerCase(),
      gameId: l.gameId,
      betType: l.marketType,
      market: l.statType ?? l.marketType,
      team: l.teamId,
      player: l.playerName,
      side: l.selectionLabel,
      line: l.lineValue,
      oddsAtRecommendation: l.americanOdds,
      impliedProbability: l.impliedProbability,
      modelProbability: l.modelProbability,
      finalScore: l.valueScore,
      confidence: l.confidence,
      riskLevel: l.riskBand === "low" ? "low" : l.riskBand === "high" ? "high" : "medium",
      volatilityScore: l.volatilityScore,
      autoProfitMode: args.autoProfitMode,
      autoProfitAction: args.autoProfitAction,
      // Stake is shared across legs for a parlay — record the same value
      // on each leg so the eventual ROI can be reconstructed per leg.
      suggestedStake: args.suggestedStake,
      actualStake: args.actualStake,
      placedByUser: args.placedByUser ?? true,
      sportsbook: args.sportsbook,
      source: args.source,
      modelVersion: args.modelVersion,
      featuresSnapshot: args.featuresSnapshotPerLeg?.(l),
    });
    if (ok) written++;
  }
  return written;
}

/**
 * Attach an outcome to a training sample. Caller passes the sample id
 * (returned by writeTrainingSample's row, or looked up via the dedup
 * constraint).
 */
export async function recordOutcome(args: {
  sampleId: string;
  result: "win" | "loss" | "push" | "cashed_out" | "void";
  closingLine?: number;
  closingOdds?: number;
  profitLoss?: number;
  settlementSource?: "user_marked" | "auto_settled" | "sportsbook_sync" | "manual_correction";
  notes?: string;
}): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  try {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    if (!userId) return false;
    const row = {
      sample_id:           args.sampleId,
      user_id:             userId,
      result:              args.result,
      closing_line:        args.closingLine ?? null,
      closing_odds:        args.closingOdds ?? null,
      profit_loss:         args.profitLoss ?? null,
      settlement_source:   args.settlementSource ?? "user_marked",
      notes:               args.notes ?? null,
    };
    const { error } = await supabase.from("ml_outcomes").upsert([row], {
      onConflict: "sample_id",
    });
    if (error) {
      const msg = (error.message ?? "").toLowerCase();
      if (msg.includes("does not exist") || msg.includes("relation")) return false;
      console.warn("[ml-training] recordOutcome failed:", error.message);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Activation thresholds ────────────────────────────────────────
// Used by the rest of the system to decide whether to surface an
// "ML active" badge for a sport+market bucket. Mirrors the RPC's
// is-active rule (≥25 resolved AND avg data_quality ≥ 0.6).

export interface MlBucketHealth {
  sport: string;
  betType: string;
  market: string;
  totalSamples: number;
  resolvedSamples: number;
  pendingSamples: number;
  avgDataQuality: number | null;
  missingFieldRate: number | null;
  mlActive: boolean;
}

/** Fetch the health rows from the RPC. Returns [] when not configured. */
export async function fetchMlTrainingHealth(): Promise<MlBucketHealth[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  try {
    const { data, error } = await supabase.rpc("analytics_ml_training_health");
    if (error || !data) return [];
    return (data as Array<{
      sport: string;
      bet_type: string;
      market: string;
      total_samples: number;
      resolved_samples: number;
      pending_samples: number;
      avg_data_quality: number | null;
      missing_field_rate: number | null;
      ml_active: boolean;
    }>).map((r) => ({
      sport: r.sport,
      betType: r.bet_type,
      market: r.market,
      totalSamples: r.total_samples,
      resolvedSamples: r.resolved_samples,
      pendingSamples: r.pending_samples,
      avgDataQuality: r.avg_data_quality,
      missingFieldRate: r.missing_field_rate,
      mlActive: r.ml_active,
    }));
  } catch {
    return [];
  }
}

/** Activation threshold for a single bucket — usable client-side too. */
export function isMlActiveForBucket(b: MlBucketHealth): boolean {
  return b.resolvedSamples >= 25 && (b.avgDataQuality ?? 0) >= 0.6;
}
