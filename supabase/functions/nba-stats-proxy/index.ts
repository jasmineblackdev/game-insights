import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** NBA.com expects browser-like headers; server-side fetch avoids browser CORS. */
const NBA_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nba.com/",
  Origin: "https://www.nba.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

function nbaSeasonFromDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (m >= 10) return `${y}-${String(y + 1).slice(-2)}`;
  return `${y - 1}-${String(y).slice(-2)}`;
}

function parseAdvancedRows(json: unknown): Record<string, { offRtg: number; defRtg: number; pace: number }> {
  const out: Record<string, { offRtg: number; defRtg: number; pace: number }> = {};
  const rs = (json as { resultSets?: { headers?: string[]; rowSet?: unknown[][] }[] })?.resultSets?.[0];
  const headers = rs?.headers;
  const rows = rs?.rowSet;
  if (!headers?.length || !rows?.length) return out;

  const idx = (name: string) => headers.indexOf(name);
  const iAbbr = idx("TEAM_ABBREVIATION");
  const iOff = idx("OFF_RATING");
  const iDef = idx("DEF_RATING");
  const iPace = idx("PACE");
  if (iAbbr < 0 || iOff < 0 || iDef < 0) return out;

  for (const row of rows) {
    const abbr = String(row[iAbbr] ?? "").trim().toUpperCase();
    const off = Number(row[iOff]);
    const def = Number(row[iDef]);
    const pace = iPace >= 0 ? Number(row[iPace]) : NaN;
    if (!abbr || !Number.isFinite(off) || !Number.isFinite(def)) continue;
    out[abbr] = {
      offRtg: Math.round(off * 10) / 10,
      defRtg: Math.round(def * 10) / 10,
      pace: Number.isFinite(pace) ? Math.round(pace * 10) / 10 : 100,
    };
  }
  return out;
}

function buildStatsUrl(season: string, seasonType: string): string {
  const st = seasonType === "Playoffs" ? "Playoffs" : "Regular Season";
  const params = new URLSearchParams({
    Conference: "",
    DateFrom: "",
    DateTo: "",
    Division: "",
    GameScope: "",
    GameSegment: "",
    Height: "",
    LastNGames: "0",
    LeagueID: "00",
    Location: "",
    MeasureType: "Advanced",
    Month: "0",
    OpponentTeamID: "0",
    Outcome: "",
    PORound: "0",
    PaceAdjust: "N",
    PerMode: "PerGame",
    Period: "0",
    PlayerExperience: "",
    PlayerPosition: "",
    PlusMinus: "N",
    Rank: "N",
    Season: season,
    SeasonSegment: "",
    SeasonType: st,
    ShotClockRange: "",
    StarterBench: "",
    TeamID: "0",
    VsConference: "",
    VsDivision: "",
  });
  return `https://stats.nba.com/stats/leaguedashteamstats?${params.toString()}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const season = url.searchParams.get("season")?.trim() || nbaSeasonFromDate(new Date());
    const seasonType = url.searchParams.get("seasonType")?.trim() === "Playoffs" ? "Playoffs" : "Regular Season";

    const target = buildStatsUrl(season, seasonType);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45_000);

    const res = await fetch(target, { headers: NBA_HEADERS, signal: ctrl.signal });
    clearTimeout(t);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return new Response(
        JSON.stringify({
          error: "nba_stats_http",
          status: res.status,
          detail: body.slice(0, 200),
          season,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const json = await res.json();
    const ratings = parseAdvancedRows(json);
    const keys = Object.keys(ratings);

    if (keys.length === 0) {
      return new Response(
        JSON.stringify({
          error: "nba_stats_parse",
          message: "No team rows parsed — stats.nba.com schema may have changed.",
          season,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        season,
        seasonType,
        source: "stats.nba.com",
        ratings,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: "nba_stats_proxy", message: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
