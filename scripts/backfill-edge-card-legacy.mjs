#!/usr/bin/env node
/**
 * One-shot recovery: read a localStorage JSON dump of `gamelens-edge-history-v1`
 * and bridge each entry into edge_card_history with source='edge_card_legacy'.
 * Idempotent — uses client_id (the original `hist-{ts}` id) for ON CONFLICT.
 *
 * Usage:
 *   1. In the browser dev console where the legacy data lives:
 *        copy(localStorage.getItem('gamelens-edge-history-v1'))
 *   2. Paste into a file (e.g. /tmp/edge-history.json), wrapped as JSON:
 *        cat > /tmp/edge-history.json
 *        <paste>
 *        ^D
 *      The pasted value should already be a JSON array string.
 *   3. node scripts/backfill-edge-card-legacy.mjs --file=/tmp/edge-history.json
 *
 * Skips entries that already exist in edge_card_history (by client_id),
 * so re-runs are cheap.
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
  }),
);

const FILE = args.file ? String(args.file) : null;
const DRY_RUN = args["dry-run"] === "true";
if (!FILE) {
  console.error("Usage: node scripts/backfill-edge-card-legacy.mjs --file=/path/to/edge-history.json [--dry-run]");
  process.exit(1);
}
if (!existsSync(FILE)) {
  console.error(`File not found: ${FILE}`);
  process.exit(1);
}

let entries;
try {
  const raw = readFileSync(FILE, "utf8").trim();
  // Accept either a raw JSON array, or the value wrapped in quotes
  // (when copied from the dev console without extra processing).
  const parsed = JSON.parse(raw);
  entries = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  if (!Array.isArray(entries)) throw new Error("expected JSON array");
} catch (e) {
  console.error("Failed to parse input file:", e.message);
  process.exit(1);
}

console.log(`parsed ${entries.length} legacy edge-card history entr${entries.length === 1 ? "y" : "ies"}`);

function entryToRow(e) {
  return {
    client_id:            String(e.id ?? `legacy-${e.savedAt ?? Date.now()}`),
    saved_at:             e.savedAt ?? new Date().toISOString(),
    card_size:            Number(e.size ?? 3),
    items:                Array.isArray(e.items) ? e.items : [],
    aggregate_confidence: e.aggregateConfidence ?? null,
    risk_label:           e.riskLabel ?? null,
    outcome:              (e.outcome === "win" || e.outcome === "loss" || e.outcome === "push") ? e.outcome : null,
    source:               "edge_card_legacy",
  };
}

const rows = entries.map(entryToRow);

console.log(`would write ${rows.length} rows to edge_card_history (source=edge_card_legacy)`);
if (DRY_RUN) {
  console.log("--dry-run set — no writes performed.");
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let inserted = 0;
let failed = 0;
for (const row of rows) {
  const { error } = await supabase
    .from("edge_card_history")
    .upsert(row, { onConflict: "client_id" });
  if (error) {
    failed++;
    if (failed <= 5) console.error(`  ${row.client_id} failed: ${error.message}`);
  } else {
    inserted++;
  }
}

console.log(`Backfill complete: ${inserted} upserted, ${failed} failed.`);
if (failed > 0) process.exit(1);
