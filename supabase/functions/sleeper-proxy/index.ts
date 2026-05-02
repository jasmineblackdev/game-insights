/**
 * sleeper-proxy — server-side wrapper around api.sleeper.app for
 * NFL roster + injury data.
 *
 * Sleeper's API is public and keyless, and their CORS policy
 * generally allows browsers — so why a proxy?
 *
 *   1. Bandwidth — /v1/players/nfl is ~5MB raw. We expose a
 *      narrower /injuries route that walks the roster server-side
 *      and returns ONLY the injured players (~30-150 rows
 *      depending on the week). Saves ~99% of the bytes for the
 *      common case.
 *   2. Uniform shape with the rest of the data layer (odds-api-
 *      proxy, balldontlie-proxy). Same wrapped-4xx pattern, same
 *      CORS surface.
 *   3. Future-proof — if Sleeper ever rate-limits or breaks CORS,
 *      we already control the boundary.
 *
 * Routes (passed as `?path=...`):
 *   players/nfl              — full NFL roster (large)
 *   injuries/nfl             — injured-only subset, normalized
 *   state/nfl                — current week / season
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SLEEPER_UPSTREAM = "https://api.sleeper.app/v1";

const ALLOWED_PATHS = new Set([
  "players/nfl",
  "injuries/nfl",   // synthesized — we walk players/nfl and filter
  "state/nfl",
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface SleeperPlayer {
  player_id?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  team?: string | null;
  position?: string | null;
  status?: string | null;
  injury_status?: string | null;
  injury_body_part?: string | null;
  injury_notes?: string | null;
  injury_start_date?: string | null;
  active?: boolean;
}

interface NormalizedInjury {
  player_id: string;
  full_name: string;
  team: string | null;
  position: string | null;
  injury_status: string;
  injury_body_part: string | null;
  injury_notes: string | null;
  injury_start_date: string | null;
}

/**
 * Filter the full NFL roster down to active players with a non-null
 * injury_status. The roster object is keyed by player_id; we walk
 * once and emit a small array. ~5MB → ~30-150 rows.
 */
function normalizeInjuries(roster: Record<string, SleeperPlayer>): NormalizedInjury[] {
  const out: NormalizedInjury[] = [];
  for (const [pid, p] of Object.entries(roster)) {
    if (!p || typeof p !== "object") continue;
    const status = (p.injury_status ?? "").trim();
    if (!status) continue;
    // "Healthy" / "" / null all mean no injury — Sleeper sometimes
    // leaves the field as "Healthy" instead of clearing it. Skip
    // those so the consumer doesn't have to.
    if (status.toLowerCase() === "healthy") continue;
    // Skip players with no team (free agents / retired) — they
    // can't show up in a slate, so the injury isn't actionable.
    if (!p.team) continue;
    out.push({
      player_id:         p.player_id ?? pid,
      full_name:         p.full_name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
      team:              p.team,
      position:          p.position ?? null,
      injury_status:     status,
      injury_body_part:  p.injury_body_part ?? null,
      injury_notes:      p.injury_notes ?? null,
      injury_start_date: p.injury_start_date ?? null,
    });
  }
  // Stable order so callers can dedupe by index if needed.
  out.sort((a, b) => a.full_name.localeCompare(b.full_name));
  return out;
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

  const path = url.searchParams.get("path");
  if (!path) return json({ error: "missing_path" }, 400);
  if (!ALLOWED_PATHS.has(path)) {
    return json({ error: "path_not_allowed", path, allowed: [...ALLOWED_PATHS] }, 400);
  }

  // injuries/nfl is synthesized from the full roster — Sleeper has
  // no dedicated injury endpoint, the data lives on each player row.
  const upstreamPath = path === "injuries/nfl" ? "players/nfl" : path;
  const target = `${SLEEPER_UPSTREAM}/${upstreamPath}`;

  try {
    const r = await fetch(target, { headers: { Accept: "application/json" } });
    const text = await r.text();

    if (!r.ok) {
      // Wrap 4xx in 200 envelope, surface 5xx.
      if (r.status >= 400 && r.status < 500) {
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* keep as text */ }
        return json({
          proxied:         true,
          upstream_status: r.status,
          body:            parsed,
        }, 200);
      }
      return new Response(text, {
        status: r.status,
        headers: {
          ...corsHeaders,
          "Content-Type": r.headers.get("Content-Type") ?? "application/json",
        },
      });
    }

    if (path === "injuries/nfl") {
      // Server-side filter — caller gets only the actionable rows.
      let parsed: Record<string, SleeperPlayer>;
      try {
        parsed = JSON.parse(text);
      } catch {
        return json({ error: "invalid_upstream_json" }, 502);
      }
      const injuries = normalizeInjuries(parsed);
      return json({
        fetched_at: new Date().toISOString(),
        count:      injuries.length,
        injuries,
      }, 200);
    }

    // Pass through verbatim for non-synthesized routes.
    return new Response(text, {
      status: r.status,
      headers: {
        ...corsHeaders,
        "Content-Type": r.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch (err) {
    return json({
      error:  "sleeper_fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    }, 502);
  }
});
