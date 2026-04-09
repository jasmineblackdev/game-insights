#!/usr/bin/env node
/**
 * ETL: roll up settled team-game outcomes into public.prediction_confidence_calibration.
 *
 * Sources (pick with --source=):
 *   versions — prediction_versions (phase=pregame) joined to prediction_outcomes on game_id
 *   log      — prediction_outcome_log (kind=team_game, correct_prediction set, evaluated_at in window)
 *   both     — sum counts per sport × bucket from both (only if your pipelines are disjoint)
 *
 * Env: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL or VITE_SUPABASE_URL (loads `.env.local`).
 *
 * Usage:
 *   node scripts/rollup-confidence-calibration.mjs
 *   node scripts/rollup-confidence-calibration.mjs --window-days=90 --source=versions
 *   node scripts/rollup-confidence-calibration.mjs --window-days=30 --source=log
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BUCKETS = ["high", "medium", "low"];
const SPORTS = ["nba", "nfl", "mlb", "soccer"];

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
  const out = { windowDays: 30, source: "versions" };
  for (const a of process.argv.slice(2)) {
    const w = a.match(/^--window-days=(\d+)$/);
    if (w) out.windowDays = Math.max(1, Math.min(365, Number(w[1])));
    const s = a.match(/^--source=(versions|log|both)$/);
    if (s) out.source = s[1];
  }
  return out;
}

function windowLabel(days) {
  return `${days}d`;
}

/** prediction_versions.sport is stored upper (e.g. NBA). */
function normSport(s) {
  const x = String(s ?? "").trim().toUpperCase();
  if (x === "NBA") return "nba";
  if (x === "NFL") return "nfl";
  if (x === "MLB") return "mlb";
  if (x === "SOCCER") return "soccer";
  const l = String(s ?? "").trim().toLowerCase();
  if (SPORTS.includes(l)) return l;
  return null;
}

/** prediction_versions.confidence: HIGH | MED | LOW */
function normBucketVersions(c) {
  const u = String(c ?? "").toUpperCase();
  if (u === "HIGH") return "high";
  if (u === "MED" || u === "MEDIUM") return "medium";
  if (u === "LOW") return "low";
  return null;
}

/** prediction_outcome_log.confidence may vary */
function normBucketLog(c) {
  return normBucketVersions(c);
}

function emptyRollup() {
  /** @type {Map<string, { hits: number; total: number }>} */
  const m = new Map();
  for (const sp of SPORTS) {
    for (const b of BUCKETS) {
      m.set(`${sp}|${b}`, { hits: 0, total: 0 });
    }
  }
  return m;
}

function addHit(m, sport, bucket, hit) {
  if (!sport || !bucket || !SPORTS.includes(sport) || !BUCKETS.includes(bucket)) return;
  const k = `${sport}|${bucket}`;
  const row = m.get(k);
  if (!row) return;
  row.total += 1;
  if (hit) row.hits += 1;
}

