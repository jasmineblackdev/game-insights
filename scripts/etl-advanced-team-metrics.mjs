#!/usr/bin/env node
/**
 * Template ETL: upsert public.advanced_team_metrics using SUPABASE_SERVICE_ROLE_KEY.
 *
 * This repo does not call StatsBomb, NFL Next Gen Stats, or MLB Statcast directly.
 * Typical flow: export or compute metrics in your pipeline, write JSON/TSV, then run this job on a schedule.
 *
 * Row id is deterministic: advtm:{sport}:{team_id}:{season}:{rolling_window}
 *
 * Input formats:
 *   --format=json   (default) JSON array: [ { sport, team_id, season, rolling_window?, metrics?, ... }, ... ]
 *   --format=ndjson Same fields as json, one object per line (--file may be .ndjson)
 *   --format=tsv    Tab-separated, no tabs inside fields. Columns:
 *                   sport | team_id | season | rolling_window | metrics_json | confidence_adjustment_weight | source
 *                   metrics_json is a JSON object string, e.g. {"team_xg_for":1.2,"team_xg_against":0.9}
 *                   Empty trailing columns allowed.
 *
 * Env: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL or VITE_SUPABASE_URL (loads `.env.local`).
 *
 * Usage:
 *   node scripts/etl-advanced-team-metrics.mjs --file=./teams.json
 *   node scripts/etl-advanced-team-metrics.mjs --file=./teams.ndjson --format=ndjson
 *   node scripts/etl-advanced-team-metrics.mjs --file=./teams.tsv --format=tsv --chunk=150
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VALID_SPORTS = new Set(["nba", "nfl", "mlb", "soccer"]);
const VALID_WINDOWS = new Set(["last_3", "last_5", "last_10", "season"]);

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
  const out = { file: null, format: "json", chunk: 200 };
  for (const a of process.argv.slice(2)) {
    const f = a.match(/^--file=(.+)$/);
    if (f) out.file = f[1].trim();
    const fmt = a.match(/^--format=(json|ndjson|tsv)$/);
    if (fmt) out.format = fmt[1];
    const c = a.match(/^--chunk=(\d+)$/);
    if (c) out.chunk = Math.max(1, Math.min(500, Number(c[1])));
  }
  return out;
}

function parseMetrics(v) {
  if (v == null || v === "") return {};
  if (typeof v === "object" && !Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const o = JSON.parse(v);
      return o && typeof o === "object" && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  }
  return {};
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowFromObject(obj, lineNo) {
  const sport = String(obj.sport ?? "").toLowerCase();
  const team_id = String(obj.team_id ?? obj.teamId ?? "").trim();
  const season = Number(obj.season);
  const rolling_window = String(obj.rolling_window ?? obj.rollingWindow ?? "season").toLowerCase();

  if (!VALID_SPORTS.has(sport)) {
    throw new Error(`Invalid sport (line ${lineNo}): ${obj.sport}`);
  }
  if (!team_id) {
    throw new Error(`Missing team_id (line ${lineNo})`);
  }
  if (!Number.isFinite(season) || season < 1900 || season > 2200) {
    throw new Error(`Invalid season (line ${lineNo}): ${obj.season}`);
  }
  if (!VALID_WINDOWS.has(rolling_window)) {
    throw new Error(`Invalid rolling_window (line ${lineNo}): ${rolling_window}`);
  }

  const metrics = parseMetrics(obj.metrics);
  const confidence_adjustment_weight = numOrNull(obj.confidence_adjustment_weight ?? obj.confidenceAdjustmentWeight);
  const source = obj.source != null && obj.source !== "" ? String(obj.source) : null;

  const id = `advtm:${sport}:${team_id.toUpperCase()}:${season}:${rolling_window}`;

  return {
    id,
    sport,
    team_id: team_id.toUpperCase(),
    season,
    rolling_window,
    metrics,
    confidence_adjustment_weight,
    source,
    updated_at: new Date().toISOString(),
  };
}

function parseTsv(content) {
  const lines = content.split("\n");
  const rows = [];
  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split("\t");
    const [
      sport,
      team_id,
      seasonStr,
      rolling_window = "season",
      metrics_json = "{}",
      confStr = "",
      source = "",
    ] = parts;
    rows.push(
      rowFromObject(
        {
          sport,
          team_id,
          season: seasonStr,
          rolling_window,
          metrics: metrics_json,
          confidence_adjustment_weight: confStr,
          source,
        },
        lineNo
      )
    );
  }
  return rows;
}

const args = parseArgs();
if (!args.file) {
  console.error("Required: --file=path");
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

const fileContent = readFileSync(args.file, "utf8");
let rows = [];

if (args.format === "tsv") {
  rows = parseTsv(fileContent);
} else if (args.format === "ndjson") {
  let lineNo = 0;
  for (const line of fileContent.split("\n")) {
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
    try {
      rows.push(rowFromObject(obj, lineNo));
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }
} else {
  let arr;
  try {
    arr = JSON.parse(fileContent);
  } catch (e) {
    console.error("Invalid JSON array:", e.message);
    process.exit(1);
  }
  if (!Array.isArray(arr)) {
    console.error("--format=json expects a JSON array at the root");
    process.exit(1);
  }
  arr.forEach((obj, i) => {
    try {
      rows.push(rowFromObject(obj, i + 1));
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  });
}

if (!rows.length) {
  console.error("No rows to upsert.");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

for (let i = 0; i < rows.length; i += args.chunk) {
  const batch = rows.slice(i, i + args.chunk);
  const { error } = await supabase.from("advanced_team_metrics").upsert(batch, { onConflict: "id" });
  if (error) {
    console.error(`Upsert failed at offset ${i}:`, error.message);
    process.exit(1);
  }
}

console.log(`OK upserted ${rows.length} advanced_team_metrics row(s) (${args.format}, chunks of ${args.chunk})`);
