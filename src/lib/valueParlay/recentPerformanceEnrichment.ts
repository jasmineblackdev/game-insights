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
  if (!propIdxs.length) return candidates;

  const out = [...candidates];

  await mapLimit(propIdxs, CONCURRENCY, async (idx) => {
    const c = out[idx];
    try {
      const games = await fetchPlayerLastGames(
        c.sport,
        c.playerId,
        c.statType!,
        5,
      );
      // Derive direction from the selection label — OVER/UNDER is embedded.
      const dir = (c.selectionLabel ?? "").toUpperCase().includes("UNDER")
        ? "LESS"
        : "MORE";
      const hit = computeRecentHitRate(games, c.lineValue!, dir);
      if (hit) {
        out[idx] = {
          ...c,
          recentHitRate:        Math.round(hit.rate * 10000) / 10000,
          recentHitRateSamples: hit.samples,
        };
      }
    } catch {
      // silent — candidate stays unenriched
    }
  });

  return out;
}
