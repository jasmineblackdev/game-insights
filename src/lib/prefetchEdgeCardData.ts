import type { QueryClient } from "@tanstack/react-query";
import type { GamePrediction } from "@/data/mockGames";
import { easternYmd, fetchNbaGamePredictions } from "@/lib/nbaEspn";
import { fetchNflGamePredictions } from "@/lib/nflEspn";
import { fetchMlbEnrichedGames } from "@/lib/mlbEspn";
import { applyMlbPredictionModel } from "@/lib/mlbPredictionModel";
import { mergeMlbStarterConfirmations } from "@/lib/mlbStarterConfirm";

const STALE_MS = 2 * 60 * 1000;

/** Warm React Query cache for /edge (same keys as Home + Edge Card). Safe to call repeatedly. */
export function prefetchEdgeCardQueries(queryClient: QueryClient): void {
  const ymd = easternYmd();
  const base = { staleTime: STALE_MS, retry: 2 as const };

  void queryClient.prefetchQuery({
    queryKey: ["nba-espn-scoreboard", ymd],
    queryFn: fetchNbaGamePredictions,
    ...base,
  });
  void queryClient.prefetchQuery({
    queryKey: ["nfl-espn-scoreboard", ymd],
    queryFn: fetchNflGamePredictions,
    ...base,
  });

  void queryClient.prefetchQuery({
    queryKey: ["mlb-espn-enriched", ymd],
    queryFn: fetchMlbEnrichedGames,
    ...base,
  }).then(() => {
    const data = queryClient.getQueryData<GamePrediction[]>(["mlb-espn-enriched", ymd]);
    if (data == null) return;
    const state = queryClient.getQueryState(["mlb-espn-enriched", ymd]);
    const updatedAt = state?.dataUpdatedAt ?? 0;
    void queryClient.prefetchQuery({
      queryKey: ["mlb-modeled", updatedAt, 0],
      queryFn: () => applyMlbPredictionModel(mergeMlbStarterConfirmations(data)),
      staleTime: Infinity,
      retry: 2,
    });
  });
}
