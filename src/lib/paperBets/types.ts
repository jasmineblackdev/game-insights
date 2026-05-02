/**
 * Paper Bets — fake-money manual entry types.
 *
 * NEVER connects to DraftKings. NEVER places real bets. Used to
 * validate that GameLens picks survive the round-trip through
 * DraftKings labelling before risking real bankroll.
 */

import type {
  ResolutionDiagnosis,
  ResolutionVia,
} from "@/lib/learning/resolutionDiagnosis";

export type PaperBetType = "single" | "parlay" | "sgp";

/** Pregame = entered before tipoff/first pitch; live = entered in-game. */
export type PaperBetTiming = "pregame" | "live";

/**
 * Game state captured at the moment a live bet was placed.
 * Stored verbatim on `paper_bets.live_state` (JSONB). Pregame bets
 * leave this null. Used by the live-vs-pregame analytics breakdown.
 */
export interface PaperLiveState {
  scoreHome?: number | null;
  scoreAway?: number | null;
  /** "Q3", "5th inning", "1st half", etc. — verbatim sport label. */
  period?: string | null;
  /** "8:42" — verbatim DK clock value. */
  gameClock?: string | null;
  /** Optional: stat already accumulated by the player at entry time. */
  playerStatAtEntry?: number | null;
  /** Model probability captured at entry, when the user is testing an in-app live signal. */
  modelProbAtEntry?: number | null;
}

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
  /**
   * Canonical diagnosis when the auto-resolver couldn't verify this
   * leg. Drives the "Pending — game not final" / "Needs review —
   * stat not found" status row in the UI. Cleared on a successful
   * resolution.
   */
  resolutionDiagnosis?: ResolutionDiagnosis | null;
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
  /** "pregame" (default) or "live". Pregame bets leave liveState null. */
  betTiming: PaperBetTiming;
  /** Game state at the moment of a live bet; null for pregame. */
  liveState?: PaperLiveState | null;
  /**
   * How this bet reached its terminal status:
   *   "espn"   → auto-resolved against ESPN feeds
   *   "manual" → user clicked Won/Lost/Push
   *   null     → still pending (or pre-migration row)
   */
  resolvedVia?: ResolutionVia;
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
