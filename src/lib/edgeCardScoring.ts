import type { ConfidenceLevel, GamePrediction, League, VolatilityLabel } from "@/data/mockGames";
import type { DraftEdgeCard, DraftEdgeCardKind } from "@/data/draftEdgeTypes";

export type EdgeSide = "home" | "away";
/** Common leg counts (3 / 5 / 7 / 10). Legacy 4→5 and 6→7 on read from storage. */
export type EdgeCardSize = 3 | 5 | 7 | 10;

export const EDGE_CARD_SIZE_OPTIONS = [3, 5, 7, 10] as const satisfies readonly EdgeCardSize[];

export function normalizeEdgeCardSizeFromStorage(raw: unknown): EdgeCardSize {
  if (raw === 3 || raw === 5 || raw === 7 || raw === 10) return raw;
  if (raw === 4) return 5;
  if (raw === 6) return 7;
  return 3;
}

export interface EdgeHubFilters {
  leagues: League[] | "all";
  minConfidence: "any" | ConfidenceLevel;
  excludeQuestionableInjuries: boolean;
  excludeUnconfirmedPitchers: boolean;
  excludeHighVolatility: boolean;
}

export const defaultEdgeHubFilters: EdgeHubFilters = {
  leagues: "all",
  minConfidence: "any",
  excludeQuestionableInjuries: false,
  excludeUnconfirmedPitchers: false,
  excludeHighVolatility: false,
};

export interface EdgePickFlags {
  injuryUncertainty: boolean;
  pitcherUnconfirmed: boolean;
  highVolatility: boolean;
  drawHeavy: boolean;
}

export interface EdgeSlipSnapshot {
  homeAbbr: string;
  awayAbbr: string;
  pickedAbbr: string;
  opponentAbbr: string;
  winProb: number;
  confidence: ConfidenceLevel;
  pickScore: number;
  topReason: string;
  topRisk: string;
  keyEdge: string;
  lastUpdated: string;
  /** From layered quality pipeline — used for card-level volatility / calibration only. */
  volatilityLabel?: VolatilityLabel;
}

export interface PlayerPropSlipSnapshot {
  playerName: string;
  label: string;
  teamAbbr: string;
  opponentAbbr: string;
  gameTime: string;
  statType: string;
  lineValue: number;
  projectedValue: number;
  predictionDirection: "MORE" | "LESS";
  edgeDisplay: number;
  confidence: ConfidenceLevel;
  topReason: string;
  topRisk: string;
  lastUpdated: string;
}

export type TeamEdgeSlipItem = {
  kind: "team_pick";
  id: string;
  gameId: string;
  league: League;
  side: EdgeSide;
  addedAt: string;
  snapshot: EdgeSlipSnapshot;
};

export type PlayerPropEdgeSlipItem = {
  kind: "player_prop";
  id: string;
  gameId: string;
  playerId: string;
  league: League;
  statType: string;
  addedAt: string;
  snapshot: PlayerPropSlipSnapshot;
};

export type DraftEdgeSlipSnapshot = {
  confidence: ConfidenceLevel;
  label: string;
  cardKind: DraftEdgeCardKind;
  playerName: string;
  position: string;
  college: string;
  grade: string;
  tier?: string;
  topReason: string;
  topRisk: string;
  cardSummary: string;
  year: number;
};

export type DraftEdgeSlipItem = {
  kind: "draft_edge";
  id: string;
  league: League;
  year: number;
  cardKind: DraftEdgeCardKind;
  addedAt: string;
  snapshot: DraftEdgeSlipSnapshot;
};

/** Mixed Edge Card: team picks, player props, draft intelligence. */
export type EdgeSlipItem = TeamEdgeSlipItem | PlayerPropEdgeSlipItem | DraftEdgeSlipItem;

export function isTeamSlipItem(item: EdgeSlipItem): item is TeamEdgeSlipItem {
  return item.kind === "team_pick";
}

