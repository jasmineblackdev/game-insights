/**
 * Parlay build logger — fire-and-forget write to parlay_build_history + parlay_build_legs.
 *
 * Called after every auto-build so we accumulate data for the ML feedback loop
 * and the ParlayPerformanceDashboard. Never blocks the UI.
 */

import type { ParlayBuildMode, SmartParlayResult } from "@/lib/valueParlay/types";
import type { AnalyticsWeights } from "@/lib/valueParlay/parlayOptimizer";
import { supabase } from "@/lib/supabase";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSportMix(result: SmartParlayResult): Record<string, number> {
  const mix: Record<string, number> = {};
  for (const leg of result.legs) {
    const s = String(leg.sport).toLowerCase();
    mix[s] = (mix[s] ?? 0) + 1;
  }
  return mix;
}

function buildMarketMix(result: SmartParlayResult): Record<string, number> {
  const mix: Record<string, number> = {};
  for (const leg of result.legs) {
    const m = leg.marketType ?? "unknown";
    mix[m] = (mix[m] ?? 0) + 1;
  }
  return mix;
}

function buildModelVariantMix(result: SmartParlayResult): Record<string, number> {
  const mix: Record<string, number> = {};
  for (const leg of result.legs) {
    const v = leg.modelVariant ?? "rules";
    mix[v] = (mix[v] ?? 0) + 1;
  }
  return mix;
}

function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Log a completed parlay build to Supabase.
 * Fire-and-forget — does not throw or block the caller.
 */
export async function logParlayBuild(
  result: SmartParlayResult,
  mode: ParlayBuildMode,
  _weights?: AnalyticsWeights,
): Promise<void> {
  if (!supabase || !result.legs.length) return;

  try {
    const legs = result.legs;

    const avgLegScore    = avg(legs.map((l) => l.valueScore));
    const avgMlProb      = avg(legs.map((l) => l.modelProbability));
    const avgConf        = avg(legs.map((l) =>
      l.confidence === "high" ? 1 : l.confidence === "medium" ? 0.6 : 0.3
    ));
    const avgTiming      = avg(legs.map((l) => l.timingScore ?? 0.55));
    const avgStability   = avg(legs.map((l) => l.stabilityScore ?? 0.5));
    const combinedEdge   = avg(legs.map((l) => l.edge));

    const timingQuality =
      avgTiming >= 0.75 ? "high" :
      avgTiming >= 0.45 ? "medium" : "low";

    // Insert parlay_build_history row
    const { data: histRow, error: histErr } = await supabase
      .from("parlay_build_history")
      .insert({
        tier:                      mode,
        leg_count:                 legs.length,
        sport_mix:                 buildSportMix(result),
        market_mix:                buildMarketMix(result),
        avg_leg_score:             Math.round(avgLegScore * 10000) / 10000,
        avg_ml_probability:        Math.round(avgMlProb * 10000) / 10000,
        avg_confidence:            Math.round(avgConf * 10000) / 10000,
        avg_timing_score:          Math.round(avgTiming * 10000) / 10000,
        avg_stability_score:       Math.round(avgStability * 10000) / 10000,
        correlation_penalty:       result.correlationPenalty,
        volatility_score:          result.volatilityPenalty,
        combined_edge:             Math.round(combinedEdge * 10000) / 10000,
        projected_hit_probability: result.projectedHitProbability,
        model_variant_mix:         buildModelVariantMix(result),
        timing_quality:            timingQuality,
        parlay_score:              Math.round(result.smartParlayScore * 10000) / 10000,
      })
      .select("id")
      .single();

    if (histErr || !histRow) return;

    const parlayId = histRow.id as string;

    // Insert parlay_build_legs rows
    const legRows = legs.map((l) => ({
      parlay_id:           parlayId,
      prediction_id:       l.id,
      sport:               String(l.sport).toLowerCase(),
      market_type:         l.marketType,
      selection:           l.selectionLabel,
      odds:                l.americanOdds,
      edge:                Math.round(l.edge * 10000) / 10000,
      ml_hit_probability:  Math.round(l.modelProbability * 10000) / 10000,
      confidence:          l.confidence,
      timing_urgency:      l.timingUrgency ?? "monitor",
      timing_score:        Math.round((l.timingScore ?? 0.55) * 10000) / 10000,
      stability_score:     Math.round((l.stabilityScore ?? 0.5) * 10000) / 10000,
      volatility_score:    l.volatilityScore,
      correlation_group_id: l.correlationGroupId,
      model_variant:       l.modelVariant ?? "rules",
    }));

    await supabase.from("parlay_build_legs").insert(legRows);
  } catch {
    // Never surface logging errors to the UI
  }
}
