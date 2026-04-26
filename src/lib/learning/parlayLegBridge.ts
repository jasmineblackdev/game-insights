/**
 * Bridge — recommended_parlays.legs → prediction_history.
 *
 * Each settled leg in a parlay becomes one row in prediction_history
 * via submit_prediction_learning_record, so the ML feedback loop
 * (recalibrateWeights / recalibratePlatt / backtest CI) can learn
 * from parlays the user logged manually.
 *
 * IMPORTANT — model_probability semantics
 *   For user-entered parlays we don't have the *model's* probability
 *   at pick time. We use the implied probability from American odds
 *   as a proxy and tag the row with extra.model_probability_source =
 *   "implied_odds_proxy". The backtest can filter on that tag if it
 *   only wants rows where model_probability is a real model output.
 *   Without filtering, training against this data nudges the model
 *   toward bookmaker calibration — useful for measuring whether bets
 *   beat the books, but NOT useful for measuring whether *our* model
 *   beats the books.
 *
 * Idempotency
 *   Each leg gets a synthetic external_game_id of `${parlay_id}:L${i}`
 *   plus extra.parlay_leg_signature. We pre-query for that signature
 *   before inserting so reruns are cheap and safe.
 *
 * Schema gates
 *   - prediction_history.sport check constraint allows only
 *     (nba, nfl, mlb, soccer). Other sports are skipped (count
 *     surfaced in the result so callers can warn).
 *   - leg_outcome must be win | loss | push. Pending legs are
 *     skipped — they're re-evaluated on the next bridge run.
 */

import { supabase } from "@/lib/supabase";

// Sports allowed by the live prediction_history.sport check.
const ALLOWED_SPORTS = new Set(["nba", "nfl", "mlb", "soccer"]);

const CONFIDENCE_TO_HIT_PROB: Record<string, number> = {
  HIGH: 0.65, MED: 0.55, LOW: 0.5,
  high: 0.65, medium: 0.55, low: 0.5,
};

export interface ParlayLegInput {
  selection?: string;
  sport?: string;
  market_type?: string;
  /** Either american_odds (manual form) or odds (screenshot path). */
  american_odds?: number | null;
  odds?: number | null;
  implied_prob?: number | null;
  confidence?: string;
  stat_type?: string;
  line_value?: number | null;
  direction?: "MORE" | "LESS" | null;
  leg_outcome?: "win" | "loss" | "push" | "pending";
  game_label?: string | null;
  final_score?: string | null;
  actual_value?: number | null;
  reason_included?: string;
}

export interface ParlayRowInput {
  id: string;
  date?: string;
  recommended_at?: string;
  resolved_at?: string | null;
  source?: string;
  legs: ParlayLegInput[];
  user_id?: string | null;
}

export interface BridgeResult {
  inserted: number;
  skipped_pending: number;
  skipped_sport: number;
  skipped_already_bridged: number;
  skipped_other: number;
  errors: string[];
}

function americanToImplied(american: number): number {
  if (!Number.isFinite(american)) return 0.5;
  return american >= 0 ? 100 / (american + 100) : -american / (-american + 100);
}

function modelProbForLeg(leg: ParlayLegInput): { value: number; source: "implied_odds" | "implied_field" | "confidence_proxy" } {
  const odds = leg.american_odds ?? leg.odds ?? null;
  if (odds != null && Number.isFinite(odds)) {
    return { value: americanToImplied(odds), source: "implied_odds" };
  }
  if (leg.implied_prob != null && Number.isFinite(leg.implied_prob)) {
    return { value: leg.implied_prob, source: "implied_field" };
  }
  const conf = leg.confidence ?? "MED";
  return { value: CONFIDENCE_TO_HIT_PROB[conf] ?? 0.5, source: "confidence_proxy" };
}

function pickSideFor(leg: ParlayLegInput, idx: number): string {
  // Player props use direction (MORE/LESS) as the side for
  // backtest grouping. Team moneyline picks use the team token from
  // the selection string, falling back to leg index.
  if (leg.market_type === "player_prop" || leg.direction) {
    return (leg.direction ?? "more").toLowerCase();
  }
  const m = /^([A-Z]{2,4})\b/.exec(String(leg.selection ?? ""));
  return m?.[1]?.toLowerCase() ?? `leg${idx}`;
}

function errorSize(modelProb: number, outcome: "win" | "loss" | "push"): number {
  const y = outcome === "win" ? 1 : outcome === "loss" ? 0 : 0.5;
  return Math.round(Math.abs(modelProb - y) * 10000) / 10000;
}

function oddsRangeBucket(american: number | null | undefined): string {
  if (american == null || !Number.isFinite(american)) return "unknown";
  if (american <= -250) return "heavy_favorite";
  if (american <= -150) return "favorite";
  if (american <= -110) return "pick_em_fav";
  if (american < 150) return "pick_em_dog";
  if (american < 250) return "underdog";
  return "longshot";
}

