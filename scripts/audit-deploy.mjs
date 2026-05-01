#!/usr/bin/env node
/**
 * Live deploy audit — drives the Vercel preview with Playwright and
 * runs the user's checklist against /paper, /parlay-builder, and
 * /parlays. Reports findings as a structured JSON + a human readable
 * summary.
 *
 * Usage:
 *   node scripts/audit-deploy.mjs <deploy-url>
 *
 * Exits non-zero when any blocker is hit (auth wall, JS error, etc.)
 * so the caller can decide whether the audit is meaningful.
 *
 * Caveats:
 *   - Vercel preview deployments behind SSO will fail at navigation;
 *     we report that as the only finding.
 *   - This script doesn't have a logged-in Supabase session, so any
 *     check that depends on user data (paper bets, slip state) sees
 *     the empty / cold-start view, not a populated one. Intent here
 *     is: confirm components mount, expected text/elements appear,
 *     no console errors. NOT to verify business logic with real data.
 */

import { chromium } from "playwright";

const URL_ARG = process.argv[2];
if (!URL_ARG) {
  console.error("Usage: node scripts/audit-deploy.mjs <deploy-url>");
  process.exit(2);
}
const BASE = URL_ARG.replace(/\/$/, "");

const findings = [];
function add(section, status, detail) {
  findings.push({ section, status, detail });
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 414, height: 896 }, // mobile first
});
const page = await ctx.newPage();

const consoleErrors = [];
const failedRequests = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`PAGE ERROR: ${err.message}`));
page.on("response", (resp) => {
  const status = resp.status();
  if (status >= 400) {
    failedRequests.push({ status, url: resp.url() });
  }
});

async function visit(path) {
  consoleErrors.length = 0;
  failedRequests.length = 0;
  const url = `${BASE}${path}`;
  const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch((e) => ({ _err: e }));
  if (resp && resp._err) return { err: resp._err.message, status: 0, finalUrl: page.url() };
  // Settle React + queries
  await page.waitForTimeout(2500);
  return { status: resp?.status(), finalUrl: page.url() };
}

async function visibleText() {
  return await page.evaluate(() => document.body.innerText);
}

async function hasText(needle) {
  const t = await visibleText();
  return t.includes(needle);
}

async function querySelectorCount(selector) {
  return await page.locator(selector).count();
}

// ── Step 0: deploy reachable? auth wall? ───────────────────────────────
const root = await visit("/");
if (root.err) {
  add("deploy", "FAIL", `navigation error: ${root.err}`);
} else if (root.status >= 400) {
  add("deploy", "FAIL", `HTTP ${root.status} on /`);
} else if (root.finalUrl.includes("vercel.com") || (await hasText("Authentication Required"))) {
  add("deploy", "FAIL", `redirected to Vercel SSO — preview is not public. final URL: ${root.finalUrl}`);
} else {
  const titleOk = await hasText("GameLens");
  add("deploy", titleOk ? "PASS" : "WARN", `loaded; title visible: ${titleOk}; finalUrl ${root.finalUrl}`);
}

// Bail early if deploy is unreachable.
if (findings.some((f) => f.section === "deploy" && f.status === "FAIL")) {
  console.log(JSON.stringify({ findings, consoleErrors }, null, 2));
  await browser.close();
  process.exit(1);
}

