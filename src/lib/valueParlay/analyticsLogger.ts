/**
 * Candidate build analytics logger.
 *
 * Logs ALL ValueBetCandidates — including excluded ones — to `candidate_analytics_log`.
 * This is the data source for exclusion_frequency and safe_pool_depth analytics RPCs.
 *
 * Contract:
 *  - Fire-and-forget: never blocks the render pipeline
 *  - Session-dedup: each candidate_id logged at most once per browser session
 *  - Batched inserts (30 rows per request) to avoid Supabase request limits
 *  - Fails silently — analytics must never break the UI
 */

import { supabase } from "@/lib/supabase";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";

// Stable session ID — identifies one browser session in the analytics log
const SESSION_ID = typeof crypto !== "undefined"
  ? crypto.randomUUID().slice(0, 16)
  : Math.random().toString(36).slice(2, 18);

const _loggedIds = new Set<string>();
const BATCH_SIZE = 30;

/**
 * Log a candidate pool build to `candidate_analytics_log`.
 * Safe to call from useEffect — async, fire-and-forget.
 */
export async function logCandidateBuild(candidates: ValueBetCandidate[]): Promise<void> {
  if (!supabase || candidates.length === 0) return;

  const toLog = candidates.filter((c) => !_loggedIds.has(c.id));
  if (toLog.length === 0) return;

  toLog.forEach((c) => _loggedIds.add(c.id));

  for (let i = 0; i < toLog.length; i += BATCH_SIZE) {
    const batch = toLog.slice(i, i + BATCH_SIZE);
    const rows = batch.map((c) => ({
      session_id:       SESSION_ID,
      candidate_id:     c.id,
      sport:            c.sport,
      pick_type:        c.pickType,
      is_recommended:   c.isRecommended,
      exclusion_reason: c.exclusionReason ?? null,
      timing_urgency:   c.timingUrgency ?? null,
      timing_score:     c.timingScore ?? null,
      volatility_score: c.volatilityScore,
      edge:             c.edge,
      confidence:       c.confidence,
      risk_band:        c.riskBand,
      value_score:      c.valueScore,
    }));

    try {
      await supabase.from("candidate_analytics_log").insert(rows);
    } catch {
      // Non-critical — silently skip
    }
  }
}
