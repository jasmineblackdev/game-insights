#!/usr/bin/env node
/**
 * Dump The Odds API /v4/sports/?all=true for syncing src/lib/oddsSportKeys.ts.
 *
 * Env: VITE_THE_ODDS_API_KEY first, then THE_ODDS_API_KEY (loads `.env.local` from repo root).
 *
 * Usage:
 *   node scripts/list-odds-sports.mjs
 *   node scripts/list-odds-sports.mjs --json
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const wantJson = process.argv.includes("--json");
const key = process.env.VITE_THE_ODDS_API_KEY || process.env.THE_ODDS_API_KEY;
if (!key) {
  console.error("Missing VITE_THE_ODDS_API_KEY or THE_ODDS_API_KEY (set in .env.local or env).");
  process.exit(1);
}

const url = `https://api.the-odds-api.com/v4/sports/?all=true&apiKey=${encodeURIComponent(key)}`;
const r = await fetch(url);
if (!r.ok) {
  const t = await r.text();
  console.error(`HTTP ${r.status}: ${t}`);
  process.exit(1);
}

const list = await r.json();
if (!Array.isArray(list)) {
  console.error("Unexpected response (expected array):", typeof list);
  process.exit(1);
}

if (wantJson) {
  console.log(JSON.stringify(list, null, 2));
  process.exit(0);
}

const rows = list
  .map((s) => ({
    key: s.key,
    title: s.title,
    active: s.active,
    group: s.group,
  }))
  .sort((a, b) => String(a.key).localeCompare(String(b.key)));

for (const s of rows) {
  const act = s.active ? "active" : "inactive";
  const g = s.group ? `\tgroup:${s.group}` : "";
  console.log(`${s.key}\t${s.title}\t${act}${g}`);
}
