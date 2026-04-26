#!/usr/bin/env node
/**
 * One-shot picks_log → prediction_history backfill.
 *
 * The bridge in src/lib/ml/feedbackLoop.ts only fires for new resolutions
 * going forward. Without this script the prediction_history table starts
 * empty, which means the first run of the backtest CI prints "no resolved
 * predictions" even though picks_log already holds resolved rows.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-prediction-history.mjs
 *   (or just have those in .env.local)
 *
 *   --dry-run         report what would be inserted without writing
 *   --window-days=N   only consider picks resolved in the last N days
 *   --limit=N         cap rows considered (default 5000)
 *
 * Idempotent — checks `extra->>'prop_id'` against existing
 * prediction_history rows and skips already-bridged props. Safe to re-run.
 *
 * Sport gating mirrors the runtime bridge: schema only allows
 * (nba, nfl, mlb, soccer); MMA / boxing / wnba picks are skipped.
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
const DRY_RUN = args["dry-run"] === "true";
const WINDOW_DAYS = Number(args["window-days"] ?? 365);
const LIMIT = Number(args.limit ?? 5000);

const ALLOWED_SPORTS = new Set(["nba", "nfl", "mlb", "soccer"]);

const CONFIDENCE_HIT_PROB = {
  HIGH: 0.65, MED: 0.55, LOW: 0.5,
  high: 0.65, medium: 0.55, low: 0.5,
};

function buildPayload(row) {
  const sport = String(row.sport).toLowerCase();
  const conf = row.confidence;
  const modelP = CONFIDENCE_HIT_PROB[conf] ?? 0.5;
  const dirLabel = row.direction === "MORE" ? "Over" : "Under";
  const pickLabel = `${row.player_name} ${dirLabel} ${row.line_value} ${row.stat_type}`;
  const outcome = row.outcome;
  const errorSize = Math.abs(modelP - (outcome === "win" ? 1 : outcome === "loss" ? 0 : 0.5));

  return {
    external_game_id: row.game_id,
    sport,
    market_type: "player_prop",
    pick_side: row.direction.toLowerCase(),
    pick_label: pickLabel,
    american_odds: "",
    implied_probability: "",
    model_probability: String(modelP),
    edge: "",
    confidence: String(conf).toLowerCase(),
    risk_score: "",
    reason_tags: [],
    checkpoint_stage: "",
    prediction_phase: "pregame",
    final_home_score: "",
    final_away_score: "",
    outcome,
    error_size: String(Math.round(errorSize * 10000) / 10000),
    odds_range_bucket: "unknown",
    stat_type: row.stat_type,
    source: "gamelens_backfill_v1",
    learning_phase: "1",
    extra: {
      prop_id: row.prop_id,
      player_name: row.player_name,
      stat_type: row.stat_type,
      line_value: row.line_value,
      projected_value: row.projected_value,
      direction: row.direction,
      actual_value: row.actual_value,
      backfilled_from: "picks_log",
    },
  };
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const { data: picks, error } = await supabase
    .from("picks_log")
    .select("prop_id, player_name, sport, stat_type, line_value, projected_value, direction, confidence, game_id, outcome, actual_value, resolved_at")
    .in("outcome", ["win", "loss", "push"])
    .gte("resolved_at", cutoff)
    .limit(LIMIT);

  if (error) {
    console.error("picks_log query failed:", error.message);
    process.exit(1);
  }
  if (!picks?.length) {
    console.log(`No resolved picks_log rows found in last ${WINDOW_DAYS} days.`);
    return;
  }

  // Filter to allowed sports
  const eligible = picks.filter((p) => ALLOWED_SPORTS.has(String(p.sport).toLowerCase()));
  const skippedSports = picks.length - eligible.length;

  // Dedupe against existing prediction_history rows (by prop_id in extra).
  const propIds = eligible.map((p) => p.prop_id);
  let existing = new Set();
  for (let i = 0; i < propIds.length; i += 200) {
    const slice = propIds.slice(i, i + 200);
    const { data: rows } = await supabase
      .from("prediction_history")
      .select("extra")
      .eq("market_type", "player_prop")
      .in("external_game_id", eligible.slice(i, i + 200).map((p) => p.game_id))
      .limit(slice.length);
    if (rows) {
      for (const r of rows) {
        const pid = r?.extra?.prop_id;
        if (pid) existing.add(pid);
      }
    }
  }
  const toBackfill = eligible.filter((p) => !existing.has(p.prop_id));

  console.log(`picks_log resolved: ${picks.length}`);
  console.log(`  · skipped (sport not in nba/nfl/mlb/soccer): ${skippedSports}`);
  console.log(`  · already bridged: ${eligible.length - toBackfill.length}`);
  console.log(`  · to backfill:    ${toBackfill.length}`);

  if (DRY_RUN) {
    console.log("--dry-run set — no writes performed.");
    return;
  }
  if (!toBackfill.length) return;

  let ok = 0;
  let failed = 0;
  for (const row of toBackfill) {
    const payload = buildPayload(row);
    const { error: rpcErr } = await supabase.rpc("submit_prediction_learning_record", {
      p_history: payload,
      p_error_tags: [],
    });
    if (rpcErr) {
      failed++;
      if (failed <= 5) console.error(`  rpc fail (${row.prop_id}):`, rpcErr.message);
    } else {
      ok++;
    }
  }

  console.log(`Backfill complete: ${ok} inserted, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
