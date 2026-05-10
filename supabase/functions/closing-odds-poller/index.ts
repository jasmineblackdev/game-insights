/**
 * closing-odds-poller — captures the second half of the CLV pipeline
 * for BOTH team markets (moneyline) AND player-prop markets.
 *
 * The bridge already records:
 *   - odds_at_recommendation (when the optimizer surfaces a leg)
 *   - odds_at_placement      (when user clicks "Mark as placed")
 *
 * What was missing is the THIRD point — odds taken right before
 * kickoff, the canonical "closing line." That's what this poller
 * captures and writes to leg.closing_odds_american (+ for props,
 * leg.closing_line_value so apples-to-apples CLV math is possible
 * even when the line moved).
 *
 * Strategy:
 *   1. Pull pending recommended_parlays whose legs include an
 *      identifiable game starting in the next ~2 hours.
 *   2. Group by sport. Per sport, build a UNION of:
 *        - h2h (always — covers moneyline legs)
 *        - prop markets we have pending legs for, mapped from each
 *          leg's stat_type via PROP_MARKET_KEYS
 *   3. ONE Odds API call per sport with comma-separated markets.
 *      Cost-aware: prop markets only enter the request when we have
 *      pending legs for them.
 *   4. For each leg, match against the response and set
 *      `closing_odds_american` (+ `closing_line_value` for props).
 *      Idempotent overwrite — the LATEST close before kickoff wins.
 *   5. Bridge reads the closing fields at settle and computes clv_pp.
 *
 * Recommendation logic is NOT changed — this is observability /
 * learning data only. Per #127 ship plan.
 *
 * No schema migration needed: legs is JSONB; new closing_line_value
 * field lives alongside the existing closing_odds_american.
 *
 * Cron + Auth: unchanged from the team-only version.
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

/**
 * Maps our internal stat_type → Odds API market key per sport.
 * Only the most common props the optimizer surfaces are covered.
 * When a stat_type isn't here, the leg is skipped (not an error).
 *
 * Keys verified against Odds API docs:
 *   https://the-odds-api.com/sports-odds-data/betting-markets.html#player-props
 */
const PROP_MARKET_KEYS: Record<string, Record<string, string>> = {
  nba: {
    points:      "player_points",
    rebounds:    "player_rebounds",
    assists:     "player_assists",
    threes:      "player_threes",
    steals:      "player_steals",
    blocks:      "player_blocks",
    pra:         "player_points_rebounds_assists",
  },
  wnba: {
    points:      "player_points",
    rebounds:    "player_rebounds",
    assists:     "player_assists",
    threes:      "player_threes",
  },
  nfl: {
    passing_yards:   "player_pass_yds",
    passing_tds:     "player_pass_tds",
    completions:     "player_pass_completions",
    rushing_yards:   "player_rush_yds",
    receiving_yards: "player_reception_yds",
    receptions:      "player_receptions",
  },
  mlb: {
    hits:         "batter_hits",
    total_bases:  "batter_total_bases",
    home_runs:    "batter_home_runs",
    rbis:         "batter_rbis",
    runs:         "batter_runs_scored",
    stolen_bases: "batter_stolen_bases",
    walks:        "batter_walks",
    // Pitcher Ks are far more common in the optimizer pool than batter Ks;
    // Odds API exposes them at pitcher_strikeouts.
    strikeouts:   "pitcher_strikeouts",
  },
};

