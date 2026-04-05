import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function num(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function rowToCard(row: Record<string, unknown>): Record<string, unknown> {
  const kind = str(row.card_kind);
  const league = str(row.league);
  const confidence = str(row.confidence);
  const ouPred = str(row.ou_prediction);
  const roundPred = str(row.round_prediction);

  const card: Record<string, unknown> = {
    id: str(row.external_id) ?? String(row.id),
    kind,
    league,
    year: Number(row.year),
    player_id: str(row.player_id) ?? "",
    player_name: str(row.player_name) ?? "",
    position: str(row.position) ?? "",
    college: str(row.college) ?? "",
    confidence,
    grade: str(row.grade) ?? "",
    reason_1: str(row.reason_1) ?? "",
    reason_2: str(row.reason_2) ?? "",
    risk_factor: str(row.risk_factor) ?? "",
    tags: Array.isArray(row.tags) ? row.tags : [],
  };

  const tier = str(row.tier);
  if (tier) card.tier = tier;
  const updated = str(row.updated_at);
  if (updated) card.updated_at = updated;

  const pn = num(row.pick_number);
  if (pn != null) card.pick_number = Math.round(pn);
  const pt = str(row.predicted_team);
  if (pt) card.predicted_team = pt;
  const pta = str(row.predicted_team_abbr);
  if (pta) card.predicted_team_abbr = pta;
  const prob = num(row.probability);
  if (prob != null) card.probability = Math.round(prob);
  const pl = num(row.prob_low);
  if (pl != null) card.prob_low = Math.round(pl);
  const ph = num(row.prob_high);
  if (ph != null) card.prob_high = Math.round(ph);

  const ouLine = num(row.ou_line);
  if (ouLine != null) card.ou_line = ouLine;
  if (ouPred === "OVER" || ouPred === "UNDER") card.ou_prediction = ouPred;
  const proj = num(row.projected_pick);
  if (proj != null) card.projected_pick = Math.round(proj);
  if (roundPred === "yes" || roundPred === "no") card.round_prediction = roundPred;

  const tta = str(row.team_target_abbr);
  if (tta) card.team_target_abbr = tta;
  const tnp = str(row.team_need_position);
  if (tnp) card.team_need_position = tnp;
  const fpl = str(row.first_position_label);
  if (fpl) card.first_position_label = fpl;
  const mn = str(row.mover_note);
  if (mn) card.mover_note = mn;

  return card;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const yearParam = url.searchParams.get("year");
    const leagueParam = (url.searchParams.get("league") ?? "nfl").toLowerCase();

    const year = yearParam ? Number(yearParam) : new Date().getUTCFullYear();
    if (!Number.isFinite(year)) {
      return new Response(JSON.stringify({ error: "Invalid year", items: [] }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (leagueParam !== "nfl" && leagueParam !== "nba") {
      return new Response(JSON.stringify({ error: "league must be nfl or nba", items: [] }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: rows, error } = await supabase
      .from("draft_predictions")
      .select("*")
      .eq("year", year)
      .eq("league", leagueParam)
      .order("external_id", { ascending: true });

    if (error) throw error;

    const items = (rows ?? []).map((r) => rowToCard(r as Record<string, unknown>));

    return new Response(JSON.stringify({ items }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg, items: [] }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
