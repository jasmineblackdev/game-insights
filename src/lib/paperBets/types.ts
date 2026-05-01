/**
 * Paper Bets — fake-money manual entry types.
 *
 * NEVER connects to DraftKings. NEVER places real bets. Used to
 * validate that GameLens picks survive the round-trip through
 * DraftKings labelling before risking real bankroll.
 */

export type PaperBetType = "single" | "parlay" | "sgp";

export type PaperLegStatus =
  | "open"
  | "won"
  | "lost"
  | "push"
  | "voided"
  | "needs_review";

export type PaperBetStatus =
  | "open"
  | "in_progress"
  | "won"
  | "lost"
  | "push"
  | "voided"
  | "needs_review";

export type PaperBetSource =
  | "manual_draftkings_entry"
  | "app_recommendation_paper";

export type PaperMarketType = "moneyline" | "spread" | "total" | "player_prop";
export type PaperDirection = "over" | "under";

export interface PaperLeg {
  /** Verbatim DraftKings label, e.g. "Hits O/U Over 0.5". */
  dkLabel: string;
  /** Sport + league for routing into existing feeds. */
  sport: "MLB" | "NBA" | "WNBA" | "NFL" | "BOXING" | "MMA";
  league: string;
  /** ESPN event id when known — needed for game-state lookups. */
  gameId?: string;
  gameTimeIso?: string;
  /** Team abbreviation if this is a team bet. */
  teamLabel?: string;
  /** Player display name if this is a player prop. */
  playerName?: string;
  /** ESPN athlete id when known — needed for player-stat lookups. */
  playerId?: string;
  marketType: PaperMarketType;
  /** Internal stat type for player props ("hits", "total_bases", "points", …). */
  statType?: string;
  direction?: PaperDirection;
  /** Numeric line. Moneyline = undefined; spread = signed (e.g. -3.5). */
  line?: number;
  americanOdds: number;
  /** Display label preserving DraftKings wording. */
  selectionLabel: string;

  // Resolution fields — null until settled.
  status: PaperLegStatus;
  resolvedActual?: number | null;
  resolvedReason?: string | null;
  resolvedAt?: string | null;
}

export interface PaperBet {
  id: string;
  source: PaperBetSource;
  betType: PaperBetType;
  legs: PaperLeg[];
  stake: number;
  combinedOddsAmerican: number;
  potentialPayout: number;
  status: PaperBetStatus;
  pnl: number | null;
  appRecommendationId?: string | null;
  appModelProbability?: number | null;
  appEdge?: number | null;
  appConfidence?: "high" | "medium" | "low" | null;
  notes?: string | null;
  placedAt: string;
  resolvedAt?: string | null;
}

export interface PaperBankroll {
  startingBankroll: number;
  currentBankroll: number;
  openRisk: number;
  totalPnl: number;
  betsPlaced: number;
  betsWon: number;
  betsLost: number;
  betsPush: number;
  updatedAt: string;
}
