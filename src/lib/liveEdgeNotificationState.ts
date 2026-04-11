const STORAGE_KEY = "gamelens-live-edge-notify-state-v1";

export type LiveNotifyEventType =
  | "top_pick"
  | "value_improved"
  | "lineup_pitcher"
  | "parlay_ready";

export interface PerGameNotifyState {
  sentCount: number;
  lastCheckpointId: string;
  lastLiveEdge: number;
  lastMlbSig: string;
  /** event type -> last unix ms (cooldown) */
  typeCooldownAt: Partial<Record<LiveNotifyEventType, number>>;
}

export interface LiveEdgeNotifyPersistedState {
  byGame: Record<string, PerGameNotifyState>;
  lastParlayGlobalAt: number;
}

const empty: LiveEdgeNotifyPersistedState = { byGame: {}, lastParlayGlobalAt: 0 };

export function loadNotifyState(): LiveEdgeNotifyPersistedState {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return { ...empty, byGame: {} };
    const o = JSON.parse(s) as LiveEdgeNotifyPersistedState;
    return {
      lastParlayGlobalAt: typeof o.lastParlayGlobalAt === "number" ? o.lastParlayGlobalAt : 0,
      byGame: o.byGame && typeof o.byGame === "object" ? o.byGame : {},
    };
  } catch {
    return { ...empty, byGame: {} };
  }
}

export function saveNotifyState(state: LiveEdgeNotifyPersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota */
  }
}

export function getOrCreateGameState(
  state: LiveEdgeNotifyPersistedState,
  gameId: string
): PerGameNotifyState {
  const cur = state.byGame[gameId];
  if (cur) return cur;
  return {
    sentCount: 0,
    lastCheckpointId: "",
    lastLiveEdge: -1,
    lastMlbSig: "",
    typeCooldownAt: {},
  };
}
