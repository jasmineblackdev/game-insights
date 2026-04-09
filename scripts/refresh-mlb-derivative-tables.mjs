#!/usr/bin/env node
/**
 * ETL: seed MLB derivative Supabase tables used by the layered model:
 *   • mlb_team_batting_splits — season **overall** hitting (Stats API); vs_lhp / vs_rhp need a paid/split feed — not on free team stats endpoint.
 *   • mlb_bullpen_fatigue_scores — reliever IP + pitch counts in the 3 calendar days before `--score-date`.
 *   • mlb_lineup_strength_scores — not populated here (requires confirmed lineup / star mapping); run a separate job or wire ESPN summaries.
 *
 * Env: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL or VITE_SUPABASE_URL (loads `.env.local` like other scripts).
 *
 * Usage:
 *   node scripts/refresh-mlb-derivative-tables.mjs --season=2025 --score-date=2025-04-10
 *
 * score-date = the pregame “as of” date (rows keyed `{TEAM_ABBR}-{score-date}`).
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MLB = "https://statsapi.mlb.com/api/v1";

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
  const out = { season: new Date().getFullYear(), scoreDate: null };
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--season=(\d{4})$/);
    if (m) out.season = Number(m[1]);
    const d = a.match(/^--score-date=(\d{4}-\d{2}-\d{2})$/);
    if (d) out.scoreDate = d[1];
  }
  if (!out.scoreDate) {
    out.scoreDate = new Date().toISOString().slice(0, 10);
  }
  return out;
}

function ymdAddDays(ymd, delta) {
  const [y, m, d] = ymd.split("-").map(Number);
  const u = new Date(Date.UTC(y, m - 1, d));
  u.setUTCDate(u.getUTCDate() + delta);
  return u.toISOString().slice(0, 10);
}

function parseIp(s) {
  if (typeof s !== "string") return 0;
  const [w, f] = s.split(".");
  const whole = Number(w) || 0;
  const third = f === "1" ? 1 / 3 : f === "2" ? 2 / 3 : 0;
  return whole + third;
}

function num(s) {
  if (s == null) return null;
  if (typeof s === "number" && Number.isFinite(s)) return s;
  const t = String(s).trim();
  const n = Number.parseFloat(t.startsWith(".") ? `0${t}` : t);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "GameLens-MLB-ETL/1.0" },
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function upsertTeamOverallSplits(supabase, season) {
  const { teams } = await fetchJson(`${MLB}/teams?sportId=1&season=${season}`);
  let n = 0;
  for (const wrap of teams ?? []) {
    const t = wrap.team;
    const tid = t?.id;
    const abbr = (t?.abbreviation || t?.fileCode || "").toUpperCase();
    if (!tid || !abbr) continue;
    const j = await fetchJson(`${MLB}/teams/${tid}/stats?stats=season&season=${season}&group=hitting&sportIds=1`);
    const split = j?.stats?.[0]?.splits?.[0];
    const st = split?.stat;
    if (!st) continue;
    const gp = Number(st.gamesPlayed) || 0;
    const pa = Number(st.plateAppearances) || 0;
    const so = Number(st.strikeOuts) || 0;
    const runs = Number(st.runs) || 0;
    const row = {
      id: `${abbr}-${season}-overall`,
      team_id: abbr,
      season,
      split_type: "overall",
      batting_avg: num(st.avg),
      obp: num(st.obp),
      slg: num(st.slg),
      ops: num(st.ops),
      strikeout_rate: pa > 0 ? Math.round((so / pa) * 1000) / 1000 : null,
      runs_per_game: gp > 0 ? Math.round((runs / gp) * 100) / 100 : null,
      sample_pa: pa,
      last_updated: new Date().toISOString(),
    };
    const { error } = await supabase.from("mlb_team_batting_splits").upsert(row, { onConflict: "id" });
    if (error) console.warn(`[batting] ${abbr}:`, error.message);
    else n += 1;
    await sleep(80);
  }
  console.log(`[batting] Upserted ${n} team overall rows for season ${season}.`);
}

function aggregateBullpenForTeam(box, side) {
  const sideObj = box?.teams?.[side];
  if (!sideObj) return null;
  const abbr = sideObj?.team?.abbreviation?.toUpperCase();
  const pitcherIds = sideObj.pitchers ?? [];
  if (!abbr || pitcherIds.length === 0) return null;
  let inn = 0;
  let pitches = 0;
  for (let i = 1; i < pitcherIds.length; i++) {
    const pid = pitcherIds[i];
    const pit = sideObj.players?.[`ID${pid}`]?.stats?.pitching;
    if (!pit) continue;
    inn += parseIp(pit.inningsPitched);
    const pc = Number(pit.numberOfPitches ?? pit.pitchesThrown ?? pit.pitches ?? 0);
    if (Number.isFinite(pc)) pitches += pc;
  }
  return { abbr, inn, pitches };
}

async function refreshBullpenFatigue(scoreDate) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !key) {
    console.error("Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL / VITE_SUPABASE_URL.");
    process.exit(1);
  }
  const supabase = createClient(supabaseUrl, key);

  const gamePks = new Set();
  for (let back = 1; back <= 3; back++) {
    const d = ymdAddDays(scoreDate, -back);
    const sched = await fetchJson(`${MLB}/schedule?sportId=1&date=${d}`);
    for (const dt of sched.dates ?? []) {
      for (const g of dt.games ?? []) {
        const st = g.status?.abstractGameState || g.status?.detailedState;
        if (st === "Final" || st === "Completed") gamePks.add(g.gamePk);
      }
    }
  }

  const byTeam = new Map();
  let bx = 0;
  for (const pk of gamePks) {
    try {
      const box = await fetchJson(`${MLB}/game/${pk}/boxscore`);
      bx += 1;
      for (const side of ["home", "away"]) {
        const agg = aggregateBullpenForTeam(box, side);
        if (!agg) continue;
        const cur = byTeam.get(agg.abbr) || { inn: 0, pitches: 0 };
        cur.inn += agg.inn;
        cur.pitches += agg.pitches;
        byTeam.set(agg.abbr, cur);
      }
    } catch (e) {
      console.warn(`[bullpen] box ${pk}:`, e?.message || e);
    }
    await sleep(150);
  }
  console.log(`[bullpen] Processed ${bx} final boxscores for window before ${scoreDate}.`);

  const rows = [];
  for (const [abbr, v] of byTeam) {
    const fatigueScore = Math.min(10, Math.round(v.inn * 1.05 + v.pitches / 55));
    rows.push({
      id: `${abbr}-${scoreDate}`,
      team_id: abbr,
      score_date: scoreDate,
      bullpen_innings_last_3_days: Math.round(v.inn * 10) / 10,
      bullpen_pitches_last_3_days: Math.min(32767, Math.round(v.pitches)),
      closer_available_score: 7,
      fatigue_score: Math.min(10, Math.max(0, fatigueScore)),
      season_bullpen_quality_score: null,
      last_updated: new Date().toISOString(),
    });
  }

  if (rows.length) {
    const { error } = await supabase.from("mlb_bullpen_fatigue_scores").upsert(rows, { onConflict: "id" });
    if (error) console.error("[bullpen] upsert:", error.message);
    else console.log(`[bullpen] Upserted ${rows.length} rows for score_date=${scoreDate}.`);
  } else {
    console.log("[bullpen] No relief usage aggregated (no finals in lookback?).");
  }
}

async function main() {
  const { season, scoreDate } = parseArgs();
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !key) {
    console.error("Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL / VITE_SUPABASE_URL.");
    process.exit(1);
  }
  const supabase = createClient(supabaseUrl, key);

  console.log(`Season ${season}, score-date ${scoreDate}`);
  await upsertTeamOverallSplits(supabase, season);
  await refreshBullpenFatigue(supabase, scoreDate);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
