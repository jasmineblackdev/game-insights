#!/usr/bin/env node
/**
 * Upsert `mlb_pitcher_recent_form` from MLB Stats API game logs + ESPN id resolution.
 * ESPN global search often returns []; we build a name→id map from all MLB team rosters, then fall back to search.
 *
 * Requires (service role — bypasses RLS write policies):
 *   SUPABASE_SERVICE_ROLE_KEY  (Dashboard → Settings → API → service_role secret)
 *   SUPABASE_URL or VITE_SUPABASE_URL (script loads `.env.local` automatically)
 *
 * Usage:
 *   node scripts/refresh-mlb-pitcher-recent-form.mjs --season=2025
 *   node scripts/refresh-mlb-pitcher-recent-form.mjs --season=2025 --date=2025-06-16
 *
 * Without --date: walks MLB schedule for the season in weekly chunks and collects
 * every probablePitcher id from completed/scheduled games (best-effort; cap pitchers per run).
 *
 * Cron: weekly in-season, or daily the morning of game days.
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

const MLB = "https://statsapi.mlb.com/api/v1";
const ESPN_SEARCH = "https://site.api.espn.com/apis/common/v3/search";
const ESPN_TEAMS = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams?limit=50";

const fetchOpts = {
  headers: {
    Accept: "application/json",
    Referer: "https://www.espn.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 GameLens-MLB-Sync/1.0",
  },
};

/** Lowercase + strip accents — matches MLB fullName to ESPN roster fullName. */
function normName(s) {
  return (s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Collect ESPN athlete id by normalized fullName from all 30 team rosters (search API often returns []). */
async function buildEspnMlbNameToIdMap() {
  const map = new Map();
  const res = await fetch(ESPN_TEAMS, fetchOpts);
  if (!res.ok) return map;
  const json = await res.json();
  const teams = json?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  const teamIds = [...new Set(teams.map((t) => t?.team?.id).filter(Boolean))];
  for (const tid of teamIds) {
    const r = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${tid}/roster`,
      fetchOpts
    );
    if (!r.ok) continue;
    const roster = await r.json();
    const groups = roster?.athletes ?? [];
    for (const g of groups) {
      for (const a of g?.items ?? []) {
        const id = a?.id != null ? String(a.id) : "";
        const fn = a?.fullName || a?.displayName;
        if (!id || !fn) continue;
        const k = normName(fn);
        if (!map.has(k)) map.set(k, id);
      }
    }
    await new Promise((x) => setTimeout(x, 90));
  }
  return map;
}

function parseIp(s) {
  if (typeof s !== "string") return 0;
  const [w, f] = s.split(".");
  const whole = Number(w) || 0;
  const third = f === "1" ? 1 / 3 : f === "2" ? 2 / 3 : 0;
  return whole + third;
}

function eraFromStarts(splits, n) {
  const games = (splits ?? [])
    .filter((x) => x?.stat?.gamesStarted >= 1 || Number(x?.stat?.gamesPitched) >= 1)
    .slice(0, n);
  let er = 0;
  let ip = 0;
  for (const g of games) {
    er += Number(g.stat?.earnedRuns) || 0;
    ip += parseIp(g.stat?.inningsPitched);
  }
  if (ip < 1) return null;
  return Math.round((9 * er) / ip * 100) / 100;
}

function pushAthleteCandidates(node, out, depth = 0) {
  if (depth > 10 || node == null) return;
  if (Array.isArray(node)) {
    for (const x of node) pushAthleteCandidates(x, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    const id = node.id;
    const name = node.fullName || node.displayName || node.name;
    if (id != null && name && String(id).match(/^\d+$/)) {
      out.push(node);
    }
    for (const v of Object.values(node)) {
      if (v && (typeof v === "object" || Array.isArray(v))) pushAthleteCandidates(v, out, depth + 1);
    }
  }
}

/** Roster map first; then common search with Referer + accent/“Last, First” variants. */
async function resolveEspnAthleteId(fullName, rosterMap) {
  const raw = (fullName ?? "").trim();
  if (!raw) return null;
  const fromRoster = rosterMap?.get(normName(raw));
  if (fromRoster) return fromRoster;

  const queries = [raw];
  const stripped = raw.normalize("NFD").replace(/\p{M}/gu, "").trim();
  if (stripped && stripped !== raw) queries.push(stripped);
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) queries.push(`${parts[parts.length - 1]}, ${parts[0]}`);

  const want = normName(raw);
  for (const q of [...new Set(queries)]) {
    if (!q) continue;
    const url = `${ESPN_SEARCH}?query=${encodeURIComponent(q)}&limit=20&lang=en&region=us`;
    const res = await fetch(url, fetchOpts);
    if (!res.ok) continue;
    const json = await res.json();
    const candidates = [];
    pushAthleteCandidates(json, candidates, 0);
    for (const a of candidates) {
      const id = a.id != null ? String(a.id) : "";
      if (!id) continue;
      const fn = a.fullName || a.displayName || a.name || "";
      const lg = (a.league?.abbreviation ?? "").toUpperCase();
      if (fn && normName(fn) === want && (lg === "MLB" || lg === "")) return id;
    }
    for (const a of candidates) {
      const id = a.id != null ? String(a.id) : "";
      const fn = a.fullName || a.displayName || a.name || "";
      if (fn && normName(fn) === want) return id;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function fetchGameLogEras(mlbPlayerId, season) {
  const url = `${MLB}/people/${mlbPlayerId}/stats?stats=gameLog&season=${season}&group=pitching`;
  const res = await fetch(url, fetchOpts);
  if (!res.ok) return { l3: null, l5: null, name: null, lastDate: null };
  const json = await res.json();
  const splits = json.stats?.[0]?.splits ?? [];
  const name = splits[0]?.player?.fullName ?? null;
  const lastDate = splits[0]?.date ?? null;
  return {
    l3: eraFromStarts(splits, 3),
    l5: eraFromStarts(splits, 5),
    name,
    lastDate,
  };
}

async function collectPitcherIdsForDate(date) {
  const url = `${MLB}/schedule?sportId=1&date=${date}&hydrate=probablePitcher(note)`;
  const res = await fetch(url, fetchOpts);
  if (!res.ok) return new Set();
  const json = await res.json();
  const ids = new Set();
  for (const d of json.dates ?? []) {
    for (const g of d.games ?? []) {
      const h = g.teams?.home?.probablePitcher?.id;
      const a = g.teams?.away?.probablePitcher?.id;
      if (h) ids.add(Number(h));
      if (a) ids.add(Number(a));
    }
  }
  return ids;
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((x) => {
      const [k, ...rest] = x.replace(/^--/, "").split("=");
      return [k, rest.join("=") || true];
    })
  );
  const season = Number(args.season || new Date().getFullYear());
  const singleDate = typeof args.date === "string" ? args.date : null;

  const supUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim();
  const supKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supKey) {
    console.error(
      "Missing SUPABASE_SERVICE_ROLE_KEY. Add it to .env.local (Supabase Dashboard → Project Settings → API → service_role)."
    );
    process.exit(1);
  }
  if (!supUrl) {
    console.error("Missing SUPABASE_URL or VITE_SUPABASE_URL.");
    process.exit(1);
  }

  const supabase = createClient(supUrl, supKey);

  console.error("Loading ESPN MLB rosters for name → id map…");
  const rosterMap = await buildEspnMlbNameToIdMap();
  console.error(`Roster map: ${rosterMap.size} players`);

  let pitcherIds = new Set();
  if (singleDate) {
    pitcherIds = await collectPitcherIdsForDate(singleDate);
  } else {
    const start = `${season}-03-01`;
    const end = `${season}-11-30`;
    let d = new Date(start);
    const endMs = new Date(end).getTime();
    while (d.getTime() <= endMs) {
      const ymd = d.toISOString().slice(0, 10);
      const chunk = await collectPitcherIdsForDate(ymd);
      for (const id of chunk) pitcherIds.add(id);
      d.setDate(d.getDate() + 7);
    }
  }

  const list = [...pitcherIds].filter(Boolean);
  console.error(`Pitchers to sync: ${list.length}${list.length > 400 ? " (capped)" : ""}`);
  const capped = list.slice(0, 400);

  let ok = 0;
  for (const mlbId of capped) {
    const { l3, l5, name, lastDate } = await fetchGameLogEras(mlbId, season);
    if (!name || (l5 == null && l3 == null)) continue;
    const espnId = await resolveEspnAthleteId(name, rosterMap);
    if (!espnId) {
      console.error(`Skip ${name} (${mlbId}): no ESPN id`);
      continue;
    }
    const row = {
      pitcher_id: espnId,
      pitcher_name: name,
      season,
      last_3_starts_era: l3,
      last_5_starts_era: l5,
      last_5_starts_fip: null,
      last_3_starts_fip: null,
      avg_pitch_count: null,
      avg_innings_pitched: null,
      last_start_date: lastDate,
      last_updated: new Date().toISOString(),
    };
    const { error } = await supabase.from("mlb_pitcher_recent_form").upsert(row, { onConflict: "pitcher_id" });
    if (error) {
      console.error(`Upsert ${name}:`, error.message);
      continue;
    }
    ok++;
    await new Promise((r) => setTimeout(r, 120));
  }
  console.error(`Done. Upserted ${ok} rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
