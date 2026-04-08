#!/usr/bin/env node
/**
 * Upsert `mlb_pitcher_recent_form` from MLB Stats API game logs + ESPN athlete search.
 *
 * Requires (service role — bypasses RLS write policies):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
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

import { createClient } from "@supabase/supabase-js";

const MLB = "https://statsapi.mlb.com/api/v1";
const ESPN_SEARCH = "https://site.api.espn.com/apis/common/v3/search";

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

async function resolveEspnAthleteId(fullName) {
  const q = (fullName ?? "").trim();
  if (!q) return null;
  const url = `${ESPN_SEARCH}?query=${encodeURIComponent(q)}&limit=12`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  for (const block of json.results ?? []) {
    if (block.type !== "athlete" && block.type !== "player") continue;
    for (const a of block.athletes ?? []) {
      const id = a.id != null ? String(a.id) : "";
      if (!id) continue;
      const lg = (a.league?.abbreviation ?? "").toUpperCase();
      if (lg === "MLB" || lg === "") return id;
    }
  }
  return null;
}

async function fetchGameLogEras(mlbPlayerId, season) {
  const url = `${MLB}/people/${mlbPlayerId}/stats?stats=gameLog&season=${season}&group=pitching`;
  const res = await fetch(url);
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
  const res = await fetch(url);
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

  const supUrl = process.env.SUPABASE_URL?.trim();
  const supKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supUrl || !supKey) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service role for upsert).");
    process.exit(1);
  }

  const supabase = createClient(supUrl, supKey);

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
    const espnId = await resolveEspnAthleteId(name);
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
