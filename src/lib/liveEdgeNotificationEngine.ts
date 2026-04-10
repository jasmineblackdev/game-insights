/**
 * Decides which live-edge notifications to fire — pure, testable rules.
 */
import type { GamePrediction, LiveBettingStageRow } from "@/data/mockGames";
import type { LiveEdgeNotificationSettings } from "@/lib/liveEdgeNotificationSettings";
import type {
  LiveEdgeNotifyPersistedState,
  LiveNotifyEventType,
  PerGameNotifyState,
} from "@/lib/liveEdgeNotificationState";
import {
  buildLivePickOverlays,
  isLivePickDataFresh,
  passesMainScreenLivePickGate,
  selectLiveCheckpointRow,
} from "@/lib/livePickRanking";
import { defaultMinEdgeForRecommend } from "@/lib/sportEdgeThresholds";

const MAX_PER_GAME = 3;
const TYPE_COOLDOWN_MS = 4 * 60 * 1000;
const PARLAY_GLOBAL_COOLDOWN_MS = 22 * 60 * 1000;
const MIN_VALUE_IMPROVE = 0.02;
const STRONG_PICKS_FOR_PARLAY = 4;

function volatilityNumeric(game: GamePrediction): number {
  const q = game._meta?.quality?.volatility?.volatility_score;
  if (typeof q === "number" && Number.isFinite(q)) return Math.min(100, Math.max(0, q));
  const lab = game._meta?.quality?.volatility?.volatility_label;
  if (lab === "high") return 72;
  if (lab === "medium") return 48;
  return 28;
}

