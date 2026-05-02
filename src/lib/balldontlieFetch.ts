/**
 * balldontlie client fetchers — NBA player / stats data routed
 * through the `balldontlie-proxy` Edge function. The browser never
 * holds the API key.
 *
 * Surface kept minimal on purpose: the goal of #168 phase 1 is the
 * data pipe, not consumer integration. Higher-level helpers (e.g.
 * "get this player's season averages and merge into our prop model")
 * land in later commits when we wire balldontlie into the
 * recommendation pipeline.
 *
 * Fail-soft contract: every helper returns null / [] on any error
 * (proxy unreachable, upstream 4xx envelope, parse failure) so
 * callers can keep rendering with whatever data they already have.
 *
 * Authentication: balldontlie revamped their pricing — every
 * endpoint now requires an Authorization header, including the
 * "free" tier (which is just rate-limited). Set
 * BALLDONTLIE_API_KEY in the Edge function env. Without it the
 * proxy reaches upstream but every call comes back as a wrapped
 * 401 envelope and the helpers return null.
 */

function trim(s: string | undefined): string {
  return (s ?? "").trim();
}

function resolveProxyBase(): string | null {
  const custom = trim(import.meta.env.VITE_BALLDONTLIE_PROXY_URL as string | undefined);
  if (custom) return custom.replace(/\/$/, "");
  const url = trim(import.meta.env.VITE_SUPABASE_URL as string | undefined);
  const key = trim(import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);
  if (url && key) {
    return `${url.replace(/\/$/, "")}/functions/v1/balldontlie-proxy`;
  }
  return null;
}

function shouldAttachSupabaseAnon(targetUrl: string): boolean {
  const sup = trim(import.meta.env.VITE_SUPABASE_URL as string | undefined);
  if (!sup) return false;
  try {
    return new URL(targetUrl).origin === new URL(sup).origin;
  } catch {
    return false;
  }
}

function authHeaders(targetUrl: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (shouldAttachSupabaseAnon(targetUrl)) {
    const key = trim(import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);
    if (key) {
      headers.Authorization = `Bearer ${key}`;
      headers.apikey = key;
    }
  }
  return headers;
}

export function isBalldontlieAvailable(): boolean {
  return Boolean(resolveProxyBase());
}

interface ProxyEnvelope<T> {
  data?: T;
  proxied?: boolean;
  upstream_status?: number;
  body?: unknown;
}

/**
 * Low-level GET against the proxy. Forwards every key in `params` to
 * the proxy, which forwards them to balldontlie verbatim. Returns the
 * upstream JSON when the request succeeds; null on any error. The
 * "wrapped 4xx" envelope is treated as failure here — callers don't
 * usually need to discriminate between a 404 and a network error.
 */
export async function balldontlieGet<T = unknown>(
  path: string,
  params: Record<string, string | number | string[]> = {},
): Promise<T | null> {
  const base = resolveProxyBase();
  if (!base) return null;
  const u = new URL(base);
  u.searchParams.set("path", path);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      // balldontlie expects array params as repeated keys
      // (e.g. player_ids[]=1&player_ids[]=2).
      const repeatedKey = k.endsWith("[]") ? k : `${k}[]`;
      for (const item of v) u.searchParams.append(repeatedKey, String(item));
    } else {
      u.searchParams.append(k, String(v));
    }
  }
  try {
    const res = await fetch(u.toString(), { headers: authHeaders(u.toString()) });
    if (!res.ok) return null;
    const json = (await res.json()) as ProxyEnvelope<T> | T;
    if (typeof json === "object" && json !== null && "proxied" in (json as object)) {
      // Wrapped 4xx — caller treats as miss.
      return null;
    }
    return json as T;
  } catch {
    return null;
  }
}

// ── Typed helpers ────────────────────────────────────────────────────

export interface BalldontliePlayer {
  id: number;
  first_name: string;
  last_name: string;
  position: string | null;
  height: string | null;
  weight: string | null;
  jersey_number: string | null;
  college: string | null;
  country: string | null;
  draft_year: number | null;
  draft_round: number | null;
  draft_number: number | null;
  team?: BalldontlieTeam;
}

export interface BalldontlieTeam {
  id: number;
  conference: string;
  division: string;
  city: string;
  name: string;
  full_name: string;
  abbreviation: string;
}

export interface BalldontlieSeasonAverages {
  games_played: number;
  player_id: number;
  season: number;
  min: string;
  fgm: number;
  fga: number;
  fg3m: number;
  fg3a: number;
  ftm: number;
  fta: number;
  oreb: number;
  dreb: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  turnover: number;
  pf: number;
  pts: number;
  fg_pct: number;
  fg3_pct: number;
  ft_pct: number;
}

interface PaginatedResponse<T> {
  data: T[];
  meta?: {
    next_cursor?: number | null;
    per_page?: number;
  };
}

/**
 * Search players by name. balldontlie's /players endpoint accepts
 * `search=` as a filter; we forward it so the proxy stays generic.
 * Returns up to 25 matches, ordered by relevance from upstream.
 */
export async function searchBalldontliePlayers(
  name: string,
): Promise<BalldontliePlayer[]> {
  if (!name.trim()) return [];
  const res = await balldontlieGet<PaginatedResponse<BalldontliePlayer>>(
    "players",
    { search: name.trim(), per_page: 25 },
  );
  return res?.data ?? [];
}

/**
 * Per-season averages for a given player. Free tier exposes the
 * current season; paid keys unlock historical seasons. Returns null
 * when the player has no recorded games for that season (rookies in
 * preseason, end-of-bench players, etc).
 */
export async function fetchBalldontlieSeasonAverages(
  playerId: number,
  season: number,
): Promise<BalldontlieSeasonAverages | null> {
  const res = await balldontlieGet<PaginatedResponse<BalldontlieSeasonAverages>>(
    "season_averages",
    { season, "player_ids[]": [String(playerId)] },
  );
  return res?.data?.[0] ?? null;
}

/**
 * Smoke test for Settings → Diagnostics. Returns "ok" when the proxy
 * is reachable and balldontlie answered, "no_proxy" when the Edge
 * function URL can't be resolved (Supabase env missing), and
 * "upstream_failed" when the round-trip didn't return a list. Used
 * to surface a green/red dot in the diagnostics panel without the
 * user having to read network logs.
 */
export async function pingBalldontlie(): Promise<"ok" | "no_proxy" | "upstream_failed"> {
  if (!resolveProxyBase()) return "no_proxy";
  const res = await balldontlieGet<PaginatedResponse<BalldontlieTeam>>("teams", {});
  if (res && Array.isArray(res.data)) return "ok";
  return "upstream_failed";
}
