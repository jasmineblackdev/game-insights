/**
 * React-Query wrapper around `fetchNflInjuries` that returns the
 * raw list AND a normalized lookup map keyed by lowercased full
 * name. Components use the map for O(1) badge lookups while the
 * list survives for panels that want to enumerate (e.g. Insights
 * Data Sources).
 *
 * Caching:
 *   • staleTime: 15 min — Sleeper updates injury statuses on a
 *     beat-writer cadence (a few times per day during the season,
 *     near-zero in the off-season). 15 min keeps cards reactive
 *     during active news cycles without hammering the proxy.
 *   • refetchOnWindowFocus: false — too aggressive for a 5MB
 *     upstream response.
 *
 * Failure mode: empty map. Components render nothing for badges
 * when the hook is loading or the call failed, so a Sleeper
 * outage never blocks the rest of the UI.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchNflInjuries, type NflInjury } from "@/lib/sleeperFetch";

const QUERY_KEY = ["sleeper-nfl-injuries"] as const;
const FIFTEEN_MIN = 15 * 60 * 1000;

interface NflInjuryFeed {
  injuries: NflInjury[];
  /** Lowercased full-name → injury, for O(1) badge lookups. */
  byNameLower: Map<string, NflInjury>;
  /** ISO timestamp of the last successful fetch (the React-Query
   *  dataUpdatedAt translated to ISO) — null until first success. */
  fetchedAtIso: string | null;
}

const EMPTY_FEED: NflInjuryFeed = {
  injuries:     [],
  byNameLower:  new Map(),
  fetchedAtIso: null,
};

export function useNflInjuries(): NflInjuryFeed {
  const q = useQuery({
    queryKey:             QUERY_KEY,
    queryFn:              fetchNflInjuries,
    staleTime:            FIFTEEN_MIN,
    refetchOnWindowFocus: false,
    refetchOnMount:       false,
  });
  if (!q.data) return EMPTY_FEED;
  const byNameLower = new Map<string, NflInjury>();
  for (const inj of q.data) {
    if (inj.fullName) byNameLower.set(inj.fullName.toLowerCase().trim(), inj);
  }
  return {
    injuries:     q.data,
    byNameLower,
    fetchedAtIso: q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString() : null,
  };
}

/**
 * Imperative lookup helper for non-component code paths. Pulls from
 * the React-Query cache only — does NOT trigger a fetch.
 *
 * NOT exported as the canonical API; the hook is the canonical API.
 * Reserved for places where wiring a hook is impractical (e.g.
 * inside a memoized helper that already takes a name string).
 */
export function findCachedInjury(
  byNameLower: Map<string, NflInjury>,
  playerName: string | null | undefined,
): NflInjury | null {
  if (!playerName) return null;
  const k = playerName.toLowerCase().trim();
  return byNameLower.get(k) ?? null;
}
