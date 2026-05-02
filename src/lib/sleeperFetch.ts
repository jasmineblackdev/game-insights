/**
 * Sleeper client fetchers — NFL roster + injury data via the
 * `sleeper-proxy` Edge function.
 *
 * Sleeper is keyless and CORS-friendly, so technically the browser
 * could hit api.sleeper.app directly. We proxy anyway for two reasons:
 *
 *   1. Bandwidth — /v1/players/nfl is ~5MB. The proxy exposes a
 *      /injuries/nfl route that walks the roster server-side and
 *      returns only the ~30-150 injured rows.
 *   2. Uniform pattern with the rest of the data layer (odds API,
 *      balldontlie). Same fail-soft contract, same wrapped-4xx
 *      envelope handling.
 *
 * Fail-soft: every helper returns null / [] on any error so callers
 * keep rendering with whatever data they already have.
 */

function trim(s: string | undefined): string {
  return (s ?? "").trim();
}

function resolveProxyBase(): string | null {
  const custom = trim(import.meta.env.VITE_SLEEPER_PROXY_URL as string | undefined);
  if (custom) return custom.replace(/\/$/, "");
  const url = trim(import.meta.env.VITE_SUPABASE_URL as string | undefined);
  const key = trim(import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);
  if (url && key) {
    return `${url.replace(/\/$/, "")}/functions/v1/sleeper-proxy`;
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

export function isSleeperAvailable(): boolean {
  return Boolean(resolveProxyBase());
}

interface ProxyEnvelope<T> {
  data?: T;
  proxied?: boolean;
  upstream_status?: number;
  body?: unknown;
}

async function sleeperGet<T = unknown>(path: string): Promise<T | null> {
  const base = resolveProxyBase();
  if (!base) return null;
  const u = new URL(base);
  u.searchParams.set("path", path);
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

/**
 * Single normalized injury row. Sleeper's `injury_status` values
 * include "Questionable", "Doubtful", "Out", "IR", "PUP",
 * "Suspended" — kept as raw strings so consumers can map to their
 * own severity scales without us baking in assumptions.
 */
export interface NflInjury {
  playerId:        string;
  fullName:        string;
  team:            string | null;
  position:        string | null;
  injuryStatus:    string;
  injuryBodyPart:  string | null;
  injuryNotes:     string | null;
  injuryStartDate: string | null;
}

interface InjuryEnvelope {
  fetched_at: string;
  count:      number;
  injuries:   Array<{
    player_id:         string;
    full_name:         string;
    team:              string | null;
    position:          string | null;
    injury_status:     string;
    injury_body_part:  string | null;
    injury_notes:      string | null;
    injury_start_date: string | null;
  }>;
}

/**
 * Active injuries across the NFL, server-filtered down from the
 * full roster. Ordered by player name. Empty array on any failure.
 */
export async function fetchNflInjuries(): Promise<NflInjury[]> {
  const env = await sleeperGet<InjuryEnvelope>("injuries/nfl");
  if (!env || !Array.isArray(env.injuries)) return [];
  return env.injuries.map((r) => ({
    playerId:        r.player_id,
    fullName:        r.full_name,
    team:            r.team,
    position:        r.position,
    injuryStatus:    r.injury_status,
    injuryBodyPart:  r.injury_body_part,
    injuryNotes:     r.injury_notes,
    injuryStartDate: r.injury_start_date,
  }));
}

/**
 * Current NFL season state (week, season type, etc). Useful for
 * deciding whether we're in regular season vs playoffs when sizing
 * injury impact. Null when the upstream call failed.
 */
export interface NflState {
  week:           number;
  season:         string;
  season_type:    string;
  league_season:  string;
  league_create_season: string;
  display_week:   number;
}

export async function fetchNflState(): Promise<NflState | null> {
  return sleeperGet<NflState>("state/nfl");
}

/**
 * Smoke test for diagnostics. Returns "ok" when the proxy round-
 * trips a valid season-state response, "no_proxy" when the URL
 * can't be resolved (Supabase env missing), and "upstream_failed"
 * otherwise. Used to surface a green/red dot in a future
 * diagnostics panel without the user reading network logs.
 */
export async function pingSleeper(): Promise<"ok" | "no_proxy" | "upstream_failed"> {
  if (!resolveProxyBase()) return "no_proxy";
  const state = await fetchNflState();
  return state && typeof state.week === "number" ? "ok" : "upstream_failed";
}

// ── User + league lookup ─────────────────────────────────────────────

export interface SleeperUser {
  /** Snowflake-style numeric id, returned as a string. Stable. */
  user_id:      string;
  username:     string;
  display_name: string;
  avatar:       string | null;
}

/**
 * Look up a Sleeper user by username OR by numeric user_id (the
 * upstream endpoint accepts both). Returns null when the username
 * doesn't exist or the proxy is unavailable. Username is forwarded
 * verbatim — Sleeper's allowed character set is alphanumeric +
 * underscore so the proxy regex covers the same range.
 */
export async function fetchSleeperUser(
  usernameOrId: string,
): Promise<SleeperUser | null> {
  const id = usernameOrId.trim();
  if (!id) return null;
  const raw = await sleeperGet<Partial<SleeperUser> | null>(`user/${encodeURIComponent(id)}`);
  if (!raw || !raw.user_id || !raw.username) return null;
  return {
    user_id:      raw.user_id,
    username:     raw.username,
    display_name: raw.display_name ?? raw.username,
    avatar:       raw.avatar ?? null,
  };
}

export type SleeperSport = "nfl" | "nba" | "mlb" | "soccer" | "lcs";

export interface SleeperLeague {
  league_id:        string;
  name:             string;
  season:           string;
  status:           string;       // "in_season" | "complete" | "drafting" | etc.
  sport:            string;
  total_rosters:    number;
  scoring_settings: Record<string, unknown> | null;
  settings:         Record<string, unknown> | null;
}

/**
 * Leagues the user belongs to for a given sport + season. Returns
 * an empty array if the user has none (free-agent account, or
 * off-season for that sport) or if the call fails.
 */
export async function fetchSleeperUserLeagues(
  userId: string,
  sport:  SleeperSport,
  season: number | string,
): Promise<SleeperLeague[]> {
  const id = userId.trim();
  if (!/^\d{1,32}$/.test(id)) return [];
  const seasonStr = String(season);
  if (!/^\d{4}$/.test(seasonStr)) return [];
  const raw = await sleeperGet<Partial<SleeperLeague>[] | null>(
    `user/${id}/leagues/${sport}/${seasonStr}`,
  );
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is Partial<SleeperLeague> & { league_id: string; name: string } =>
      Boolean(l && l.league_id && l.name))
    .map((l) => ({
      league_id:        l.league_id,
      name:             l.name,
      season:           l.season ?? seasonStr,
      status:           l.status ?? "unknown",
      sport:            l.sport ?? sport,
      total_rosters:    l.total_rosters ?? 0,
      scoring_settings: l.scoring_settings ?? null,
      settings:         l.settings ?? null,
    }));
}
