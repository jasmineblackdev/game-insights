import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  defaultLiveEdgeNotificationSettings,
  loadLiveEdgeNotificationSettings,
  saveLiveEdgeNotificationSettings,
  type LiveEdgeNotificationSettings,
} from "@/lib/liveEdgeNotificationSettings";

type Ctx = {
  settings: LiveEdgeNotificationSettings;
  setSettings: (next: LiveEdgeNotificationSettings) => void;
};

const LiveEdgeNotificationContext = createContext<Ctx | null>(null);

export function LiveEdgeNotificationProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<LiveEdgeNotificationSettings>(() =>
    loadLiveEdgeNotificationSettings()
  );

  const setSettings = useCallback((next: LiveEdgeNotificationSettings) => {
    saveLiveEdgeNotificationSettings(next);
    setSettingsState(next);
  }, []);

  const v = useMemo(() => ({ settings, setSettings }), [settings, setSettings]);

  return <LiveEdgeNotificationContext.Provider value={v}>{children}</LiveEdgeNotificationContext.Provider>;
}

export function useLiveEdgeNotificationSettings(): Ctx {
  const c = useContext(LiveEdgeNotificationContext);
  if (!c) {
    return {
      settings: defaultLiveEdgeNotificationSettings,
      setSettings: () => {},
    };
  }
  return c;
}
