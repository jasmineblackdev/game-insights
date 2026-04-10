import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GamePrediction } from "@/data/mockGames";
import { useLiveEdgeNotificationSettings } from "@/context/LiveEdgeNotificationContext";
import { enrichGamesWithBettingIntelligence } from "@/lib/bettingIntelligence";
import { computeLiveEdgeNotifications } from "@/lib/liveEdgeNotificationEngine";
import { deliverLiveEdgeNotification, registerGameLensNotifyServiceWorker } from "@/lib/liveEdgeNotificationDelivery";
import { loadNotifyState, saveNotifyState } from "@/lib/liveEdgeNotificationState";
import { easternYmd, fetchNbaGamePredictions } from "@/lib/nbaEspn";
import { fetchNflGamePredictions } from "@/lib/nflEspn";
import { fetchMlbEnrichedGames } from "@/lib/mlbEspn";
import { applyMlbPredictionModel } from "@/lib/mlbPredictionModel";
import { mergeMlbStarterConfirmations } from "@/lib/mlbStarterConfirm";
import { fetchSoccerGamePredictions } from "@/lib/soccerEspn";
import { useOddsBundlesWithLivePoll } from "@/hooks/useOddsBundlesWithLivePoll";

/**
 * Background scoreboard + odds enrichment for all enabled sports, then evaluates live-edge notify rules.
 * Respects user settings, permission, and background-only mode.
 */
export function useLiveEdgeNotifications(): void {
  const { settings } = useLiveEdgeNotificationSettings();
  const ymd = useMemo(() => easternYmd(), []);

  const anySport =
    settings.sports.nba ||
    settings.sports.nfl ||
    settings.sports.mlb ||
    settings.sports.soccer;

  const canPoll =
    settings.masterEnabled &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted" &&
    anySport;

  const nbaQuery = useQuery({
    queryKey: ["nba-espn-scoreboard", ymd],
    queryFn: fetchNbaGamePredictions,
    staleTime: 2 * 60 * 1000,
    refetchInterval: canPoll && settings.sports.nba ? 2 * 60 * 1000 : false,
    refetchIntervalInBackground: false,
    enabled: canPoll && settings.sports.nba,
  });

  const nflQuery = useQuery({
    queryKey: ["nfl-espn-scoreboard", ymd],
    queryFn: fetchNflGamePredictions,
    staleTime: 2 * 60 * 1000,
    refetchInterval: canPoll && settings.sports.nfl ? 2 * 60 * 1000 : false,
    refetchIntervalInBackground: false,
    enabled: canPoll && settings.sports.nfl,
  });

  const mlbBaseQuery = useQuery({
    queryKey: ["mlb-espn-enriched", ymd],
    queryFn: fetchMlbEnrichedGames,
    staleTime: 2 * 60 * 1000,
    refetchInterval: canPoll && settings.sports.mlb ? 2 * 60 * 1000 : false,
    refetchIntervalInBackground: false,
    enabled: canPoll && settings.sports.mlb,
  });

  const mlbModeledQuery = useQuery({
    queryKey: ["mlb-modeled", "notify-scan", mlbBaseQuery.dataUpdatedAt],
    queryFn: () => applyMlbPredictionModel(mergeMlbStarterConfirmations(mlbBaseQuery.data ?? [])),
    enabled: canPoll && settings.sports.mlb && mlbBaseQuery.isSuccess,
    staleTime: Infinity,
  });

  const soccerQuery = useQuery({
    queryKey: ["soccer-espn-scoreboard", ymd],
    queryFn: fetchSoccerGamePredictions,
    staleTime: 2 * 60 * 1000,
    refetchInterval: canPoll && settings.sports.soccer ? 2 * 60 * 1000 : false,
    refetchIntervalInBackground: false,
    enabled: canPoll && settings.sports.soccer,
  });

  const leagueGames = useMemo(() => {
    const out: GamePrediction[] = [];
    if (nbaQuery.data?.length) out.push(...nbaQuery.data);
    if (nflQuery.data?.length) out.push(...nflQuery.data);
    if (mlbModeledQuery.data?.length) out.push(...mlbModeledQuery.data);
    if (soccerQuery.data?.length) out.push(...soccerQuery.data);
    return out;
  }, [nbaQuery.data, nflQuery.data, mlbModeledQuery.data, soccerQuery.data]);

  const oddsMap = useOddsBundlesWithLivePoll(leagueGames);

  const enriched = useMemo(
    () => enrichGamesWithBettingIntelligence(leagueGames, oddsMap),
    [leagueGames, oddsMap]
  );

  const fingerprint = useMemo(() => {
    return enriched
      .filter((g) => g.status === "live")
      .map(
        (g) =>
          `${g.id}:${g.lastUpdated}:${g._meta?.liveBetting?.checkpoints?.length ?? 0}:${g._meta?.liveBetting?.pregame?.edge ?? ""}`
      )
      .sort()
      .join("|");
  }, [enriched]);

  useEffect(() => {
    if (settings.masterEnabled && Notification.permission === "granted") {
      void registerGameLensNotifyServiceWorker();
    }
  }, [settings.masterEnabled]);

  useEffect(() => {
    if (!canPoll) return;
    if (settings.onlyWhenBackground && typeof document !== "undefined" && document.visibilityState !== "hidden") {
      return;
    }
    const now = Date.now();
    if (now - lastThrottle.current < SCAN_THROTTLE_MS) return;
    lastThrottle.current = now;

    const state = loadNotifyState();
    const { payloads, nextState } = computeLiveEdgeNotifications(enriched, settings, state, now);
    if (!payloads.length) return;

    saveNotifyState(nextState);

    void (async () => {
      for (const p of payloads) {
        try {
          await deliverLiveEdgeNotification(p);
        } catch {
          /* ignore delivery failures */
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
  }, [
    canPoll,
    enriched,
    fingerprint,
    settings,
    settings.masterEnabled,
    settings.onlyWhenBackground,
    settings.pickMode,
    settings.nbaHalftimeUpdates,
    settings.sports.mlb,
    settings.sports.nba,
    settings.sports.nfl,
    settings.sports.soccer,
  ]);
}
