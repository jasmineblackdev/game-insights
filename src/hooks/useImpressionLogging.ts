/**
 * useImpressionLogging — fires the three pick/prop loggers once per
 * candidate-pool change. Without this hook, surfaces other than the
 * parlay builder (Home, Daily Plan, Best Value Picks) showed picks
 * without writing impression rows — leaving an audit gap that meant
 * we couldn't reconstruct the full set of picks the user ever saw.
 *
 * The underlying writers (logPropImpressions, logParlayLegRejections,
 * logGamePredictionSnapshots) already de-duplicate at session scope
 * and use server-side UNIQUE constraints, so calling this hook from
 * every page is safe and cheap.
 *
 * Pass `surface` so analytics rollups can answer "where did this pick
 * surface from" — not yet stored on the row, but the hook is ready
 * for the column when the migration lands.
 */

import { useEffect } from "react";
import type { GamePrediction } from "@/data/mockGames";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import type { ParlayBuildMode } from "@/lib/valueParlay/types";
import { buildAllValueCandidates, buildEnrichedPropCandidates } from "@/lib/valueParlay/buildCandidates";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import {
  logPropImpressions,
  logParlayLegRejections,
  logGamePredictionSnapshots,
} from "@/lib/ml/impressionLogger";

export type ImpressionSurface =
  | "home"
  | "daily_plan"
  | "best_value"
  | "parlay_builder"
  | "tomorrow"
  | "live";

interface UseImpressionLoggingArgs {
  /** Surface label for analytics. */
  surface: ImpressionSurface;
  /** Parlay-build mode used by the leg-rejection diagnostic. */
  mode?: ParlayBuildMode;
  /** Game predictions visible on this surface. */
  games?: GamePrediction[];
  /** Player props visible on this surface. */
  props?: PlayerEdgePrediction[];
  /**
   * Odds bundle map used by buildAllValueCandidates. Optional — when
   * absent, only player-prop impressions are logged.
   */
  oddsMap?: Map<string, GameOddsBundle>;
}

export function useImpressionLogging(args: UseImpressionLoggingArgs): void {
  const { surface, mode = "balanced", games, props, oddsMap } = args;

  // Player props → prop_impressions. Cheap, fires whenever the visible
  // prop list changes.
  useEffect(() => {
    if (!props?.length) return;
    void logPropImpressions(props);
    void surface; // reserved for future surface-tag column
  }, [props, surface]);

  // Team picks → game_prediction_snapshots + parlay_leg_rejections.
  // Both require ValueBetCandidate shape, so we build candidates here
  // (same path the parlay builder uses).
  useEffect(() => {
    if (!games?.length || !oddsMap) return;
    // Build candidates exactly like the builder does. Player-prop
    // candidates from `props` are joined so leg-rejection diagnosis
    // sees the full pool.
    const teamCandidates = buildAllValueCandidates(games, oddsMap);
    const propCandidates = buildEnrichedPropCandidates(props ?? []);
    const fullPool = [...teamCandidates, ...propCandidates];
    void logGamePredictionSnapshots(teamCandidates);
    void logParlayLegRejections(fullPool, mode);
  }, [games, oddsMap, props, mode]);
}
