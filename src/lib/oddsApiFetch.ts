/**
 * Fetch The Odds API via (1) Vite dev proxy when `THE_ODDS_API_KEY` is set locally, (2) Edge `odds-api-proxy`,
 * or (3) legacy `VITE_THE_ODDS_API_KEY`. Dev proxy is tried first so local `.env.local` works without deploying Edge.
 */

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

function legacyViteKey(): string | null {
  const k = trim(import.meta.env.VITE_THE_ODDS_API_KEY as string | undefined);
  return k || null;
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
  return fetch(u.toString(), { headers: supabaseAnonHeaders(u.toString()) });
}

/** Path under /v4/, e.g. sports/?all=true or sports/basketball_nba/odds?regions=us&markets=h2h */
async function fetchViaDevProxy(pathUnderV4: string): Promise<Response | null> {
  if (!devProxyEnabled()) return null;
  const p = pathUnderV4.replace(/^\//, "");
  return fetch(`/__odds-api/${p}`, { headers: { Accept: "application/json" } });
}

async function fetchViaDirect(pathUnderV4: string): Promise<Response | null> {
  const key = legacyViteKey();
  if (!key) return null;
  const u = new URL(pathUnderV4.replace(/^\//, ""), "https://api.the-odds-api.com/v4/");
  u.searchParams.set("apiKey", key);
  return fetch(u.toString(), { headers: { Accept: "application/json" } });
}

/**
 * Odds API is usable if any path can reach the API: Edge (Supabase), dev proxy + server key, or legacy VITE key.
 */
export function isOddsApiAvailable(): boolean {
  return Boolean(resolveEdgeBase() || devProxyEnabled() || legacyViteKey());
}

/** GET /v4/sports/?all=true */
export async function fetchOddsSportsAll(): Promise<Response> {
  if (devProxyEnabled()) {
    const dev = await fetchViaDevProxy("sports/?all=true");
    if (dev) return dev;
  }
  const edge = await fetchViaEdge("sports", {});
  if (edge) return edge;
  const direct = await fetchViaDirect("sports/?all=true");
  if (direct) return direct;
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
}): Promise<Response> {
  const { sportKey, markets, regions = "us", oddsFormat = "american" } = params;
  const q = new URLSearchParams({ regions, markets, oddsFormat });
  const path = `sports/${encodeURIComponent(sportKey)}/odds?${q.toString()}`;

  if (devProxyEnabled()) {
    const dev = await fetchViaDevProxy(path);
    if (dev) return dev;
  }

  const edge = await fetchViaEdge("odds", { sportKey, markets, regions, oddsFormat });
  if (edge) return edge;

  const direct = await fetchViaDirect(path);
  if (direct) return direct;

  return new Response(JSON.stringify({ message: "odds_api_not_configured" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}
