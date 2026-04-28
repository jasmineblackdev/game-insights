/**
 * closing-odds-poller — captures the second half of the CLV pipeline.
 *
 * The bridge already records:
 *   - odds_at_recommendation (when the optimizer surfaces a leg)
 *   - odds_at_placement      (when user clicks "Mark as placed")
 *
 * What's missing is the THIRD point — odds taken right before kickoff,
 * the canonical "closing line." That's what this poller captures.
 *
 * Strategy:
 *   1. Pull pending recommended_parlays whose legs include an
 *      identifiable game starting in the next ~2 hours.
 *   2. Group by (sport, game_id) — refetch each unique game once.
 *   3. Hit the existing odds-api-proxy (server-side key) for fresh
 *      odds. Only the_odds_api path is supported here; other
 *      providers can be wired later.
 *   4. Update each matching leg's `closing_odds_american` field.
 *      Idempotent overwrite — the LATEST close before kickoff wins.
 *   5. Bridge (parlayLegBridge) already reads odds_at_placement +
 *      odds_at_recommendation; once closing_odds_american is set, it
 *      computes the full clv_pp at settle and writes to extra.clv_pp.
 *
 * Cron:
 *   Recommended schedule — every 15 min during NA sport hours.
 *   Set up via pg_cron from the Supabase SQL editor:
 *     SELECT cron.schedule(
 *       'closing-odds-poll',
 *       '*\/15 * * * *',
 *       $$ SELECT net.http_post(
 *            url := 'https://<project>.supabase.co/functions/v1/closing-odds-poller',
 *            headers := jsonb_build_object('Authorization', 'Bearer <service-role-jwt>')
 *          ); $$
 *     );
 *   Or trigger from any external scheduler (GitHub Actions cron,
 *   Vercel cron, etc.) by hitting the function URL.
 *
 * Auth:
 *   Requires SUPABASE_SERVICE_ROLE_KEY at the function (set via
 *   `supabase secrets set` if not already). The function uses it to
 *   bypass RLS when reading recommended_parlays and writing back.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.46.1";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const ODDS_UPSTREAM = "https://api.the-odds-api.com/v4";
const NEAR_KICKOFF_HOURS = 2;

const SPORT_TO_KEY: Record<string, string> = {
  nba:    "basketball_nba",
  wnba:   "basketball_wnba",
  nfl:    "americanfootball_nfl",
  mlb:    "baseball_mlb",
  soccer: "soccer_usa_mls",
};

interface ParlayLeg {
  id?: string;
  sport?: string;
  market_type?: string;
  selection?: string;
  american_odds?: number | null;
  odds_at_placement?: number | null;
  closing_odds_american?: number | null;
  game_id?: string | null;
  game_label?: string | null;
  game_time?: string | null;
  leg_outcome?: string;
  [k: string]: unknown;
}

interface ParlayRow {
  id: string;
  legs: ParlayLeg[];
  outcome: string;
  recommended_at: string;
}

/** Extract a usable ESPN gameId from a parlay leg's id field. */
function gameIdFromLegId(legId: string | undefined): string | null {
  if (!legId) return null;
  // Team moneyline: vp-{gameId}-ml-{side}
  const ml = /^vp-(.+)-ml-(home|away)$/.exec(legId);
  if (ml) return ml[1];
  // Player prop: ml-prop-espn-{sport}-{gameId}-{athleteId}-{stat}
  const prop = /^(?:ml-prop|pe)-espn-[a-z]+-(\d+)-/i.exec(legId);
  if (prop) return prop[1];
  return null;
}

