const STORAGE_KEY = "gamelens-live-edge-notify-settings-v1";

export type LiveEdgeNotifyPickMode = "safe" | "aggressive";

export interface LiveEdgeNotificationSettings {
  masterEnabled: boolean;
  /** Only fire system notifications when the tab is in the background. */
  onlyWhenBackground: boolean;
  sports: {
    nba: boolean;
    nfl: boolean;
    mlb: boolean;
    soccer: boolean;
  };
  /** Safe: higher edge + high confidence. Aggressive: ≥3% edge + medium+ confidence. */
  pickMode: LiveEdgeNotifyPickMode;
  /** NBA: allow a second wave at halftime (value / rank updates). */
  nbaHalftimeUpdates: boolean;
  /** Reserved — no live prop pipeline wired yet; stored for future use. */
  playerPropAlerts: boolean;
}

export const defaultLiveEdgeNotificationSettings: LiveEdgeNotificationSettings = {
  masterEnabled: false,
  onlyWhenBackground: true,
  sports: { nba: true, nfl: true, mlb: true, soccer: true },
  pickMode: "aggressive",
  nbaHalftimeUpdates: true,
  playerPropAlerts: false,
};

export function loadLiveEdgeNotificationSettings(): LiveEdgeNotificationSettings {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return { ...defaultLiveEdgeNotificationSettings };
    const o = JSON.parse(s) as Partial<LiveEdgeNotificationSettings>;
    return {
      ...defaultLiveEdgeNotificationSettings,
      ...o,
      sports: { ...defaultLiveEdgeNotificationSettings.sports, ...o.sports },
    };
  } catch {
    return { ...defaultLiveEdgeNotificationSettings };
  }
}

export function saveLiveEdgeNotificationSettings(v: LiveEdgeNotificationSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* quota */
  }
}
