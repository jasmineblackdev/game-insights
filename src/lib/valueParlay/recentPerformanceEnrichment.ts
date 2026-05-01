/**
 * Recent performance enrichment for player prop candidates.
 *
 * Batches ESPN athlete gamelog fetches for every player_prop in a candidate
 * pool, computes the fraction of the last 5 games where the player's stat
 * cleared the prop's line in the picked direction, and attaches the result
 * as `recentHitRate` on each candidate.
 *
 * Downstream consumers:
 *   - computeLegScore: adds ±0.06 based on deviation from 0.5
 *   - legPassesParlayBuildFilters (SAFE): rejects props whose recent hit
 *     rate is below 0.45 (player has been losing the line lately)
 *
 * Concurrency is limited so a full slate of 40+ props doesn't flood ESPN.
 * React Query layered on top gives cross-render deduplication.
 */

import { fetchPlayerLastGames, type PlayerGameStat } from "@/lib/playerGameLog";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";
import { whyThisPick } from "./explanation";
import { legAudit } from "./executionAssistant";

const CONCURRENCY = 6;

interface RecentHit {
  rate: number;
  samples: number;
}

/**
 * Run an async fn over items with a concurrency cap.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

function computeRecentHitRate(
  games: PlayerGameStat[],
  line: number,
  direction: "MORE" | "LESS" | string | undefined,
): RecentHit | null {
  if (!games.length) return null;
  let hits = 0;
  let decided = 0;
  for (const g of games) {
    if (!Number.isFinite(g.value)) continue;
    if (g.value === line) continue; // push — exclude
    decided++;
    const hit = direction === "MORE" ? g.value > line : g.value < line;
    if (hit) hits++;
  }
  if (!decided) return null;
  return { rate: hits / decided, samples: decided };
}

/**
 * Augment every player_prop candidate with recentHitRate + recentHitRateSamples.
 * Candidates without a playerId, a supported sport, or a gamelog response pass
 * through unchanged.
 */
export async function enrichCandidatesWithRecentPerformance(
  candidates: ValueBetCandidate[],
): Promise<ValueBetCandidate[]> {
  const propIdxs: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.pickType !== "player_prop") continue;
    if (!c.playerId || !c.statType || c.lineValue == null) continue;
    propIdxs.push(i);
  }
  // Backfill whyThisPick + decision on EVERY candidate (not just props)
  // up front, then enrich props with hit rates which can refine the
  // factor selection. Cheap pure derivation; no fetches.
  const seeded = candidates.map((c) => ({
    ...c,
    decision: c.decision ?? legAudit(c),
    whyThisPick: c.whyThisPick ?? whyThisPick(c),
  }));

  if (!propIdxs.length) return seeded;

  const out = [...seeded];

  await mapLimit(propIdxs, CONCURRENCY, async (idx) => {
    const c = out[idx];
    try {
      // One fetch per athlete-stat — pull a full season slice (200 games is
      // a hard upper bound; 162 for MLB / ~82 NBA / ~17 NFL fit easily).
      const seasonGames = await fetchPlayerLastGames(
        c.sport,
        c.playerId,
        c.statType!,
        200,
      );
      // Derive direction from the selection label — OVER/UNDER is embedded.
      const dir = (c.selectionLabel ?? "").toUpperCase().includes("UNDER")
        ? "LESS"
        : "MORE";

      // Slice the same gamelog into 4 windows. Cheaper than 4 fetches
      // and keeps last5 / last10 perfectly aligned with season.
      const last5  = computeRecentHitRate(seasonGames.slice(0, 5),  c.lineValue!, dir);
      const last10 = computeRecentHitRate(seasonGames.slice(0, 10), c.lineValue!, dir);
      const season = computeRecentHitRate(seasonGames,              c.lineValue!, dir);

      // vs-opponent slice — match the candidate's opponent abbr against
      // the gamelog's opponent column. Token-light comparison.
      const opp = extractOpponentAbbr(c.matchupLabel, c.sport);
      const vsRows = opp
        ? seasonGames.filter((g) => g.opponent.toUpperCase() === opp.toUpperCase())
        : [];
      const vsOpponent = vsRows.length
        ? computeRecentHitRate(vsRows, c.lineValue!, dir)
        : null;

      const round = (n: number | undefined) =>
        n == null ? null : Math.round(n * 10000) / 10000;

      const enriched: ValueBetCandidate = {
        ...c,
        // Legacy alias — kept for computeLegScore + legPassesParlayBuildFilters.
        recentHitRate:        last5 ? round(last5.rate)! : c.recentHitRate,
        recentHitRateSamples: last5 ? last5.samples : c.recentHitRateSamples,
        // Props.Cash-style quartet for UI consumption.
        hitRates: {
          last5:  last5  && last5.samples  >= 3 ? round(last5.rate)  : null,
          last10: last10 && last10.samples >= 5 ? round(last10.rate) : null,
          season: season && season.samples >= 5 ? round(season.rate) : null,
          vsOpponent: vsOpponent && vsOpponent.samples >= 1 ? round(vsOpponent.rate) : null,
          samples: {
            last5:  last5?.samples  ?? 0,
            last10: last10?.samples ?? 0,
            season: season?.samples ?? 0,
            vsOpponent: vsOpponent?.samples ?? 0,
          },
        },
      };
      // Re-derive after hitRates land — explanation.ts prefers L10 sample
      // signal when available, so refresh.
      enriched.whyThisPick = whyThisPick(enriched);
      enriched.decision    = legAudit(enriched);
      out[idx] = enriched;
    } catch {
      // silent — candidate stays unenriched
    }
  });

  return out;
}

/**
 * Pull the opponent abbr out of "BOS vs LAL" / "BOS @ LAL" style strings.
 * The candidate's `matchupLabel` is built in propCandidate as
 * `${team} vs ${opponent}` for player props.
 */
function extractOpponentAbbr(matchupLabel: string | undefined, _sport: string): string | null {
  if (!matchupLabel) return null;
  const m = matchupLabel.match(/(?:vs|@)\s*([A-Z]{2,4})/i);
  return m ? m[1].toUpperCase() : null;
}
