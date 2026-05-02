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
