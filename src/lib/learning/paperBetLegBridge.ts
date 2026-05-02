/**
 * Bridge — paper_bets.legs → prediction_history.
 *
 * Mirrors parlayLegBridge for the paper-bets table so CLV,
 * strategy-performance rollups, and the ML feedback loop see paper
 * activity (which is now the user's primary tracking surface, per
 * the Phase 3 consolidation). Without this, every paper bet was
 * invisible to the learning pipeline — recommended_parlays was the
 * only source.
 *
 * Why a separate file (instead of reusing parlayLegBridge):
 *   • Different leg shape — paper_bets.legs is camelCase
 *     (statType / americanOdds / playerName / etc.) and uses
 *     "over"/"under" for direction vs the parlay bridge's
 *     "MORE"/"LESS".
 *   • Different status vocabulary — paper has open/won/lost/push/
 *     voided/needs_review/in_progress, parlay has won/lost/push/
 *     pending/partial.
 *   • Different metadata to surface in extra — paper_bet_id,
 *     paper_source (manual vs auto_plan), bet_timing (pregame vs
 *     live), strategy_type, weakest_leg_id. The parlay bridge
 *     doesn't carry any of these and they're load-bearing for
 *     the per-source ROI / hit-rate split that #171 introduced.
 *   • Different source tag — rows land with
 *     source="gamelens_paper_bridge_v1" so the backtest can filter
 *     paper rows independently from app-recommended rows.
 *
 * Signature collision avoidance:
 *   prediction_history.external_game_id is unique. The parlay
 *   bridge uses `${parlay_id}:L${i}`. We use `paper:${bet_id}:L${i}`
 *   so a paper-bet uuid that happens to share a substring with a
 *   parlay uuid can never collide.
 *
 * Voided rule:
 *   Voided paper bets are explicitly skipped — they represent
 *   cancelled / postponed games, not pick outcomes, and bridging
 *   them as "push" would pollute the calibration signal.
 *
 * Sport gate:
 *   prediction_history.sport check only allows nba/nfl/mlb/soccer.
 *   Paper bets in WNBA / BOXING / MMA are counted in
 *   skipped_sport for visibility but not bridged.
 */

import { supabase } from "@/lib/supabase";
import type { PaperBet, PaperLeg } from "@/lib/paperBets/types";

// Sports allowed by the live prediction_history.sport check.
const ALLOWED_SPORTS = new Set(["nba", "nfl", "mlb", "soccer"]);

const DAY_OF_WEEK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export interface PaperBridgeResult {
  inserted:                number;
  skipped_pending:         number;
  skipped_sport:           number;
  skipped_already_bridged: number;
  skipped_voided:          number;
  skipped_other:           number;
  errors:                  string[];
}

function emptyResult(): PaperBridgeResult {
  return {
    inserted: 0,
    skipped_pending: 0,
    skipped_sport: 0,
    skipped_already_bridged: 0,
    skipped_voided: 0,
    skipped_other: 0,
    errors: [],
  };
}

function americanToImplied(american: number): number {
  if (!Number.isFinite(american)) return 0.5;
  return american >= 0 ? 100 / (american + 100) : -american / (-american + 100);
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
  if (american < 150)   return "pick_em_dog";
  if (american < 250)   return "underdog";
  return "longshot";
}

function dayOfWeekFromIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return DAY_OF_WEEK[d.getDay()];
}

function monthFromIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.getMonth() + 1;
}

function legOutcome(status: PaperLeg["status"]): "win" | "loss" | "push" | "pending" | "voided" {
  if (status === "won")    return "win";
  if (status === "lost")   return "loss";
  if (status === "push")   return "push";
  if (status === "voided") return "voided";
  // open / needs_review / undefined → pending (try again next bridge run)
  return "pending";
}

function pickSideFor(leg: PaperLeg, idx: number): string {
  // Player props: use direction (over/under). Team markets: use the
  // first ~3-letter token from selectionLabel as the team side.
  if (leg.marketType === "player_prop" || leg.direction) {
    return (leg.direction ?? "more").toLowerCase();
  }
  const m = /^([A-Z]{2,4})\b/.exec(String(leg.selectionLabel ?? leg.dkLabel ?? ""));
  return m?.[1]?.toLowerCase() ?? `leg${idx}`;
}

function marketTypeForLeg(leg: PaperLeg): string {
  // Paper marketType uses moneyline | spread | total | player_prop;
  // prediction_history doesn't constrain market_type but the rest
  // of the system filters on player_prop / team_moneyline. Map so
  // analytics queries still see consistent values.
  if (leg.marketType === "player_prop") return "player_prop";
  if (leg.marketType === "moneyline")   return "team_moneyline";
  return leg.marketType;
}

interface LegPayload {
  payload: Record<string, unknown>;
  signature: string;
}

