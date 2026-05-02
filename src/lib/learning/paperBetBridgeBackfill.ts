/**
 * One-shot backfill — bridges every historical settled paper bet
 * into prediction_history. Use after deploying the #164 bridge so
 * past activity shows up in CLV / strategy / calibration analytics
 * alongside new bets.
 *
 * Lives in its own file (rather than co-located with the bridge) so
 * the bridge module stays free of `listPaperBets` and we avoid the
 * paperBetLegBridge ↔ paperBets/store circular import.
 *
 * Idempotent — already-bridged legs are skipped by the per-leg
 * signature dedupe inside bridgePaperBetLegs. Safe to re-run.
 */

import { listPaperBets } from "@/lib/paperBets/store";
import { bridgePaperBetLegs, type PaperBridgeResult } from "./paperBetLegBridge";

export interface PaperBackfillSummary {
  bets_scanned:    number;
  bets_bridged:    number;
  legs_inserted:   number;
  legs_skipped:    number;
  errors:          string[];
}

/**
 * Walk every settled paper bet (won / lost / push) and bridge any
 * leg whose signature isn't already present in prediction_history.
 *
 * Returns an aggregate summary the caller can show in a toast or
 * log. Errors are collected per-bet rather than thrown, so a bad
 * row doesn't stop the whole backfill.
 */
export async function backfillPaperBets(): Promise<PaperBackfillSummary> {
  const summary: PaperBackfillSummary = {
    bets_scanned:  0,
    bets_bridged:  0,
    legs_inserted: 0,
    legs_skipped:  0,
    errors:        [],
  };
  let bets;
  try {
    // Settled-only — voided bets are skipped inside the bridge,
    // and open / needs_review bets aren't ready to be bridged yet.
    bets = await listPaperBets({ status: "settled", limit: 1000 });
  } catch (e) {
    summary.errors.push(`listPaperBets: ${String(e)}`);
    return summary;
  }
  for (const bet of bets) {
    summary.bets_scanned++;
    let r: PaperBridgeResult;
    try {
      r = await bridgePaperBetLegs(bet);
    } catch (e) {
      summary.errors.push(`bet ${bet.id}: ${String(e)}`);
      continue;
    }
    if (r.inserted > 0) summary.bets_bridged++;
    summary.legs_inserted += r.inserted;
    summary.legs_skipped  += r.skipped_pending +
                              r.skipped_sport +
                              r.skipped_already_bridged +
                              r.skipped_voided +
                              r.skipped_other;
    if (r.errors.length) summary.errors.push(...r.errors.map((e) => `bet ${bet.id}: ${e}`));
  }
  return summary;
}
