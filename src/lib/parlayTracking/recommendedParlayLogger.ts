/**
 * Recommended-parlay logger.
 *
 * Auto-saves every parlay variant produced by the optimizer (best value,
 * safer, higher payout, cash-out trio) into the `recommended_parlays`
 * Supabase table so the user has a full history regardless of whether they
 * actually placed it.
 *
 * Source labelling:
 *   "app_recommended"             — auto-saved from optimizer
 *   "user_manual"                 — user typed it into the manual entry form
 *   "app_recommended_and_placed"  — promoted via "Mark as placed" on a row
 *
 * Dedup: per-session per-(tier, variant, legs-fingerprint). The migration
 * also enforces a UNIQUE on session_dedup_key, so a re-render of the same
 * triple doesn't double-write.
 */

import { supabase } from "@/lib/supabase";
import type { ParlayBuildMode, SmartParlayResult, ValueBetCandidate } from "@/lib/valueParlay/types";
import { writeTrainingSamplesFromLegs, type TrainingSampleSource } from "@/lib/ml/trainingSamples";

/**
 * Per-render save status surfaced to the UI as a small indicator on the
 * Parlay Builder. "missing_table" surfaces a different banner so the user
 * knows the migration hasn't been applied yet.
 */
export type SaveStatus =
  | "saved"
  | "duplicate"
  | "failed"
  | "missing_table"
  | "waiting"
  | "no_supabase";

const seen = new Set<string>();

export type ParlayVariant =
  | "best_value"
  | "safer"
  | "higher_payout"
  | "cashout_best"
  | "cashout_safer"
  | "cashout_upside";

function legsFingerprint(legs: ValueBetCandidate[]): string {
  return legs.map((l) => `${l.id}:${l.americanOdds}`).sort().join("|");
}

/**
 * Multi-key dedup: date + tier + variant + legs fingerprint + total odds.
 * Stronger than legs alone because two recommendations with the same legs
 * but different combined odds (rare but possible after odds refresh) won't
 * collide as one row.
 */
function dedupKey(
  tier: ParlayBuildMode,
  variant: ParlayVariant,
  legs: ValueBetCandidate[],
  combinedAmericanOdds: number,
): string {
  const day = new Date().toISOString().slice(0, 10);
  return `${day}:${tier}:${variant}:${combinedAmericanOdds}:${legsFingerprint(legs)}`;
}

function legPayload(l: ValueBetCandidate, modelStatus: string | null): Record<string, unknown> {
  return {
    id:                l.id,
    selection:         l.selectionLabel,
    sport:             l.sport,
    market_type:       l.marketType,
    pick_type:         l.pickType,
    stat_type:         l.statType ?? null,
    line_value:        l.lineValue ?? null,
    american_odds:     l.americanOdds,
    implied_prob:      l.impliedProbability,
    model_prob:        l.modelProbability,
    edge:              l.edge,
    confidence:        l.confidence,
    timing_urgency:    l.timingUrgency ?? null,
    stability_score:   l.stabilityScore ?? null,
    recent_hit_rate:   l.recentHitRate ?? null,
    correlation_group: l.correlationGroupId,
    risk_band:         l.riskBand,
    risk_note:         l.riskNote,
    model_variant:     l.modelVariant ?? "rules",
    model_status:      modelStatus,
    reason_included:   l.riskNote,        // best human-readable reason we have today
    reason_excluded:   l.exclusionReason ?? null,
    leg_outcome:       "pending",
  };
}

export interface LogRecommendedParlayInput {
  tier: ParlayBuildMode;
  variant: ParlayVariant;
  result: SmartParlayResult;
  reasons?: string[];
  /** True when no leg's underlying ML was active (every leg = rules-only). */
  rulesOnly?: boolean;
  /** True when at least one leg used ML. */
  mlActive?: boolean;
  /** Build version of the model — bumps on tuning. */
  modelVersion?: string;
}

/**
 * Cached probe of whether the recommended_parlays table exists. Set to
 * `null` until first save attempt completes; flipped to true/false from
 * the response. The /parlays page reads this to show a deploy-warning
 * banner instead of a misleading empty state.
 */
let _tableExists: boolean | null = null;

export function recommendedParlaysTableExists(): boolean | null {
  return _tableExists;
}

/** Force a probe — used by the /parlays page on mount. */
export async function probeRecommendedParlaysTable(): Promise<boolean> {
  if (!supabase) { _tableExists = false; return false; }
  try {
    const { error } = await supabase
      .from("recommended_parlays")
      .select("id", { count: "exact", head: true })
      .limit(1);
    _tableExists = !error;
    return _tableExists;
  } catch {
    _tableExists = false;
    return false;
  }
}

