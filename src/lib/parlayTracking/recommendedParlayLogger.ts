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

function dedupKey(tier: ParlayBuildMode, variant: ParlayVariant, legs: ValueBetCandidate[]): string {
  const day = new Date().toISOString().slice(0, 10);
  return `${day}:${tier}:${variant}:${legsFingerprint(legs)}`;
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

export async function logRecommendedParlay(input: LogRecommendedParlayInput): Promise<void> {
  if (!supabase) return;
  const legs = input.result.legs;
  if (!legs.length) return;

  const key = dedupKey(input.tier, input.variant, legs);
  if (seen.has(key)) return;
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
    combined_american_odds:  input.result.combinedAmericanOdds,
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
    await supabase
      .from("recommended_parlays")
      .upsert([row], { onConflict: "session_dedup_key", ignoreDuplicates: true });
  } catch {
    // never block UI on logging
  }
}
