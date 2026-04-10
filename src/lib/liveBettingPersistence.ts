import type { BettingIntelligenceMeta, GamePrediction, LiveBettingIntelMeta } from "@/data/mockGames";

const STORAGE_KEY = "gamelens-pregame-bet-v1";
const LEARNING_KEY = "gamelens-live-bet-learning-v1";
const LEARNING_CAP = 80;

export interface PregameBetPersisted {
  winProbability: { home: number; away: number };
  bettingIntel: BettingIntelligenceMeta;
  capturedAt: string;
}

type StoreShape = Record<string, PregameBetPersisted>;

function readAll(): StoreShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoreShape;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function loadPregameSnapshot(gameId: string): PregameBetPersisted | null {
  const row = readAll()[gameId];
  if (!row?.bettingIntel || !row.winProbability) return null;
  return row;
}

/** While the fixture is still upcoming, refresh the frozen opening snapshot for learning + live edge compare. */
export function persistPregameSnapshot(game: GamePrediction, intel: BettingIntelligenceMeta): void {
  if (game.status !== "upcoming") return;
  try {
    const all = readAll();
    all[game.id] = {
      winProbability: { home: game.winProbability.home, away: game.winProbability.away },
      bettingIntel: intel,
      capturedAt: game.lastUpdated,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota / private mode */
  }
}

export interface LiveBettingLearningRecord {
  gameId: string;
  league: GamePrediction["league"];
  easternYmd?: string;
  capturedAt: string;
  liveBetting: LiveBettingIntelMeta;
}

function readLearning(): LiveBettingLearningRecord[] {
  try {
    const raw = localStorage.getItem(LEARNING_KEY);
    if (!raw) return [];
    const a = JSON.parse(raw) as LiveBettingLearningRecord[];
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** One compact row per finished fixture for offline analytics / future export. */
export function maybeRecordFinalLiveBettingLearning(
  game: GamePrediction,
  liveBetting: LiveBettingIntelMeta
): void {
  if (game.status !== "final") return;
  try {
    const prev = readLearning();
    if (prev.some((r) => r.gameId === game.id)) return;
    const row: LiveBettingLearningRecord = {
      gameId: game.id,
      league: game.league,
      easternYmd: game._meta?.easternYmd,
      capturedAt: game.lastUpdated,
      liveBetting,
    };
    const next = [row, ...prev].slice(0, LEARNING_CAP);
    localStorage.setItem(LEARNING_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
}
