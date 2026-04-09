#!/usr/bin/env node
/**
 * Live check: NFL draft sport in /v4/sports?all=true and outrights payload shape.
 * Reads VITE_THE_ODDS_API_KEY (preferred) or THE_ODDS_API_KEY from process.env or .env.local.
 *
 * Usage:
 *   npm run verify:odds-draft
 *   VITE_THE_ODDS_API_KEY=... node scripts/verify-odds-nfl-draft.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env.local");

function loadEnvFile() {
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env) || process.env[k] === "") {
      process.env[k] = v;
    }
  }
}

function apiKey() {
  return (process.env.VITE_THE_ODDS_API_KEY || process.env.THE_ODDS_API_KEY || "").trim();
}

function envDraftSportKey() {
  return (process.env.VITE_THE_ODDS_API_NFL_DRAFT_SPORT_KEY || "").trim();
}

loadEnvFile();

const BASE = "https://api.the-odds-api.com/v4";

async function main() {
  const key = apiKey();
  if (!key) {
    console.error(
      "Missing VITE_THE_ODDS_API_KEY (recommended) or THE_ODDS_API_KEY. Set in .env.local or export, then run again."
    );
    process.exit(1);
  }

  const sportsRes = await fetch(`${BASE}/sports/?all=true&apiKey=${encodeURIComponent(key)}`);
  const sports = await sportsRes.json().catch(() => null);
  if (!sportsRes.ok || !Array.isArray(sports)) {
    console.log(JSON.stringify({ step: "sports", ok: false, status: sportsRes.status, body: sports }, null, 2));
    process.exit(1);
  }

  const nflDraft = sports.filter((s) => {
    if (s.active === false) return false;
    const k = `${s.key || ""} ${s.title || ""}`.toLowerCase();
    const nfl = k.includes("nfl") || (s.key || "").includes("americanfootball_nfl");
    const draft = k.includes("draft");
    return nfl && draft;
  });

  console.log("--- Catalog: NFL + draft ---");
  console.log(JSON.stringify(nflDraft, null, 2));
  if (nflDraft.length === 0) {
    console.log("\n(No rows matched nfl+draft. Search broader: keys containing 'draft'.)");
    const anyDraft = sports.filter((s) => String(s.key + s.title).toLowerCase().includes("draft"));
    console.log(JSON.stringify(anyDraft.slice(0, 20), null, 2));
  }

  const sportKey = envDraftSportKey() || nflDraft[0]?.key;
  if (!sportKey) {
    console.log("\nNo sport key to fetch odds. Set VITE_THE_ODDS_API_NFL_DRAFT_SPORT_KEY or fix catalog match.");
    process.exit(0);
  }

  console.log("\n--- Using sport_key ---", sportKey);
  const oddsUrl = `${BASE}/sports/${encodeURIComponent(sportKey)}/odds?regions=us&markets=outrights&oddsFormat=american&apiKey=${encodeURIComponent(key)}`;
  const oddsRes = await fetch(oddsUrl);
  const oddsJson = await oddsRes.json().catch(() => null);

  if (!oddsRes.ok) {
    console.log(JSON.stringify({ step: "odds", ok: false, status: oddsRes.status, body: oddsJson }, null, 2));
    process.exit(1);
  }

  if (!Array.isArray(oddsJson)) {
    console.log("Unexpected: odds response is not an array:", typeof oddsJson, oddsJson);
    process.exit(1);
  }

  console.log("\n--- Shape ---");
  console.log("eventCount:", oddsJson.length);
  if (oddsJson.length === 0) {
    console.log("Empty array: no outright events for this sport (or market offline / plan).");
    process.exit(0);
  }

  const ev = oddsJson[0];
  console.log("firstEvent top-level keys:", Object.keys(ev));
  const bms = ev.bookmakers || [];
  console.log("bookmakerCount (first event):", bms.length);
  const bm = bms[0];
  if (bm) {
    console.log("first bookmaker keys:", Object.keys(bm));
    console.log("first bookmaker key/title:", bm.key, "|", bm.title);
    const markets = bm.markets || [];
    console.log("market keys:", markets.map((m) => m.key));
    const outright = markets.find((m) => (m.key || "").toLowerCase() === "outrights") || markets[0];
    const outs = outright?.outcomes || [];
    console.log("outcomes in first market:", outs.length);
    console.log("sample outcomes (up to 5):", JSON.stringify(outs.slice(0, 5), null, 2));
  }

  const truncated = JSON.parse(JSON.stringify(ev));
  if (truncated.bookmakers) {
    for (const b of truncated.bookmakers) {
      if (!b.markets) continue;
      for (const m of b.markets) {
        if (m.outcomes?.length > 6) {
          m.outcomes = [...m.outcomes.slice(0, 5), { _note: `+${m.outcomes.length - 5} more` }];
        }
      }
    }
  }
  console.log("\n--- firstEvent JSON (outcomes truncated) ---");
  console.log(JSON.stringify(truncated, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
