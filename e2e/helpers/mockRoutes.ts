/**
 * Playwright route-interception helpers for odds provider E2E tests.
 *
 * All mocks operate at the Supabase Edge Function / REST API boundary so
 * tests never hit real provider APIs and can control exactly what each
 * provider returns.
 */

import type { Page } from "@playwright/test";
import {
  mmaValidResponse,
  boxingValidResponse,
  pinnacleFixtures,
  pinnacleOdds,
} from "./fixtures";

const SUPABASE_URL = "https://rxnqjdclqyazferbseeq.supabase.co";
const PROXY        = `${SUPABASE_URL}/functions/v1/odds-api-proxy`;

// ── Database mock ─────────────────────────────────────────────────────────────

/**
 * Make all Supabase REST table calls return empty results.
 * Forces the app down the odds-only path (no DB fighter records).
 *
 * Handles both array selects (returns []) and .single() selects
 * (returns 406 — PostgREST "no rows found", which supabase-js maps to
 * { data: null, error: {...} } — gracefully handled by all fetch functions).
 */
export async function mockDbEmpty(page: Page) {
  await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) => {
    const accept = route.request().headers()["accept"] ?? "";
    const isSingle = accept.includes("vnd.pgrst.object");

    if (isSingle) {
      return route.fulfill({
        status: 406,
        contentType: "application/json",
        body: JSON.stringify({
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
          details: "Results contain 0 rows",
          hint: null,
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    });
  });
}

// ── Proxy mocks ───────────────────────────────────────────────────────────────

/**
 * Mock the odds-api-proxy to return valid TheOddsAPI-format events for
 * the given sport. All other provider calls return 404.
 */
export async function mockOddsApiSuccess(
  page: Page,
  sport: "mma" | "boxing",
  body?: unknown,
) {
  const response = body ?? (sport === "mma" ? mmaValidResponse() : boxingValidResponse());
  const sportKey = sport === "mma" ? "mma_mixed_martial_arts" : "boxing";

  await page.route(`${PROXY}**`, (route) => {
    const url      = new URL(route.request().url());
    const provider = url.searchParams.get("provider") ?? "";
    const sk       = url.searchParams.get("sportKey")  ?? "";

    const isOddsApiCall = (provider === "the-odds-api" || provider === "") && sk === sportKey;
    if (isOddsApiCall) {
      return route.fulfill({
        status:      200,
        contentType: "application/json",
        body:        JSON.stringify(response),
      });
    }
    // Any other provider → 404 (not configured / wrong sport)
    return route.fulfill({ status: 404, contentType: "application/json", body: "[]" });
  });
}

/**
 * Mock TheOddsAPI to return a quota-exhausted 402 so the fallback chain
 * advances to the next provider.
 *
 * Does NOT intercept other providers — pair with mockPinnacleSuccess or
 * mockAllProvidersFail depending on the scenario under test.
 */
export async function mockOddsApiQuotaExhausted(page: Page) {
  await page.route(`${PROXY}**`, (route) => {
    const url      = new URL(route.request().url());
    const provider = url.searchParams.get("provider") ?? "";

    if (provider === "the-odds-api" || provider === "") {
      return route.fulfill({
        status:      402,
        contentType: "application/json",
        body:        JSON.stringify({ error_code: "OUT_OF_USAGE_CREDITS", message: "Quota exhausted" }),
      });
    }
    route.continue();
  });
}

/**
 * Simulate the full Pinnacle fallback scenario:
 *  - TheOddsAPI → 402 quota exhausted
 *  - Pinnacle fixtures + odds → valid data
 *  - All other secondary providers → 503 (not configured)
 */
export async function mockPinnacleSuccess(page: Page, sport: "mma" | "boxing") {
  await page.route(`${PROXY}**`, (route) => {
    const url      = new URL(route.request().url());
    const provider = url.searchParams.get("provider") ?? "";
    const subroute = url.searchParams.get("subroute") ?? "";

    if (provider === "the-odds-api" || provider === "") {
      return route.fulfill({
        status:      402,
        contentType: "application/json",
        body:        JSON.stringify({ error_code: "OUT_OF_USAGE_CREDITS" }),
      });
    }
    if (provider === "pinnacle" && subroute === "fixtures") {
      return route.fulfill({
        status:      200,
        contentType: "application/json",
        body:        JSON.stringify(pinnacleFixtures(sport)),
      });
    }
    if (provider === "pinnacle" && subroute === "odds") {
      return route.fulfill({
        status:      200,
        contentType: "application/json",
        body:        JSON.stringify(pinnacleOdds()),
      });
    }
    // All other secondary providers → unconfigured
    return route.fulfill({
      status:      503,
      contentType: "application/json",
      body:        JSON.stringify({ error: "provider_not_configured" }),
    });
  });
}

/**
 * Make every provider call return a 503 error.
 * Used to test graceful empty/error states in the UI.
 */
export async function mockAllProvidersFail(page: Page) {
  await page.route(`${PROXY}**`, (route) =>
    route.fulfill({
      status:      503,
      contentType: "application/json",
      body:        JSON.stringify({ error: "service_unavailable" }),
    }),
  );
}
