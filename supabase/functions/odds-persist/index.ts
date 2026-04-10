import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-odds-persist-secret",
};

const UPSTREAM = "https://api.the-odds-api.com/v4";

const DEFAULT_SPORT_KEYS = [
  "basketball_nba",
  "americanfootball_nfl",
  "baseball_mlb",
  "soccer_epl",
] as const;

type Bookmaker = {
  key?: string;
  title?: string;
  markets?: { key?: string; outcomes?: { name?: string; price?: number; point?: number }[] }[];
};

type OddsEvent = {
  id?: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: Bookmaker[];
};

type SnapshotRow = {
  sport: string;
  game_id: string;
  sportsbook_id: string;
  market_type: string;
  side_key: string;
  stat_type: string | null;
  line_value: number | null;
  american_odds: number;
  implied_probability: number;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function americanToImplied(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 0.5;
  if (american < 0) {
    const a = Math.abs(american);
    return a / (a + 100);
  }
  return 100 / (american + 100);
}

function sideKeySlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 200) || "side";
}

function stableGameId(sportKey: string, ev: OddsEvent): string {
  const eid = ev.id != null ? String(ev.id).trim() : "";
  if (eid.length >= 8 && /^[a-zA-Z0-9-]+$/.test(eid)) {
    return `${sportKey}:${eid}`;
  }
  const h = sideKeySlug(ev.home_team);
  const a = sideKeySlug(ev.away_team);
  const t = (ev.commence_time ?? "").slice(0, 16).replace(/[^0-9T-]/g, "");
  return `${sportKey}:${h}:${a}:${t}`;
}

async function ensureSportsbook(
  supabase: ReturnType<typeof createClient>,
  key: string,
  name: string
): Promise<string | null> {
  const k = key.slice(0, 80);
  const n = (name || key).slice(0, 120);
  const { data, error } = await supabase
    .from("sportsbooks")
    .upsert({ key: k, name: n, is_active: true }, { onConflict: "key" })
    .select("id")
    .single();
  if (!error && data?.id) return data.id as string;
  const { data: row } = await supabase.from("sportsbooks").select("id").eq("key", k).maybeSingle();
  return (row?.id as string) ?? null;
}

function collectRowsFromBook(
  sportKey: string,
  gameId: string,
  sportsbookId: string,
  book: Bookmaker
): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  const markets = book.markets ?? [];

  for (const m of markets) {
    const mk = m.key ?? "";
    if (!["h2h", "spreads", "totals"].includes(mk)) continue;
    const outs = m.outcomes ?? [];
    for (const o of outs) {
      const price = o.price;
      if (typeof price !== "number" || !Number.isFinite(price)) continue;
      const implied = americanToImplied(price);
      const name = (o.name ?? "").trim();
      if (!name) continue;

      if (mk === "h2h") {
        rows.push({
          sport: sportKey,
          game_id: gameId,
          sportsbook_id: sportsbookId,
          market_type: "h2h",
          side_key: sideKeySlug(name),
          stat_type: null,
          line_value: null,
          american_odds: Math.round(price),
          implied_probability: Math.round(implied * 10000) / 10000,
        });
      } else if (mk === "spreads") {
        const pt = o.point;
        rows.push({
          sport: sportKey,
          game_id: gameId,
          sportsbook_id: sportsbookId,
          market_type: "spreads",
          side_key: sideKeySlug(name),
          stat_type: null,
          line_value: typeof pt === "number" && Number.isFinite(pt) ? pt : null,
          american_odds: Math.round(price),
          implied_probability: Math.round(implied * 10000) / 10000,
        });
      } else if (mk === "totals") {
        const nl = name.toLowerCase();
        const side = nl.includes("over") ? "over" : nl.includes("under") ? "under" : sideKeySlug(name);
        const pt = o.point;
        rows.push({
          sport: sportKey,
          game_id: gameId,
          sportsbook_id: sportsbookId,
          market_type: "totals",
          side_key: side,
          stat_type: null,
          line_value: typeof pt === "number" && Number.isFinite(pt) ? pt : null,
          american_odds: Math.round(price),
          implied_probability: Math.round(implied * 10000) / 10000,
        });
      }
    }
  }
  return rows;
}

async function fetchOddsForSport(
  apiKey: string,
  sportKey: string,
  regions: string,
  markets: string
): Promise<OddsEvent[]> {
  const q = new URLSearchParams({
    regions,
    markets,
    oddsFormat: "american",
    apiKey,
  });
  const url = `${UPSTREAM}/sports/${encodeURIComponent(sportKey)}/odds?${q.toString()}`;
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`odds_api_${r.status}: ${t.slice(0, 200)}`);
  }
  const data = (await r.json()) as unknown;
  return Array.isArray(data) ? (data as OddsEvent[]) : [];
}