export function isPlayerPropSlipItem(item: EdgeSlipItem): item is PlayerPropEdgeSlipItem {
  return item.kind === "player_prop";
}

export function isDraftEdgeSlipItem(item: EdgeSlipItem): item is DraftEdgeSlipItem {
  return item.kind === "draft_edge";
}

/** API / UI payload shape for adding a player prop to the slip. */
export interface PlayerPropInput {
  id: string;
  game_id: string;
  player_id: string;
  player_name: string;
  sport: "NBA" | "NFL" | "MLB" | "Boxing";
  team: string;
  opponent: string;
  game_time: string;
  stat_type: string;
  line_value: number;
  projected_value: number;
  prediction_direction: "MORE" | "LESS";
  edge: number;
  confidence: "HIGH" | "MED" | "LOW";
  reason_1: string;
  reason_2: string;
  risk_factor: string;
}

function sportToLeague(s: PlayerPropInput["sport"]): League {
  if (s === "NBA") return "nba";
  if (s === "NFL") return "nfl";
  if (s === "MLB") return "mlb";
  return "boxing";
}

function apiConfidenceToLevel(c: PlayerPropInput["confidence"]): ConfidenceLevel {
  if (c === "HIGH") return "high";
  if (c === "MED") return "medium";
  return "low";
}

function humanStatLabel(statType: string): string {
  const map: Record<string, string> = {
    points: "Pts",
    rebounds: "Reb",
    assists: "Ast",
    passing_yards: "Pass Yds",
    rushing_yards: "Rush Yds",
    receiving_yards: "Rec Yds",
    strikeouts: "K",
    hits: "Hits",
    total_bases: "TB",
    shots: "Shots",
    shots_on_target: "SoT",
  };
  return map[statType] ?? statType.replace(/_/g, " ");
}

export function buildPlayerPropLabel(p: PlayerPropInput): string {
  return `${p.player_name} ${p.prediction_direction} ${p.line_value} ${humanStatLabel(p.stat_type)}`;
}

export function playerPropToSlipItem(p: PlayerPropInput): PlayerPropEdgeSlipItem {
  const league = sportToLeague(p.sport);
  const conf = apiConfidenceToLevel(p.confidence);
  const label = buildPlayerPropLabel(p);
  return {
    kind: "player_prop",
    id: p.id,
    gameId: p.game_id,
    playerId: p.player_id,
    league,
    statType: p.stat_type,
    addedAt: new Date().toISOString(),
    snapshot: {
      playerName: p.player_name,
      label,
      teamAbbr: p.team,
      opponentAbbr: p.opponent,
      gameTime: p.game_time,
      statType: p.stat_type,
      lineValue: p.line_value,
      projectedValue: p.projected_value,
      predictionDirection: p.prediction_direction,
      edgeDisplay: Math.abs(p.edge),
      confidence: conf,
      topReason: p.reason_1,
      topRisk: p.risk_factor,
      lastUpdated: new Date().toISOString(),
    },
  };
}

function draftApiConfidence(c: DraftEdgeCard["confidence"]): ConfidenceLevel {
  if (c === "HIGH") return "high";
  if (c === "MED") return "medium";
  return "low";
}

export function buildDraftEdgeSlipLabel(card: DraftEdgeCard): string {
  switch (card.kind) {
    case "exact_pick": {
      const abbr = card.predicted_team_abbr ?? card.predicted_team ?? "TBD";
      const p = card.probability != null ? ` ${Math.round(card.probability)}%` : "";
      return `#${card.pick_number ?? "?"} ${card.player_name} → ${abbr}${p}`;
    }
    case "position_ou":
      return `${card.player_name} pos O/U ${card.ou_line ?? "—"}: ${card.ou_prediction ?? "—"}`;
    case "round_yes_no":
      return `${card.player_name} 1st round: ${card.round_prediction === "yes" ? "Yes" : "No"}`;
    case "team_position":
      return `${card.team_target_abbr ?? "?"} R1 ${card.team_need_position ?? "—"}`;
    case "position_first":
      return `First ${card.first_position_label ?? card.position}: ${card.player_name}`;
    default:
      return `Draft · ${card.player_name}`;
  }
}

