/**
 * Main-screen ranked live picks (fallback / quick-pick when Edge Card is heavy or unused).
 * Gates: NBA after Q1 (halftime row allowed), NFL after Q1 (not halftime), MLB after 5th, soccer halftime.
 */
import type { GamePrediction, LiveBettingStageRow } from "@/data/mockGames";
import { computePickFlags, getFavoredSide, type EdgeSide } from "@/lib/edgeCardScoring";
import { computeValueScore } from "@/lib/valueParlay/valueScore";
import { computePatternBoostSync } from "@/lib/learning/userBettingPatterns";
import { defaultMinEdgeForRecommend, isEdgeBelowSportFloor } from "@/lib/sportEdgeThresholds";

export const LIVE_PICK_RANK_MAX = 6;
const FRESH_MS = 90_000;

export type LivePickOverlay =
  | {
      kind: "ranked";
      rank: number;
      checkpointLabel: string;
      badgeLine: string;
      liveConfidencePct: number;
      edgePct: number;
      /** Model confidence for the card (High / Medium / Low). */
      modelConfidenceLabel: string;
      recommendedAction: string | null;
    }
  | { kind: "stale"; label: "Value Gone" | "Pass" };

function modelConfidenceLabel(game: GamePrediction): string {
  if (game.confidence === "high") return "High";
  if (game.confidence === "medium") return "Medium";
  return "Low";
}

function volatilityNumeric(game: GamePrediction): number {
  const q = game._meta?.quality?.volatility?.volatility_score;
  if (typeof q === "number" && Number.isFinite(q)) return Math.min(100, Math.max(0, q));
  const lab = game._meta?.quality?.volatility?.volatility_label;
  if (lab === "high") return 72;
  if (lab === "medium") return 48;
  return 28;
}

function uncertaintyNumeric(game: GamePrediction, side: EdgeSide): number {
  const flags = computePickFlags(game, side);
  const uncBase = game.confidence === "high" ? 18 : game.confidence === "medium" ? 42 : 78;
  return Math.min(
    100,
    uncBase +
      (flags.injuryUncertainty ? 14 : 0) +
      (flags.pitcherUnconfirmed ? 22 : 0) +
      (flags.highVolatility ? 10 : 0)
  );
}

function confirmationScore01(game: GamePrediction): number {
  let s = 0.35;
  if (game._meta?.quality?.market?.model_implied_home != null) s += 0.12;
  if (game.league === "mlb") {
    if (game._meta?.userConfirmedMlbStarters) s += 0.18;
    const pc = game.mlb?.pitcherCertainty;
    if (pc === "confirmed") s += 0.2;
    else if (pc === "probable") s += 0.1;
    if (game.mlb?.lineupConfirmed) s += 0.08;
  }
  if (game.league === "nba" && game._meta?.nbaRatingsFromStats) s += 0.12;
  return Math.min(1, s);
}

function correlationPenalty(game: GamePrediction): number {
  const c = game._meta?.quality?.correlation;
  if (!c) return 0;
  const pen = (c.card_risk_penalty ?? 0) + (c.correlation_score ?? 0) * 0.08;
  return Math.min(40, pen);
}

/** True when scoreboard data is fresh enough for live signals. */
export function isLivePickDataFresh(game: GamePrediction): boolean {
  if (game.status !== "live") return false;
  const dataAgeMs = Date.now() - new Date(game.lastUpdated).getTime();
  return dataAgeMs <= FRESH_MS;
}

/**
 * Sport checkpoints for main-screen ranking (stricter than legacy "live trigger" in places).
 */
export function passesMainScreenLivePickGate(game: GamePrediction): boolean {
  if (!isLivePickDataFresh(game)) return false;
  const ls = game._meta?.liveState;
  if (!ls) return false;
  switch (game.league) {
    case "nba":
      return ls.periodNum >= 2 || ls.isHalftime === true;
    case "nfl":
      return ls.periodNum >= 2 && ls.isHalftime !== true;
    case "mlb":
      return ls.periodNum >= 5;
    default:
      return false;
  }
}

export type LiveCheckpointFilter = {
  /** NFL: only after-Q1 row, not halftime. */
  nflExcludeHalftime?: boolean;
  /** NBA: when false, ignore halftime checkpoint rows. */
  nbaIncludeHalftime?: boolean;
};

/** Latest matching live betting checkpoint row for overlays / notifications. */
export function selectLiveCheckpointRow(game: GamePrediction, filter?: LiveCheckpointFilter): LiveBettingStageRow | null {
  const cps = game._meta?.liveBetting?.checkpoints ?? [];
  if (!cps.length) return null;
  const want = new Set<string>();
  switch (game.league) {
    case "nba": {
      want.add("after_q1");
      if (filter?.nbaIncludeHalftime !== false) want.add("halftime");
      break;
    }
    case "nfl": {
      want.add("after_q1");
      if (!filter?.nflExcludeHalftime) want.add("halftime");
      break;
    }
    case "mlb":
      want.add("after_inning_5");
      break;
    default:
      return null;
  }
  const filtered = cps.filter((r) => want.has(r.stageId));
  if (!filtered.length) return null;
  return filtered[filtered.length - 1]!;
}

