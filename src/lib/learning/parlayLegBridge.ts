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
  /** American odds at the moment user clicked "Mark as placed". Used
   *  to compute the partial CLV signal `clv_at_placement`. */
  odds_at_placement?: number | null;
  /** Closing-line American odds (latest snapshot before kickoff). Set
   *  by the closing-odds-poller edge function on its 15-min cycle. */
  closing_odds_american?: number | null;
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

/** Schema check accepts only ("high", "medium", "low"). Map common abbreviations. */
function normalizeConfidence(v: string | undefined | null): "high" | "medium" | "low" {
  const s = String(v ?? "medium").trim().toLowerCase();
  if (s === "high" || s === "h" || s === "hi") return "high";
  if (s === "low" || s === "l" || s === "lo") return "low";
  return "medium";
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

const DAY_OF_WEEK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * game_label is "AWAY @ HOME" (e.g. "CHC @ LAD"). For team_moneyline
 * legs we determine which side the user picked by matching the
 * away/home tokens against pick_label or selection. Returns
 * { is_home, opponent } when unambiguous; null fields otherwise so
 * downstream code falls back to the coarse bucket.
 */
export function parseHomeAwayContext(leg: ParlayLegInput): {
  is_home: boolean | null;
  opponent: string | null;
  home_team: string | null;
  away_team: string | null;
} {
  const label = (leg.game_label ?? "").trim();
  const m = /^([A-Z][A-Z0-9]{1,4})\s*@\s*([A-Z][A-Z0-9]{1,4})$/.exec(label);
  if (!m) return { is_home: null, opponent: null, home_team: null, away_team: null };
  const [, away, home] = m;

  if (leg.market_type === "team_moneyline") {
    const sel = String(leg.selection ?? "").toUpperCase();
    if (sel.includes(home)) return { is_home: true,  opponent: away, home_team: home, away_team: away };
    if (sel.includes(away)) return { is_home: false, opponent: home, home_team: home, away_team: away };
  }
  // Player props or other markets: surface the matchup but leave is_home
  // null since we don't reliably know which team's player they're on.
  return { is_home: null, opponent: null, home_team: home, away_team: away };
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

  // Phase-A context features — derived from data we already have, no
  // external lookup required. Pattern coach uses these as additional
  // bucket dimensions so it can learn finer-grained edge:
  //   "user wins 67% on NBA road dogs on Tuesdays" beats
  //   "user wins 60% on NBA dogs"
  const homeAway = parseHomeAwayContext(leg);
  const dateForContext = parlay.recommended_at ?? parlay.date ?? null;

  // CLV signals — three odds snapshots in priority order:
  //   - oddsRec: at recommendation
  //   - oddsPlc: at "Mark as placed" (RecommendedParlaysPage handler)
  //   - oddsCls: closing line (closing-odds-poller edge function)
  // Prefer the placement → close diff (true CLV); fall back to the
  // recommend → close diff when no placement was recorded; fall back
  // again to recommend → place when no close was captured.
  const oddsRec = leg.american_odds ?? leg.odds ?? null;
  const oddsPlc = leg.odds_at_placement ?? null;
  const oddsCls = leg.closing_odds_american ?? null;
  const clvPp = (() => {
    const fromOdds = oddsPlc ?? oddsRec;
    if (fromOdds == null || oddsCls == null) return null;
    return Math.round((americanToImplied(oddsCls) - americanToImplied(fromOdds)) * 10000) / 10000;
  })();
  const clvAtPlacement = (oddsRec != null && oddsPlc != null)
    ? Math.round((americanToImplied(oddsPlc) - americanToImplied(oddsRec)) * 10000) / 10000
    : null;

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
    confidence: normalizeConfidence(leg.confidence),
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
        // Closing line value captured by closing-odds-poller (commit
        // f458691). Bridge surfaces it here so the CLV analytics view
        // can filter to apples-to-apples (closing line == entry line)
        // rows distinct from drifted-line rows.
        closing_line_value: (leg as { closing_line_value?: number | null }).closing_line_value ?? null,
      },
      // Phase-A context features
      is_home:      homeAway.is_home,
      opponent:     homeAway.opponent,
      home_team:    homeAway.home_team,
      away_team:    homeAway.away_team,
      day_of_week:  dayOfWeekFromIso(dateForContext),
      month:        monthFromIso(dateForContext),
      // CLV — three snapshots stored alongside the computed deltas.
      // clv_pp is the canonical CLV the backtest reads (extra->>'clv_pp'),
      // populated when both placement (or recommend) AND close are known.
      odds_at_recommendation: oddsRec,
      odds_at_placement:      oddsPlc,
      closing_odds_american:  oddsCls,
      clv_at_placement:       clvAtPlacement,
      clv_pp:                 clvPp,
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