export function draftEdgeToSlipItem(card: DraftEdgeCard): DraftEdgeSlipItem {
  const label = buildDraftEdgeSlipLabel(card);
  const cardSummary = `${card.reason_1} · ${card.risk_factor}`.slice(0, 180);
  return {
    kind: "draft_edge",
    id: card.id,
    league: card.league,
    year: card.year,
    cardKind: card.kind,
    addedAt: new Date().toISOString(),
    snapshot: {
      confidence: draftApiConfidence(card.confidence),
      label,
      cardKind: card.kind,
      playerName: card.player_name,
      position: card.position,
      college: card.college,
      grade: card.grade,
      tier: card.tier,
      topReason: card.reason_1,
      topRisk: card.risk_factor,
      cardSummary,
      year: card.year,
    },
  };
}

function normalizeTeamSlipSnapshot(raw: unknown): EdgeSlipSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const conf = s.confidence;
  const confidence: ConfidenceLevel =
    conf === "high" || conf === "medium" || conf === "low" ? conf : "medium";
  const vl = s.volatilityLabel;
  const volatilityLabel: VolatilityLabel | undefined =
    vl === "low" || vl === "medium" || vl === "high" ? vl : undefined;
  return {
    homeAbbr: typeof s.homeAbbr === "string" ? s.homeAbbr : "?",
    awayAbbr: typeof s.awayAbbr === "string" ? s.awayAbbr : "?",
    pickedAbbr: typeof s.pickedAbbr === "string" ? s.pickedAbbr : "?",
    opponentAbbr: typeof s.opponentAbbr === "string" ? s.opponentAbbr : "?",
    winProb: typeof s.winProb === "number" && Number.isFinite(s.winProb) ? s.winProb : 50,
    confidence,
    pickScore: typeof s.pickScore === "number" && Number.isFinite(s.pickScore) ? s.pickScore : 0,
    topReason: typeof s.topReason === "string" ? s.topReason : "—",
    topRisk: typeof s.topRisk === "string" ? s.topRisk : "—",
    keyEdge: typeof s.keyEdge === "string" ? s.keyEdge : "—",
    lastUpdated: typeof s.lastUpdated === "string" ? s.lastUpdated : new Date().toISOString(),
    ...(volatilityLabel ? { volatilityLabel } : {}),
  };
}