interface ParlayLeg {
  id?: string;
  sport?: string;
  market_type?: string;
  stat_type?: string | null;
  line_value?: number | null;
  /** Direction stored as "MORE"/"LESS" by the logger. */
  direction?: "MORE" | "LESS" | null;
  selection?: string;
  american_odds?: number | null;
  odds_at_placement?: number | null;
  closing_odds_american?: number | null;
  /**
   * Closing line value for player props — captured alongside
   * closing_odds_american so CLV math can detect line moves and
   * decide whether the comparison is apples-to-apples (same line)
   * or ambiguous (line drifted). Null for team markets.
   */
  closing_line_value?: number | null;
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

/**
 * Pull the player name out of "Aaron Judge Over 1.5 Total Bases".
 * Returns the part before the first Over/Under/numeric token.
 */
function playerNameFromSelection(selection: string | undefined | null): string | null {
  if (!selection) return null;
  const m = /^([^\d]+?)\s+(?:Over|Under|O\/U|\d)/i.exec(String(selection).trim());
  return m ? m[1].trim() : null;
}

/** Loose name match — full-name on most providers; allow last-name fallback. */
function nameMatches(odsName: string, target: string): boolean {
  const a = odsName.toUpperCase().replace(/[^A-Z\s]/g, "").trim();
  const b = target.toUpperCase().replace(/[^A-Z\s]/g, "").trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const aLast = a.split(/\s+/).slice(-1)[0];
  const bLast = b.split(/\s+/).slice(-1)[0];
  return aLast.length >= 4 && aLast === bLast;
}

type OddsEvent = {
  id: string;
  home_team: string;
  away_team: string;
  bookmakers?: Array<{
    markets?: Array<{
      key: string;
      outcomes?: Array<{
        name: string;
        /** Player-prop outcomes use `description` for the player name; team h2h uses `name`. */
        description?: string;
        price: number;
        point?: number;
      }>;
    }>;
  }>;
};

/**
 * Match a player-prop outcome on the Odds API event. Returns the
 * outcome with the smallest |line - target_line| AND matching
 * direction. Null when no candidate is found.
 */
function findPropOutcome(
  ev: OddsEvent,
  marketKey: string,
  playerName: string,
  direction: "MORE" | "LESS",
  targetLine: number,
): { price: number; point: number } | null {
  const wantedDirName = direction === "MORE" ? "OVER" : "UNDER";
  let best: { price: number; point: number; diff: number } | null = null;
  for (const bk of ev.bookmakers ?? []) {
    const market = bk.markets?.find((m) => m.key === marketKey);
    if (!market) continue;
    for (const o of market.outcomes ?? []) {
      if ((o.name?.toUpperCase() ?? "") !== wantedDirName) continue;
      const desc = o.description ?? "";
      if (!nameMatches(desc, playerName)) continue;
      if (!Number.isFinite(o.price) || !Number.isFinite(o.point ?? NaN)) continue;
      const diff = Math.abs((o.point ?? 0) - targetLine);
      if (best == null || diff < best.diff) {
        best = { price: o.price, point: o.point ?? 0, diff };
      }
    }
    if (best) break; // first bookmaker with a hit is good enough for CLV consensus
  }
  if (!best) return null;
  return { price: best.price, point: best.point };
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

  // Build (sport → set of gameIds) AND (sport → set of needed prop
  // markets) maps across legs whose game starts soon.
  const sportGameMap   = new Map<string, Set<string>>();
  const sportMarketMap = new Map<string, Set<string>>(); // sportKey → set of market keys ("h2h" + props)

  for (const p of (parlays ?? []) as ParlayRow[]) {
    if (!Array.isArray(p.legs)) continue;
    for (const leg of p.legs) {
      const sport = String(leg.sport ?? "").toLowerCase();
      const sportKey = SPORT_TO_KEY[sport];
      if (!sportKey) continue;
      const gameTime = leg.game_time ?? null;
      if (gameTime) {
        const t = new Date(gameTime).toISOString();
        if (t < cutoffStart || t > cutoffEnd) continue;
      }
      const gameId = leg.game_id ?? gameIdFromLegId(leg.id);
      if (!gameId) continue;
      let s = sportGameMap.get(sportKey);
      if (!s) { s = new Set<string>(); sportGameMap.set(sportKey, s); }
      s.add(gameId);

      // Track which markets this sport needs.
      let mkts = sportMarketMap.get(sportKey);
      if (!mkts) { mkts = new Set<string>(); sportMarketMap.set(sportKey, mkts); }

      const mt = String(leg.market_type ?? "").toLowerCase();
      if (mt === "moneyline" || mt === "team_moneyline") {
        mkts.add("h2h");
      } else if (mt === "player_prop") {
        const propKey = PROP_MARKET_KEYS[sport]?.[String(leg.stat_type ?? "").toLowerCase()];
        if (propKey) mkts.add(propKey);
      }
    }
  }

  if (sportGameMap.size === 0) {
    return json({ ok: true, parlays_scanned: parlays?.length ?? 0, games_polled: 0, legs_updated: 0 });
  }

  // Per-sport batch: one upstream call per sport with comma-separated
  // markets list. The Odds API charges per-market-per-game, so scoping
  // markets to what we actually need keeps quota cost bounded.
  let legsUpdated = 0;
  let gamesPolled = 0;
  const errors: string[] = [];
  const oddsByGame = new Map<string, OddsEvent>();

  // Track the worst-status the run observed. The end-of-run health
  // upsert reads this — "ok" stays sticky only when every sport
  // succeeded; the moment any sport hits OUT_OF_USAGE_CREDITS we
  // surface that to Insights regardless of whether other sports
  // partially succeeded earlier in the loop.
  type HealthStatus =
    | "ok"
    | "quota_exhausted"
    | "rate_limited"
    | "auth_failed"
    | "invalid_market"
    | "network_error"
    | "unknown";
  let runStatus: HealthStatus = "unknown";
  let runErrorCode: string | null = null;
  let runMessage: string = "";
  let runSportKey: string | null = null;
  let quotaExhausted = false;

  // Try-once-with-backoff wrapper for transient network blips.
  async function fetchOdds(url: string): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        return r;
      } catch (e) {
        if (attempt === 1) throw e;
        await new Promise((res) => setTimeout(res, 800));
      }
    }
    // unreachable, but appeases TS
    throw new Error("unreachable");
  }

  // Parse The Odds API error envelope. They always return JSON with
  // `error_code` + `message` on 4xx — we map their codes to our
  // singleton-table status enum so Insights can render a useful
  // banner without the consumer having to know the upstream taxonomy.
  function classifyUpstreamError(status: number, body: unknown): {
    healthStatus: HealthStatus;
    errorCode: string | null;
    message: string;
    fatal: boolean; // true → break out of sport loop entirely
  } {
    const obj = (body && typeof body === "object") ? body as Record<string, unknown> : {};
    const code = typeof obj.error_code === "string" ? obj.error_code : "";
    const msg  = typeof obj.message    === "string" ? obj.message    : `HTTP ${status}`;
    if (status === 401 && code === "OUT_OF_USAGE_CREDITS") {
      return { healthStatus: "quota_exhausted", errorCode: code, message: msg, fatal: true };
    }
    if (status === 401) {
      return { healthStatus: "auth_failed", errorCode: code || "UNAUTHORIZED", message: msg, fatal: true };
    }
    if (status === 422 && code === "INVALID_MARKET") {
      return { healthStatus: "invalid_market", errorCode: code, message: msg, fatal: false };
    }
    if (status === 429 || code === "EXCEEDED_FREQ_LIMIT") {
      return { healthStatus: "rate_limited", errorCode: code || "EXCEEDED_FREQ_LIMIT", message: msg, fatal: false };
    }
    if (status >= 500) {
      return { healthStatus: "network_error", errorCode: code || `HTTP_${status}`, message: msg, fatal: false };
    }
    return { healthStatus: "unknown", errorCode: code || `HTTP_${status}`, message: msg, fatal: false };
  }

  for (const [sportKey, mktsSet] of sportMarketMap.entries()) {
    if (quotaExhausted) {
      // Skip remaining sports — every call would just burn the same
      // 401, and OUT_OF_USAGE_CREDITS is account-wide, not per-sport.
      errors.push(`${sportKey}: skipped (quota exhausted earlier in run)`);
      continue;
    }
    if (mktsSet.size === 0) continue;
    // Mutable copy so we can drop INVALID_MARKET entries and retry.
    let mkts = [...mktsSet];
    let attemptedRetry = false;

    while (mkts.length > 0) {
      const marketsParam = mkts.join(",");
      const url = `${ODDS_UPSTREAM}/sports/${encodeURIComponent(sportKey)}/odds?regions=us&markets=${encodeURIComponent(marketsParam)}&oddsFormat=american&apiKey=${encodeURIComponent(ODDS_KEY)}`;
      try {
        const res = await fetchOdds(url);
        if (res.ok) {
          const data = await res.json() as OddsEvent[];
          for (const ev of data) {
            oddsByGame.set(ev.id, ev);
            const homeUp = ev.home_team?.toUpperCase() ?? "";
            const awayUp = ev.away_team?.toUpperCase() ?? "";
            if (homeUp && awayUp) {
              oddsByGame.set(`__teams::${awayUp}@${homeUp}`, ev);
            }
            gamesPolled++;
          }
          // Sport done — promote runStatus to "ok" only if it hasn't
          // been set to something worse already.
          if (runStatus === "unknown") runStatus = "ok";
          break;
        }
        // Parse upstream error body for the exact code.
        let body: unknown = null;
        try { body = await res.json(); } catch { /* non-JSON */ }
        const cls = classifyUpstreamError(res.status, body);
        runStatus    = cls.healthStatus;
        runErrorCode = cls.errorCode;
        runMessage   = cls.message;
        runSportKey  = sportKey;
        errors.push(`${sportKey}: ${cls.errorCode ?? `HTTP ${res.status}`} — ${cls.message}`);

        if (cls.healthStatus === "quota_exhausted" || cls.healthStatus === "auth_failed") {
          quotaExhausted = true;
          break;
        }
        if (cls.healthStatus === "invalid_market" && !attemptedRetry) {
          // Drop the most expensive market (last one in the list,
          // which is typically a player-prop market that requires
          // a higher tier) and retry the same sport with what's left.
          // Single retry per sport — don't loop forever.
          attemptedRetry = true;
          const dropped = mkts.pop();
          if (dropped) {
            errors.push(`${sportKey}: dropped market "${dropped}", retrying`);
            continue;
          }
          break;
        }
        // Other classes (rate_limited, network_error, unknown):
        // give up on this sport, move on. Cron will retry next run.
        break;
      } catch (e) {
        runStatus    = "network_error";
        runErrorCode = "FETCH_THREW";
        runMessage   = String(e).slice(0, 200);
        runSportKey  = sportKey;
        errors.push(`${sportKey}: ${runMessage}`);
        break;
      }
    }
  }

  // For each parlay, walk legs and update closing_odds_american when
  // we have fresh data for that game/market. Idempotent on every call.
  for (const p of (parlays ?? []) as ParlayRow[]) {
    if (!Array.isArray(p.legs)) continue;
    let touched = false;
    const nextLegs = p.legs.map((leg) => {
      // Match by team-pair (preferred) or fall back to gameId lookup.
      let ev: OddsEvent | undefined = undefined;
      const labelMatch = /^([A-Z][A-Z0-9]{1,4})\s*@\s*([A-Z][A-Z0-9]{1,4})$/.exec(String(leg.game_label ?? "").trim());
      if (labelMatch) {
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
      const mt = String(leg.market_type ?? "").toLowerCase();

      // Team moneyline. Schema uses "moneyline"; accept legacy
      // "team_moneyline" too for back-compat with old rows.
      if ((mt === "moneyline" || mt === "team_moneyline") && teamToken) {
        const market = ev.bookmakers?.[0]?.markets?.find((m) => m.key === "h2h");
        const outcome = market?.outcomes?.find((o) => o.name?.toUpperCase().includes(teamToken));
        if (outcome && Number.isFinite(outcome.price)) {
          touched = true;
          return { ...leg, closing_odds_american: Math.round(outcome.price) };
        }
      }

      // Player prop. Match against the prop market for this stat type.
      // Capture both the closing price AND the closing line value so
      // downstream CLV math can decide whether the comparison is
      // apples-to-apples (same line) or ambiguous (line drifted).
      if (
        mt === "player_prop"
        && leg.stat_type
        && leg.line_value != null
        && (leg.direction === "MORE" || leg.direction === "LESS")
      ) {
        const sport = String(leg.sport ?? "").toLowerCase();
        const marketKey = PROP_MARKET_KEYS[sport]?.[String(leg.stat_type).toLowerCase()];
        const player = playerNameFromSelection(leg.selection);
        if (marketKey && player) {
          const hit = findPropOutcome(ev, marketKey, player, leg.direction, leg.line_value);
          if (hit) {
            touched = true;
            return {
              ...leg,
              closing_odds_american: Math.round(hit.price),
              closing_line_value: hit.point,
            };
          }
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

  // Persist the run's worst-status to the singleton odds_api_health
  // row so Insights Data Health can surface "quota exhausted" et al.
  // without users having to read the function's response body. The
  // banner copy is built here so the client never has to translate
  // upstream error codes into UI strings.
  const finalStatus: HealthStatus =
    runStatus === "unknown" && (parlays?.length ?? 0) === 0
      ? "ok"  // nothing to poll → nothing to be wrong about
      : runStatus === "unknown"
        ? "ok"
        : runStatus;
  const banner = (() => {
    switch (finalStatus) {
      case "quota_exhausted":
        return "The Odds API monthly quota exhausted — closing-line capture paused until quota resets or plan upgrades.";
      case "auth_failed":
        return "The Odds API rejected the configured API key — verify THE_ODDS_API_KEY secret on the Edge function.";
      case "invalid_market":
        return runMessage
          ? `The Odds API rejected a market: ${runMessage}`
          : "The Odds API rejected one or more requested markets — function dropped them and continued.";
      case "rate_limited":
        return "The Odds API rate-limited the poller — this run is partial; next cron tick will retry.";
      case "network_error":
        return "The Odds API was unreachable for at least one sport — partial run.";
      case "ok":
        return parlays?.length === 0
          ? "No pending parlays in the closing-line window — nothing to poll."
          : `Healthy — ${gamesPolled} games polled, ${legsUpdated} legs updated.`;
      default:
        return "Closing-line poller status unknown.";
    }
  })();

  try {
    await supabase
      .from("odds_api_health")
      .upsert({
        id: "singleton",
        status: finalStatus,
        error_code: runErrorCode,
        sport_key: runSportKey,
        message: banner,
        parlays_scanned: parlays?.length ?? 0,
        games_polled: gamesPolled,
        legs_updated: legsUpdated,
        observed_at: new Date().toISOString(),
      }, { onConflict: "id" });
  } catch (e) {
    // Health upsert failure is non-fatal — the poll itself still
    // happened and the response below carries the details.
    errors.push(`health_upsert: ${String(e).slice(0, 100)}`);
  }

  return json({
    ok: finalStatus === "ok",
    health_status: finalStatus,
    error_code: runErrorCode,
    sport_key: runSportKey,
    message: banner,
    parlays_scanned: parlays?.length ?? 0,
    games_polled: gamesPolled,
    legs_updated: legsUpdated,
    errors: errors.slice(0, 10),
  });
});
