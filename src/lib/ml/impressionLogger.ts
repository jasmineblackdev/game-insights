/**
 * ML training impression logger — closes the three selection-bias gaps
 * identified in the parlay hit-rate audit:
 *
 *   1. prop_impressions          — every displayed prop, not just copied ones
 *   2. parlay_leg_rejections     — candidates the optimizer filtered out
 *   3. game_prediction_snapshots — pre-game team/market picks at build time
 *
 * All three writers are fire-and-forget, batched, and de-duplicated within a
 * single page session so normal UI scrolling / refetches don't spam the DB.
 * Server-side UNIQUE constraints protect against duplicate writes across
 * sessions on the same day.
 */

import { supabase } from "@/lib/supabase";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import type { ParlayBuildMode, ValueBetCandidate } from "@/lib/valueParlay/types";
import { diagnoseLegRejection } from "@/lib/valueParlay/parlayOptimizer";

// ── Session-scoped dedup sets ────────────────────────────────────────────────
// Keyed by the natural dedup key. Reset on page reload.

const seenPropImpressions     = new Set<string>();
const seenRejections          = new Set<string>();
const seenGameSnapshots       = new Set<string>();

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function round4(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}

function round2(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function round1(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

// ── 1. Prop impressions ──────────────────────────────────────────────────────

/**
 * Log every enriched player prop we showed the user for today.
 * Call fire-and-forget from the parlay builder once per candidate refresh.
 */
export async function logPropImpressions(
  predictions: PlayerEdgePrediction[],
): Promise<void> {
  if (!supabase || !predictions.length) return;
  const day  = utcDay();
  const rows = predictions
    .filter((p) => {
      const k = `${p.id}:${day}`;
      if (seenPropImpressions.has(k)) return false;
      seenPropImpressions.add(k);
      return true;
    })
    .map((p) => ({
      prop_id:            p.id,
      sport:              p.sport,
      stat_type:          p.stat_type,
      line_value:         p.line_value,
      projected_value:    p.projected_value,
      direction:          p.prediction_direction,
      confidence:         p.confidence,
      ml_hit_probability: round4(p.ml_hit_probability),
      edge:               round4(p.edge),
      model_variant:      p.ml_active ? "ml_blended" : "rules",
      volatility_score:   null,
      stability_score:    round4(p.ml_debug?.stability_score),
      uncertainty_score:  null,
      timing_urgency:     p.timing_urgency ?? null,
      game_id:            p.game_id,
      game_time:          p.game_time ?? null,
      team:               p.team,
      opponent:           p.opponent,
      impression_date:    day,
    }));
  if (!rows.length) return;
  try {
    await supabase
      .from("prop_impressions")
      .upsert(rows, { onConflict: "prop_id,impression_date", ignoreDuplicates: true });
  } catch {
    // Never surface logging errors to the UI
  }
}

// ── 2. Parlay leg rejections ─────────────────────────────────────────────────

/**
 * Log every candidate that was filtered out by legPassesParlayBuildFilters
 * during a parlay build. Pass the full candidate pool that was offered to
 * the optimizer; this function derives rejections itself and de-duplicates.
 */
export async function logParlayLegRejections(
  candidates: ValueBetCandidate[],
  mode: ParlayBuildMode,
): Promise<void> {
  if (!supabase || !candidates.length) return;
  const day  = utcDay();
  const rows: Record<string, unknown>[] = [];

  for (const c of candidates) {
    const reason = diagnoseLegRejection(c, mode);
    if (reason === null) continue;
    const k = `${c.id}:${mode}:${reason}:${day}`;
    if (seenRejections.has(k)) continue;
    seenRejections.add(k);
    rows.push({
      mode,
      candidate_id:       c.id,
      sport:              String(c.sport).toLowerCase(),
      market_type:        c.marketType,
      pick_type:          c.pickType,
      stat_type:          c.statType ?? null,
      selection:          c.selectionLabel ?? null,
      american_odds:      c.americanOdds,
      edge:               round4(c.edge),
      ml_hit_probability: round4(c.modelProbability),
      confidence:         c.confidence,
      volatility_score:   round2(c.volatilityScore),
      stability_score:    round4(c.stabilityScore),
      timing_urgency:     c.timingUrgency ?? null,
      rejection_reason:   reason,
      rejection_date:     day,
    });
  }

  if (!rows.length) return;
  try {
    await supabase.from("parlay_leg_rejections").insert(rows);
  } catch {
    // silent
  }
}

// ── 3. Game prediction snapshots ─────────────────────────────────────────────

/**
 * Log every team-level pick (moneyline / spread / total) produced by
 * buildAllValueCandidates. Deduplicated per (game_id, pick_type, selection, day).
 */
export async function logGamePredictionSnapshots(
  candidates: ValueBetCandidate[],
): Promise<void> {
  if (!supabase || !candidates.length) return;
  const day = utcDay();
  const rows = candidates
    .filter((c) => c.pickType !== "player_prop")
    .filter((c) => {
      const k = `${c.gameId}:${c.pickType}:${c.selectionLabel}:${day}`;
      if (seenGameSnapshots.has(k)) return false;
      seenGameSnapshots.add(k);
      return true;
    })
    .map((c) => ({
      game_id:             c.gameId,
      sport:               String(c.sport).toLowerCase(),
      pick_type:           c.pickType,
      market_type:         c.marketType,
      selection:           c.selectionLabel,
      team_id:             c.teamId ?? null,
      line_value:          c.lineValue ?? null,
      american_odds:       c.americanOdds,
      implied_probability: round4(c.impliedProbability),
      model_probability:   round4(c.modelProbability),
      edge:                round4(c.edge),
      edge_score:          round1(c.edgeScore),
      confidence:          c.confidence,
      volatility_score:    round2(c.volatilityScore),
      uncertainty_score:   round2(c.uncertaintyScore),
      stability_score:     round4(c.stabilityScore),
      risk_score:          round2(c.riskScore),
      risk_band:           c.riskBand,
      value_score:         round4(c.valueScore),
      value_grade:         c.valueGrade,
      is_recommended:      c.isRecommended,
      matchup_label:       c.matchupLabel,
      snapshot_date:       day,
    }));
  if (!rows.length) return;
  try {
    await supabase
      .from("game_prediction_snapshots")
      .upsert(rows, {
        onConflict: "game_id,pick_type,selection,snapshot_date",
        ignoreDuplicates: true,
      });
  } catch {
    // silent
  }
}
