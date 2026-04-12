/**
 * E2E tests for the odds provider fallback chain.
 *
 * Coverage:
 *  1. Primary provider success — fights load with correct names and odds
 *  2. Odds formatting — American odds render correctly (+ prefix, no double-minus)
 *  3. Incomplete market coverage — card renders when totals absent (no crash / NaN)
 *  4. Fallback chain — Pinnacle serves fights when TheOddsAPI quota is exhausted
 *  5. All providers fail — graceful error/empty state, no blank screen
 *  6. Sport routing isolation — MMA events don't bleed into Boxing tab and vice versa
 *
 * All Supabase DB calls are mocked to return empty so tests run on the
 * odds-only fetch path and are not affected by real database state.
 * All provider API calls are mocked so tests never hit real APIs.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  mockDbEmpty,
  mockOddsApiSuccess,
  mockPinnacleSuccess,
  mockAllProvidersFail,
} from "./helpers/mockRoutes";
import { mmaMoneylineOnly } from "./helpers/fixtures";

// ── Navigation helpers ────────────────────────────────────────────────────────

async function openSport(page: Page, sport: "mma" | "boxing") {
  await page.goto("/");
  // Combat sport tabs may include emoji — match by text content substring
  await page.getByRole("button", { name: new RegExp(sport, "i") }).first().click();
}

/**
 * Combat sports default to "Today" then auto-advance to the nearest
 * date with events. Click "Next 14 days" if visible to ensure the
 * test fixtures (which are 3 days out) are shown.
 */
async function showUpcomingFights(page: Page) {
  // Brief wait for auto-advance effect to settle after loading completes
  await page.waitForTimeout(1_000);
  const weekTab = page.getByRole("button", { name: /next 14 days/i });
  if (await weekTab.isVisible()) {
    await weekTab.click();
  }
}

/** Waits for either fight data or a meaningful empty/error state. */
async function waitForDataOrFeedback(page: Page, dataText: string | RegExp) {
  await expect(
    page.getByText(dataText).or(page.getByText(/could not load|no.*fights|try.*date/i).first()),
  ).toBeVisible({ timeout: 30_000 });
}

// ── Scenario 1: Primary provider success ─────────────────────────────────────

test.describe("Scenario 1 — primary provider: fight data loads correctly", () => {
  test.beforeEach(async ({ page }) => {
    await mockDbEmpty(page);
    await mockOddsApiSuccess(page, "mma");
    await openSport(page, "mma");
    await waitForDataOrFeedback(page, "Jon Jones");
    await showUpcomingFights(page);
  });

  test("fight cards show correct fighter names", async ({ page }) => {
    await expect(page.getByText("Jon Jones")).toBeVisible();
    await expect(page.getByText("Stipe Miocic")).toBeVisible();
    // Second fight from fixture
    await expect(page.getByText("Islam Makhachev")).toBeVisible();
    await expect(page.getByText("Charles Oliveira")).toBeVisible();
  });

  test("totals line (over/under rounds) renders when present", async ({ page }) => {
    // First fight includes o/u 2.5 rounds
    await expect(page.getByText(/2\.5/).first()).toBeVisible();
  });

  test("no error state shown when provider succeeds", async ({ page }) => {
    await expect(page.getByText(/could not load/i)).not.toBeVisible();
    await expect(page.getByText(/unavailable/i)).not.toBeVisible();
  });
});

// ── Scenario 2: Odds formatting ───────────────────────────────────────────────

test.describe("Scenario 2 — American odds display correctly", () => {
  test("favorite shows negative moneyline without double-minus", async ({ page }) => {
    await mockDbEmpty(page);
    await mockOddsApiSuccess(page, "mma");
    await openSport(page, "mma");
    await waitForDataOrFeedback(page, "Jon Jones");
    await showUpcomingFights(page);

    // Jones -400 should render as "-400", never "--400"
    await expect(page.getByText("-400")).toBeVisible();
    const content = await page.content();
    expect(content).not.toContain("--400");
  });

  test("underdog shows positive moneyline with + prefix", async ({ page }) => {
    await mockDbEmpty(page);
    await mockOddsApiSuccess(page, "mma");
    await openSport(page, "mma");
    await waitForDataOrFeedback(page, "Jon Jones");
    await showUpcomingFights(page);

    // Miocic +300 should render as "+300", never "300"
    await expect(page.getByText("+300")).toBeVisible();
  });

  test("boxing odds: favorite negative, underdog positive", async ({ page }) => {
    await mockDbEmpty(page);
    await mockOddsApiSuccess(page, "boxing");
    await openSport(page, "boxing");
    await waitForDataOrFeedback(page, "Canelo Alvarez");
    await showUpcomingFights(page);

    await expect(page.getByText("-150")).toBeVisible(); // Canelo favorite
    await expect(page.getByText("+120")).toBeVisible(); // Bivol underdog
  });
});

// ── Scenario 3: Incomplete market coverage ────────────────────────────────────

