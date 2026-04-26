#!/usr/bin/env node
/**
 * Backtest harness — replays resolved prediction_history entries and
 * reports Brier score, calibration buckets (reliability diagram), and
 * CLV hit-rate by sport × market_type × confidence.
 *
 * Env: SUPABASE_SERVICE_ROLE_KEY + SUPABASE_URL (loads .env.local).
 *
 * Usage:
 *   node scripts/backtest.mjs                      # 90-day window
 *   node scripts/backtest.mjs --window-days=30
 *   node scripts/backtest.mjs --sport=nba
 *   node scripts/backtest.mjs --json > report.json # machine output
 *
 * Key metrics:
 *   - Brier score    : 0 perfect, 0.25 always-50%, 1 maximally wrong
 *   - Log loss       : 0 perfect, ↑ when confident but wrong
 *   - Calibration    : per-bucket gap between predicted and observed hit rate
 *   - CLV hit rate   : fraction of settled predictions with positive CLV
 *   - CLV-win corr   : Pearson correlation between clv_pp and win — should be
 *                      positive if the model is genuinely finding value
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Env loading ─────────────────────────────────────────────────────

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

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_PROJECT_URL;
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — set them in .env.local.");
  process.exit(1);
}

// ── CLI args ────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^-+/, "").split("=");
    return [k, v];
  })
);

const WINDOW_DAYS   = Number(args["window-days"] ?? 90);
const SPORT_FILTER  = args.sport ? String(args.sport).toLowerCase() : null;
const EMIT_JSON     = args.json === "true";

// ── Metric helpers ──────────────────────────────────────────────────

function brierScore(rows) {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    if (r.outcome !== "win" && r.outcome !== "loss") continue;
    const p = Number(r.hit_probability_at_prediction);
    const y = r.outcome === "win" ? 1 : 0;
    if (!Number.isFinite(p)) continue;
    sum += (p - y) ** 2;
    n++;
  }
  return n ? sum / n : null;
}

function logLoss(rows) {
  const eps = 1e-12;
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    if (r.outcome !== "win" && r.outcome !== "loss") continue;
    const p = Math.min(1 - eps, Math.max(eps, Number(r.hit_probability_at_prediction)));
    const y = r.outcome === "win" ? 1 : 0;
    sum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    n++;
  }
  return n ? sum / n : null;
}

/**
 * Split into 10 equal-width bins of predicted probability, report the
 * observed hit rate in each. A well-calibrated model has bin_predicted ≈
 * bin_observed.
 */
function calibrationBuckets(rows) {
  const bins = Array.from({ length: 10 }, (_, i) => ({
    low:       i / 10,
    high:      (i + 1) / 10,
    predicted: 0,
    observed:  0,
    n:         0,
  }));
  for (const r of rows) {
    if (r.outcome !== "win" && r.outcome !== "loss") continue;
    const p = Number(r.hit_probability_at_prediction);
    if (!Number.isFinite(p)) continue;
    const idx = Math.min(9, Math.max(0, Math.floor(p * 10)));
    bins[idx].predicted += p;
    bins[idx].observed  += r.outcome === "win" ? 1 : 0;
    bins[idx].n++;
  }
  return bins.map((b) => ({
    range:          `${b.low.toFixed(1)}-${b.high.toFixed(1)}`,
    n:              b.n,
    avg_predicted:  b.n ? Math.round((b.predicted / b.n) * 1000) / 1000 : null,
    observed:       b.n ? Math.round((b.observed  / b.n) * 1000) / 1000 : null,
    gap:            b.n
      ? Math.round(((b.observed / b.n) - (b.predicted / b.n)) * 1000) / 1000
      : null,
  }));
}

function clvMetrics(rows) {
  const decided = rows.filter((r) => r.outcome === "win" || r.outcome === "loss");
  const withClv = decided.filter((r) => r.clv_pp !== null && r.clv_pp !== undefined);
  if (!withClv.length) {
    return { samples: 0, positive_pct: null, avg_clv_pp: null, clv_win_corr: null };
  }
  const positive = withClv.filter((r) => Number(r.clv_pp) > 0).length;
  const sumClv   = withClv.reduce((s, r) => s + Number(r.clv_pp), 0);

  // Pearson correlation between clv_pp and win (1 / 0)
  const xs = withClv.map((r) => Number(r.clv_pp));
  const ys = withClv.map((r) => (r.outcome === "win" ? 1 : 0));
  const n  = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const corr = (dx && dy) ? num / Math.sqrt(dx * dy) : null;

  return {
    samples:      n,
    positive_pct: Math.round((100 * positive / n) * 10) / 10,
    avg_clv_pp:   Math.round((sumClv / n) * 100) / 100,
    clv_win_corr: corr === null ? null : Math.round(corr * 10000) / 10000,
  };
}

