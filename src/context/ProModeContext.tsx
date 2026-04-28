/**
 * ProModeContext — top-level toggle for the disciplined daily-decision
 * pipeline. When enabled, the pipeline:
 *   1. Forces Sharp Mode on (dependency)
 *   2. Reads candidates from the parlay-builder pool
 *   3. Applies Sport Priority filter (drops avoid-tier sports)
 *   4. Applies Sharp filter (edge / EV / sample / volatility / etc)
 *   5. Checks bankroll discipline (stop-loss / profit-lock)
 *   6. Applies Scaling Ladder cap to suggested stake
 *   7. Emits ONE Pro Bet to the queue (max 1 per day)
 *
 * Persistence: localStorage. Same pattern as Sharp Mode.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const STORAGE_KEY = "gamelens-pro-mode-v1";

interface PersistedState {
  enabled: boolean;
}

function readPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { enabled: false };
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return { enabled: Boolean(parsed.enabled) };
  } catch {
    return { enabled: false };
  }
}

interface ProModeContextValue {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
}

const Ctx = createContext<ProModeContextValue | null>(null);

export function ProModeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PersistedState>(() => readPersisted());

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { /* private mode — ignore */ }
  }, [state]);

  const setEnabled = useCallback((next: boolean) => {
    setState({ enabled: next });
  }, []);

  const value = useMemo<ProModeContextValue>(() => ({
    enabled: state.enabled,
    setEnabled,
  }), [state.enabled, setEnabled]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProMode(): ProModeContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProMode must be used inside <ProModeProvider>");
  return v;
}
