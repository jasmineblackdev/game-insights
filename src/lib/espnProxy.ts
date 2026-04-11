export type ScoreboardResource = { league: "nba" | "nfl" | "mlb" | "soccer"; slug?: string };

/** Map ESPN scoreboard base URL → proxy params (whitelist only). */
export function parseScoreboardResourceFromBaseUrl(baseUrl: string): ScoreboardResource | null {
  if (baseUrl.includes("/basketball/nba/scoreboard")) return { league: "nba" };
  if (baseUrl.includes("/football/nfl/scoreboard")) return { league: "nfl" };
  if (baseUrl.includes("/baseball/mlb/scoreboard")) return { league: "mlb" };
  const m = /\/sports\/soccer\/([a-z0-9._-]+)\/scoreboard/i.exec(baseUrl);
  if (m) return { league: "soccer", slug: m[1] };
  return null;
}

/**
 * When set, scoreboard JSON is fetched via Supabase Edge Function `espn-proxy` (short TTL cache server-side).
 * Set `VITE_ENABLE_ESPN_PROXY=1` and deploy the function, or set `VITE_ESPN_PROXY_URL` explicitly.
 */
export function resolveEspnProxyUrl(): string | null {
  const explicit = import.meta.env.VITE_ESPN_PROXY_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const enable =
    import.meta.env.VITE_ENABLE_ESPN_PROXY === "1" || import.meta.env.VITE_ENABLE_ESPN_PROXY === "true";
  const supabase = import.meta.env.VITE_SUPABASE_URL?.trim();
  if (enable && supabase) {
    return `${supabase.replace(/\/$/, "")}/functions/v1/espn-proxy`;
  }
  return null;
}
