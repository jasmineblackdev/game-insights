/**
 * Draft picks/prospects — now sourced live from ESPN.
 * The `getDraftPicks` synchronous export is removed; use `fetchDraftPicks` instead.
 * Types are kept here so imports remain stable across the app.
 */

import type { ConfidenceLevel, League } from "@/data/mockGames";
import { fetchLiveDraftPicks, currentDraftSeason } from "@/lib/espnDraftProspects";

export type DraftGrade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+";

export interface DraftPickPrediction {
  league: League;
  pickNumber: number;
  teamName: string;
  teamAbbr: string;
  teamLogo: string;
  playerName: string;
  position: string;
  college: string;
  grade: DraftGrade;
  confidence: ConfidenceLevel;
  analysis: string;
  keyStrength: string;
  projectedImpact: string;
  comparablePro?: string;
}

/**
 * Async fetch of live draft picks/prospects for the given league.
 * Uses the current draft season (calendar year).
 */
export async function fetchDraftPicks(league: League): Promise<DraftPickPrediction[]> {
  if (league === "soccer") return [];
  return fetchLiveDraftPicks(league, currentDraftSeason());
}
