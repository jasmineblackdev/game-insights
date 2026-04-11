import type { GamePrediction } from "@/data/mockGames";

function parseMsEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * ESPN scoreboard HTTP polling (SPA has no partner WebSocket). When any game in a feed is `live`,
 * refetch tightens toward this interval (foreground only if `refetchIntervalInBackground: false`).
 *
 * @see docs/DATA_STACK.md — true sub-10s play-by-play still needs server push / WebSockets.
 */
export const SCOREBOARD_POLL_MS_IDLE = parseMsEnv(
  import.meta.env.VITE_SCOREBOARD_POLL_MS_IDLE,
  120_000,
  30_000,
  600_000
);

export const SCOREBOARD_POLL_MS_LIVE = parseMsEnv(
  import.meta.env.VITE_SCOREBOARD_POLL_MS_LIVE,
  10_000,
  5_000,
  120_000
);

export function scoreboardRefetchIntervalMs(data: unknown): number {
  const games = data as GamePrediction[] | undefined;
  if (!Array.isArray(games) || games.length === 0) return SCOREBOARD_POLL_MS_IDLE;
  return games.some((g) => g.status === "live") ? SCOREBOARD_POLL_MS_LIVE : SCOREBOARD_POLL_MS_IDLE;
}