async function mergeLatest(
  supabase: ReturnType<typeof createClient>,
  row: SnapshotRow
): Promise<{ error?: string }> {
  const { error } = await supabase.rpc("merge_odds_latest_row", {
    p_sport: row.sport,
    p_game_id: row.game_id,
    p_sportsbook_id: row.sportsbook_id,
    p_market_type: row.market_type,
    p_side_key: row.side_key,
    p_stat_type: row.stat_type ?? null,
    p_line_value: row.line_value,
    p_american: row.american_odds,
    p_implied: row.implied_probability,
  });
  if (error) return { error: error.message };
  return {};
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const persistSecret = Deno.env.get("ODDS_PERSIST_SECRET")?.trim();
  const hdr = req.headers.get("x-odds-persist-secret")?.trim();
  if (!persistSecret || hdr !== persistSecret) {
    return json({ error: "unauthorized", hint: "Set x-odds-persist-secret header" }, 401);
  }

  const apiKey = Deno.env.get("THE_ODDS_API_KEY")?.trim();
  if (!apiKey) {
    return json({ error: "the_odds_api_key_not_configured" }, 503);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "supabase_service_env_missing" }, 503);
  }

  let body: {
    sportKeys?: string[];
    regions?: string;
    markets?: string;
  } = {};
  try {
    const t = await req.text();
    if (t) body = JSON.parse(t) as typeof body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const sportKeys =
    Array.isArray(body.sportKeys) && body.sportKeys.length > 0
      ? body.sportKeys.filter((k) => /^[a-zA-Z0-9_]+$/.test(k))
      : [...DEFAULT_SPORT_KEYS];
  if (!sportKeys.length) {
    return json({ error: "no_valid_sport_keys" }, 400);
  }
  if (sportKeys.length > 15) {
    return json({ error: "too_many_sport_keys", max: 15 }, 400);
  }

  const regions = body.regions && /^[a-z]{2}$/i.test(body.regions) ? body.regions : "us";
  const markets =
    body.markets && /^[a-z0-9,_-]+$/i.test(body.markets) ? body.markets : "h2h,spreads,totals";

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const allSnapshots: SnapshotRow[] = [];
  const errors: string[] = [];
  let eventsTotal = 0;

  for (const sportKey of sportKeys) {
    try {
      const events = await fetchOddsForSport(apiKey, sportKey, regions, markets);
      eventsTotal += events.length;
      for (const ev of events) {
        const gameId = stableGameId(sportKey, ev);
        const books = ev.bookmakers ?? [];
        for (const book of books) {
          const bkey = (book.key ?? "unknown").slice(0, 80);
          const btitle = (book.title ?? book.key ?? "Book").slice(0, 120);
          const sid = await ensureSportsbook(supabase, bkey, btitle);
          if (!sid) {
            errors.push(`sportsbook_upsert_failed:${bkey}`);
            continue;
          }
          allSnapshots.push(...collectRowsFromBook(sportKey, gameId, sid, book));
        }
      }
    } catch (e) {
      errors.push(`${sportKey}:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let snapshotsInserted = 0;
  const chunk = 250;
  for (let i = 0; i < allSnapshots.length; i += chunk) {
    const slice = allSnapshots.slice(i, i + chunk);
    const { error } = await supabase.from("odds_snapshots").insert(slice);
    if (error) {
      errors.push(`snapshots_insert:${error.message}`);
    } else {
      snapshotsInserted += slice.length;
    }
  }

  let latestMerged = 0;
  const mergeErrors: string[] = [];
  const MERGE_CONCURRENCY = 45;
  for (let i = 0; i < allSnapshots.length; i += MERGE_CONCURRENCY) {
    const batch = allSnapshots.slice(i, i + MERGE_CONCURRENCY);
    const results = await Promise.all(batch.map((row) => mergeLatest(supabase, row)));
    for (const r of results) {
      if (r.error) mergeErrors.push(r.error);
      else latestMerged++;
    }
  }

  const mergeUnique = [...new Set(mergeErrors)];

  return json({
    ok: errors.length === 0 && mergeErrors.length === 0,
    sportKeys,
    events_seen: eventsTotal,
    snapshots_inserted: snapshotsInserted,
    odds_latest_merged: latestMerged,
    snapshot_rows_built: allSnapshots.length,
    errors: errors.length ? errors : undefined,
    merge_errors_sample: mergeUnique.slice(0, 12),
    merge_errors_total: mergeErrors.length,
  });
});
