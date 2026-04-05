import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { GamePrediction, League } from "@/data/mockGames";
import type { DraftEdgeCard } from "@/data/draftEdgeTypes";
import {
  type EdgeCardSize,
  type EdgeCandidate,
  type EdgeHistoryEntry,
  type EdgeSlipOutcome,
  type EdgeHubFilters,
  type EdgeSide,
  type EdgeSlipItem,
  type PlayerPropInput,
  type TeamEdgeSlipItem,
  autoBuildEdgeSlip,
  buildCandidate,
  candidateToSlipItem,
  defaultEdgeHubFilters,
  draftEdgeToSlipItem,
  isTeamSlipItem,
  normalizeSlipItem,
  playerPropToSlipItem,
  slipAggregateConfidence,
} from "@/lib/edgeCardScoring";

const STORAGE_SLIP = "gamelens-edge-slip-v1";
const STORAGE_HISTORY = "gamelens-edge-history-v1";

interface EdgeCardContextValue {
  cardSize: EdgeCardSize;
  setCardSize: (n: EdgeCardSize) => void;
  filters: EdgeHubFilters;
  setFilters: (f: EdgeHubFilters | ((p: EdgeHubFilters) => EdgeHubFilters)) => void;
  slip: EdgeSlipItem[];
  history: EdgeHistoryEntry[];
  addPick: (game: GamePrediction, side?: EdgeSide) => { ok: boolean; message?: string };
  addPlayerProp: (p: PlayerPropInput) => { ok: boolean; message?: string };
  addDraftEdge: (card: DraftEdgeCard) => { ok: boolean; message?: string };
  removePick: (itemId: string) => void;
  replacePick: (itemId: string, item: TeamEdgeSlipItem) => void;
  clearSlip: () => void;
  autoBuild: (candidates: EdgeCandidate[], size: EdgeCardSize) => void;
  saveSlipToHistory: () => void;
  setHistoryOutcome: (entryId: string, outcome: EdgeSlipOutcome | null) => void;
  isOnSlip: (gameId: string) => boolean;
  isPlayerPropOnSlip: (predictionId: string) => boolean;
  slipFull: boolean;
}

const EdgeCardContext = createContext<EdgeCardContextValue | null>(null);

function parseSlipItems(raw: unknown): EdgeSlipItem[] {
  if (!Array.isArray(raw)) return [];
  const out: EdgeSlipItem[] = [];
  for (const row of raw) {
    const n = normalizeSlipItem(row);
    if (n) out.push(n);
  }
  return out;
}

function loadSlip(): { cardSize: EdgeCardSize; items: EdgeSlipItem[] } {
  try {
    const raw = localStorage.getItem(STORAGE_SLIP);
    if (!raw) return { cardSize: 3, items: [] };
    const p = JSON.parse(raw) as { cardSize?: EdgeCardSize; items?: unknown[] };
    const size =
      p.cardSize === 4 || p.cardSize === 6 || p.cardSize === 10 ? p.cardSize : 3;
    return { cardSize: size, items: parseSlipItems(p.items) };
  } catch {
    return { cardSize: 3, items: [] };
  }
}

function loadHistory(): EdgeHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_HISTORY);
    if (!raw) return [];
    const p = JSON.parse(raw) as EdgeHistoryEntry[];
    if (!Array.isArray(p)) return [];
    return p.slice(0, 30).map((h) => {
      const raw = h as EdgeHistoryEntry & { outcome?: unknown };
      const o = raw.outcome;
      const outcome: EdgeSlipOutcome | undefined =
        o === "win" || o === "loss" || o === "push" ? o : undefined;
      return {
        ...raw,
        items: parseSlipItems(raw.items as unknown[]),
        outcome: outcome ?? null,
      };
    });
  } catch {
    return [];
  }
}