function checkpointRowForRanking(game: GamePrediction): LiveBettingStageRow | null {
  return selectLiveCheckpointRow(game);
}

export function mainScreenCheckpointLabel(game: GamePrediction, row: LiveBettingStageRow): string {
  if (row.stageId === "halftime") return "Halftime Confirmed";
  if (row.stageId === "after_inning_5") return "F5 Confirmed";
  if (row.stageId === "after_q1") return "Q1 Confirmed";
  return "Live Confirmed";
}

function canRankFromRow(row: LiveBettingStageRow, minEdge: number): boolean {
  if (row.recommendedAction === "Value Gone" || row.recommendedAction === "Pass") return false;
  if (row.edge < minEdge) return false;
  return true;
}

function staleLabelFromRow(row: LiveBettingStageRow): "Value Gone" | "Pass" | null {
  if (row.recommendedAction === "Value Gone") return "Value Gone";
  if (row.recommendedAction === "Pass") return "Pass";
  return null;
}

/**
 * live_pick_score =
 *   live_edge_score + confidence_score + value_score + confirmation_score
 *   - volatility_penalty - correlation_penalty
 */
export function computeLivePickScore(game: GamePrediction, row: LiveBettingStageRow): number {
  const live_edge_score = row.edge * 100;
  const confidence_score = row.confidence === "HIGH" ? 22 : row.confidence === "MED" ? 14 : 7;

  const side = getFavoredSide(game);
  const vol = volatilityNumeric(game);
  const unc = uncertaintyNumeric(game, side);
  const lineMv = game._meta?.quality?.market?.line_movement_home_pp;
  const lineDelta = lineMv != null && Number.isFinite(lineMv) ? Math.abs(lineMv) : null;

  const value01 = computeValueScore({
    edge: row.edge,
    confidence: game.confidence,
    impliedProbability: row.impliedProbability,
    modelProbability: row.modelProbability,
    volatilityScore: vol,
    uncertaintyScore: unc,
    lineMovementDeltaPp: lineDelta,
    sport: game.league,
    marketKind: "moneyline",
    scheduleRestHint: game._meta?.quality?.fatigue
      ? 100 - (game._meta.quality.fatigue.fatigue_penalty ?? 30)
      : undefined,
    // Live ranking row doesn't carry American odds directly. The
    // pattern boost falls through to 0 when odds are unknown.
    userPatternBoost: computePatternBoostSync({
      sport: game.league,
      marketType: "team_moneyline",
      americanOdds: null,
      isHome: side === "home",
    }),
  });
  const value_score = value01 * 28;

  const confirmation_score = confirmationScore01(game) * 18;
  const volatility_penalty = vol * 0.12;
  const corrPen = correlationPenalty(game);

  return (
    live_edge_score +
    confidence_score +
    value_score +
    confirmation_score -
    volatility_penalty -
    corrPen
  );
}

/**
 * Build per-game overlay: top ranks (up to 6) among eligible live games, or Value Gone / Pass.
 * Uses per-sport edge floors + learned `optimal_edge_threshold` when present.
 */
export function buildLivePickOverlays(games: GamePrediction[]): Map<string, LivePickOverlay> {
  const map = new Map<string, LivePickOverlay>();
  type Cand = { game: GamePrediction; row: LiveBettingStageRow; score: number };
  const candidates: Cand[] = [];

  for (const game of games) {
    if (!passesMainScreenLivePickGate(game)) continue;
    const row = checkpointRowForRanking(game);
    if (!row) continue;

    const minE =
      game._meta?.quality?.predictionIntel?.optimal_edge_threshold ?? defaultMinEdgeForRecommend(game.league);

    if (canRankFromRow(row, minE)) {
      candidates.push({ game, row, score: computeLivePickScore(game, row) });
      continue;
    }

    const stale = staleLabelFromRow(row);
    if (stale) map.set(game.id, { kind: "stale", label: stale });
    else if (isEdgeBelowSportFloor(game.league, row.edge))
      map.set(game.id, { kind: "stale", label: "Pass" });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, LIVE_PICK_RANK_MAX);
  let rank = 1;
  for (const c of top) {
    const checkpointLabel = mainScreenCheckpointLabel(c.game, c.row);
    map.set(c.game.id, {
      kind: "ranked",
      rank,
      checkpointLabel,
      badgeLine: `Live Edge • ${checkpointLabel}`,
      liveConfidencePct: Math.round(c.row.modelProbability * 1000) / 10,
      edgePct: Math.round(c.row.edge * 1000) / 10,
      modelConfidenceLabel: modelConfidenceLabel(c.game),
      recommendedAction: c.row.recommendedAction,
    });
    rank += 1;
  }

  return map;
}
