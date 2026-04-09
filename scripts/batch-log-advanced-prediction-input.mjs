#!/usr/bin/env node
/**
 * Batch upsert public.advanced_prediction_inputs from NDJSON (one JSON object per line).
 * Use with SUPABASE_SERVICE_ROLE_KEY — same RLS as log-advanced-prediction-input.mjs.
 *
 * Each line must include:
 *   sport, external_game_id (or externalGameId)
 * Optional per line: phase (default "pregame"), base_signals, advanced_signals, live_signals,
 *   market_signals, final_adjustment_note
 *
 * Each upsert uses id advpi:{sport}:{external_game_id}:{phase}. Omitted optional fields are stored as null.
 *
 * Usage:
 *   node scripts/batch-log-advanced-prediction-input.mjs --file=./games.ndjson
 *   node scripts/batch-log-advanced-prediction-input.mjs --file=./games.ndjson --chunk=100
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

const SIGNAL_KEYS = ["base_signals", "advanced_signals", "live_signals", "market_signals", "final_adjustment_note"];

function parseArgs() {
  const out = { file: null, chunk: 200 };
  for (const a of process.argv.slice(2)) {
    const f = a.match(/^--file=(.+)$/);
    if (f) out.file = f[1].trim();
    const c = a.match(/^--chunk=(\d+)$/);
    if (c) out.chunk = Math.max(1, Math.min(500, Number(c[1])));
  }
  return out;
}

function rowFromObject(obj) {
  const sport = obj.sport;
  const external_game_id = obj.external_game_id ?? obj.externalGameId;
  const phase = (obj.phase ?? "pregame").trim() || "pregame";
  if (!sport || !external_game_id) {
    throw new Error("Each line needs sport and external_game_id (or externalGameId)");
  }
  const id = `advpi:${sport}:${external_game_id}:${phase}`;
  const row = {
    id,
    sport: String(sport),
    external_game_id: String(external_game_id),
    phase,
  };
  for (const k of SIGNAL_KEYS) {
    row[k] = obj[k] !== undefined && obj[k] !== "" ? obj[k] : null;
  }
  return row;
}

const args = parseArgs();
if (!args.file) {
  console.error("Required: --file=path.ndjson");
  process.exit(1);
}
if (!existsSync(args.file)) {
  console.error("File not found:", args.file);
  process.exit(1);
}

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const raw = readFileSync(args.file, "utf8");
const lines = raw.split("\n");
const rows = [];
let lineNo = 0;
for (const line of lines) {
  lineNo += 1;
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  let obj;
  try {
    obj = JSON.parse(t);
  } catch (e) {
    console.error(`Line ${lineNo}: invalid JSON — ${e.message}`);
    process.exit(1);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    console.error(`Line ${lineNo}: expected a JSON object`);
    process.exit(1);
  }
  try {
    rows.push(rowFromObject(obj));
  } catch (e) {
    console.error(`Line ${lineNo}: ${e.message}`);
    process.exit(1);
  }
}

if (!rows.length) {
  console.error("No rows to upsert (empty file or only comments/blank lines).");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

for (let i = 0; i < rows.length; i += args.chunk) {
  const batch = rows.slice(i, i + args.chunk);
  const { error } = await supabase.from("advanced_prediction_inputs").upsert(batch, { onConflict: "id" });
  if (error) {
    console.error(`Upsert failed at offset ${i}:`, error.message);
    process.exit(1);
  }
}

console.log(`OK upserted ${rows.length} row(s) in chunks of ${args.chunk}`);
