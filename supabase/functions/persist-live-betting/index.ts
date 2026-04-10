import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type StageRow = Record<string, unknown>;

function isValidStage(r: unknown): r is StageRow {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 4 &&
    typeof o.game_id === "string" &&
    typeof o.league === "string" &&
    typeof o.stage_kind === "string"
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")?.trim();
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!url || !service) return json({ error: "supabase_env_missing" }, 503);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const stages = (body as { stages?: unknown }).stages;
  if (!Array.isArray(stages) || stages.length === 0) {
    return json({ error: "stages_required" }, 400);
  }
  if (stages.length > 80) return json({ error: "too_many_stages" }, 400);

  const cleaned: StageRow[] = [];
  for (const s of stages) {
    if (!isValidStage(s)) continue;
    cleaned.push(s);
  }
  if (!cleaned.length) return json({ error: "no_valid_stages" }, 400);

  const supabase = createClient(url, service);
  const { error } = await supabase.from("live_betting_stages").upsert(cleaned, { onConflict: "id" });
  if (error) {
    console.error("[persist-live-betting]", error);
    return json({ error: "upsert_failed", detail: error.message }, 500);
  }

  return json({ ok: true, upserted: cleaned.length });
});