function winRate(rows) {
  const decided = rows.filter((r) => r.outcome === "win" || r.outcome === "loss");
  if (!decided.length) return null;
  const wins = decided.filter((r) => r.outcome === "win").length;
  return Math.round((100 * wins / decided.length) * 10) / 10;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();

  // Live schema (gamelens_learning_intelligence). Older shape with
  // prediction_id/resolved_at/hit_probability_at_prediction/clv_pp was
  // superseded; we read the new columns and map them to the internal
  // names the metric helpers expect so the rest of the script is
  // schema-agnostic. CLV columns aren't yet in this schema — those
  // metrics surface as null until a CLV migration lands.
  let query = supabase
    .from("prediction_history")
    .select(
      "id, sport, market_type, prediction_phase, confidence, " +
      "model_probability, edge, outcome, settled_at, " +
      "american_odds, implied_probability"
    )
    .gte("settled_at", cutoff)
    .in("outcome", ["win", "loss"])
    .limit(10_000);
  if (SPORT_FILTER) query = query.eq("sport", SPORT_FILTER);

  const { data: raw, error } = await query;
  if (error) {
    console.error("Supabase error:", error.message);
    process.exit(1);
  }
  if (!raw?.length) {
    console.error(`No resolved predictions found in last ${WINDOW_DAYS} days.`);
    process.exit(0);
  }

  // Normalize to the field names the metric helpers + group key use.
  const data = raw.map((r) => ({
    prediction_id:                  r.id,
    sport:                          r.sport,
    market_type:                    r.market_type,
    context:                        r.prediction_phase,
    confidence:                     r.confidence,
    hit_probability_at_prediction:  r.model_probability,
    edge_at_prediction:             r.edge,
    outcome:                        r.outcome,
    resolved_at:                    r.settled_at,
    clv_pp:                         null,
    closing_line_american:          null,
    opening_line_american:          null,
    pre_confirmation_flag:          false,
  }));

  const overall = {
    window_days:        WINDOW_DAYS,
    sport_filter:       SPORT_FILTER,
    total_samples:      data.length,
    win_rate:           winRate(data),
    brier_score:        brierScore(data),
    log_loss:           logLoss(data),
    calibration_buckets: calibrationBuckets(data),
    clv:                clvMetrics(data),
  };

  // Group rollups
  const groups = new Map();
  for (const r of data) {
    const key = `${r.sport}|${r.market_type}|${r.context}|${r.confidence}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const per_slice = Array.from(groups.entries())
    .map(([key, rows]) => {
      const [sport, market_type, context, confidence] = key.split("|");
      return {
        sport, market_type, context, confidence,
        n:           rows.length,
        win_rate:    winRate(rows),
        brier_score: brierScore(rows),
        clv:         clvMetrics(rows),
      };
    })
    .filter((s) => s.n >= 10)
    .sort((a, b) => b.n - a.n);

  const report = { overall, per_slice };

  if (EMIT_JSON) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  // Pretty print
  console.log(`\n=== Backtest report · last ${WINDOW_DAYS} days${SPORT_FILTER ? ` · ${SPORT_FILTER.toUpperCase()}` : ""} ===`);
  console.log(`Samples: ${overall.total_samples} · Win rate: ${overall.win_rate}% · Brier: ${overall.brier_score?.toFixed(4)} · Log loss: ${overall.log_loss?.toFixed(4)}`);
  console.log(`CLV: ${overall.clv.samples} samples · ${overall.clv.positive_pct}% positive · avg ${overall.clv.avg_clv_pp}pp · corr(CLV,win) ${overall.clv.clv_win_corr}`);

  console.log(`\n-- Calibration buckets (predicted vs observed) --`);
  console.log("  range    n     predicted  observed   gap");
  for (const b of overall.calibration_buckets) {
    if (b.n === 0) continue;
    console.log(
      `  ${b.range}  ${String(b.n).padStart(4)}    ` +
      `${(b.avg_predicted ?? 0).toFixed(3).padStart(6)}    ` +
      `${(b.observed ?? 0).toFixed(3).padStart(6)}    ` +
      `${(b.gap ?? 0 >= 0 ? "+" : "")}${(b.gap ?? 0).toFixed(3)}`
    );
  }

  console.log(`\n-- Per slice (min 10 samples) --`);
  console.log("  sport  market          context     conf   n    win%   brier    CLV+%   corr");
  for (const s of per_slice) {
    const brier = s.brier_score !== null ? s.brier_score.toFixed(4) : "   — ";
    console.log(
      `  ${s.sport.padEnd(5)}  ${s.market_type.padEnd(14)}  ${s.context.padEnd(10)}  ${s.confidence.padEnd(5)}  ` +
      `${String(s.n).padStart(4)}   ${String(s.win_rate).padStart(5)}  ${brier}   ` +
      `${String(s.clv.positive_pct ?? "—").padStart(5)}   ${s.clv.clv_win_corr ?? "—"}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
