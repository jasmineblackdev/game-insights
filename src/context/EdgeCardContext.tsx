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
import {
  type EdgeCardSize,
  type EdgeCandidate,
  type EdgeHistoryEntry,
  type EdgeHubFilters,
  type EdgeSide,
  type EdgeSlipItem,
  autoBuildEdgeSlip,
  buildCandidate,
  candidateToSlipItem,
  defaultEdgeHubFilters,
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
  removePick: (gameId: string) => void;
  replacePick: (gameId: string, item: EdgeSlipItem) => void;
  clearSlip: () => void;
  autoBuild: (candidates: EdgeCandidate[], size: EdgeCardSize) => void;
  saveSlipToHistory: () => void;
  isOnSlip: (gameId: string) => boolean;
  slipFull: boolean;
}

const EdgeCardContext = createContext<EdgeCardContextValue | null>(null);

function loadSlip(): { cardSize: EdgeCardSize; items: EdgeSlipItem[] } {
  try {
    const raw = localStorage.getItem(STORAGE_SLIP);
    if (!raw) return { cardSize: 3, items: [] };
    const p = JSON.parse(raw) as { cardSize?: EdgeCardSize; items?: EdgeSlipItem[] };
    const size =
      p.cardSize === 4 || p.cardSize === 6 || p.cardSize === 10 ? p.cardSize : 3;
    return { cardSize: size, items: Array.isArray(p.items) ? p.items : [] };
  } catch {
    return { cardSize: 3, items: [] };
  }
}

function loadHistory(): EdgeHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_HISTORY);
    if (!raw) return [];
    const p = JSON.parse(raw) as EdgeHistoryEntry[];
    return Array.isArray(p) ? p.slice(0, 30) : [];
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
      if (slip.some((x) => x.gameId === game.id)) {
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

  const removePick = useCallback((gameId: string) => {
    setSlipState((s) => ({ ...s, items: s.items.filter((x) => x.gameId !== gameId) }));
  }, []);

  const replacePick = useCallback((gameId: string, item: EdgeSlipItem) => {
    setSlipState((s) => ({
      ...s,
      items: s.items.map((x) => (x.gameId === gameId ? item : x)),
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
    const aggregateConfidence = slipAggregateConfidence(slip.map((i) => ({ confidence: i.snapshot.confidence })));
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

  const isOnSlip = useCallback((gameId: string) => slip.some((x) => x.gameId === gameId), [slip]);

  const value = useMemo(
    () => ({
      cardSize,
      setCardSize,
      filters,
      setFilters,
      slip,
      history,
      addPick,
      removePick,
      replacePick,
      clearSlip,
      autoBuild,
      saveSlipToHistory,
      isOnSlip,
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
      removePick,
      replacePick,
      clearSlip,
      autoBuild,
      saveSlipToHistory,
      isOnSlip,
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
