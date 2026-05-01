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
      const last3  = computeRecentHitRate(seasonGames.slice(0, 3),  c.lineValue!, dir);
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

      // Per-game timeline (chronological oldest → newest) for the
      // Outlier-style last-10 chart. Push-flagged with hit=null so the
      // chart can render a neutral cell.
      const last10ChronoSlice = seasonGames.slice(0, 10).slice().reverse();
      const gameByGame = last10ChronoSlice.map((g) => {
        if (!Number.isFinite(g.value)) {
          return { date: g.date, opponent: g.opponent, value: g.value, hit: null };
        }
        if (g.value === c.lineValue!) {
          return { date: g.date, opponent: g.opponent, value: g.value, hit: null };
        }
        const isOver = g.value > c.lineValue!;
        const hit = (dir === "MORE" && isOver) || (dir === "LESS" && !isOver);
        return { date: g.date, opponent: g.opponent, value: g.value, hit };
      });

      // Consistency: bucketed last10. <50% low / 50-70% medium / >70% high.
      const last10Rate = last10 && last10.samples >= 5 ? last10.rate : null;
      const consistency: "high" | "medium" | "low" | null =
        last10Rate == null ? null
        : last10Rate > 0.70 ? "high"
        : last10Rate >= 0.50 ? "medium"
        : "low";

      // Trend: last3 vs last10. ≥10pp difference flips the label.
      const last3Rate = last3 && last3.samples >= 2 ? last3.rate : null;
      const trend: "up" | "down" | "flat" | null =
        last3Rate == null || last10Rate == null ? null
        : last3Rate >= last10Rate + 0.10 ? "up"
        : last3Rate <= last10Rate - 0.10 ? "down"
        : "flat";

      // Matchup insight — Outlier-style "Opponent allows X" line.
      // Derived from vs-opponent hit rate when sample is meaningful;
      // falls back to NFL injury opportunity adjustment when relevant.
      // Future: pipe in nba/mlb/nfl opponentMultiplier when those are
      // surfaced on the candidate.
      const matchupNote = deriveMatchupNote({
        vsOpponentRate: vsOpponent?.rate ?? null,
        vsOpponentSamples: vsOpponent?.samples ?? 0,
        opponentAbbr: opp,
        injuryImpactAdj: c.injuryImpactAdj,
      });

      const enriched: ValueBetCandidate = {
        ...c,
        // Legacy alias — kept for computeLegScore + legPassesParlayBuildFilters.
        recentHitRate:        last5 ? round(last5.rate)! : c.recentHitRate,
        recentHitRateSamples: last5 ? last5.samples : c.recentHitRateSamples,
        matchupNote: matchupNote || c.matchupNote,
        // Props.Cash + Outlier visualization payload.
        hitRates: {
          last3:  last3  && last3.samples  >= 2 ? round(last3.rate)  : null,
          last5:  last5  && last5.samples  >= 3 ? round(last5.rate)  : null,
          last10: last10 && last10.samples >= 5 ? round(last10.rate) : null,
          season: season && season.samples >= 5 ? round(season.rate) : null,
          vsOpponent: vsOpponent && vsOpponent.samples >= 1 ? round(vsOpponent.rate) : null,
          samples: {
            last3:  last3?.samples  ?? 0,
            last5:  last5?.samples  ?? 0,
            last10: last10?.samples ?? 0,
            season: season?.samples ?? 0,
            vsOpponent: vsOpponent?.samples ?? 0,
          },
          gameByGame,
          consistency,
          trend,
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

/**
 * Compose an Outlier-style matchup insight line from the signals
 * already on the candidate. Honest about sample size — small
 * vs-opponent windows surface as "small sample" rather than a
 * misleading hit rate.
 */
function deriveMatchupNote(args: {
  vsOpponentRate: number | null;
  vsOpponentSamples: number;
  opponentAbbr: string | null;
  injuryImpactAdj: number | undefined;
}): string {
  const opp = args.opponentAbbr ?? "OPP";
  if (args.injuryImpactAdj != null && args.injuryImpactAdj >= 0.04) {
    return `Role boost vs ${opp} — teammate injury elevates volume.`;
  }
  if (args.injuryImpactAdj != null && args.injuryImpactAdj <= -0.04) {
    return `Injury risk vs ${opp} — pressure / coverage degraded.`;
  }
  if (args.vsOpponentRate != null && args.vsOpponentSamples >= 3) {
    const pct = Math.round(args.vsOpponentRate * 100);
    if (pct >= 70) return `vs ${opp} historically: ${pct}% hit rate (${args.vsOpponentSamples} games) — favourable matchup.`;
    if (pct <= 30) return `vs ${opp} historically: ${pct}% hit rate (${args.vsOpponentSamples} games) — opponent has been tough.`;
    return `vs ${opp} historically: ${pct}% hit rate (${args.vsOpponentSamples} games) — neutral matchup.`;
  }
  if (args.vsOpponentSamples > 0 && args.vsOpponentSamples < 3) {
    return `vs ${opp}: small historical sample.`;
  }
  return "";
}
