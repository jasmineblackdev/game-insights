import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CACHE_TTL_MS = 45_000;
const cache = new Map<string, { text: string; exp: number }>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function upstreamBase(league: string, slug: string | null): string | null {
  switch (league) {
    case "nba":
      return "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard";
    case "nfl":
      return "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
    case "mlb":
      return "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard";
    case "soccer":
      if (!slug || !/^[a-z0-9._-]+$/i.test(slug)) return null;
      return `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard`;
    default:
      return null;
  }
}

const DATES_RE = /^(\d{8}|\d{8}-\d{8})$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const url = new URL(req.url);
  const league = (url.searchParams.get("league") ?? "").toLowerCase();
  const slug = url.searchParams.get("slug");
  const dates = url.searchParams.get("dates");
  const limit = url.searchParams.get("limit");

  if (!["nba", "nfl", "mlb", "soccer"].includes(league)) {
    return json({ error: "invalid_league", hint: "league=nba|nfl|mlb|soccer" }, 400);
  }
  if (league === "soccer" && !slug) {
    return json({ error: "soccer_requires_slug", hint: "slug=eng.1" }, 400);
  }
  if (dates && !DATES_RE.test(dates)) {
    return json({ error: "invalid_dates", hint: "YYYYMMDD or YYYYMMDD-YYYYMMDD" }, 400);
  }
  if (limit && !/^\d{1,4}$/.test(limit)) {
    return json({ error: "invalid_limit" }, 400);
  }

  const base = upstreamBase(league, slug);
  if (!base) {
    return json({ error: "bad_upstream" }, 400);
  }

  const q = new URLSearchParams();
  if (dates) q.set("dates", dates);
  if (limit) q.set("limit", limit);
  const upstream = q.toString() ? `${base}?${q.toString()}` : base;
  const cacheKey = upstream;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.exp > now) {
    return new Response(hit.text, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Cache": "HIT",
        "Cache-Control": "public, max-age=30",
      },
    });
  }

  try {
    const r = await fetch(upstream, {
      headers: {
        "User-Agent": "GameLens/1.0 (scoreboard proxy)",
        Accept: "application/json",
      },
    });
    const text = await r.text();
    if (r.ok) {
      cache.set(cacheKey, { text, exp: now + CACHE_TTL_MS });
    }
    return new Response(text, {
      status: r.status,
      headers: {
        ...corsHeaders,
        "Content-Type": r.headers.get("Content-Type") ?? "application/json",
        "X-Cache": "MISS",
        "Cache-Control": r.ok ? "public, max-age=30" : "no-store",
      },
    });
  } catch (e) {
    console.error("[espn-proxy]", e);
    return json({ error: "upstream_fetch_failed" }, 502);
  }
});
