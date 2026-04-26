#!/usr/bin/env node
/**
 * verify-snapshot-rls.mjs
 *
 * Deploy-time check that mlb_prediction_inputs_snapshot accepts
 * anon-role inserts. Pre-RLS-fix, the table only allowed service_role
 * writes — every browser-side snapshot returned 42501 silently.
 * Migration 20260504000000_mlb_snapshot_append_only.sql added an
 * append-only policy; this script confirms that policy is actually
 * in place by attempting a write with the anon key.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/verify-snapshot-rls.mjs
 *
 * Exit codes:
 *   0 — anon insert succeeded (RLS policy is in place)
 *   1 — anon insert returned 42501 (policy missing — re-run migration)
 *   2 — Supabase env not configured / network error
 *
 * Designed to run in CI so a future migration revert can't silently
 * break the learning loop.
 */

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim();

if (!SUPABASE_URL || !ANON_KEY) {
  console.error("[verify-snapshot-rls] SUPABASE_URL + SUPABASE_ANON_KEY required");
  process.exit(2);
}

const probeRow = {
  game_id:        `rls-probe-${Date.now()}`,
  team_abbr:      "PROBE",
  prediction_at:  new Date().toISOString(),
  inputs:         { source: "verify-snapshot-rls", purpose: "RLS smoke test" },
};

try {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/mlb_prediction_inputs_snapshot`, {
    method:  "POST",
    headers: {
      apikey:        ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      "Content-Type":  "application/json",
      Prefer:          "return=minimal",
    },
    body: JSON.stringify(probeRow),
  });

  if (res.ok) {
    console.log(`[verify-snapshot-rls] ✓ anon insert succeeded (status ${res.status})`);
    console.log("                       RLS append-only policy is in place.");
    process.exit(0);
  }

  const body = await res.text();
  if (res.status === 401 || res.status === 403 || body.includes("42501") || body.includes("row-level security")) {
    console.error(`[verify-snapshot-rls] ✗ anon insert blocked (status ${res.status})`);
    console.error("                       Response: " + body.slice(0, 200));
    console.error("                       Run migration 20260504000000_mlb_snapshot_append_only.sql");
    process.exit(1);
  }

  console.error(`[verify-snapshot-rls] unexpected status ${res.status}: ${body.slice(0, 200)}`);
  process.exit(2);
} catch (err) {
  console.error("[verify-snapshot-rls] network error:", err.message);
  process.exit(2);
}
