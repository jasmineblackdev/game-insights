import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function rowToItem(row: Record<string, unknown>): Record<string, unknown> {
  const explanations = row.explanations;
  const item: Record<string, unknown> = {
    id: row.id,
    player_name: row.player_name,
    sport: row.sport,
    game_id: row.game_id,
    player_id: row.player_id,
    team: row.team_abbr,
    opponent: row.opponent_abbr,
    game_time: row.game_time,
    stat_type: row.stat_type,
    line_value: Number(row.line_value),
    projected_value: Number(row.projected_value),
    prediction_direction: row.prediction_direction,
    edge: Number(row.edge),
    confidence: row.confidence,
    reason_1: row.reason_1,
    reason_2: row.reason_2,
    risk_factor: row.risk_factor,
    game_sort: row.game_sort,
  };
  if (row.confidence_score_0_100 != null) {
    item.confidence_score_0_100 = row.confidence_score_0_100;
  }
  if (Array.isArray(explanations)) {
    item.explanations = explanations;
  }
  if (row.risk_tier) item.risk_tier = row.risk_tier;
  if (row.consistency_label) item.consistency_label = row.consistency_label;
  if (row.trend_note) item.trend_note = row.trend_note;
  return item;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const sport = url.searchParams.get("sport");
    const statType = url.searchParams.get("statType");
    const id = url.searchParams.get("id");

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    let q = supabase
      .from("player_projections")
      .select("*")
      .eq("status", "active")
      .order("game_sort", { ascending: true });

    if (id) {
      q = q.eq("id", id);
    } else {
      if (sport && sport !== "all") q = q.eq("sport", sport);
      if (statType && statType !== "all") q = q.eq("stat_type", statType);
    }

    const { data: rows, error } = await q;
    if (error) throw error;

    const items = (rows ?? []).map((r) => rowToItem(r as Record<string, unknown>));

    const { data: accRows, error: accErr } = await supabase.rpc("player_edge_accuracy_7d");
    let accuracy: Record<string, unknown> | undefined;
    if (!accErr && accRows && Array.isArray(accRows) && accRows[0]) {
      const a = accRows[0] as { wins: number | string; losses: number | string; pushes: number | string };
      const wins = Number(a.wins);
      const losses = Number(a.losses);
      const pushes = Number(a.pushes);
      const total = wins + losses + pushes;
      accuracy = { window: "7d", wins, losses, pushes, total };
    }

    return new Response(JSON.stringify({ items, accuracy }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg, items: [], accuracy: undefined }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
