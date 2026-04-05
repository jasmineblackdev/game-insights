/**
 * Draft Edge mock data has been removed.
 * All draft edge cards are now sourced live from the Supabase `draft-edge` Edge Function.
 * When not configured, the draft edge section shows an empty state rather than mock data.
 *
 * See src/lib/draftEdgeApi.ts and src/lib/espnDraftProspects.ts.
 */

import type { DraftEdgeCard } from "@/data/draftEdgeTypes";
import type { League } from "@/data/mockGames";

/** Returns an empty array — mock data removed. Configure Supabase to see live draft edge cards. */
export function draftEdgeMockForLeague(_league: League, _year: number): DraftEdgeCard[] {
  return [];
}