// ── 1. /paper ──────────────────────────────────────────────────────────
const paper = await visit("/paper");
if (paper.err) {
  add("/paper", "FAIL", `nav error: ${paper.err}`);
} else {
  const t = await visibleText();
  add("/paper", "INFO", `status ${paper.status}, ${t.length} chars rendered`);
  add("/paper", t.includes("Paper Bets") ? "PASS" : "FAIL", "header 'Paper Bets' visible");
  add("/paper", t.includes("PAPER MODE") ? "PASS" : "FAIL", "PAPER MODE banner visible");
  if (t.includes("Paper Bets tables not deployed")) {
    add("/paper", "FAIL", "migration banner showing — Supabase tables missing");
  }
  add("/paper", t.includes("Slip builder") ? "PASS" : "WARN", "Slip builder tab visible");
  add("/paper", t.includes("Open (") ? "PASS" : "WARN", "Open count tab visible");
  add("/paper", t.includes("Settled (") ? "PASS" : "WARN", "Settled count tab visible");
  // Auto-sweep happens on mount; can't verify resolution from outside but
  // we can confirm no error toast.
  add("/paper", consoleErrors.length === 0 ? "PASS" : "WARN", `${consoleErrors.length} console error(s) on mount`);
  consoleErrors.slice(0, 3).forEach((e, i) => add("/paper", "INFO", `err${i + 1}: ${e.slice(0, 200)}`));
  // Try entry form rendering
  const sportSelect = await querySelectorCount("select");
  add("/paper", sportSelect > 0 ? "PASS" : "WARN", `${sportSelect} <select> elements on entry form`);
}

// ── 2. Parlay builder tab (lives at "/" — clicked into via the nav) ───
// The parlay builder is NOT its own route. It's a viewMode tab inside
// Index.tsx, reached by clicking the "Parlay" / "Builder" nav button.
const pb = await visit("/");
if (pb.err) {
  add("parlay-builder", "FAIL", `nav error: ${pb.err}`);
} else {
  // Click into the parlay-builder tab. The button label varies — try
  // a few candidates the codebase uses.
  for (const label of ["Parlay Builder", "Parlay", "Builder", "Open Parlay Builder"]) {
    const btn = page.locator(`button:has-text('${label}'), a:has-text('${label}')`).first();
    if (await btn.count() > 0) {
      await btn.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(2500);
      break;
    }
  }
  const t = await visibleText();
  add("parlay-builder", "INFO", `status ${pb.status}, ${t.length} chars after tab click`);
  add("parlay-builder", t.includes("DraftKings Execution Assistant") ? "PASS" : "FAIL", "DK Assistant card visible");
  add("parlay-builder", t.includes("Candidate Pool") || t.includes("Best safe") || t.includes("Best props") ? "PASS" : "WARN", "Candidate pool section visible");
  add("parlay-builder", t.includes("Top props today") ? "PASS" : "WARN", "PropScanner mounted");
  // BetCard / decision pill / trust row
  const placeBadges = (t.match(/PLACE/g) ?? []).length;
  const modifyBadges = (t.match(/MODIFY/g) ?? []).length;
  const avoidBadges = (t.match(/AVOID/g) ?? []).length;
  add("parlay-builder", placeBadges + modifyBadges + avoidBadges > 0 ? "PASS" : "WARN",
      `decision pills: ${placeBadges} PLACE / ${modifyBadges} MODIFY / ${avoidBadges} AVOID`);
  const trustRow = (t.match(/Model \d+%/g) ?? []).length;
  add("parlay-builder", trustRow > 0 ? "PASS" : "WARN", `${trustRow} TrustRow instances`);
  add("parlay-builder", consoleErrors.length === 0 ? "PASS" : "WARN", `${consoleErrors.length} console error(s) (${new Set(consoleErrors).size} distinct)`);
  const distinct = [...new Set(consoleErrors.map((e) => e.slice(0, 200)))];
  distinct.slice(0, 6).forEach((e, i) => add("parlay-builder", "INFO", `distinct err${i + 1}: ${e}`));
  // Failed network requests deduped by host+path
  const failedHosts = new Map();
  for (const f of failedRequests) {
    try {
      const u = new URL(f.url);
      const key = `${u.hostname}${u.pathname.replace(/\/\d+/g, "/{id}").slice(0, 60)} (${f.status})`;
      failedHosts.set(key, (failedHosts.get(key) ?? 0) + 1);
    } catch {
      failedHosts.set(f.url.slice(0, 80), (failedHosts.get(f.url.slice(0, 80)) ?? 0) + 1);
    }
  }
  [...failedHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, n]) =>
    add("parlay-builder net", "INFO", `${n}× ${k}`),
  );

  // Try to expand the first BetCard's Details
  const detailsButtons = await page.locator("button:has-text('Details')").count();
  add("parlay-builder", detailsButtons > 0 ? "PASS" : "WARN", `${detailsButtons} Details toggle buttons`);
  if (detailsButtons > 0) {
    await page.locator("button:has-text('Details')").first().click().catch(() => {});
    await page.waitForTimeout(800);
    const t2 = await visibleText();
    add("parlay-builder", t2.includes("Hide details") ? "PASS" : "WARN", "Details opened (Hide details now visible)");
  }

  // DK Assistant quick actions — Open the panel first.
  const openAssistant = page.locator("button:has-text('Open')").last();
  if (await openAssistant.count() > 0) {
    await openAssistant.click().catch(() => {});
    await page.waitForTimeout(500);
  }
  const auditBtn = await page.locator("button:has-text('Audit my slip')").count();
  const safeBtn = await page.locator("button:has-text('Build SAFE')").count();
  const cashBtn = await page.locator("button:has-text('Build CASH-OUT')").count();
  const weakBtn = await page.locator("button:has-text('Find weakest')").count();
  add("parlay-builder DK", auditBtn > 0 ? "PASS" : "WARN", `Audit my slip button present (${auditBtn})`);
  add("parlay-builder DK", safeBtn > 0 ? "PASS" : "WARN", `Build SAFE button present (${safeBtn})`);
  add("parlay-builder DK", cashBtn > 0 ? "PASS" : "WARN", `Build CASH-OUT button present (${cashBtn})`);
  add("parlay-builder DK", weakBtn > 0 ? "PASS" : "WARN", `Find weakest button present (${weakBtn})`);
}

