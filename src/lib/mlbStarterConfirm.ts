import type { GamePrediction } from "@/data/mockGames";

const STORAGE_KEY = "gamelens-mlb-starters-v1";

function readRaw(): Record<string, boolean> {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return {};
    const o = JSON.parse(s) as unknown;
    if (!o || typeof o !== "object") return {};
    return o as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function isMlbStartersUserConfirmed(gameId: string): boolean {
  return readRaw()[gameId] === true;
}

export function setMlbStartersUserConfirmed(gameId: string, confirmed: boolean): void {
  const next = readRaw();
  if (confirmed) next[gameId] = true;
  else delete next[gameId];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
}

/** Merge local "I verified starters" flags into `_meta` before running the MLB model. */
export function mergeMlbStarterConfirmations(games: GamePrediction[]): GamePrediction[] {
  const raw = readRaw();
  return games.map((g) => {
    if (g.league !== "mlb" || !g._meta) return g;
    if (!raw[g.id]) return g;
    return {
      ...g,
      _meta: { ...g._meta, userConfirmedMlbStarters: true },
    };
  });
}
