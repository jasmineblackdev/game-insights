import { test, expect } from "@playwright/test";

/**
 * Production-style checks: `vite preview` serves dist/ like a static host + SPA fallback.
 * If index references /src/main.tsx, script requests return HTML → Safari MIME type error.
 */
test.describe("Edge Card (production build / vite preview)", () => {
  test("/edge loads and script modules are not served as text/html", async ({ page }) => {
    const htmlAsScript: { url: string; contentType: string; status: number }[] = [];

    page.on("response", (response) => {
      if (response.request().resourceType() !== "script") return;
      const raw = response.headers()["content-type"] ?? "";
      const contentType = raw.split(";")[0].trim().toLowerCase();
      if (contentType.includes("text/html")) {
        htmlAsScript.push({
          url: response.url(),
          contentType: raw,
          status: response.status(),
        });
      }
    });

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    page.on("pageerror", (err) => {
      consoleErrors.push(err.message);
    });

    await page.goto("/edge", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Edge Card", level: 1 })).toBeVisible({
      timeout: 60_000,
    });

    await expect(
      page.getByRole("heading", { name: /Today's best team picks/i })
    ).toBeVisible({ timeout: 90_000 });

    expect(
      htmlAsScript,
      `A script request got text/html (usually SPA rewrite serving index.html for a missing .js file): ${JSON.stringify(htmlAsScript)}`
    ).toEqual([]);

    const mimeErrors = consoleErrors.filter((t) => /not a valid javascript mime type/i.test(t));
    expect(mimeErrors, `Console MIME errors: ${mimeErrors.join(" | ")}`).toEqual([]);
  });

  test("deep link /edge after home scroll still shows Edge header", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => window.scrollTo(0, 4_000));
    await page.goto("/edge");
    await expect(page.getByRole("heading", { name: "Edge Card", level: 1 })).toBeVisible({
      timeout: 60_000,
    });
  });
});
