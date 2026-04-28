/**
 * SharpModeContext — global toggle for the strict edge-only filter.
 * Persists to localStorage so the setting survives reloads. Lives at
 * the app shell level so any surface (Home, DailyPlan, AutoProfit,
 * card badges) can read the active state without prop drilling.
 *
 * Threshold overrides (edge / EV / sample-size minimums) are also
 * persisted here so power users can tune without touching code.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SharpThresholds } from "@/lib/learning/sharpMode";
import { SHARP_DEFAULTS } from "@/lib/learning/sharpMode";

const STORAGE_KEY = "gamelens-sharp-mode-v1";

interface PersistedState {
  enabled: boolean;
  thresholds: SharpThresholds;
}

function readPersisted(): PersistedState {
  const fallback: PersistedState = { enabled: false, thresholds: SHARP_DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      enabled: Boolean(parsed.enabled),
      thresholds: { ...SHARP_DEFAULTS, ...(parsed.thresholds ?? {}) },
    };
  } catch {
    return fallback;
  }
}

interface SharpModeContextValue {
  enabled: boolean;
  thresholds: SharpThresholds;
  setEnabled: (next: boolean) => void;
  setThresholds: (patch: Partial<SharpThresholds>) => void;
  reset: () => void;
}

const Ctx = createContext<SharpModeContextValue | null>(null);

export function SharpModeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PersistedState>(() => readPersisted());

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { /* localStorage full / private mode — ignore */ }
  }, [state]);

  const setEnabled = useCallback((next: boolean) => {
    setState((s) => ({ ...s, enabled: next }));
  }, []);

  const setThresholds = useCallback((patch: Partial<SharpThresholds>) => {
    setState((s) => ({ ...s, thresholds: { ...s.thresholds, ...patch } }));
  }, []);

  const reset = useCallback(() => {
    setState({ enabled: false, thresholds: SHARP_DEFAULTS });
  }, []);

  const value = useMemo<SharpModeContextValue>(() => ({
    enabled: state.enabled,
    thresholds: state.thresholds,
    setEnabled,
    setThresholds,
    reset,
  }), [state, setEnabled, setThresholds, reset]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSharpMode(): SharpModeContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSharpMode must be used inside <SharpModeProvider>");
  return v;
}