function buildPaperLegPayload(bet: PaperBet, leg: PaperLeg, idx: number): LegPayload | null {
  const outcome = legOutcome(leg.status);
  if (outcome === "pending" || outcome === "voided") return null;

  const sport = String(leg.sport ?? "").toLowerCase();
  if (!ALLOWED_SPORTS.has(sport)) return null;

  const odds = leg.americanOdds ?? null;
  // Paper bets don't carry an explicit model probability — use
  // implied odds as a proxy and tag the source so the backtest
  // can filter when it wants real model output only. Same convention
  // as the parlay bridge (extra.model_probability_source).
  const modelP = odds != null && Number.isFinite(odds)
    ? americanToImplied(odds)
    : 0.5;

  const signature = `paper:${bet.id}:L${idx}`;

  // Live bets have very different calibration than pregame bets —
  // tag the prediction_phase so backtest can keep the cohorts
  // separate. Anything not explicitly "live" is treated as pregame.
  const phase: "pregame" | "live" | "closing" =
    bet.betTiming === "live" ? "live" : "pregame";

  const dateForContext = bet.placedAt;

  const payload: Record<string, unknown> = {
    external_game_id: signature,
    sport,
    market_type: marketTypeForLeg(leg),
    pick_side: pickSideFor(leg, idx),
    pick_label: leg.selectionLabel ?? leg.dkLabel ?? `leg ${idx + 1}`,
    american_odds: odds != null ? String(Math.round(odds)) : "",
    implied_probability: odds != null ? String(americanToImplied(odds)) : "",
    model_probability: String(modelP),
    edge: "",
    confidence: "medium",
    risk_score: "",
    reason_tags: [],
    checkpoint_stage: "",
    prediction_phase: phase,
    final_home_score: "",
    final_away_score: "",
    outcome,
    error_size: String(errorSize(modelP, outcome)),
    odds_range_bucket: oddsRangeBucket(odds),
    stat_type: leg.statType ?? "",
    source: "gamelens_paper_bridge_v1",
    learning_phase: "1",
    extra: {
      // Provenance — distinguishes paper rows from parlay rows in
      // every analytics query that reads extra.parlay_source vs
      // extra.paper_source.
      paper_bet_id:           bet.id,
      paper_source:           bet.source,
      paper_bet_type:         bet.betType,
      paper_bet_timing:       bet.betTiming,
      paper_resolved_via:     bet.resolvedVia ?? null,
      // Mirror the parlay bridge's "parlay_leg_signature" key so
      // the dedupe read path can find paper rows by the same field.
      parlay_leg_signature:   signature,
      leg_index:              idx,
      leg: {
        line_value:  leg.line ?? null,
        direction:   leg.direction ?? null,
        game_id:     leg.gameId ?? null,
        team_label:  leg.teamLabel ?? null,
        player_name: leg.playerName ?? null,
        player_id:   leg.playerId ?? null,
        actual_value: leg.resolvedActual ?? null,
        // closing_line_value is captured by the closing-odds-poller
        // on the parlay path; paper bets don't currently have a
        // closing-line bridge, so this field is null for them. The
        // CLV analytics queries treat null as "unavailable", which
        // is correct.
        closing_line_value: null,
      },
      // Phase-A context features
      day_of_week: dayOfWeekFromIso(dateForContext),
      month:       monthFromIso(dateForContext),
      // CLV — only the pregame snapshot is available for paper bets
      // today. Future enhancement: capture odds_at_placement when the
      // user submits and merge a closing-line poll keyed off bet.id.
      odds_at_recommendation:   odds,
      odds_at_placement:        null,
      closing_odds_american:    null,
      clv_at_placement:         null,
      clv_pp:                   null,
      model_probability_source: "implied_odds_proxy_paper",
    },
  };

  return { payload, signature };
}

/**
 * Bridge one paper bet's settled legs into prediction_history.
 *
 * Idempotent — any leg whose signature already exists in
 * prediction_history is skipped. Safe to call repeatedly. Voided
 * paper bets short-circuit to a no-op result so the caller doesn't
 * have to gate.
 *
 * Fire-and-forget from caller — never throws. Returns counts so
 * the caller can log or surface a toast on demand.
 */
export async function bridgePaperBetLegs(bet: PaperBet): Promise<PaperBridgeResult> {
  const result = emptyResult();
  if (!supabase) {
    result.errors.push("supabase_unavailable");
    return result;
  }
  if (!bet || !Array.isArray(bet.legs) || bet.legs.length === 0) {
    return result;
  }
  // Voided whole-bet — every leg counts as voided. Calibration would
  // be poisoned by treating these as pushes.
  if (bet.status === "voided") {
    result.skipped_voided = bet.legs.length;
    return result;
  }

  // Pre-query for any signatures already bridged so we can skip
  // them in one round-trip rather than N.
  const signatures = bet.legs.map((_, i) => `paper:${bet.id}:L${i}`);
  const existing = new Set<string>();
  try {
    const { data } = await supabase
      .from("prediction_history")
      .select("external_game_id")
      .in("external_game_id", signatures);
    if (data) {
      for (const r of data as Array<{ external_game_id: string | null }>) {
        if (r.external_game_id) existing.add(r.external_game_id);
      }
    }
  } catch {
    // Read failure is non-fatal — we'll let the RPC error if a
    // duplicate insert is attempted (it shouldn't, but the table
    // has a unique index so it'd fail loudly rather than silently
    // double-counting).
  }

  for (let i = 0; i < bet.legs.length; i++) {
    const leg = bet.legs[i];
    const sport = String(leg.sport ?? "").toLowerCase();
    const sig = `paper:${bet.id}:L${i}`;

    const outcome = legOutcome(leg.status);
    if (outcome === "voided") {
      result.skipped_voided++;
      continue;
    }
    if (outcome === "pending") {
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

    const built = buildPaperLegPayload(bet, leg, i);
    if (!built) {
      result.skipped_other++;
      continue;
    }

    try {
      const { error } = await supabase.rpc("submit_prediction_learning_record", {
        p_history:    built.payload,
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