function confirmation01(game: GamePrediction): number {
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

function minEdge(settings: LiveEdgeNotificationSettings): number {
  return settings.pickMode === "safe" ? 0.04 : 0.03;
}

function confidenceOk(settings: LiveEdgeNotificationSettings, game: GamePrediction): boolean {
  if (settings.pickMode === "safe") return game.confidence === "high";
  return game.confidence === "medium" || game.confidence === "high";
}

function volatilityOk(game: GamePrediction): boolean {
  const v = volatilityNumeric(game);
  const lab = game._meta?.quality?.volatility?.volatility_label;
  if (lab === "high") return false;
  return v < 66;
}

function confirmationOk(game: GamePrediction): boolean {
  return confirmation01(game) >= 0.45;
}

function mlbSig(game: GamePrediction): string {
  return [
    game.mlb?.pitcherCertainty ?? "",
    game.mlb?.lineupConfirmed ? "1" : "0",
    game._meta?.userConfirmedMlbStarters ? "1" : "0",
  ].join("|");
}

function checkpointRowForNotify(
  game: GamePrediction,
  settings: LiveEdgeNotificationSettings
): LiveBettingStageRow | null {
  if (game.league === "nfl") {
    return selectLiveCheckpointRow(game, { nflExcludeHalftime: true });
  }
  if (game.league === "nba" && !settings.nbaHalftimeUpdates) {
    return selectLiveCheckpointRow(game, { nbaIncludeHalftime: false });
  }
  return selectLiveCheckpointRow(game);
}

function baseActionable(
  game: GamePrediction,
  row: LiveBettingStageRow,
  settings: LiveEdgeNotificationSettings
): boolean {
  if (row.recommendedAction === "Value Gone" || row.recommendedAction === "Pass") return false;
  if (row.edge < effectiveMinEdge(game, settings)) return false;
  if (!confidenceOk(settings, game)) return false;
  if (!volatilityOk(game)) return false;
  if (!confirmationOk(game)) return false;
  return true;
}

function typeCooldownOk(gs: PerGameNotifyState, type: LiveNotifyEventType, now: number): boolean {
  const t = gs.typeCooldownAt[type];
  if (t == null) return true;
  return now - t >= TYPE_COOLDOWN_MS;
}

function cloneGs(gs: PerGameNotifyState): PerGameNotifyState {
  return {
    ...gs,
    typeCooldownAt: { ...gs.typeCooldownAt },
  };
}

function leagueLiveGames(games: GamePrediction[], league: GamePrediction["league"]): GamePrediction[] {
  return games.filter((g) => g.league === league && g.status === "live");
}

function rankInLeague(game: GamePrediction, leagueGames: GamePrediction[]): number | null {
  const overlays = buildLivePickOverlays(leagueGames);
  const o = overlays.get(game.id);
  if (o?.kind !== "ranked") return null;
  return o.rank;
}

export type LiveEdgeNotificationPayload = {
  type: LiveNotifyEventType;
  gameId: string;
  title: string;
  body: string;
  /** Path + query — SW prepends origin. */
  url: string;
  tag: string;
};

function getGs(map: Record<string, PerGameNotifyState>, id: string): PerGameNotifyState {
  const cur = map[id];
  if (cur) return cloneGs(cur);
  return {
    sentCount: 0,
    lastCheckpointId: "",
    lastLiveEdge: -1,
    lastMlbSig: "",
    typeCooldownAt: {},
  };
}

export function computeLiveEdgeNotifications(
  games: GamePrediction[],
  settings: LiveEdgeNotificationSettings,
  state: LiveEdgeNotifyPersistedState,
  now: number
): { payloads: LiveEdgeNotificationPayload[]; nextState: LiveEdgeNotifyPersistedState } {
  if (!settings.masterEnabled) {
    return { payloads: [], nextState: state };
  }

  const payloads: LiveEdgeNotificationPayload[] = [];
  const byGame: Record<string, PerGameNotifyState> = { ...state.byGame };
  let lastParlayGlobalAt = state.lastParlayGlobalAt;

  const enabled = (league: GamePrediction["league"]) => settings.sports[league];

  const liveCandidates = games.filter(
    (g) =>
      g.status === "live" &&
      enabled(g.league) &&
      isLivePickDataFresh(g) &&
      passesMainScreenLivePickGate(g)
  );

  const strongForParlay: GamePrediction[] = [];

  for (const game of liveCandidates) {
    const row = checkpointRowForNotify(game, settings);
    if (!row) continue;

    let gs = getGs(byGame, game.id);

    if (baseActionable(game, row, settings)) {
      strongForParlay.push(game);
    }

    if (gs.sentCount >= MAX_PER_GAME) {
      if (game.league === "mlb") gs.lastMlbSig = mlbSig(game);
      byGame[game.id] = gs;
      continue;
    }

    if (!baseActionable(game, row, settings)) {
      if (game.league === "mlb") gs.lastMlbSig = mlbSig(game);
      byGame[game.id] = gs;
      continue;
    }

    const edge = row.edge;
    const edgePct = `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(0)}%`;
    const short = `${game.awayTeam.abbreviation} @ ${game.homeTeam.abbreviation}`;
    let sentThisGame = false;

    // Priority 3: MLB lineup / pitcher confirmation
    if (game.league === "mlb" && typeCooldownOk(gs, "lineup_pitcher", now)) {
      const sig = mlbSig(game);
      const prevSig = gs.lastMlbSig;
      const improved =
        prevSig !== "" &&
        sig !== prevSig &&
        (game.mlb?.pitcherCertainty === "confirmed" || game.mlb?.lineupConfirmed === true);
      if (improved) {
        payloads.push({
          type: "lineup_pitcher",
          gameId: game.id,
          title: "GameLens · Pitcher / lineup update",
          body: `${short} — confirmed, edge ${edgePct}`,
          url: `/?game=${encodeURIComponent(game.id)}&livePicks=1`,
          tag: `${game.id}-lineup_pitcher`,
        });
        gs.typeCooldownAt = { ...gs.typeCooldownAt, lineup_pitcher: now };
        gs.sentCount += 1;
        sentThisGame = true;
      }
      gs.lastMlbSig = sig;
    } else if (game.league === "mlb") {
      gs.lastMlbSig = mlbSig(game);
    }

    // Priority 2: Value improved vs frozen pregame
    if (
      !sentThisGame &&
      typeCooldownOk(gs, "value_improved", now) &&
      game._meta?.liveBetting?.pregame
    ) {
      const pre = game._meta.liveBetting.pregame;
      const bump = edge - pre.edge;
      if (bump >= MIN_VALUE_IMPROVE && edge >= effectiveMinEdge(game, settings)) {
        payloads.push({
          type: "value_improved",
          gameId: game.id,
          title: "GameLens · Value improved",
          body: `${short} — edge ${(pre.edge * 100).toFixed(0)}% → ${(edge * 100).toFixed(0)}% live`,
          url: `/?game=${encodeURIComponent(game.id)}&livePicks=1`,
          tag: `${game.id}-value_improved`,
        });
        gs.typeCooldownAt = { ...gs.typeCooldownAt, value_improved: now };
        gs.sentCount += 1;
        sentThisGame = true;
      }
    }

    // Priority 1: Top pick (league rank 1)
    if (!sentThisGame && typeCooldownOk(gs, "top_pick", now)) {
      const leagueSlice = leagueLiveGames(games, game.league);
      const r = rankInLeague(game, leagueSlice);
      if (r === 1) {
        const cpLabel =
          row.stageId === "halftime" || row.stageId === "soccer_halftime"
            ? "halftime"
            : row.stageId === "after_inning_5"
              ? "F5"
              : "Q1";
        payloads.push({
          type: "top_pick",
          gameId: game.id,
          title: "GameLens · Top pick ready",
          body: `Pick 1 ready after ${cpLabel} · ${short} · Live edge ${edgePct}`,
          url: "/?livePicks=1",
          tag: `${game.id}-top_pick`,
        });
        gs.typeCooldownAt = { ...gs.typeCooldownAt, top_pick: now };
        gs.sentCount += 1;
        sentThisGame = true;
      }
    }

    gs.lastCheckpointId = row.stageId;
    gs.lastLiveEdge = Math.max(gs.lastLiveEdge, edge);
    byGame[game.id] = gs;
  }

  if (
    strongForParlay.length >= STRONG_PICKS_FOR_PARLAY &&
    now - lastParlayGlobalAt >= PARLAY_GLOBAL_COOLDOWN_MS
  ) {
    payloads.push({
      type: "parlay_ready",
      gameId: "parlay",
      title: "GameLens · Parlay window",
      body: `${strongForParlay.length} strong live picks available — open Edge Card`,
      url: "/edge",
      tag: "gamelens-parlay-ready",
    });
    lastParlayGlobalAt = now;
  }

  return {
    payloads,
    nextState: { byGame, lastParlayGlobalAt },
  };
}