/** Identify the team token in a moneyline leg's selection (e.g. "LAL ML" → "LAL"). */
function teamTokenFromSelection(selection: string | undefined): string | null {
  if (!selection) return null;
  const m = /^([A-Z][A-Z0-9]{1,4})\b/.exec(selection.trim());
  return m?.[1] ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ODDS_KEY     = Deno.env.get("THE_ODDS_API_KEY");
  if (!SUPABASE_URL || !SERVICE_ROLE) return json({ error: "supabase_not_configured" }, 503);
  if (!ODDS_KEY)                       return json({ error: "odds_api_key_missing" }, 503);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const cutoffStart = new Date().toISOString();
  const cutoffEnd   = new Date(Date.now() + NEAR_KICKOFF_HOURS * 3_600_000).toISOString();

  // Pull pending parlays — limited to last 7d so we don't replay history.
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: parlays, error } = await supabase
    .from("recommended_parlays")
    .select("id, legs, outcome, recommended_at")
    .eq("outcome", "pending")
    .gte("recommended_at", since)
    .limit(500);
  if (error) return json({ error: "parlays_query_failed", detail: error.message }, 500);

  // Build (sport → set of gameIds) map across legs whose game starts soon.
  const sportGameMap = new Map<string, Set<string>>();
  for (const p of (parlays ?? []) as ParlayRow[]) {
    if (!Array.isArray(p.legs)) continue;
    for (const leg of p.legs) {
      const sport = String(leg.sport ?? "").toLowerCase();
      const sportKey = SPORT_TO_KEY[sport];
      if (!sportKey) continue;
      const gameTime = leg.game_time ?? null;
      // If we know the game time, gate on near-kickoff. Otherwise opt-in:
      // poll the leg anyway — we don't want to silently miss closes when
      // game_time wasn't recorded.
      if (gameTime) {
        const t = new Date(gameTime).toISOString();
        if (t < cutoffStart || t > cutoffEnd) continue;
      }
      const gameId = leg.game_id ?? gameIdFromLegId(leg.id);
      if (!gameId) continue;
      let s = sportGameMap.get(sportKey);
      if (!s) { s = new Set<string>(); sportGameMap.set(sportKey, s); }
      s.add(gameId);
    }
  }

  if (sportGameMap.size === 0) {
    return json({ ok: true, parlays_scanned: parlays?.length ?? 0, games_polled: 0, legs_updated: 0 });
  }

  // Per-sport batch: one upstream call per sport. The Odds API
  // supports eventIds= filter so we can target the specific games.
  let legsUpdated = 0;
  let gamesPolled = 0;
  const errors: string[] = [];
  const oddsByGame = new Map<string, { home_team: string; away_team: string; bookmakers?: Array<{ markets?: Array<{ key: string; outcomes?: Array<{ name: string; price: number }> }> }> }>();

  // Fetch every event for the sport then match by team name. The
  // eventIds= filter expects The Odds API's own UUIDs, not ESPN
  // gameIds — so we can't pre-filter. <50 games per sport per day
  // makes the wider fetch cheap.
  for (const [sportKey] of sportGameMap.entries()) {
    const url = `${ODDS_UPSTREAM}/sports/${encodeURIComponent(sportKey)}/odds?regions=us&markets=h2h&oddsFormat=american&apiKey=${encodeURIComponent(ODDS_KEY)}`;
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        errors.push(`${sportKey}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json() as Array<{ id: string; home_team: string; away_team: string; bookmakers?: Array<{ markets?: Array<{ key: string; outcomes?: Array<{ name: string; price: number }> }> }> }>;
      for (const ev of data) {
        oddsByGame.set(ev.id, ev);
        // Also key by team-pair so we can match via parlay leg's
        // selection ("LAL ML" / game_label "LAL @ HOU") when the
        // gameId is ESPN-style instead of Odds-API-style.
        const homeUp = ev.home_team?.toUpperCase() ?? "";
        const awayUp = ev.away_team?.toUpperCase() ?? "";
        if (homeUp && awayUp) {
          oddsByGame.set(`__teams::${awayUp}@${homeUp}`, ev);
        }
        gamesPolled++;
      }
    } catch (e) {
      errors.push(`${sportKey}: ${String(e).slice(0, 100)}`);
    }
  }

  // For each parlay, walk legs and update closing_odds_american when
  // we have fresh data for that game. Use the consensus h2h price
  // from the first bookmaker — good enough for CLV.
  for (const p of (parlays ?? []) as ParlayRow[]) {
    if (!Array.isArray(p.legs)) continue;
    let touched = false;
    const nextLegs = p.legs.map((leg) => {
      // Match by team-pair (preferred) or fall back to gameId lookup.
      // Team pair gives us a reliable hit even when the parlay's
      // gameId is ESPN-style and the Odds API's id is its own UUID.
      let ev: typeof oddsByGame extends Map<string, infer V> ? V | undefined : undefined = undefined;
      const labelMatch = /^([A-Z][A-Z0-9]{1,4})\s*@\s*([A-Z][A-Z0-9]{1,4})$/.exec(String(leg.game_label ?? "").trim());
      if (labelMatch) {
        // Try matching against any event whose home/away contains the
        // tokens (Odds API uses full team names; we have abbrevs).
        const [, awayTok, homeTok] = labelMatch;
        for (const [, candidate] of oddsByGame.entries()) {
          const homeUp = candidate.home_team?.toUpperCase() ?? "";
          const awayUp = candidate.away_team?.toUpperCase() ?? "";
          if (homeUp.includes(homeTok) && awayUp.includes(awayTok)) {
            ev = candidate;
            break;
          }
        }
      }
      if (!ev) {
        const gameId = leg.game_id ?? gameIdFromLegId(leg.id);
        if (gameId) ev = oddsByGame.get(gameId);
      }
      if (!ev) return leg;

      const teamToken = teamTokenFromSelection(leg.selection);
      if (leg.market_type === "team_moneyline" && teamToken) {
        const market = ev.bookmakers?.[0]?.markets?.find((m) => m.key === "h2h");
        const outcome = market?.outcomes?.find((o) => o.name?.toUpperCase().includes(teamToken));
        if (outcome && Number.isFinite(outcome.price)) {
          touched = true;
          return { ...leg, closing_odds_american: Math.round(outcome.price) };
        }
      }
      return leg;
    });
    if (touched) {
      const { error: upErr } = await supabase
        .from("recommended_parlays")
        .update({ legs: nextLegs })
        .eq("id", p.id);
      if (upErr) errors.push(`update ${p.id}: ${upErr.message}`);
      else legsUpdated++;
    }
  }

  return json({
    ok: true,
    parlays_scanned: parlays?.length ?? 0,
    games_polled: gamesPolled,
    legs_updated: legsUpdated,
    errors: errors.slice(0, 10),
  });
});