/** Migrate v1 JSON slip rows (no `kind`) to discriminated union. */
export function normalizeSlipItem(raw: unknown): EdgeSlipItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "draft_edge") {
    return raw as DraftEdgeSlipItem;
  }
  if (o.kind === "player_prop") {
    const item = raw as PlayerPropEdgeSlipItem;
    const snap = item.snapshot;
    if (!snap || typeof snap !== "object") return null;
    const ed = snap.edgeDisplay;
    const edgeDisplay = typeof ed === "number" && Number.isFinite(ed) ? Math.abs(ed) : 0;
    const predictionDirection =
      snap.predictionDirection === "MORE" || snap.predictionDirection === "LESS"
        ? snap.predictionDirection
        : "MORE";
    return {
      ...item,
      snapshot: {
        ...snap,
        playerName: typeof snap.playerName === "string" ? snap.playerName : "—",
        label: typeof snap.label === "string" ? snap.label : "Player prop",
        teamAbbr: typeof snap.teamAbbr === "string" ? snap.teamAbbr : "?",
        opponentAbbr: typeof snap.opponentAbbr === "string" ? snap.opponentAbbr : "?",
        gameTime: typeof snap.gameTime === "string" ? snap.gameTime : "—",
        statType: typeof snap.statType === "string" ? snap.statType : "—",
        lineValue: typeof snap.lineValue === "number" && Number.isFinite(snap.lineValue) ? snap.lineValue : 0,
        projectedValue:
          typeof snap.projectedValue === "number" && Number.isFinite(snap.projectedValue)
            ? snap.projectedValue
            : 0,
        topReason: typeof snap.topReason === "string" ? snap.topReason : "—",
        topRisk: typeof snap.topRisk === "string" ? snap.topRisk : "—",
        lastUpdated: typeof snap.lastUpdated === "string" ? snap.lastUpdated : new Date().toISOString(),
        edgeDisplay,
        predictionDirection,
        confidence:
          snap.confidence === "high" || snap.confidence === "medium" || snap.confidence === "low"
            ? snap.confidence
            : "medium",
      },
    };
  }
  if (o.kind === "team_pick") {
    const item = raw as TeamEdgeSlipItem;
    const snap = normalizeTeamSlipSnapshot(item.snapshot);
    if (!snap) return null;
    return { ...item, snapshot: snap };
  }
  if (
    typeof o.gameId === "string" &&
    o.league &&
    o.side &&
    o.snapshot &&
    typeof o.snapshot === "object" &&
    "pickedAbbr" in (o.snapshot as object)
  ) {
    const gid = String(o.gameId);
    const snap = normalizeTeamSlipSnapshot(o.snapshot);
    if (!snap) return null;
    return {
      kind: "team_pick",
      id: gid,
      gameId: gid,
      league: o.league as League,
      side: o.side as EdgeSide,
      addedAt: typeof o.addedAt === "string" ? o.addedAt : new Date().toISOString(),
      snapshot: snap,
    };
  }
  return null;
}

export type EdgeSlipOutcome = "win" | "loss" | "push";

export interface EdgeHistoryEntry {
  id: string;
  savedAt: string;
  size: EdgeCardSize;
  items: EdgeSlipItem[];
  aggregateConfidence: ConfidenceLevel;
  riskLabel: "elevated" | "moderate" | "controlled";
  /** User-tracked result for the saved card (optional). */
  outcome?: EdgeSlipOutcome | null;
}

export interface EdgeCandidate {
  game: GamePrediction;
  side: EdgeSide;
  pickScore: number;
  winProbability: number;
  flags: EdgePickFlags;
}

export function getWinProbForSide(game: GamePrediction, side: EdgeSide): number {
  if (game.threeWay) {
    return side === "home" ? game.threeWay.home : game.threeWay.away;
  }
  return side === "home" ? game.winProbability.home : game.winProbability.away;
}

export function getFavoredSide(game: GamePrediction): EdgeSide {
  if (game.threeWay) {
    return game.threeWay.home >= game.threeWay.away ? "home" : "away";
  }
  return game.winProbability.home >= game.winProbability.away ? "home" : "away";
}

/**
 * Confidence bonus — dampened per sport to reflect actual predictive power.
 * NBA/NFL markets are more efficient → higher bonus for HIGH confidence.
 * MLB/Soccer have more variance → caps lower.
 */
function confidenceStability(conf: ConfidenceLevel, league?: string): number {
  const isHighVariance = league === "mlb" || league === "boxing";
  if (conf === "high") return isHighVariance ? 10 : 14;
  if (conf === "medium") return isHighVariance ? 5 : 7;
  return 2;
}

/** Higher = more certain lineup / starter situation for the picked side. */
function lineupCertaintyBonus(game: GamePrediction, side: EdgeSide): number {
  if (game.league === "mlb" && game.mlb) {
    const pc = game.mlb.pitcherCertainty;
    if (pc === "confirmed") return 10;
    if (pc === "probable") return 5;
    return 0;
  }
  const inj = side === "home" ? game.injuries.home : game.injuries.away;
  const bad = inj.filter((i) => i.status === "QUESTIONABLE" || i.status === "GTD" || i.status === "OUT");
  const q = bad.filter((i) => i.status !== "OUT").length;
  const out = bad.filter((i) => i.status === "OUT").length;
  return Math.max(0, 6 - q * 2 - out * 3);
}

