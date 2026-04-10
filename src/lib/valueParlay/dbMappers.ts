import type { ValueBetCandidate } from "@/lib/valueParlay/types";

/** Row shape for `bet_candidates` inserts (id generated server-side). */
export function candidateToBetCandidateRow(c: ValueBetCandidate) {
  return {
    sport: c.sport,
    game_id: c.gameId,
    pick_type: c.pickType,
    market_type: c.marketType,
    selection_label: c.selectionLabel,
    team_id: c.teamId ?? null,
    player_id: c.playerId ?? null,
    stat_type: c.statType ?? null,
    line_value: c.lineValue ?? null,
    american_odds: c.americanOdds,
    implied_probability: c.impliedProbability,
    model_probability: c.modelProbability,
    edge: c.edge,
    confidence: c.confidence,
    volatility_score: c.volatilityScore,
    uncertainty_score: c.uncertaintyScore,
    correlation_group_id: c.correlationGroupId,
    value_score: c.valueScore,
    is_recommended: c.isRecommended,
  };
}

export function oddsSnapshotRows(args: {
  sport: string;
  gameId: string;
  sportsbookId: string | null;
  marketType: string;
  sideKey: string;
  statType?: string | null;
  lineValue?: number | null;
  americanOdds: number;
  impliedProbability: number;
}) {
  return {
    sport: args.sport,
    game_id: args.gameId,
    sportsbook_id: args.sportsbookId,
    market_type: args.marketType,
    side_key: args.sideKey,
    stat_type: args.statType ?? null,
    line_value: args.lineValue ?? null,
    american_odds: args.americanOdds,
    implied_probability: args.impliedProbability,
  };
}
