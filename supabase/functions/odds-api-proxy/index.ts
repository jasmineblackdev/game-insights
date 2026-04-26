import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ODDS_API_UPSTREAM  = "https://api.the-odds-api.com/v4";
const PINNACLE_GUEST     = "https://guest.api.pinnacle.com/v1";
const SDIO_UPSTREAM      = "https://api.sportsdata.io/v3";
const SPORTRADAR_UPSTREAM = "https://api.sportradar.us";
const ODDSJAM_UPSTREAM   = "https://api.oddsjam.com/api/v2";
const OPTICODDS_UPSTREAM = "https://api.opticodds.com/api/v3";
const BETFAIR_UPSTREAM   = "https://api.betfair.com/exchange/betting/rest/v1.0";

// Pinnacle sport IDs (guest API)
const PINNACLE_SPORT_IDS: Record<string, number> = {
  mma: 23,
  boxing: 7,
  nba: 4,
  nfl: 3,
  mlb: 2,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function missingKey(provider: string): Response {
  return json({ error: `${provider}_key_not_configured`, provider }, 503);
}

/**
 * Pass-through with status-envelope on upstream 4xx.
 *
 * Forwarding upstream's raw status (401/404/422/429) caused the
 * Supabase JS client to log every quota / unknown-sport / invalid-
 * market response as a "RUNTIME_ERROR: Edge function returned 401"
 * even though the caller handles it correctly via oddsApiHealth.
 *
 * Now: 2xx pass through unchanged; 4xx upstream responses are
 * wrapped in HTTP 200 with `{ upstream_status, error_code, body }`
 * so callers parse the body without the JS client treating the
 * proxy itself as a failure. 5xx and network errors still surface
 * as non-200 because those are actually proxy-side problems and
 * the caller's retry behavior should change.
 */
async function passThrough(url: string, headers: Record<string, string> = {}): Promise<Response> {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", ...headers } });
    const text = await r.text();

    // 2xx — pass through as-is.
    if (r.ok) {
      return new Response(text, {
        status: r.status,
        headers: { ...corsHeaders, "Content-Type": r.headers.get("Content-Type") ?? "application/json" },
      });
    }

    // 4xx — wrap in 200 envelope. Caller reads body.error_code.
    if (r.status >= 400 && r.status < 500) {
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep as text */ }
      const errorCode = (typeof parsed === "object" && parsed !== null && "error_code" in parsed)
        ? String((parsed as { error_code?: unknown }).error_code ?? "")
        : "";
      return json({
        proxied:         true,
        upstream_status: r.status,
        error_code:      errorCode,
        body:            parsed,
      }, 200);
    }

    // 5xx — proxy-side failure. Surface it.
    return new Response(text, {
      status: r.status,
      headers: { ...corsHeaders, "Content-Type": r.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (e) {
    return json({ error: "upstream_failed", detail: String(e) }, 502);
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────

/** The Odds API — existing route */
async function handleTheOddsApi(url: URL): Promise<Response> {
  const apiKey = Deno.env.get("THE_ODDS_API_KEY")?.trim();
  if (!apiKey) return missingKey("the_odds_api");

  const route = url.searchParams.get("route");
  if (route === "sports") {
    return passThrough(`${ODDS_API_UPSTREAM}/sports/?all=true&apiKey=${encodeURIComponent(apiKey)}`);
  }
  if (route === "odds") {
    const sportKey  = url.searchParams.get("sportKey") ?? "";
    if (!/^[a-zA-Z0-9_]+$/.test(sportKey)) return json({ error: "invalid_sport_key" }, 400);
    const markets   = url.searchParams.get("markets")   ?? "h2h,spreads,totals";
    const regions   = url.searchParams.get("regions")   ?? "us";
    const oddsFormat = url.searchParams.get("oddsFormat") ?? "american";
    const eventIds  = url.searchParams.get("eventIds")?.trim() ?? "";
    if (markets  && !/^[a-z0-9,_-]+$/i.test(markets))  return json({ error: "invalid_markets" }, 400);
    if (regions  && !/^[a-z]{2}$/i.test(regions))       return json({ error: "invalid_regions" }, 400);
    if (oddsFormat && !/^[a-z]+$/i.test(oddsFormat))    return json({ error: "invalid_odds_format" }, 400);
    if (eventIds && !/^[a-zA-Z0-9_,-]+$/.test(eventIds)) return json({ error: "invalid_event_ids" }, 400);
    const q = new URLSearchParams({ regions, markets, oddsFormat, apiKey });
    if (eventIds) q.set("eventIds", eventIds);
    return passThrough(`${ODDS_API_UPSTREAM}/sports/${encodeURIComponent(sportKey)}/odds?${q}`);
  }
  return json({ error: "bad_route" }, 400);
}

/** Pinnacle guest API — no key required, public endpoint */
async function handlePinnacle(url: URL): Promise<Response> {
  const sport = url.searchParams.get("sport") ?? "mma";
  const sportId = PINNACLE_SPORT_IDS[sport];
  if (!sportId) return json({ error: "unsupported_sport", sport }, 400);

  const subroute = url.searchParams.get("subroute") ?? "odds";
  const q = new URLSearchParams({ sportId: String(sportId) });

  // Optionally filter by specific league IDs to reduce payload
  const leagueIds = url.searchParams.get("leagueIds");
  if (leagueIds) q.set("leagueIds", leagueIds);

  const target = subroute === "fixtures"
    ? `${PINNACLE_GUEST}/fixtures?${q}`
    : `${PINNACLE_GUEST}/odds?${q}`;

  // Pinnacle guest API requires Accept-Language + User-Agent to avoid 403
  return passThrough(target, {
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (compatible; GameLens/1.0)",
  });
}

/** SportsDataIO — MMA schedule + odds */
async function handleSportsDataIo(url: URL): Promise<Response> {
  const key = Deno.env.get("SDIO_API_KEY")?.trim();
  if (!key) return missingKey("sportsdata_io");

  const sport = url.searchParams.get("sport") ?? "mma";
  const season = url.searchParams.get("season") ?? new Date().getFullYear().toString();

  let target: string;
  if (sport === "mma") {
    const org = url.searchParams.get("org") ?? "ufc";
    target = `${SDIO_UPSTREAM}/mma/scores/json/Schedule/${org}/${season}?key=${encodeURIComponent(key)}`;
  } else if (sport === "boxing") {
    // SportsDataIO boxing uses same MMA endpoint with org=boxing
    target = `${SDIO_UPSTREAM}/mma/scores/json/Schedule/boxing/${season}?key=${encodeURIComponent(key)}`;
  } else {
    return json({ error: "unsupported_sport", sport }, 400);
  }
  return passThrough(target);
}

/** Sportradar — MMA / boxing event odds */
async function handleSportradar(url: URL): Promise<Response> {
  const key = Deno.env.get("SPORTRADAR_API_KEY")?.trim();
  if (!key) return missingKey("sportradar");

  const sport  = url.searchParams.get("sport") ?? "mma";
  const year   = url.searchParams.get("year")  ?? new Date().getFullYear().toString();
  const month  = url.searchParams.get("month") ?? String(new Date().getMonth() + 1).padStart(2, "0");
  const day    = url.searchParams.get("day")   ?? String(new Date().getDate()).padStart(2, "0");

  let target: string;
  if (sport === "mma") {
    target = `${SPORTRADAR_UPSTREAM}/mma/production/v1/en/schedules/${year}-${month}-${day}/schedule.json?api_key=${encodeURIComponent(key)}`;
  } else if (sport === "boxing") {
    target = `${SPORTRADAR_UPSTREAM}/boxing/production/v1/en/schedules/${year}-${month}-${day}/schedule.json?api_key=${encodeURIComponent(key)}`;
  } else {
    return json({ error: "unsupported_sport", sport }, 400);
  }
  return passThrough(target);
}

/** OddsJam — sharp odds aggregator */
async function handleOddsJam(url: URL): Promise<Response> {
  const key = Deno.env.get("ODDSJAM_API_KEY")?.trim();
  if (!key) return missingKey("oddsjam");

  const sport = url.searchParams.get("sport") ?? "mma";
  const books = url.searchParams.get("bookmakers") ?? "pinnacle,draftkings,fanduel";

  // OddsJam uses "mixed_martial_arts" or "boxing"
  const oddsSport = sport === "mma" ? "mixed_martial_arts" : sport;
  const q = new URLSearchParams({ sport: oddsSport, bookmakers: books, key });
  return passThrough(`${ODDSJAM_UPSTREAM}/game-odds?${q}`);
}

/** OpticOdds — odds aggregation platform */
async function handleOpticOdds(url: URL): Promise<Response> {
  const key = Deno.env.get("OPTICODDS_API_KEY")?.trim();
  if (!key) return missingKey("opticodds");

  const sport  = url.searchParams.get("sport") ?? "mma";
  const market = url.searchParams.get("market") ?? "moneyline";

  const q = new URLSearchParams({ sport, market, key });
  return passThrough(`${OPTICODDS_UPSTREAM}/fixtures/odds?${q}`);
}

/** Betfair Exchange — requires OAuth session token (set BETFAIR_SESSION_TOKEN) */
async function handleBetfair(url: URL): Promise<Response> {
  const appKey  = Deno.env.get("BETFAIR_APP_KEY")?.trim();
  const session = Deno.env.get("BETFAIR_SESSION_TOKEN")?.trim();
  if (!appKey || !session) return missingKey("betfair");

  const sport = url.searchParams.get("sport") ?? "mma";
  // Betfair event type IDs: MMA=26420387, Boxing=6
  const eventTypeId = sport === "boxing" ? "6" : "26420387";

  const body = JSON.stringify({
    filter: { eventTypeIds: [eventTypeId] },
    priceProjection: { priceData: ["EX_ALL_OFFERS"], exBestOffersOverrides: { rollupModel: "STAKE", bestPricesDepth: 1 } },
    sort: "FIRST_TO_START",
    maxResults: "50",
  });

  try {
    const r = await fetch(`${BETFAIR_UPSTREAM}/listMarketCatalogue/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Application": appKey,
        "X-Authentication": session,
        Accept: "application/json",
      },
      body,
    });
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return json({ error: "betfair_upstream_failed", detail: String(e) }, 502);
  }
}

/** SportMonks — primarily soccer; limited combat sports coverage */
async function handleSportMonks(url: URL): Promise<Response> {
  const key = Deno.env.get("SPORTMONKS_API_KEY")?.trim();
  if (!key) return missingKey("sportmonks");

  // SportMonks v3 supports MMA via the "mma" sport endpoint
  const sport  = url.searchParams.get("sport") ?? "mma";
  const q = new URLSearchParams({ api_token: key, include: "odds" });
  return passThrough(`https://api.sportmonks.com/v3/${sport}/fixtures?${q}`);
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const url = new URL(req.url);
  const provider = url.searchParams.get("provider") ?? "the-odds-api";

  try {
    switch (provider) {
      case "the-odds-api":   return handleTheOddsApi(url);
      case "pinnacle":       return handlePinnacle(url);
      case "sportsdata-io":  return handleSportsDataIo(url);
      case "sportradar":     return handleSportradar(url);
      case "oddsjam":        return handleOddsJam(url);
      case "opticodds":      return handleOpticOdds(url);
      case "betfair":        return handleBetfair(url);
      case "sportmonks":     return handleSportMonks(url);
      // Legacy route param used by existing client code
      case "the-odds-api-legacy": return handleTheOddsApi(url);
      default:
        // Backwards-compat: old code sends route= without provider=
        return handleTheOddsApi(url);
    }
  } catch (e) {
    console.error("[odds-api-proxy]", provider, e);
    return json({ error: "upstream_failed", provider }, 502);
  }
});