export async function logRecommendedParlay(input: LogRecommendedParlayInput): Promise<SaveStatus> {
  if (!supabase) return "no_supabase";
  const legs = input.result.legs;
  if (!legs.length) return "waiting";

  const combinedOdds = input.result.combinedAmericanOdds;
  const key = dedupKey(input.tier, input.variant, legs, combinedOdds);
  if (seen.has(key)) return "duplicate";
  seen.add(key);

  const sportMix  = [...new Set(legs.map((l) => String(l.sport).toLowerCase()))].sort().join(",");
  const marketMix = [...new Set(legs.map((l) => l.marketType))].sort().join(",");

  const row: Record<string, unknown> = {
    source:                  "app_recommended",
    recommended_at:          new Date().toISOString(),
    date:                    new Date().toISOString().slice(0, 10),
    model_version:           input.modelVersion ?? "v1",
    rules_only:              input.rulesOnly ?? false,
    ml_active:               input.mlActive ?? false,
    tier:                    input.tier,
    variant:                 input.variant,
    sport_mix:               sportMix,
    market_mix:              marketMix,
    legs:                    legs.map((l) => legPayload(l, null)),
    leg_count:               legs.length,
    combined_american_odds:  combinedOdds,
    payout_multiplier:       input.result.projectedPayoutMultiplier,
    combined_probability:    input.result.projectedHitProbability,
    card_score:              input.result.smartParlayScore,
    card_confidence:         input.result.cardConfidence,
    warnings:                input.result.warnings,
    reasons:                 input.reasons ?? [],
    user_placed:             false,
    outcome:                 "pending",
    session_dedup_key:       key,
  };

  try {
    const { error } = await supabase
      .from("recommended_parlays")
      .upsert([row], { onConflict: "session_dedup_key", ignoreDuplicates: true });
    if (error) {
      // Distinguish "table doesn't exist" from generic insert failures so
      // the /parlays page can show the right banner.
      const msg = (error.message ?? "").toLowerCase();
      if (msg.includes("does not exist") || msg.includes("relation")) {
        _tableExists = false;
        console.warn("[parlay-tracking] recommended_parlays table missing — run the Supabase migration.");
        return "missing_table";
      }
      console.warn("[parlay-tracking] insert failed:", error.message);
      return "failed";
    }
    _tableExists = true;
    // Fire-and-forget: also write per-leg training samples so the ML
    // training set captures every recommended parlay's legs at the
    // moment of recommendation. Source maps from the parlay reasons
    // when the caller hinted (e.g. auto_profit_mode=...).
    const reasonHint = (input.reasons ?? []).find((r) => r.startsWith("auto_profit_mode="));
    const trainingSource: TrainingSampleSource = reasonHint
      ? "auto_profit"
      : "app_recommended";
    void writeTrainingSamplesFromLegs({
      legs,
      source: trainingSource,
      modelVersion: input.modelVersion ?? "v1",
      placedByUser: false,
    });
    return "saved";
  } catch (e) {
    console.warn("[parlay-tracking] insert threw:", (e as Error).message);
    return "failed";
  }
}

// ── Per-leg outcome helper ───────────────────────────────────────────────
// Lets the UI tag a single leg as won/lost/push so the user can see which
// leg killed the ticket. Updates the legs jsonb in place.

export type LegOutcome = "pending" | "won" | "lost" | "push";

export async function setLegOutcome(
  parlayId: string,
  legId: string,
  legOutcome: LegOutcome,
): Promise<boolean> {
  if (!supabase) return false;
  try {
    // Read current legs, modify in place, write back.
    const { data, error } = await supabase
      .from("recommended_parlays")
      .select("legs")
      .eq("id", parlayId)
      .maybeSingle();
    if (error || !data) return false;
    const legs = (data.legs ?? []) as Array<Record<string, unknown>>;
    let touched = false;
    for (const l of legs) {
      if (String(l.id) === legId) {
        l.leg_outcome = legOutcome;
        touched = true;
      }
    }
    if (!touched) return false;
    const { error: upErr } = await supabase
      .from("recommended_parlays")
      .update({ legs })
      .eq("id", parlayId);
    if (upErr) {
      console.warn("[parlay-tracking] setLegOutcome failed:", upErr.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[parlay-tracking] setLegOutcome threw:", (e as Error).message);
    return false;
  }
}
