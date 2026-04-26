/**
 * parse-parlay-screenshot — Anthropic Vision wrapper that turns
 * one or more bet-slip screenshots into a structured parlay JSON
 * the client can pre-fill into ManualParlayEntryForm.
 *
 * The browser POSTs:
 *   { images: ["data:image/png;base64,...", ...], hint?: string }
 *
 * The function POSTs to Anthropic /v1/messages with the images +
 * a strict-JSON-mode prompt asking Claude to extract:
 *   { combined_american_odds, wager, payout, parlay_outcome,
 *     bet_id, placed_at, sport_mix, market_mix,
 *     legs: [{ selection, sport, market_type, odds, line_value,
 *              direction, stat_type, leg_outcome, game_label,
 *              final_score }] }
 *
 * Returns 200 with the parsed object on success. Anthropic errors and
 * malformed JSON come back as HTTP 502 with `{ error, detail }`. The
 * caller should still let the user verify before saving — vision
 * extraction can mis-OCR small text and team abbreviations.
 *
 * Cost: ~1 vision call per parlay; phone screenshots are ~1100
 * tokens of image data, so each extract is roughly $0.005 on Sonnet.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL         = "claude-sonnet-4-6";
const MAX_IMAGES    = 4;

// Trimmed extraction prompt — explicit about JSON shape, units, and
// the fact that some legs may be unresolved.
const SYSTEM_PROMPT = `You are extracting a sportsbook parlay from one or more bet-slip screenshots. Return ONLY a single JSON object matching this exact shape — no prose, no markdown fences:

{
  "combined_american_odds": <integer, e.g. +1542 → 1542 or -213>,
  "wager":                  <number, dollars staked>,
  "payout":                 <number, paid out, 0 if lost or pending>,
  "parlay_outcome":         "won" | "lost" | "push" | "pending" | "partial",
  "bet_id":                 <string or null>,
  "placed_at":              <ISO 8601 string or null>,
  "sport_mix":              <comma-joined sport tags, e.g. "MLB,NBA">,
  "market_mix":             <comma-joined market types, e.g. "team_moneyline,player_prop">,
  "legs": [
    {
      "selection":     <string, e.g. "Ian Happ Hits Over 0.5">,
      "sport":         "NBA" | "WNBA" | "NFL" | "MLB" | "Boxing" | "MMA" | "Other",
      "market_type":   "team_moneyline" | "player_prop" | "spread" | "total" | "other",
      "odds":          <integer American or null if not visible>,
      "line_value":    <number or null>,
      "direction":     "MORE" | "LESS" | null,
      "stat_type":     <e.g. "hits", "points_assists", "total_bases", "moneyline">,
      "leg_outcome":   "win" | "loss" | "push" | "pending",
      "game_label":    <e.g. "CHC @ LAD" or null>,
      "final_score":   <e.g. "CHC 0 - LAD 6" or null>
    }
  ]
}

Rules:
- Treat the red ⊗ icon as leg loss; green ✓ as win; empty circle / "in progress" as pending.
- The parlay-level outcome badge (LOST / WON / red box / green box near top) wins over leg sums when they conflict.
- If a parlay shows LOST overall but has unfinished legs, set those legs to "pending" and parlay_outcome to "lost".
- Map "Moneyline" market_type to "team_moneyline".
- Map "Total Bases O/U", "Points + Assists O/U", "Hits O/U", etc. to "player_prop" with the appropriate stat_type and direction.
- "Over 0.5" / "Over 1.5" → direction "MORE"; "Under 30.5" → direction "LESS".
- "20+" anytime-style stat targets are MORE with line_value the threshold (e.g. 20+ → line_value 20, direction MORE).
- combined_american_odds: convert "+1542" to 1542; "-213" to -213.
- If multiple screenshots are passed, treat them as different parts of the SAME parlay (use them together to fill leg gaps). Only return one parlay per request.

Return JUST the JSON. No commentary.`;

interface ParseRequest {
  images: string[];
  hint?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Anthropic image content blocks expect base64 + media_type. The
 * client sends data URIs like "data:image/png;base64,iVBOR..." — we
 * split that into the parts the API needs.
 */
function dataUriToImageBlock(uri: string): { type: "image"; source: { type: "base64"; media_type: string; data: string } } | null {
  const m = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/i.exec(uri);
  if (!m) return null;
  let mediaType = m[1].toLowerCase();
  if (mediaType === "image/jpg") mediaType = "image/jpeg";
  return { type: "image", source: { type: "base64", media_type: mediaType, data: m[2] } };
}

/**
 * Pull a JSON object out of Claude's response, even if it accidentally
 * wrapped things in ```json fences. Returns null on parse failure.
 */
function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const raw = fenced ? fenced[1].trim() : text.trim();
  try { return JSON.parse(raw); } catch { /* fall through */ }
  // Last-ditch: find the first { and matching }.
  const start = raw.indexOf("{");
  const end   = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!apiKey) return json({ error: "anthropic_key_not_configured" }, 503);

  let body: ParseRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json_body" }, 400);
  }

  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  if (images.length === 0) return json({ error: "no_images_provided" }, 400);

  const imageBlocks = images
    .map(dataUriToImageBlock)
    .filter((b): b is NonNullable<ReturnType<typeof dataUriToImageBlock>> => b !== null);
  if (imageBlocks.length === 0) {
    return json({ error: "could_not_decode_any_images", detail: "Send data URIs like data:image/png;base64,..." }, 400);
  }

  const userContent: Array<unknown> = [...imageBlocks];
  if (body.hint && typeof body.hint === "string") {
    userContent.push({ type: "text", text: `Hint from user: ${body.hint.slice(0, 500)}` });
  }
  userContent.push({ type: "text", text: "Extract the parlay as JSON per the system instructions." });

  const anthropicReq = {
    model:       MODEL,
    max_tokens:  2048,
    system:      SYSTEM_PROMPT,
    messages:    [{ role: "user", content: userContent }],
  };

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method:  "POST",
      headers: {
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type":      "application/json",
      },
      body: JSON.stringify(anthropicReq),
    });
  } catch (e) {
    return json({ error: "anthropic_unreachable", detail: String(e) }, 502);
  }

  const text = await res.text();
  if (!res.ok) {
    return json({ error: "anthropic_error", upstream_status: res.status, detail: text.slice(0, 500) }, 502);
  }

  let parsed: { content?: Array<{ type: string; text?: string }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return json({ error: "anthropic_response_not_json", detail: text.slice(0, 500) }, 502);
  }

  const textBlock = parsed.content?.find((c) => c.type === "text" && typeof c.text === "string");
  if (!textBlock?.text) {
    return json({ error: "anthropic_no_text_block", detail: text.slice(0, 500) }, 502);
  }

  const parlay = extractJson(textBlock.text);
  if (!parlay || typeof parlay !== "object") {
    return json({ error: "could_not_parse_parlay_json", model_text: textBlock.text.slice(0, 800) }, 502);
  }

  return json({ parlay, model: MODEL, image_count: imageBlocks.length });
});
