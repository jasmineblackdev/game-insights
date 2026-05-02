/**
 * balldontlie proxy — server-side wrapper around api.balldontlie.io
 * for NBA player / stats data.
 *
 * Why a proxy:
 *   1. Keeps BALLDONTLIE_API_KEY server-side. Anything VITE_-prefixed
 *      gets bundled into the client JS, which would expose the key
 *      to anyone who visits the site.
 *   2. Provides a single CORS surface so the browser doesn't get
 *      blocked by upstream policy on free-tier endpoints.
 *   3. Centralizes the "wrap upstream 4xx in 200 envelope" pattern
 *      we already use for the odds API, so the JS client doesn't
 *      log RUNTIME_ERROR for normal quota / not-found responses.
 *
 * Routes (passed as `?path=...`):
 *   players/search           — &name=Aaron Judge → player matches
 *   players/{id}             — single player lookup
 *   players/{id}/season_averages?season=2025 — season averages
 *   teams                    — list teams
 *   stats                    — &player_ids[]=... → game-by-game stats
 *
 * Auth: balldontlie revamped pricing — every endpoint now requires
 * an Authorization header, including the free tier (which is just
 * rate-limited, no longer keyless). Set BALLDONTLIE_API_KEY in the
 * Edge function env. Without it the proxy reaches upstream but
 * every call comes back as 401 (wrapped 200 envelope).
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BALLDONTLIE_UPSTREAM = "https://api.balldontlie.io/v1";

// Paths the client is allowed to hit. Whitelisted so a misuse of the
// proxy can't be turned into a SSRF tool against arbitrary URLs.
const ALLOWED_PATH_PREFIXES = [
  "players",
  "teams",
  "games",
  "stats",
  "season_averages",
] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isAllowedPath(path: string): boolean {
  // Strip leading slash and split on /. The first segment must be in
  // the allow-list. balldontlie has no nested arbitrary paths beyond
  // the few we whitelist above.
  const head = path.replace(/^\/+/, "").split(/[/?]/, 1)[0] ?? "";
  return ALLOWED_PATH_PREFIXES.includes(head as typeof ALLOWED_PATH_PREFIXES[number]);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return json({ error: "invalid_url" }, 400);
  }

  // The client passes the upstream path via ?path=... and any query
  // string they want forwarded as additional query params on the
  // proxy URL. We carry every non-`path` param through verbatim.
  const path = url.searchParams.get("path");
  if (!path) return json({ error: "missing_path" }, 400);
  if (!isAllowedPath(path)) {
    return json({ error: "path_not_allowed", path }, 400);
  }

  // Build the upstream URL: /v1/{path}?{forwarded_params}
  const target = new URL(`${BALLDONTLIE_UPSTREAM}/${path.replace(/^\/+/, "")}`);
  for (const [k, v] of url.searchParams.entries()) {
    if (k === "path") continue;
    target.searchParams.append(k, v);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  // Authorization is optional — free tier endpoints work without
  // a key. The server-side env var is the authoritative source so
  // the client never needs to know the key exists.
  const apiKey = Deno.env.get("BALLDONTLIE_API_KEY")?.trim();
  if (apiKey) headers.Authorization = apiKey;

  try {
    const r = await fetch(target.toString(), { headers });
    const text = await r.text();

    // 2xx — pass body through.
    if (r.ok) {
      return new Response(text, {
        status: r.status,
        headers: {
          ...corsHeaders,
          "Content-Type": r.headers.get("Content-Type") ?? "application/json",
        },
      });
    }

    // 4xx — wrap in a 200 envelope so the JS client doesn't log it
    // as a proxy error. 401/429/etc are upstream conditions the
    // caller should react to, not proxy bugs.
    if (r.status >= 400 && r.status < 500) {
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep as text */ }
      return json({
        proxied:         true,
        upstream_status: r.status,
        body:            parsed,
      }, 200);
    }

    // 5xx — proxy-side or upstream outage. Surface so retries back off.
    return new Response(text, {
      status: r.status,
      headers: {
        ...corsHeaders,
        "Content-Type": r.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch (err) {
    return json({
      error:  "balldontlie_fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    }, 502);
  }
});