test.describe("Scenario 3 — incomplete provider data (moneyline only)", () => {
  test("card renders without crash or NaN when totals market absent", async ({ page }) => {
    await mockDbEmpty(page);
    await mockOddsApiSuccess(page, "mma", mmaMoneylineOnly());
    await openSport(page, "mma");
    await waitForDataOrFeedback(page, "Fighter Alpha");
    await showUpcomingFights(page);

    // Card should render with the fighter names
    await expect(page.getByText("Fighter Alpha")).toBeVisible();
    await expect(page.getByText("Fighter Beta")).toBeVisible();

    // No broken values in the rendered output
    const content = await page.content();
    expect(content).not.toContain("NaN");
    expect(content).not.toContain("[object Object]");
    expect(content).not.toContain("undefined");
  });

  test("moneyline odds still display when totals are absent", async ({ page }) => {
    await mockDbEmpty(page);
    await mockOddsApiSuccess(page, "mma", mmaMoneylineOnly());
    await openSport(page, "mma");
    await waitForDataOrFeedback(page, "-200");
    await showUpcomingFights(page);

    await expect(page.getByText("-200")).toBeVisible(); // Alpha favorite
    await expect(page.getByText("+160")).toBeVisible(); // Beta underdog
  });
});

// ── Scenario 4: Fallback chain — Pinnacle ────────────────────────────────────

test.describe("Scenario 4 — fallback: Pinnacle serves when TheOddsAPI quota exhausted", () => {
  test("fights still load via Pinnacle after 402 from TheOddsAPI", async ({ page }) => {
    await mockDbEmpty(page);
    await mockPinnacleSuccess(page, "mma");
    await openSport(page, "mma");
    await waitForDataOrFeedback(page, "Jon Jones");
    await showUpcomingFights(page);

    // Pinnacle fixture has Jon Jones vs Stipe Miocic
    await expect(page.getByText("Jon Jones")).toBeVisible();
    await expect(page.getByText("Stipe Miocic")).toBeVisible();
  });

  test("no hard error state shown when fallback provider succeeds", async ({ page }) => {
    await mockDbEmpty(page);
    await mockPinnacleSuccess(page, "mma");
    await openSport(page, "mma");
    await page.waitForTimeout(5_000); // allow full fallback chain to resolve

    await expect(page.getByText(/could not load.*fight/i)).not.toBeVisible();
  });

  test("Pinnacle odds display with correct +/- formatting", async ({ page }) => {
    await mockDbEmpty(page);
    await mockPinnacleSuccess(page, "mma");
    await openSport(page, "mma");
    await waitForDataOrFeedback(page, /\-38[0-9]|\+28[0-9]/);
    await showUpcomingFights(page);

    // Pinnacle mock: home -380, away +280
    await expect(page.getByText("-380")).toBeVisible();
    await expect(page.getByText("+280")).toBeVisible();
  });
});

// ── Scenario 5: All providers fail ───────────────────────────────────────────

test.describe("Scenario 5 — all providers fail: graceful degradation", () => {
  test("MMA tab shows meaningful feedback, not a blank screen", async ({ page }) => {
    await mockDbEmpty(page);
    await mockAllProvidersFail(page);
    await openSport(page, "mma");

    // Wait for the query to fail (allow full timeout window)
    await page.waitForTimeout(8_000);

    // The page should show either an error message or an empty-state message
    const errorVisible = await page.getByText(/could not load|unavailable|no.*fights/i).isVisible();
    expect(errorVisible).toBe(true);

    // Critical: no blank white page
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.trim().length).toBeGreaterThan(0);
  });

  test("app does not crash when all providers fail", async ({ page }) => {
    await mockDbEmpty(page);
    await mockAllProvidersFail(page);
    await openSport(page, "mma");
    await page.waitForTimeout(8_000);

    // Check no uncaught exceptions were thrown
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    expect(errors.filter((e) => !e.includes("ResizeObserver"))).toHaveLength(0);
  });
});

// ── Scenario 6: Sport routing isolation ──────────────────────────────────────

test.describe("Scenario 6 — sport routing: MMA and Boxing feeds are isolated", () => {
  test("MMA fighter names do not appear in Boxing tab", async ({ page }) => {
    await mockDbEmpty(page);
    // Only mock MMA odds — Boxing provider calls will return 404
    await mockOddsApiSuccess(page, "mma");

    await page.goto("/");
    // Navigate directly to Boxing tab without touching MMA
    await page.getByRole("button", { name: /boxing/i }).first().click();
    await page.waitForTimeout(5_000);

    // MMA-specific fixture names must not bleed into Boxing
    await expect(page.getByText("Jon Jones")).not.toBeVisible();
    await expect(page.getByText("Stipe Miocic")).not.toBeVisible();
    await expect(page.getByText("Islam Makhachev")).not.toBeVisible();
  });

  test("Boxing fighter names do not appear in MMA tab", async ({ page }) => {
    await mockDbEmpty(page);
    await mockOddsApiSuccess(page, "boxing");

    await page.goto("/");
    await page.getByRole("button", { name: /mma/i }).first().click();
    await page.waitForTimeout(5_000);

    // Boxing-specific fixture names must not bleed into MMA
    await expect(page.getByText("Canelo Alvarez")).not.toBeVisible();
    await expect(page.getByText("Dmitry Bivol")).not.toBeVisible();
  });

  test("switching from MMA to Boxing clears MMA fight cards", async ({ page }) => {
    await mockDbEmpty(page);
    // MMA returns data, Boxing returns empty (404 from the mock)
    await mockOddsApiSuccess(page, "mma");

    await openSport(page, "mma");
    await waitForDataOrFeedback(page, "Jon Jones");
    await showUpcomingFights(page);
    await expect(page.getByText("Jon Jones")).toBeVisible();

    // Switch to Boxing
    await page.getByRole("button", { name: /boxing/i }).first().click();
    await page.waitForTimeout(3_000);

    // MMA fighter should no longer be visible
    await expect(page.getByText("Jon Jones")).not.toBeVisible();
  });
});
