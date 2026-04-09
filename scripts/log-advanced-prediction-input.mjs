#!/usr/bin/env node
/**
 * Upsert public.advanced_prediction_inputs (audit / backtest) using the service role.
 * RLS allows INSERT/UPDATE only for service_role — run from CI/cron, not the browser client.
 *
 * Env: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL or VITE_SUPABASE_URL (loads `.env.local`).
 *
 * Payload JSON (object) may include:
 *   base_signals, advanced_signals, live_signals, market_signals (objects), final_adjustment_note (string).
 * Omitted keys are left unchanged on upsert except: use --replace to null out missing top-level keys.
 *
 * Usage:
 *   node scripts/log-advanced-prediction-input.mjs --sport=nba --external-game-id=401585936 --phase=pregame --file=./payload.json
 *   echo '{"base_signals":{"foo":1}}' | node scripts/log-advanced-prediction-input.mjs --sport=soccer --external-game-id=abc --phase=pregame --stdin
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

function parseArgs() {
  const out = {
    sport: null,
    externalGameId: null,
    phase: "pregame",
    file: null,
    stdin: false,
    replace: false,
  };
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--sport=(.+)$/);
    if (m) out.sport = m[1].trim();
    const e = a.match(/^--external-game-id=(.+)$/);
    if (e) out.externalGameId = e[1].trim();
    const p = a.match(/^--phase=(.+)$/);
    if (p) out.phase = p[1].trim();
    const f = a.match(/^--file=(.+)$/);
    if (f) out.file = f[1].trim();
    if (a === "--stdin") out.stdin = true;
    if (a === "--replace") out.replace = true;
  }
  return out;
}

const args = parseArgs();
if (!args.sport || !args.externalGameId) {
  console.error(
    "Required: --sport=nba|nfl|mlb|soccer --external-game-id=<id> [--phase=pregame] [--file=payload.json | --stdin]"
  );
  process.exit(1);
}

let rawPayload = "{}";
if (args.stdin) {
  rawPayload = readFileSync(0, "utf8");
} else if (args.file) {
  if (!existsSync(args.file)) {
    console.error("File not found:", args.file);
    process.exit(1);
  }
  rawPayload = readFileSync(args.file, "utf8");
}

let payload;
try {
  payload = JSON.parse(rawPayload || "{}");
} catch (e) {
  console.error("Invalid JSON:", e.message);
  process.exit(1);
}

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const id = `advpi:${args.sport}:${args.externalGameId}:${args.phase}`;

const row = {
  id,
  sport: args.sport,
  external_game_id: args.externalGameId,
  phase: args.phase,
};

const keys = ["base_signals", "advanced_signals", "live_signals", "market_signals", "final_adjustment_note"];
for (const k of keys) {
  if (args.replace) {
    row[k] = payload[k] !== undefined ? payload[k] : null;
  } else if (payload[k] !== undefined) {
    row[k] = payload[k];
  }
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

const { data: existing } = await supabase.from("advanced_prediction_inputs").select("id").eq("id", id).maybeSingle();

let error;
if (existing?.id) {
  const updatePayload = { ...row };
  delete updatePayload.id;
  if (!args.replace) {
    for (const k of keys) {
      if (payload[k] === undefined) delete updatePayload[k];
    }
  }
  ({ error } = await supabase.from("advanced_prediction_inputs").update(updatePayload).eq("id", id));
} else {
  for (const k of keys) {
    if (row[k] === undefined) row[k] = null;
  }
  ({ error } = await supabase.from("advanced_prediction_inputs").insert(row));
}

if (error) {
  console.error("Supabase error:", error.message);
  process.exit(1);
}

console.log("OK", id);
