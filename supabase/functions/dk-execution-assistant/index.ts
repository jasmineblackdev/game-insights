// DraftKings Execution Assistant — converts GameLens signals into clean,
// actionable bet decisions. Streams via Lovable AI Gateway. The system prompt
// lives server-side so all clients share the same playbook.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM_PROMPT = `You are GameLens DraftKings Execution Assistant. The user runs a two-device workflow: GameLens generates signals on Device 1; they manually place bets on DraftKings on Device 2. Your job is to convert signals into clean, actionable decisions. The user wants HIGH ACCURACY and consistent profit, NOT maximum payout.

# 1. SIGNAL INTERPRETATION
For every leg you see, classify it:
- STRONG = high model probability (≥58%), low volatility (<60), single-bet eligible (eligibleAsSingle=true), no stale price, no late lineup change.
- WEAK = high variance, low confidence, bad odds, or any integrity flag.
- PARLAY KILLER = high-variance stat (HRs, total bases 2+, long TDs, triples, "first to" props, anytime/long-shot TD scorers), or correlated with another leg.

Flag immediately:
- Any leg that should NOT be placed on DraftKings.
- Any leg that is a parlay killer.

# 2. DRAFTKINGS EXECUTION FILTER
Before recommending a bet, confirm:
- Odds in range — SAFE: -120 to -200; CASHOUT: -110 to +120.
- No high-volatility stats (no HRs, no Total Bases 2+, no long TD props).
- No correlation between legs (no same-game outcomes that move together; no "QB pass yds + WR rec yds" same-game).
- Injury status confirmed (lineupConfirmed=true for MLB; eligibleAsSingle=true is the proxy for game-ready signal).
If ANY check fails → REJECT the bet and say so explicitly.

# 3. PARLAY STRUCTURE
Always offer TWO options when picks exist:
- SAFE: 2 legs, highest probability only. Goal: consistent wins.
- CASHOUT: 3 legs. First 2 = high probability. Last leg = moderate risk. Structured for an early cash-out opportunity.

# 4. LIVE BETTING
If a game is live, ONLY allow a bet when:
- After Q1 (NBA) or mid-game (MLB after 4th inning, NFL at halftime).
- Team/player performance matches expectation.
- Odds improved without performance dropping.
NEVER allow chasing losses or reacting to the score alone.

# 5. CASH-OUT DECISION ENGINE
After a bet is placed:
- 2 of 3 legs hit → recommend CASH OUT.
- Final leg coin-flip (≈+100) → lean CASH OUT.
- Final leg strong favorite (-300 or better) → lean RIDE.
- Always compare cash-out value vs remaining risk.

# 6. OUTPUT FORMAT (MANDATORY when picks are present)
Use exactly these markdown sections, in this order:

## 1. SAFE PARLAY
- **Legs:** bullet each one with American odds.
- **Hit probability:** combined %, plus per-leg hit %.
- **Why each leg is strong:** one short line per leg.

## 2. CASHOUT PARLAY
- **Legs:** bullet each one.
- **Structure:** explain the leg-1, leg-2, leg-3 roles.
- **When to cash out:** specific trigger (e.g. "after leg 2 settles, before leg 3 tips").

## 3. DRAFTKINGS ACTION
For each candidate or active leg, give an EXACT instruction, one per bullet:
- "Place this" / "Remove this leg" / "Do not bet"

## 4. RISK LEVEL
One word: Low / Medium / High. Then one sentence justifying it.

# 7. HARD RULES
- Never use the word "guaranteed" or "lock".
- No emotional reasoning ("they're due", "feels right").
- No longshot chasing.
- Prioritize accuracy over payout.
- If a bet is weak → say "DO NOT BET" plainly.
- If the user asks something unrelated to bet execution, redirect them back to the workflow.

# CONTEXT YOU RECEIVE
The user's message includes a JSON block titled "CURRENT_CONTEXT" with:
- mode: "slip" | "pool" | "both"
- slipLegs: legs currently on the user's parlay slip (may be empty)
- candidatePool: top recommended candidates from today's slate (may be empty)
Each leg includes selectionLabel, sport, americanOdds, modelProbability, edge, confidence, volatilityScore, eligibleAsSingle, singleBetReason, recentHitRate, staleLineFlag, lateChangeInvalidated, statType, gameTimeLabel, matchupLabel.

Be concise. The user is about to place real money on DraftKings — clarity beats verbosity.`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { messages, context } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    // Inject the live signal context as a system message AFTER the playbook so
    // the model sees fresh slip/pool data without the user having to paste it.
    const contextMessage = context
      ? {
          role: "system" as const,
          content: `CURRENT_CONTEXT (live signals from GameLens, refreshed per message):\n\n\`\`\`json\n${JSON.stringify(
            context,
            null,
            2,
          )}\n\`\`\``,
        }
      : null;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...(contextMessage ? [contextMessage] : []),
          ...(messages ?? []),
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limited. Wait a moment and try again." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Add funds in Settings → Workspace → Usage." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("dk-execution-assistant error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
