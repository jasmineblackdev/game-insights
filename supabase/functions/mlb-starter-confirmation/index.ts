import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

/**
 * HTTP API for MLB probable-starter self-confirmation (same data as mlb_starter_user_confirmations).
 *
 * Deploy: supabase functions deploy mlb-starter-confirmation
 *
 * GET  — list your confirmations: { confirmations: [{ game_id, confirmed, updated_at }] }
 * POST — body: { "game_id": "401772893", "confirmed": true }  (false clears row)
 *
 * Headers: Authorization: Bearer <user_access_token>, apikey: <anon_key>
 */
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

function userClient(req: Request) {
  const url = Deno.env.get("SUPABASE_URL")?.trim();
  const anon = Deno.env.get("SUPABASE_ANON_KEY")?.trim();
  const auth = req.headers.get("Authorization") ?? "";
  if (!url || !anon) return null;
  return createClient(url, anon, {
    global: { headers: { Authorization: auth } },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = userClient(req);
  if (!supabase) return json({ error: "supabase_env_missing" }, 503);

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) return json({ error: "unauthorized" }, 401);

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("mlb_starter_user_confirmations")
      .select("game_id, confirmed, updated_at");
    if (error) return json({ error: error.message }, 500);
    return json({ confirmations: data ?? [] });
  }

  if (req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const gameId = typeof body.game_id === "string" ? body.game_id : typeof body.gameId === "string" ? body.gameId : "";
    if (!gameId || gameId.length > 64) return json({ error: "invalid_game_id" }, 400);
    const confirmed = body.confirmed !== false;

    if (!confirmed) {
      const { error } = await supabase.from("mlb_starter_user_confirmations").delete().eq("game_id", gameId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, game_id: gameId, confirmed: false });
    }

    const { error } = await supabase.from("mlb_starter_user_confirmations").upsert(
      {
        user_id: user.id,
        game_id: gameId,
        confirmed: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,game_id" }
    );
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, game_id: gameId, confirmed: true });
  }

  return json({ error: "method_not_allowed" }, 405);
});
