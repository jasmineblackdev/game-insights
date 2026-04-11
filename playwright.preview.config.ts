import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against `vite preview` (same static output Vercel should serve).
 * Catches: /edge loading index.html that still points at /src/main.tsx → MIME type errors.
 *
 * Run: npm run test:e2e:preview
 */
const PORT = Number(process.env.E2E_PREVIEW_PORT ?? "4173");
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /edge-card-production\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 180_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
