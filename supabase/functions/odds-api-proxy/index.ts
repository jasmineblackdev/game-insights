import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const UPSTREAM = "https://api.the-odds-api.com/v4";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const apiKey = Deno.env.get("THE_ODDS_API_KEY")?.trim();
  if (!apiKey) {
    return json({ error: "the_odds_api_key_not_configured" }, 503);
  }

  const url = new URL(req.url);
  const route = url.searchParams.get("route");

  try {
    if (route === "sports") {
      const target = `${UPSTREAM}/sports/?all=true&apiKey=${encodeURIComponent(apiKey)}`;
      const r = await fetch(target);
      const text = await r.text();
      return new Response(text, {
        status: r.status,
        headers: { ...corsHeaders, "Content-Type": r.headers.get("Content-Type") ?? "application/json" },
      });
    }

    if (route === "odds") {
      const sportKey = url.searchParams.get("sportKey") ?? "";
      if (!/^[a-zA-Z0-9_]+$/.test(sportKey)) {
        return json({ error: "invalid_sport_key" }, 400);
      }
      const markets = url.searchParams.get("markets") ?? "h2h,spreads,totals";
      if (!/^[a-z0-9,_-]+$/i.test(markets)) {
        return json({ error: "invalid_markets" }, 400);
      }
      const regions = url.searchParams.get("regions") ?? "us";
      if (!/^[a-z]{2}$/i.test(regions)) {
        return json({ error: "invalid_regions" }, 400);
      }
      const oddsFormat = url.searchParams.get("oddsFormat") ?? "american";
      if (!/^[a-z]+$/i.test(oddsFormat)) {
        return json({ error: "invalid_odds_format" }, 400);
      }

      const eventIds = url.searchParams.get("eventIds")?.trim() ?? "";
      if (eventIds && !/^[a-zA-Z0-9_,-]+$/.test(eventIds)) {
        return json({ error: "invalid_event_ids" }, 400);
      }

      const q = new URLSearchParams({
        regions,
        markets,
        oddsFormat,
        apiKey,
      });
      if (eventIds) q.set("eventIds", eventIds);
      const target = `${UPSTREAM}/sports/${encodeURIComponent(sportKey)}/odds?${q.toString()}`;
      const r = await fetch(target);
      const text = await r.text();
      return new Response(text, {
        status: r.status,
        headers: { ...corsHeaders, "Content-Type": r.headers.get("Content-Type") ?? "application/json" },
      });
    }

    return json({ error: "bad_route", hint: "route=sports | route=odds&sportKey=..." }, 400);
  } catch (e) {
    console.error("[odds-api-proxy]", e);
    return json({ error: "upstream_failed" }, 502);
  }
});
