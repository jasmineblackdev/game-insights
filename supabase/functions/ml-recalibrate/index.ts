/**
 * ml-recalibrate — nightly learning-loop closure.
 *
 * Runs:
 *   1. Selects resolved predictions where platt_applied = false
 *   2. Groups by (sport, market_type, confidence_bucket)
 *   3. Fits Platt A/B via logistic regression on raw hit probabilities
 *      vs observed outcomes
 *   4. Computes Brier score and log loss per group
 *   5. Upserts platt_calibration_params
 *   6. Marks included predictions with platt_applied = true + batch id
 *
 * Invoke via Supabase Cron:
 *   select cron.schedule('ml-recalibrate-nightly', '15 4 * * *',
 *     $$ select net.http_post(
 *          url := 'https://<project>.functions.supabase.co/ml-recalibrate',
 *          headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_token'))
 *        ) $$);
 *
 * Or one-shot: curl -X POST $URL/ml-recalibrate -H "Authorization: Bearer $SERVICE_KEY"
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Platt scaling via Newton's method on logistic regression ───────
// Fits p_calibrated = 1 / (1 + exp(A * logit + B)) given raw logits
// and binary outcomes. Uses the standard Platt reference implementation
// (Lin, Lin, Weng 2007) with bias-corrected target labels to avoid
// overfit on small samples.

interface PlattResult {
  a: number;
  b: number;
  iterations: number;
  converged: boolean;
}

function fitPlatt(
  rawProbs: number[],
  outcomes: number[],
  maxIter = 100,
): PlattResult {
  const eps    = 1e-12;
  const n      = rawProbs.length;
  const prior1 = outcomes.reduce((s, y) => s + y, 0);
  const prior0 = n - prior1;

  // Lin-Lin-Weng bias-corrected targets
  const hi = (prior1 + 1) / (prior1 + 2);
  const lo = 1 / (prior0 + 2);
  const t: number[] = outcomes.map((y) => (y === 1 ? hi : lo));

  // Convert raw probs → decision values (f) via logit.
  const f: number[] = rawProbs.map((p) => {
    const clamped = Math.min(1 - eps, Math.max(eps, p));
    return Math.log(clamped / (1 - clamped));
  });

  let a = 0;
  let b = Math.log((prior0 + 1) / (prior1 + 1));
  const minStep = 1e-10;
  const sigma   = 1e-12;

  const fnValue = (A: number, B: number): number => {
    let fv = 0;
    for (let i = 0; i < n; i++) {
      const fApB = f[i] * A + B;
      if (fApB >= 0) {
        fv += t[i] * fApB + Math.log(1 + Math.exp(-fApB));
      } else {
        fv += (t[i] - 1) * fApB + Math.log(1 + Math.exp(fApB));
      }
    }
    return fv;
  };

  let current = fnValue(a, b);
  let iter = 0;
  for (; iter < maxIter; iter++) {
    let h11 = sigma, h22 = sigma, h21 = 0;
    let g1 = 0, g2 = 0;

    for (let i = 0; i < n; i++) {
      const fApB = f[i] * a + b;
      let p: number;
      let q: number;
      if (fApB >= 0) {
        const e = Math.exp(-fApB);
        p = e / (1 + e);
        q = 1 / (1 + e);
      } else {
        const e = Math.exp(fApB);
        p = 1 / (1 + e);
        q = e / (1 + e);
      }
      const d2 = p * q;
      h11 += f[i] * f[i] * d2;
      h22 += d2;
      h21 += f[i] * d2;
      const d1 = t[i] - p;
      g1 += f[i] * d1;
      g2 += d1;
    }

    if (Math.abs(g1) < 1e-5 && Math.abs(g2) < 1e-5) {
      return { a, b, iterations: iter, converged: true };
    }

    const det = h11 * h22 - h21 * h21;
    const dA  = -(h22 * g1 - h21 * g2) / det;
    const dB  = -(-h21 * g1 + h11 * g2) / det;
    const gd  = g1 * dA + g2 * dB;

    let stepSize = 1;
    for (; stepSize >= minStep; stepSize /= 2) {
      const newA = a + stepSize * dA;
      const newB = b + stepSize * dB;
      const newF = fnValue(newA, newB);
      if (newF < current + 1e-4 * stepSize * gd) {
        a = newA; b = newB; current = newF;
        break;
      }
    }
    if (stepSize < minStep) {
      return { a, b, iterations: iter, converged: false };
    }
  }
  return { a, b, iterations: iter, converged: false };
}

function brier(rawProbs: number[], outcomes: number[]): number {
  let s = 0;
  for (let i = 0; i < rawProbs.length; i++) {
    s += (rawProbs[i] - outcomes[i]) ** 2;
  }
  return s / rawProbs.length;
}

function logLoss(rawProbs: number[], outcomes: number[]): number {
  const eps = 1e-12;
  let s = 0;
  for (let i = 0; i < rawProbs.length; i++) {
    const p = Math.min(1 - eps, Math.max(eps, rawProbs[i]));
    s += -(outcomes[i] * Math.log(p) + (1 - outcomes[i]) * Math.log(1 - p));
  }
  return s / rawProbs.length;
}

// ── Main handler ───────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const url = new URL(req.url);
  // 25 matches the bucket-activation threshold the rest of the
  // system already uses (mlPredictionLayer.ts requires ≥25 settled
  // outcomes per (sport × market × confidence) before consulting
  // bucket-derived hit-rate). Override via ?min_samples= for testing.
  const MIN_SAMPLES = Number(url.searchParams.get("min_samples") ?? 25);
  const WINDOW_DAYS = Number(url.searchParams.get("window_days") ?? 90);

  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const batchId = crypto.randomUUID();

  // 1. Pull settled predictions in the window from the live
  // `prediction_history` schema (gamelens_learning_intelligence
  // migration 20260421). Live columns:
  //   model_probability   — Platt input (was hit_probability_at_prediction)
  //   settled_at          — resolution timestamp (was resolved_at)
  //   outcome ∈ win|loss|push (we filter to win/loss only)
  //   confidence ∈ high|medium|low (lowercase per check constraint)
  // No `platt_applied` flag exists on this schema — we re-fit every
  // run and the upsert (sport, market, confidence) keeps it
  // idempotent. Cheap; the alternative (tracking applied rows) was
  // load-bearing only for the legacy schema.
  const { data, error } = await supabase
    .from("prediction_history")
    .select("id, sport, market_type, confidence, model_probability, outcome, settled_at")
    .in("outcome", ["win", "loss"])
    .gte("settled_at", cutoff)
    .limit(50_000);

  if (error) return json({ ok: false, error: error.message }, 500);
  if (!data?.length) return json({ ok: true, message: "no settled predictions in window", batch_id: batchId });

  // 2. Group by (sport, market_type, confidence) — plus an "ALL" bucket
  type Group = {
    sport: string;
    market_type: string;
    confidence_bucket: string;
    probs: number[];
    outcomes: number[];
  };
  const groups = new Map<string, Group>();

  const addToGroup = (
    key: string,
    sport: string,
    market_type: string,
    confidence_bucket: string,
    p: number,
    y: number,
  ) => {
    let g = groups.get(key);
    if (!g) {
      g = { sport, market_type, confidence_bucket, probs: [], outcomes: [] };
      groups.set(key, g);
    }
    g.probs.push(p);
    g.outcomes.push(y);
  };

  for (const r of data) {
    const p = Number(r.model_probability);
    if (!Number.isFinite(p)) continue;
    const y = r.outcome === "win" ? 1 : 0;
    const sport = String(r.sport).toLowerCase();
    const mkt   = String(r.market_type).toLowerCase();
    const conf  = String(r.confidence).toUpperCase();

    addToGroup(`${sport}|${mkt}|${conf}`, sport, mkt, conf,  p, y);
    addToGroup(`${sport}|${mkt}|ALL`,     sport, mkt, "ALL", p, y);
  }

  // 3. Fit Platt per group with enough samples
  const upserts: unknown[] = [];
  const skipped: unknown[] = [];

  for (const g of groups.values()) {
    if (g.probs.length < MIN_SAMPLES) {
      skipped.push({
        sport: g.sport, market_type: g.market_type,
        confidence_bucket: g.confidence_bucket, sample_size: g.probs.length,
        reason: "below min_samples",
      });
      continue;
    }
    const fit = fitPlatt(g.probs, g.outcomes);
    const brierScore = brier(g.probs, g.outcomes);
    const logLossVal = logLoss(g.probs, g.outcomes);

    upserts.push({
      sport:             g.sport,
      market_type:       g.market_type,
      confidence_bucket: g.confidence_bucket,
      a_param:           Math.round(fit.a * 10_000) / 10_000,
      b_param:           Math.round(fit.b * 10_000) / 10_000,
      sample_size:       g.probs.length,
      brier_score:       Math.round(brierScore * 10_000) / 10_000,
      log_loss:          Math.round(logLossVal * 10_000) / 10_000,
      fitted_at:         new Date().toISOString(),
    });
  }

  if (!upserts.length) {
    return json({
      ok: true, batch_id: batchId, message: "no groups met min_samples", skipped,
    });
  }

  // 4. Upsert platt params — re-fit on every run so the params
  // track the latest 90-day window without needing a per-row
  // applied flag.
  const { error: upErr } = await supabase
    .from("platt_calibration_params")
    .upsert(upserts, { onConflict: "sport,market_type,confidence_bucket" });
  if (upErr) return json({ ok: false, error: upErr.message }, 500);

  return json({
    ok: true,
    batch_id: batchId,
    groups_fit: upserts.length,
    skipped_groups: skipped.length,
    upserts,
    skipped,
  });
});
