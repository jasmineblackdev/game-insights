#!/usr/bin/env node
/**
 * Bulk-bridge recommended_parlays.legs → prediction_history.
 *
 * Reads every settled parlay from recommended_parlays, explodes its
 * legs into prediction_history rows so the ML feedback loop has data
 * to train on. Mirrors src/lib/learning/parlayLegBridge.ts (TS used
 * by the live ManualParlayEntryForm submit path).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-recommended-parlays-to-history.mjs
 *   (or just have those in .env.local)
 *
 *   --dry-run         report planned writes without inserting
 *   --window-days=N   only consider parlays from last N days (default 365)
 *   --limit=N         cap parlays processed (default 5000)
 *   --source=SRC      filter parlay source (e.g. user_manual, draftkings_manual)
 *
 * Idempotency: each leg gets a synthetic signature `${parlay_id}:L${i}`.
 * The script pre-fetches existing signatures and skips legs already
 * bridged. Safe to re-run after every screenshot ingest.
 *
 * Schema gates (live prediction_history):
 *   - sport must be in (nba, nfl, mlb, soccer)
 *   - outcome must be win | loss | push (pending legs skipped)
 *
 * IMPORTANT — model_probability semantics:
 *   For user-entered parlays we don't have the model's actual
 *   probability at pick time. We use implied-from-American-odds as a
 *   proxy and tag the row with extra.model_probability_source =
 *   "implied_odds" / "implied_field" / "confidence_proxy". Filter the
 *   backtest to exclude these tags if you only want rows where
 *   model_probability is a true model output.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvLocal() {
  const envPath = join(__dirname, "..", ".env.local");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
  }
}
loadEnvLocal();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — set them in .env.local.");
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^-+/, "").split("=");
    return [k, v];
  })
);
const DRY_RUN     = args["dry-run"] === "true";
const WINDOW_DAYS = Number(args["window-days"] ?? 365);
const LIMIT       = Number(args.limit ?? 5000);
const SOURCE      = args.source ? String(args.source) : null;

const ALLOWED_SPORTS = new Set(["nba", "nfl", "mlb", "soccer"]);
const CONFIDENCE_HIT_PROB = {
  HIGH: 0.65, MED: 0.55, LOW: 0.5,
  high: 0.65, medium: 0.55, low: 0.5,
};

function americanToImplied(american) {
  if (!Number.isFinite(american)) return 0.5;
  return american >= 0 ? 100 / (american + 100) : -american / (-american + 100);
}

function modelProbForLeg(leg) {
  const odds = leg.american_odds ?? leg.odds ?? null;
  if (odds != null && Number.isFinite(odds)) return { value: americanToImplied(odds), source: "implied_odds" };
  if (leg.implied_prob != null && Number.isFinite(leg.implied_prob)) return { value: leg.implied_prob, source: "implied_field" };
  const conf = leg.confidence ?? "MED";
  return { value: CONFIDENCE_HIT_PROB[conf] ?? 0.5, source: "confidence_proxy" };
}

function normalizeConfidence(v) {
  const s = String(v ?? "medium").trim().toLowerCase();
  if (s === "high" || s === "h" || s === "hi") return "high";
  if (s === "low" || s === "l" || s === "lo") return "low";
  return "medium";
}

function pickSideFor(leg, idx) {
  if (leg.market_type === "player_prop" || leg.direction) {
    return (leg.direction ?? "more").toLowerCase();
  }
  const m = /^([A-Z]{2,4})\b/.exec(String(leg.selection ?? ""));
  return m?.[1]?.toLowerCase() ?? `leg${idx}`;
}

function errorSize(modelProb, outcome) {
  const y = outcome === "win" ? 1 : outcome === "loss" ? 0 : 0.5;
  return Math.round(Math.abs(modelProb - y) * 10000) / 10000;
}

function oddsRangeBucket(american) {
  if (american == null || !Number.isFinite(american)) return "unknown";
  if (american <= -250) return "heavy_favorite";
  if (american <= -150) return "favorite";
  if (american <= -110) return "pick_em_fav";
  if (american < 150) return "pick_em_dog";
  if (american < 250) return "underdog";
  return "longshot";
}

const DAY_OF_WEEK = ["sun","mon","tue","wed","thu","fri","sat"];

function parseHomeAwayContext(leg) {
  const label = String(leg.game_label ?? "").trim();
  const m = /^([A-Z][A-Z0-9]{1,4})\s*@\s*([A-Z][A-Z0-9]{1,4})$/.exec(label);
  if (!m) return { is_home: null, opponent: null, home_team: null, away_team: null };
  const [, away, home] = m;
  if (leg.market_type === "team_moneyline") {
    const sel = String(leg.selection ?? "").toUpperCase();
    if (sel.includes(home)) return { is_home: true, opponent: away, home_team: home, away_team: away };
    if (sel.includes(away)) return { is_home: false, opponent: home, home_team: home, away_team: away };
  }
  return { is_home: null, opponent: null, home_team: home, away_team: away };
}

function dayOfWeekFromIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return DAY_OF_WEEK[d.getDay()];
}

function monthFromIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.getMonth() + 1;
}

function buildPayload(parlay, leg, idx) {
  const sport = String(leg.sport ?? "").toLowerCase();
  const odds = leg.american_odds ?? leg.odds ?? null;
  const { value: modelP, source: modelPSource } = modelProbForLeg(leg);
  const market_type = leg.market_type === "player_prop" || leg.market_type === "team_moneyline"
    ? leg.market_type
    : (leg.stat_type ? "player_prop" : "team_moneyline");
  const signature = `${parlay.id}:L${idx}`;
  const homeAway = parseHomeAwayContext(leg);
  const dateForContext = parlay.recommended_at ?? parlay.date ?? null;
  // Three-snapshot CLV — same logic as src/lib/learning/parlayLegBridge.ts
  const oddsRec = leg.american_odds ?? leg.odds ?? null;
  const oddsPlc = leg.odds_at_placement ?? null;
  const oddsCls = leg.closing_odds_american ?? null;
  const fromOdds = oddsPlc ?? oddsRec;
  const clvPp = (fromOdds != null && oddsCls != null)
    ? Math.round((americanToImplied(oddsCls) - americanToImplied(fromOdds)) * 10000) / 10000
    : null;
  const clvAtPlacement = (oddsRec != null && oddsPlc != null)
    ? Math.round((americanToImplied(oddsPlc) - americanToImplied(oddsRec)) * 10000) / 10000
    : null;

  return {
    external_game_id: signature,
    sport,
    market_type,
    pick_side: pickSideFor(leg, idx),
    pick_label: leg.selection ?? `leg ${idx + 1}`,
    american_odds: odds != null ? String(Math.round(odds)) : "",
    implied_probability: odds != null ? String(americanToImplied(odds)) : "",
    model_probability: String(modelP),
    edge: "",
    confidence: normalizeConfidence(leg.confidence),
    risk_score: "",
    reason_tags: [],
    checkpoint_stage: "",
    prediction_phase: "pregame",
    final_home_score: "",
    final_away_score: "",
    outcome: leg.leg_outcome,
    error_size: String(errorSize(modelP, leg.leg_outcome)),
    odds_range_bucket: oddsRangeBucket(odds),
    stat_type: leg.stat_type ?? "",
    source: parlay.source === "draftkings_manual" ? "gamelens_dk_manual_bridge_v1" : "gamelens_parlay_bridge_v1",
    learning_phase: "1",
    user_id: parlay.user_id ?? null,
    extra: {
      parlay_leg_signature: signature,
      parlay_id: parlay.id,
      parlay_source: parlay.source ?? null,
      parlay_date: parlay.date ?? null,
      leg_index: idx,
      leg: {
        line_value: leg.line_value ?? null,
        direction: leg.direction ?? null,
        game_label: leg.game_label ?? null,
        final_score: leg.final_score ?? null,
        actual_value: leg.actual_value ?? null,
      },
      // Phase-A context features (mirror src/lib/learning/parlayLegBridge.ts)
      is_home:      homeAway.is_home,
      opponent:     homeAway.opponent,
      home_team:    homeAway.home_team,
      away_team:    homeAway.away_team,
      day_of_week:  dayOfWeekFromIso(dateForContext),
      month:        monthFromIso(dateForContext),
      odds_at_recommendation: oddsRec,
      odds_at_placement:      oddsPlc,
      closing_odds_american:  oddsCls,
      clv_at_placement:       clvAtPlacement,
      clv_pp:                 clvPp,
      model_probability_source: modelPSource,
    },
  };
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  let q = supabase
    .from("recommended_parlays")
    .select("id, source, date, recommended_at, resolved_at, legs, user_id, leg_count, outcome")
    .gte("recommended_at", cutoff)
    .in("outcome", ["won", "lost", "push", "partial"])
    .limit(LIMIT);
  if (SOURCE) q = q.eq("source", SOURCE);

  const { data: parlays, error } = await q;
  if (error) {
    console.error("recommended_parlays query failed:", error.message);
    process.exit(1);
  }
  if (!parlays?.length) {
    console.log(`No settled parlays found in last ${WINDOW_DAYS} days${SOURCE ? ` (source=${SOURCE})` : ""}.`);
    return;
  }

  // Pre-fetch existing signatures across all parlays in one query.
  const allSignatures = [];
  for (const p of parlays) {
    if (!Array.isArray(p.legs)) continue;
    for (let i = 0; i < p.legs.length; i++) allSignatures.push(`${p.id}:L${i}`);
  }
  const existing = new Set();
  for (let i = 0; i < allSignatures.length; i += 200) {
    const batch = allSignatures.slice(i, i + 200);
    const { data } = await supabase
      .from("prediction_history")
      .select("extra")
      .in("external_game_id", batch);
    if (data) {
      for (const r of data) {
        const sig = r?.extra?.parlay_leg_signature;
        if (sig) existing.add(sig);
      }
    }
  }

  let candidates = 0;
  let skippedPending = 0;
  let skippedSport = 0;
  let skippedAlreadyBridged = 0;
  let inserted = 0;
  let failed = 0;

  for (const parlay of parlays) {
    if (!Array.isArray(parlay.legs)) continue;
    for (let i = 0; i < parlay.legs.length; i++) {
      const leg = parlay.legs[i];
      candidates++;
      if (!leg.leg_outcome || leg.leg_outcome === "pending") { skippedPending++; continue; }
      const sport = String(leg.sport ?? "").toLowerCase();
      if (!ALLOWED_SPORTS.has(sport)) { skippedSport++; continue; }
      const sig = `${parlay.id}:L${i}`;
      if (existing.has(sig)) { skippedAlreadyBridged++; continue; }

      if (DRY_RUN) { inserted++; continue; }

      const payload = buildPayload(parlay, leg, i);
      const { error: rpcErr } = await supabase.rpc("submit_prediction_learning_record", {
        p_history: payload,
        p_error_tags: [],
      });
      if (rpcErr) {
        failed++;
        if (failed <= 5) console.error(`  ${sig} failed: ${rpcErr.message}`);
      } else {
        inserted++;
      }
    }
  }

  console.log(`parlays scanned:        ${parlays.length}`);
  console.log(`leg candidates:         ${candidates}`);
  console.log(`  · skipped pending:    ${skippedPending}`);
  console.log(`  · skipped sport:      ${skippedSport}  (allowed: nba/nfl/mlb/soccer)`);
  console.log(`  · already bridged:    ${skippedAlreadyBridged}`);
  console.log(`  · ${DRY_RUN ? "would insert" : "inserted"}:        ${inserted}`);
  if (failed > 0) console.log(`  · failed:             ${failed}`);
  if (DRY_RUN) console.log("--dry-run set — no writes performed.");
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