function injuryVolatilityPenalty(game: GamePrediction, side: EdgeSide): number {
  const inj = side === "home" ? game.injuries.home : game.injuries.away;
  let p = 0;
  for (const i of inj) {
    if (i.status === "OUT" && i.impactScore >= 6) p += 8;
    else if (i.status === "OUT") p += 4;
    else if (i.status === "QUESTIONABLE" || i.status === "GTD") p += 6;
    else if (i.status === "PROBABLE") p += 1;
  }
  return Math.min(p, 22);
}

function marketVolatility(game: GamePrediction, side: EdgeSide): number {
  let v = 0;
  if (game.confidence === "low") v += 10;
  else if (game.confidence === "medium") v += 3;

  const p = getWinProbForSide(game, side);
  if (p >= 38 && p <= 58) v += 8;

  const sp = game.lines?.spreadNum;
  if (sp != null && Math.abs(sp) <= 1.5) v += 5;

  if (game.league === "boxing" && game.threeWay) {
    // Boxing draws are rare (4%) — large draw probability is a model anomaly
    if (game.threeWay.draw >= 15) v += 4;
  }

  if (game.soccer?.congestion) {
    const { homeLast7, awayLast7 } = game.soccer.congestion;
    const d = Math.abs(homeLast7 - awayLast7);
    if (d >= 2) v += 5;
  }

  const qv = game._meta?.quality?.volatility?.volatility_label;
  if (qv === "high") v += 14;
  else if (qv === "medium") v += 5;

  return v;
}

export function computePickFlags(game: GamePrediction, side: EdgeSide): EdgePickFlags {
  const inj = side === "home" ? game.injuries.home : game.injuries.away;
  const injuryUncertainty = inj.some((i) => i.status === "QUESTIONABLE" || i.status === "GTD");
  const pitcherUnconfirmed =
    game.league === "mlb" && game.mlb != null && game.mlb.pitcherCertainty !== "confirmed";
  const vol = marketVolatility(game, side);
  const highVolatility = vol >= 18;
  const drawHeavy = Boolean(game.threeWay && game.threeWay.draw >= 28);
  return { injuryUncertainty, pitcherUnconfirmed, highVolatility, drawHeavy };
}

/**
 * Internal ranking: win% + confidence stability + lineup certainty − injury noise − market volatility.
 */
export function computePickScore(game: GamePrediction, side: EdgeSide): number {
  const win = getWinProbForSide(game, side);
  const conf = confidenceStability(game.confidence, game.league);
  const lineup = lineupCertaintyBonus(game, side);
  const injPen = injuryVolatilityPenalty(game, side);
  const vol = marketVolatility(game, side);
  // Injury weight raised to 0.6 (injuries are underweighted at 0.45 — a star OUT materially shifts win%)
  // Volatility weight lowered slightly to 0.5 (market noise is less impactful than actual roster changes)
  const raw = win + conf + lineup - injPen * 0.6 - vol * 0.5;
  return Math.round(raw * 10) / 10;
}

export function buildCandidate(game: GamePrediction, side?: EdgeSide): EdgeCandidate {
  const s = side ?? getFavoredSide(game);
  return {
    game,
    side: s,
    pickScore: computePickScore(game, s),
    winProbability: getWinProbForSide(game, s),
    flags: computePickFlags(game, s),
  };
}