export function EdgeCardProvider({ children }: { children: ReactNode }) {
  const [{ cardSize, items: slip }, setSlipState] = useState(loadSlip);
  const [filters, setFiltersState] = useState<EdgeHubFilters>(defaultEdgeHubFilters);
  const [history, setHistory] = useState<EdgeHistoryEntry[]>(loadHistory);

  useEffect(() => {
    localStorage.setItem(STORAGE_SLIP, JSON.stringify({ cardSize, items: slip }));
  }, [cardSize, slip]);

  useEffect(() => {
    localStorage.setItem(STORAGE_HISTORY, JSON.stringify(history));
  }, [history]);

  const setCardSize = useCallback((n: EdgeCardSize) => {
    setSlipState((s) => ({ ...s, cardSize: n, items: s.items.slice(0, n) }));
  }, []);

  const setFilters = useCallback((f: EdgeHubFilters | ((p: EdgeHubFilters) => EdgeHubFilters)) => {
    setFiltersState((prev) => (typeof f === "function" ? f(prev) : f));
  }, []);

  const slipFull = slip.length >= cardSize;

  const addPick = useCallback(
    (game: GamePrediction, side?: EdgeSide): { ok: boolean; message?: string } => {
      if (slip.some((x) => isTeamSlipItem(x) && x.gameId === game.id)) {
        return { ok: false, message: "Already on your Edge Card" };
      }
      if (slip.length >= cardSize) {
        return { ok: false, message: `Edge Card ${cardSize} is full` };
      }
      const c = buildCandidate(game, side);
      const item = candidateToSlipItem(c);
      setSlipState((s) => ({ ...s, items: [...s.items, item] }));
      return { ok: true };
    },
    [slip, cardSize]
  );

  const addDraftEdge = useCallback(
    (card: DraftEdgeCard): { ok: boolean; message?: string } => {
      if (slip.some((x) => x.kind === "draft_edge" && x.id === card.id)) {
        return { ok: false, message: "This Draft Edge card is already on your Edge Card" };
      }
      if (slip.length >= cardSize) {
        return { ok: false, message: `Edge Card ${cardSize} is full` };
      }
      const item = draftEdgeToSlipItem(card);
      setSlipState((s) => ({ ...s, items: [...s.items, item] }));
      return { ok: true };
    },
    [slip, cardSize]
  );

  const addPlayerProp = useCallback(
    (p: PlayerPropInput): { ok: boolean; message?: string } => {
      if (slip.some((x) => x.kind === "player_prop" && x.id === p.id)) {
        return { ok: false, message: "This player prop is already on your Edge Card" };
      }
      const dup = slip.some(
        (x) =>
          x.kind === "player_prop" &&
          x.playerId === p.player_id &&
          x.gameId === p.game_id &&
          x.statType === p.stat_type
      );
      if (dup) {
        return { ok: false, message: "You already have this player & stat for this game" };
      }
      if (slip.length >= cardSize) {
        return { ok: false, message: `Edge Card ${cardSize} is full` };
      }
      const item = playerPropToSlipItem(p);
      setSlipState((s) => ({ ...s, items: [...s.items, item] }));
      return { ok: true };
    },
    [slip, cardSize]
  );

  const removePick = useCallback((itemId: string) => {
    setSlipState((s) => ({ ...s, items: s.items.filter((x) => x.id !== itemId) }));
  }, []);

  const replacePick = useCallback((itemId: string, item: TeamEdgeSlipItem) => {
    setSlipState((s) => ({
      ...s,
      items: s.items.map((x) => (x.id === itemId ? item : x)),
    }));
  }, []);

  const clearSlip = useCallback(() => {
    setSlipState((s) => ({ ...s, items: [] }));
  }, []);

  const autoBuild = useCallback((candidates: EdgeCandidate[], size: EdgeCardSize) => {
    const picked = autoBuildEdgeSlip(candidates, size);
    setSlipState((s) => ({
      ...s,
      cardSize: size,
      items: picked.map(candidateToSlipItem),
    }));
  }, []);

  const saveSlipToHistory = useCallback(() => {
    if (!slip.length) return;
    const aggregateConfidence = slipAggregateConfidence(
      slip.map((i) => ({ confidence: i.snapshot.confidence }))
    );
    let riskLabel: EdgeHistoryEntry["riskLabel"] = "controlled";
    if (slip.some((i) => i.snapshot.confidence === "low")) riskLabel = "elevated";
    else if (slip.some((i) => i.snapshot.confidence === "medium")) riskLabel = "moderate";
    const entry: EdgeHistoryEntry = {
      id: `hist-${Date.now()}`,
      savedAt: new Date().toISOString(),
      size: cardSize,
      items: slip,
      aggregateConfidence,
      riskLabel,
    };
    setHistory((h) => [entry, ...h].slice(0, 30));
  }, [slip, cardSize]);

  const setHistoryOutcome = useCallback((entryId: string, outcome: EdgeSlipOutcome | null) => {
    setHistory((h) =>
      h.map((e) => {
        if (e.id !== entryId) return e;
        if (outcome === null) {
          const next = { ...e };
          delete next.outcome;
          return next;
        }
        return { ...e, outcome };
      })
    );
  }, []);

  const isOnSlip = useCallback(
    (gameId: string) => slip.some((x) => isTeamSlipItem(x) && x.gameId === gameId),
    [slip]
  );

  const isPlayerPropOnSlip = useCallback(
    (predictionId: string) => slip.some((x) => x.kind === "player_prop" && x.id === predictionId),
    [slip]
  );

  const value = useMemo(
    () => ({
      cardSize,
      setCardSize,
      filters,
      setFilters,
      slip,
      history,
      addPick,
      addPlayerProp,
      addDraftEdge,
      removePick,
      replacePick,
      clearSlip,
      autoBuild,
      saveSlipToHistory,
      setHistoryOutcome,
      isOnSlip,
      isPlayerPropOnSlip,
      slipFull,
    }),
    [
      cardSize,
      setCardSize,
      filters,
      setFilters,
      slip,
      history,
      addPick,
      addPlayerProp,
      addDraftEdge,
      removePick,
      replacePick,
      clearSlip,
      autoBuild,
      saveSlipToHistory,
      setHistoryOutcome,
      isOnSlip,
      isPlayerPropOnSlip,
      slipFull,
    ]
  );

  return <EdgeCardContext.Provider value={value}>{children}</EdgeCardContext.Provider>;
}

export function useEdgeCard(): EdgeCardContextValue {
  const ctx = useContext(EdgeCardContext);
  if (!ctx) throw new Error("useEdgeCard must be used within EdgeCardProvider");
  return ctx;
}

export function useEdgeCardOptional(): EdgeCardContextValue | null {
  return useContext(EdgeCardContext);
}
