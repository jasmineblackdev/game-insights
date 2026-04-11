import { useEffect, useMemo, useRef, useState } from "react";
import type { GamePrediction } from "@/data/mockGames";
import { isOddsApiAvailable } from "@/lib/oddsApiFetch";
import {
  fetchAllOddsBundles,
  fetchOddsBundlesForLiveGames,
  type GameOddsBundle,
} from "@/lib/valueParlay/oddsEvents";

const LIVE_ODDS_MS = 20_000;
/** Faster refresh while any fixture is live (checkpoint windows decay quickly). */
const LIVE_ODDS_FAST_MS = 8_000;

/**
 * Full odds fetch when the game list changes, plus periodic in-play refresh
 * using Odds API `eventIds` (requires `oddsApiEventId` from the initial match).
 */
export function useOddsBundlesWithLivePoll(leagueGames: GamePrediction[]) {
  const gameIdsKey = useMemo(() => leagueGames.map((g) => g.id).sort().join(","), [leagueGames]);
  const anyLive = useMemo(() => leagueGames.some((g) => g.status === "live"), [leagueGames]);

  const [oddsMap, setOddsMap] = useState<Map<string, GameOddsBundle>>(() => new Map());

  const gamesRef = useRef(leagueGames);
  const oddsRef = useRef(oddsMap);
  gamesRef.current = leagueGames;
  oddsRef.current = oddsMap;

  useEffect(() => {
    if (!leagueGames.length) {
      setOddsMap(new Map());
      return;
    }
    let cancelled = false;
    fetchAllOddsBundles(leagueGames).then((m) => {
      if (!cancelled) setOddsMap(m);
    });
    return () => {
      cancelled = true;
    };
    // Intentionally only when membership changes — avoids refetching all odds every score tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameIdsKey]);

  useEffect(() => {
    if (!isOddsApiAvailable()) return;

    let cancelled = false;
    const tick = async () => {
      const delta = await fetchOddsBundlesForLiveGames(gamesRef.current, oddsRef.current);
      if (cancelled || delta.size === 0) return;
      setOddsMap((prev) => {
        const next = new Map(prev);
        for (const [id, b] of delta) {
          const old = next.get(id) ?? { gameId: id };
          next.set(id, { ...old, ...b });
        }
        return next;
      });
    };

    const intervalMs = anyLive ? LIVE_ODDS_FAST_MS : LIVE_ODDS_MS;

    tick();
    const iv = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [gameIdsKey, anyLive]);

  return oddsMap;
}