export function candidateToSlipItem(c: EdgeCandidate): TeamEdgeSlipItem {
  const { game, side } = c;
  const picked = side === "home" ? game.homeTeam : game.awayTeam;
  const opp = side === "home" ? game.awayTeam : game.homeTeam;
  const gid = game.id;
  return {
    kind: "team_pick",
    id: gid,
    gameId: gid,
    league: game.league,
    side,
    addedAt: new Date().toISOString(),
    snapshot: {
      homeAbbr: game.homeTeam.abbreviation,
      awayAbbr: game.awayTeam.abbreviation,
      pickedAbbr: picked.abbreviation,
      opponentAbbr: opp.abbreviation,
      winProb: c.winProbability,
      confidence: game.confidence,
      pickScore: c.pickScore,
      topReason: game.topReasons[0] ?? "",
      topRisk: game.riskFactors[0] ?? "",
      keyEdge: game.matchupEdges[0]?.description ?? game.keyMatchup,
      lastUpdated: game.lastUpdated,
      volatilityLabel: game._meta?.quality?.volatility?.volatility_label,
    },
  };
}

/** Same-game team + prop overlap and multi-prop clusters — 0 = independent, 100 = highly coupled. */
export function computeSlipCorrelationScore(items: EdgeSlipItem[]): { score: number; warnings: string[] } {
  let score = 0;
  const warnings: string[] = [];
  const teamItems = items.filter(isTeamSlipItem);
  const propItems = items.filter(isPlayerPropSlipItem);

  for (const t of teamItems) {
    for (const p of propItems) {
      if (p.gameId !== t.gameId) continue;
      if (p.snapshot.teamAbbr === t.snapshot.pickedAbbr) {
        score += 40;
        warnings.push(
          `Same-game stack: ${t.snapshot.pickedAbbr} side + ${p.snapshot.playerName} prop share outcome risk.`
        );
      } else {
        score += 14;
      }
    }
  }

  for (let a = 0; a < propItems.length; a++) {
    for (let b = a + 1; b < propItems.length; b++) {
      const p = propItems[a];
      const q = propItems[b];
      if (p.gameId !== q.gameId) continue;
      score += 20;
      if (p.playerId === q.playerId) {
        score += 35;
        warnings.push(`Multiple props on ${p.snapshot.playerName} — legs are tightly correlated.`);
      }
    }
  }

  return { score: Math.min(100, score), warnings: [...new Set(warnings)].slice(0, 4) };
}

function passesConfidence(game: GamePrediction, min: EdgeHubFilters["minConfidence"]): boolean {
  if (min === "any") return true;
  const order: ConfidenceLevel[] = ["low", "medium", "high"];
  return order.indexOf(game.confidence) >= order.indexOf(min);
}

function passesFilters(c: EdgeCandidate, f: EdgeHubFilters): boolean {
  const { game, side, flags } = c;
  if (f.leagues !== "all" && !f.leagues.includes(game.league)) return false;
  if (!passesConfidence(game, f.minConfidence)) return false;
  if (f.excludeQuestionableInjuries && flags.injuryUncertainty) return false;
  if (f.excludeUnconfirmedPitchers && flags.pitcherUnconfirmed) return false;
  if (f.excludeHighVolatility && flags.highVolatility) return false;
  return true;
}

export function rankCandidatesForHub(games: GamePrediction[], filters: EdgeHubFilters): EdgeCandidate[] {
  const out: EdgeCandidate[] = [];
  for (const g of games) {
    if (g.status !== "upcoming") continue;
    const c = buildCandidate(g);
    if (passesFilters(c, filters)) out.push(c);
  }
  return out.sort((a, b) => b.pickScore - a.pickScore);
}

const LEAGUE_ORDER: League[] = ["nba", "nfl", "mlb", "boxing"];

export function groupCandidatesByLeague(candidates: EdgeCandidate[]): Record<League, EdgeCandidate[]> {
  const acc: Record<League, EdgeCandidate[]> = {
    nba: [],
    nfl: [],
    mlb: [],
    boxing: [],
  };
  for (const c of candidates) {
    acc[c.game.league].push(c);
  }
  for (const l of LEAGUE_ORDER) {
    acc[l].sort((a, b) => b.pickScore - a.pickScore);
  }
  return acc;
}

/**
 * Auto-build with diversification: cap picks per league, then relax if under-filled.
 */
