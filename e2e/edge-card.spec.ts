import { test, expect } from "@playwright/test";

test.describe("Edge Card E2E", () => {
  test("direct /edge: hub loads and tabs switch", async ({ page }) => {
    await page.goto("/edge");

    await expect(page.getByRole("heading", { name: "Edge Card", level: 1 })).toBeVisible();

    const tabBar = page.getByRole("banner");

    await expect(page.getByRole("heading", { name: /Today's best team picks/i })).toBeVisible({
      timeout: 90_000,
    });

    await tabBar.getByRole("button", { name: /Best value/i }).click();
    await expect(
      page.getByText(/Top 5 best value|No value legs for this slate|Loading sportsbook lines/i).first()
    ).toBeVisible({ timeout: 60_000 });

    await tabBar.getByRole("button", { name: /Parlay builder/i }).click();
    await expect(page.getByRole("heading", { name: "Parlay builder" })).toBeVisible({ timeout: 30_000 });

    await tabBar.getByRole("button", { name: /Team picks/i }).click();
    await expect(page.getByRole("heading", { name: /Today's best team picks/i })).toBeVisible();
  });

  test("home → Edge Card link → /edge", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /Predictions|Props|Draft/i }).first()).toBeVisible({
      timeout: 90_000,
    });

    const edgeLink = page.getByRole("link", { name: /Edge Card|Edge/i }).first();
    await edgeLink.click();

    await expect(page).toHaveURL(/\/edge\/?$/);
    await expect(page.getByRole("heading", { name: "Edge Card", level: 1 })).toBeVisible({
      timeout: 60_000,
    });
  });
});