async function fetchAllRows(supabase, table, selectCols, filters) {
  const pageSize = 1000;
  let from = 0;
  const out = [];
  for (;;) {
    let q = supabase.from(table).select(selectCols);
    for (const { op, col, val } of filters) {
      if (op === "eq") q = q.eq(col, val);
      else if (op === "gte") q = q.gte(col, val);
      else if (op === "notNull") q = q.not(col, "is", null);
    }
    const { data, error } = await q.range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function rollupFromVersions(supabase, sinceIso) {
  const rollup = emptyRollup();
  const outcomes = await fetchAllRows(supabase, "prediction_outcomes", "game_id,sport,actual_winner,closed_at", [
    { op: "gte", col: "closed_at", val: sinceIso },
  ]);
  if (!outcomes.length) return rollup;

  const gameIds = [...new Set(outcomes.map((o) => o.game_id).filter(Boolean))];
  /** @type {Map<string, { sport: string; confidence: string; predicted_side: string }>} */
  const pregameByGame = new Map();

  for (const part of chunk(gameIds, 150)) {
    const { data, error } = await supabase
      .from("prediction_versions")
      .select("game_id,sport,confidence,predicted_side,phase")
      .eq("phase", "pregame")
      .in("game_id", part);
    if (error) throw new Error(`prediction_versions: ${error.message}`);
    for (const row of data ?? []) {
      pregameByGame.set(row.game_id, row);
    }
  }

  for (const po of outcomes) {
    const pv = pregameByGame.get(po.game_id);
    if (!pv) continue;
    const sport = normSport(pv.sport ?? po.sport);
    const bucket = normBucketVersions(pv.confidence);
    if (!sport || !bucket) continue;
    const pred = String(pv.predicted_side ?? "").trim().toUpperCase();
    const actual = String(po.actual_winner ?? "").trim().toUpperCase();
    const hit = pred.length > 0 && actual.length > 0 && pred === actual;
    addHit(rollup, sport, bucket, hit);
  }

  return rollup;
}

async function rollupFromOutcomeLog(supabase, sinceIso) {
  const rollup = emptyRollup();
  const rows = await fetchAllRows(
    supabase,
    "prediction_outcome_log",
    "sport,confidence,correct_prediction,evaluated_at",
    [
      { op: "eq", col: "kind", val: "team_game" },
      { op: "gte", col: "evaluated_at", val: sinceIso },
      { op: "notNull", col: "correct_prediction", val: null },
    ]
  );

  for (const row of rows) {
    const sport = normSport(row.sport);
    const bucket = normBucketLog(row.confidence);
    if (!sport || !bucket) continue;
    const hit = row.correct_prediction === true;
    addHit(rollup, sport, bucket, hit);
  }

  return rollup;
}

function mergeRollups(a, b) {
  const out = emptyRollup();
  for (const sp of SPORTS) {
    for (const bu of BUCKETS) {
      const k = `${sp}|${bu}`;
      const x = a.get(k);
      const y = b.get(k);
      out.set(k, { hits: x.hits + y.hits, total: x.total + y.total });
    }
  }
  return out;
}

const args = parseArgs();
const label = windowLabel(args.windowDays);
const since = new Date(Date.now() - args.windowDays * 86400000).toISOString();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

let rollup = emptyRollup();
try {
  if (args.source === "versions" || args.source === "both") {
    rollup = mergeRollups(rollup, await rollupFromVersions(supabase, since));
  }
  if (args.source === "log" || args.source === "both") {
    rollup = mergeRollups(rollup, await rollupFromOutcomeLog(supabase, since));
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const upsertRows = [];
for (const sp of SPORTS) {
  for (const bu of BUCKETS) {
    const { hits, total } = rollup.get(`${sp}|${bu}`);
    if (total < 1) continue;
    upsertRows.push({
      id: `${sp}:${bu}:${label}`,
      sport: sp,
      confidence_bucket: bu,
      calibration_window: label,
      sample_count: total,
      empirical_hit_rate: Math.round((hits / total) * 10000) / 10000,
      updated_at: new Date().toISOString(),
    });
  }
}

if (!upsertRows.length) {
  console.log(`No samples in window ${label} (since ${since.slice(0, 10)}) for source=${args.source}. Nothing to upsert.`);
  process.exit(0);
}

const { error: upErr } = await supabase.from("prediction_confidence_calibration").upsert(upsertRows, {
  onConflict: "id",
});

if (upErr) {
  console.error("Upsert failed:", upErr.message);
  process.exit(1);
}

for (const r of upsertRows) {
  const pct = (r.empirical_hit_rate * 100).toFixed(2);
  console.log(`${r.sport} ${r.confidence_bucket} ${r.calibration_window}: n=${r.sample_count} hit_rate=${pct}%`);
}
console.log(`OK upserted ${upsertRows.length} row(s).`);