export function autoBuildEdgeSlip(candidates: EdgeCandidate[], size: EdgeCardSize): EdgeCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.pickScore - a.pickScore);
  const maxPerLeague = size <= 3 ? 3 : size >= 10 ? 3 : 2;
  const picked: EdgeCandidate[] = [];
  const leagueCount = new Map<League, number>();

  const tryAdd = (c: EdgeCandidate) => {
    if (picked.some((p) => p.game.id === c.game.id)) return false;
    const cnt = leagueCount.get(c.game.league) ?? 0;
    if (cnt >= maxPerLeague) return false;
    picked.push(c);
    leagueCount.set(c.game.league, cnt + 1);
    return true;
  };

  for (const c of sorted) {
    if (picked.length >= size) break;
    tryAdd(c);
  }

  if (picked.length < size) {
    for (const c of sorted) {
      if (picked.length >= size) break;
      if (picked.some((p) => p.game.id === c.game.id)) continue;
      picked.push(c);
    }
  }

  return picked.slice(0, size);
}

export function slipAggregateConfidence(items: { confidence: ConfidenceLevel }[]): ConfidenceLevel {
  if (!items.length) return "low";
  if (items.some((i) => i.confidence === "low")) return "low";
  if (items.some((i) => i.confidence === "medium")) return "medium";
  return "high";
}

/** Short warnings for the fixed Edge Card drawer (mixed team + player props). */
export function edgeSlipWarningLines(items: EdgeSlipItem[]): string[] {
  const lines: string[] = [];
  const { score: corrScore, warnings: corrWarn } = computeSlipCorrelationScore(items);
  if (corrScore >= 48) {
    lines.push(...corrWarn.slice(0, 2));
  }
  let lowConf = 0;
  let pitcherNote = 0;
  let injuryNote = 0;
  for (const i of items) {
    if (isDraftEdgeSlipItem(i)) {
      if (i.snapshot.confidence === "low") lowConf++;
      continue;
    }
    if (isPlayerPropSlipItem(i)) {
      if (i.snapshot.confidence === "low") lowConf++;
      continue;
    }
    const risk = (i.snapshot.topRisk ?? "").toLowerCase();
    const reason = (i.snapshot.topReason ?? "").toLowerCase();
    if (risk.includes("probable pitcher") || risk.includes("bullpen leverage")) pitcherNote++;
    if (risk.includes("injury") || reason.includes("injury") || risk.includes("questionable")) injuryNote++;
  }
  if (injuryNote > 0) {
    lines.push(`${injuryNote} pick${injuryNote > 1 ? "s have" : " has"} lineup uncertainty`);
  }
  if (pitcherNote > 0) {
    lines.push(
      `${pitcherNote} pick${pitcherNote > 1 ? "s depend" : " depends"} on probable pitcher confirmation`
    );
  }
  if (lowConf > 0) {
    lines.push(`${lowConf} pick${lowConf > 1 ? "s are" : " is"} low confidence`);
  }
  return lines;
}

export function slipRiskLabel(items: { flags: EdgePickFlags }[]): "elevated" | "moderate" | "controlled" {
  const anyPitch = items.some((i) => i.flags.pitcherUnconfirmed);
  const anyInj = items.some((i) => i.flags.injuryUncertainty);
  const anyVol = items.some((i) => i.flags.highVolatility || i.flags.drawHeavy);
  const n = [anyPitch, anyInj, anyVol].filter(Boolean).length;
  if (n >= 2) return "elevated";
  if (n === 1) return "moderate";
  return "controlled";
}

/** Next best candidate not already on the slip (excludeIds includes all occupied game IDs). */
export function suggestReplacement(candidates: EdgeCandidate[], excludeIds: Set<string>): EdgeCandidate | null {
  const sorted = [...candidates].sort((a, b) => b.pickScore - a.pickScore);
  for (const c of sorted) {
    if (excludeIds.has(c.game.id)) continue;
    return c;
  }
  return null;
}