function buildPayload(parlay: ParlayRowInput, leg: ParlayLegInput, idx: number): Record<string, unknown> | null {
  if (!leg.leg_outcome || leg.leg_outcome === "pending") return null;
  const sport = String(leg.sport ?? "").toLowerCase();
  if (!ALLOWED_SPORTS.has(sport)) return null;

  const outcome = leg.leg_outcome;
  const odds = leg.american_odds ?? leg.odds ?? null;
  const { value: modelP, source: modelPSource } = modelProbForLeg(leg);
  const market_type = leg.market_type === "player_prop" || leg.market_type === "team_moneyline"
    ? leg.market_type
    : (leg.stat_type ? "player_prop" : "team_moneyline");

  const signature = `${parlay.id}:L${idx}`;
  const phase: "pregame" | "live" | "closing" = "pregame";

  return {
    external_game_id: signature, // synthetic — keyed per-leg-per-parlay
    sport,
    market_type,
    pick_side: pickSideFor(leg, idx),
    pick_label: leg.selection ?? `leg ${idx + 1}`,
    american_odds: odds != null ? String(Math.round(odds)) : "",
    implied_probability: odds != null ? String(americanToImplied(odds)) : "",
    model_probability: String(modelP),
    edge: "",
    confidence: String(leg.confidence ?? "medium").toLowerCase(),
    risk_score: "",
    reason_tags: [],
    checkpoint_stage: "",
    prediction_phase: phase,
    final_home_score: "",
    final_away_score: "",
    outcome,
    error_size: String(errorSize(modelP, outcome)),
    odds_range_bucket: oddsRangeBucket(odds),
    stat_type: leg.stat_type ?? "",
    source: parlay.source === "draftkings_manual" ? "gamelens_dk_manual_bridge_v1" : "gamelens_parlay_bridge_v1",
    learning_phase: "1",
    user_id: parlay.user_id ?? undefined,
    extra: {
      parlay_leg_signature: signature,
      parlay_id: parlay.id,
      parlay_source: parlay.source ?? null,
      parlay_date: parlay.date ?? null,
      leg_index: idx,
      leg: {
        line_value: leg.line_value ?? null,
        direction: leg.direction ?? null,
        game_label: leg.game_label ?? null,
        final_score: leg.final_score ?? null,
        actual_value: leg.actual_value ?? null,
      },
      model_probability_source: modelPSource,
    },
  };
}

/**
 * Bridge one parlay row's settled legs into prediction_history. Safe
 * to call repeatedly — already-bridged legs are skipped by signature.
 *
 * Fire-and-forget from caller — never throws. Returns counts so the UI
 * can show a toast.
 */
export async function bridgeParlayLegs(parlay: ParlayRowInput): Promise<BridgeResult> {
  const result: BridgeResult = {
    inserted: 0,
    skipped_pending: 0,
    skipped_sport: 0,
    skipped_already_bridged: 0,
    skipped_other: 0,
    errors: [],
  };
  if (!supabase) {
    result.errors.push("supabase_unavailable");
    return result;
  }
  if (!Array.isArray(parlay.legs) || parlay.legs.length === 0) {
    return result;
  }

  // Collect signatures and check existing rows in one query so we don't
  // do N round trips for an N-leg parlay.
  const signatures = parlay.legs.map((_, i) => `${parlay.id}:L${i}`);
  let existing = new Set<string>();
  try {
    const { data } = await supabase
      .from("prediction_history")
      .select("extra")
      .in("external_game_id", signatures);
    if (data) {
      for (const r of data as Array<{ extra: Record<string, unknown> | null }>) {
        const sig = r.extra?.parlay_leg_signature;
        if (typeof sig === "string") existing.add(sig);
      }
    }
  } catch {
    // Read failure shouldn't block writes; the RPC will no-op or
    // duplicate downstream.
  }

  for (let i = 0; i < parlay.legs.length; i++) {
    const leg = parlay.legs[i];
    const sport = String(leg.sport ?? "").toLowerCase();
    const sig = `${parlay.id}:L${i}`;

    if (!leg.leg_outcome || leg.leg_outcome === "pending") {
      result.skipped_pending++;
      continue;
    }
    if (!ALLOWED_SPORTS.has(sport)) {
      result.skipped_sport++;
      continue;
    }
    if (existing.has(sig)) {
      result.skipped_already_bridged++;
      continue;
    }

    const payload = buildPayload(parlay, leg, i);
    if (!payload) {
      result.skipped_other++;
      continue;
    }

    try {
      const { error } = await supabase.rpc("submit_prediction_learning_record", {
        p_history: payload,
        p_error_tags: [],
      });
      if (error) {
        result.errors.push(`L${i}: ${error.message}`);
        continue;
      }
      result.inserted++;
    } catch (e) {
      result.errors.push(`L${i}: ${String(e)}`);
    }
  }

  return result;
}
