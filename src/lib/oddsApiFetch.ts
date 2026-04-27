/**
 * Fetch The Odds API via either:
 *   1. Vite dev proxy (server-side THE_ODDS_API_KEY in vite.config) — local dev only
 *   2. Supabase Edge function `odds-api-proxy` (server-side key in env) — production
 *
 * The browser NEVER holds the Odds API key. The previous direct-from-browser
 * path (legacy VITE_THE_ODDS_API_KEY) was removed for security: any VITE_-prefixed
 * value gets bundled into the client JS, exposing the key to anyone who visits
 * the site. If the Edge function is unreachable in production we surface a 503,
 * which the StaleLinesBanner already handles.
 */

import { trackOddsResponse, isOddsSportLocked } from "@/lib/oddsApiHealth";
import { unwrapEdgeEnvelope as sharedUnwrap, logOddsApiCall } from "@/lib/oddsApiEnvelope";

function trim(s: string | undefined): string {
  return (s ?? "").trim();
}

function resolveEdgeBase(): string | null {
  const custom = trim(import.meta.env.VITE_ODDS_API_PROXY_URL as string | undefined);
  if (custom) return custom.replace(/\/$/, "");
  const url = trim(import.meta.env.VITE_SUPABASE_URL as string | undefined);
  const key = trim(import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);
  if (url && key) {
    return `${url.replace(/\/$/, "")}/functions/v1/odds-api-proxy`;
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

function supabaseAnonHeaders(targetUrl: string): Record<string, string> {
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

function devProxyEnabled(): boolean {
  return typeof __GAMELENS_ODDS_DEV_PROXY__ !== "undefined" && __GAMELENS_ODDS_DEV_PROXY__;
}

async function fetchViaEdge(
  route: "sports" | "odds",
  params: Record<string, string>
): Promise<Response | null> {
  const base = resolveEdgeBase();
  if (!base) return null;
  const u = new URL(base);
  u.searchParams.set("route", route);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  const res = await fetch(u.toString(), { headers: supabaseAnonHeaders(u.toString()) });
  // The Edge proxy wraps upstream 4xx in a 200 envelope to keep the
  // JS client from treating quota / unknown-sport responses as a
  // proxy-side failure. Unwrap so trackOddsResponse() sees the real
  // upstream status. Shared helper — same code path used by
  // multiOddsProvider.proxyGet.
  const { res: unwrapped, meta } = await sharedUnwrap(res);
  logOddsApiCall({
    path:      "oddsApiFetch.edge",
    sportKey:  params.sportKey,
    status:    unwrapped.status,
    unwrapped: meta.unwrapped,
    errorCode: meta.errorCode,
  });
  return unwrapped;
}

/** Path under /v4/, e.g. sports/?all=true or sports/basketball_nba/odds?regions=us&markets=h2h */
async function fetchViaDevProxy(pathUnderV4: string): Promise<Response | null> {
  if (!devProxyEnabled()) return null;
  const p = pathUnderV4.replace(/^\//, "");
  return fetch(`/__odds-api/${p}`, { headers: { Accept: "application/json" } });
}

/**
 * Odds API is usable when the Edge proxy can be reached (production)
 * or the Vite dev proxy is enabled (local dev). The browser never has
 * a usable key on its own.
 */
export function isOddsApiAvailable(): boolean {
  return Boolean(resolveEdgeBase() || devProxyEnabled());
}

/** GET /v4/sports/?all=true */
export async function fetchOddsSportsAll(): Promise<Response> {
  if (devProxyEnabled()) {
    const dev = await fetchViaDevProxy("sports/?all=true");
    if (dev) return dev;
  }
  const edge = await fetchViaEdge("sports", {});
  if (edge?.ok) return edge;
  return new Response(JSON.stringify({ message: "odds_api_not_configured" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

/** GET /v4/sports/{sportKey}/odds */
export async function fetchOddsForSport(params: {
  sportKey: string;
  markets: string;
  regions?: string;
  oddsFormat?: string;
  /** Comma-separated Odds API event ids — use for in-play refresh (same endpoint, filtered). */
  eventIds?: string;
}): Promise<Response> {
  const { sportKey, markets, regions = "us", oddsFormat = "american", eventIds } = params;

  // Per-sport TTL lockout — after a hard quota / freq-limit / network
  // error the sport is locked out for 5 minutes (see oddsApiHealth).
  // Skip the round-trip entirely so we don't burn the retry budget
  // on a guaranteed-fail.
  if (isOddsSportLocked(sportKey)) {
    return new Response(JSON.stringify({
      message: "odds_api_sport_locked",
      sportKey,
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const q = new URLSearchParams({ regions, markets, oddsFormat });
  if (eventIds?.trim()) q.set("eventIds", eventIds.trim());
  const path = `sports/${encodeURIComponent(sportKey)}/odds?${q.toString()}`;

  if (devProxyEnabled()) {
    const dev = await fetchViaDevProxy(path);
    if (dev) {
      void trackOddsResponse(dev, sportKey);
      return dev;
    }
  }

  const edgeParams: Record<string, string> = { sportKey, markets, regions, oddsFormat };
  if (eventIds?.trim()) edgeParams.eventIds = eventIds.trim();
  const edge = await fetchViaEdge("odds", edgeParams);
  if (edge) {
    void trackOddsResponse(edge, sportKey);
    return edge;
  }

  // No path worked — surface as a network failure so the banner shows.
  const fallback = new Response(JSON.stringify({ message: "odds_api_not_configured" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
  void trackOddsResponse(fallback, sportKey);
  return fallback;
}