// ── 3. /parlays ────────────────────────────────────────────────────────
const parl = await visit("/parlays");
if (parl.err) {
  add("/parlays", "FAIL", `nav error: ${parl.err}`);
} else {
  const t = await visibleText();
  add("/parlays", "INFO", `status ${parl.status}, ${t.length} chars`);
  add("/parlays", t.includes("Recommended Parlays") ? "PASS" : "FAIL", "header visible");
  add("/parlays", t.includes("Refresh & resolve") || t.includes("Resolving ") ? "PASS" : "WARN", "Refresh & resolve button present");
  add("/parlays", t.includes("Clear stale pending") ? "PASS" : "WARN", "Clear stale pending button present");
  // Pending count
  const pendingMatch = t.match(/Pending\s+(\d+)/);
  if (pendingMatch) add("/parlays", "INFO", `Pending count: ${pendingMatch[1]}`);
  if (t.includes("Parlay tracking database is not deployed")) {
    add("/parlays", "FAIL", "migration banner showing");
  }
  add("/parlays", consoleErrors.length === 0 ? "PASS" : "WARN", `${consoleErrors.length} console error(s)`);
  consoleErrors.slice(0, 3).forEach((e, i) => add("/parlays", "INFO", `err${i + 1}: ${e.slice(0, 200)}`));
}

// ── Stale lines banner check ───────────────────────────────────────────
await visit("/");
const t0 = await visibleText();
if (t0.includes("Odds provider returned an error") || t0.toLowerCase().includes("stale")) {
  add("odds-freshness", "INFO", "stale-lines banner visible (odds provider error)");
} else {
  add("odds-freshness", "PASS", "no stale-lines banner — odds provider healthy");
}

// ── Output ─────────────────────────────────────────────────────────────
console.log("\n=== AUDIT RESULTS ===\n");
let pass = 0, warn = 0, fail = 0, info = 0;
for (const f of findings) {
  if (f.status === "PASS") pass++;
  else if (f.status === "WARN") warn++;
  else if (f.status === "FAIL") fail++;
  else info++;
  console.log(`[${f.status.padEnd(4)}] ${f.section.padEnd(28)} ${f.detail}`);
}
console.log(`\nSummary: ${pass} PASS · ${warn} WARN · ${fail} FAIL · ${info} INFO`);

await browser.close();
process.exit(fail > 0 ? 1 : 0);
