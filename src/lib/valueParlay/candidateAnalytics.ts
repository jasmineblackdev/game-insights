/**
 * Analytics utilities for ValueBetCandidate pools.
 *
 * These are pure, side-effect-free functions designed for:
 *  1. Dev console logging to catch overfiring filters
 *  2. Inline analytics bars in the UI (visible to developer / advanced users)
 *  3. Future integration with Supabase RPC for server-side aggregation
 *
 * No external dependencies — safe to call anywhere in the render pipeline.
 */

import type { ValueBetCandidate } from "@/lib/valueParlay/types";

// ── Exclusion distribution ────────────────────────────────────────────────────

export interface ExclusionSummary {
  total: number;
  recommended: number;
  excluded: number;
  /** % of all candidates that are recommended (0–100). */
  recommendedPct: number;
  /** Exclusion count by reason string (the leading clause). */
  byReason: Record<string, number>;
  /** Top reason string for the most common exclusion. */
  topReason: string | null;
  /** Flag: any single reason accounts for > 60% of exclusions — possible overfire. */
  overfireWarning: boolean;
}

/**
 * Break down why candidates are not recommended.
 * Groups by the leading clause of `exclusionReason` (e.g. "Timing:", "Edge too small").
 * Non-ML candidates (no exclusionReason on non-recommended) count under "Untagged".
 */
export function analyzeExclusionDistribution(candidates: ValueBetCandidate[]): ExclusionSummary {
  const total = candidates.length;
  const recommended = candidates.filter((c) => c.isRecommended).length;
  const excluded = total - recommended;

  const byReason: Record<string, number> = {};
  for (const c of candidates) {
    if (c.isRecommended) continue;
    const reason = c.exclusionReason
      ? c.exclusionReason.split(":")[0].trim()
      : "Untagged";
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }

  const topReason = excluded > 0
    ? Object.entries(byReason).sort(([, a], [, b]) => b - a)[0]?.[0] ?? null
    : null;

  const topCount = topReason ? (byReason[topReason] ?? 0) : 0;
  const overfireWarning = excluded > 0 && topCount / excluded > 0.6;

  return {
    total,
    recommended,
    excluded,
    recommendedPct: total > 0 ? Math.round((recommended / total) * 100) : 0,
    byReason,
    topReason,
    overfireWarning,
  };
}

// ── Timing bucket distribution ────────────────────────────────────────────────

export interface TimingBucketSummary {
  now: number;
  monitor: number;
  wait: number;
  /** Candidates where timingUrgency is undefined (game-level picks, no ML timing). */
  untagged: number;
  avgTimingScore: number;
  /** Flag: > 50% of ML-tagged candidates are "wait" — timing model may be too conservative. */
  tooManyWaits: boolean;
  /** Flag: > 60% of ML-tagged candidates are "now" — timing model may be too aggressive. */
  tooManyNows: boolean;
}

export function analyzeTimingBuckets(candidates: ValueBetCandidate[]): TimingBucketSummary {
  let now = 0, monitor = 0, wait = 0, untagged = 0;
  let timingScoreSum = 0;
  let timingTagged = 0;

  for (const c of candidates) {
    if (c.timingUrgency === "now")     { now++;     timingScoreSum += c.timingScore ?? 0.85; timingTagged++; }
    else if (c.timingUrgency === "wait")    { wait++;    timingScoreSum += c.timingScore ?? 0.15; timingTagged++; }
    else if (c.timingUrgency === "monitor") { monitor++; timingScoreSum += c.timingScore ?? 0.55; timingTagged++; }
    else { untagged++; }
  }

  const avgTimingScore = timingTagged > 0
    ? Math.round((timingScoreSum / timingTagged) * 100) / 100
    : 0.55;

  const tagged = now + monitor + wait;
  return {
    now,
    monitor,
    wait,
    untagged,
    avgTimingScore,
    tooManyWaits: tagged > 0 && wait / tagged > 0.5,
    tooManyNows:  tagged > 0 && now  / tagged > 0.6,
  };
}

// ── Safe-mode pool depth check ────────────────────────────────────────────────

export interface SafePoolDepthSummary {
  /** Candidates that would survive the safe-mode filter (no "wait", low/moderate risk). */
  safeEligible: number;
  /** Breakdown by sport. */
  bySport: Record<string, number>;
  /** Sports with fewer than 2 safe candidates — risky for parlay construction. */
  thinSports: string[];
}

export function analyzeSafePoolDepth(candidates: ValueBetCandidate[]): SafePoolDepthSummary {
  const safe = candidates.filter(
    (c) => c.timingUrgency !== "wait" && (c.riskBand === "low" || c.riskBand === "moderate")
  );
  const bySport: Record<string, number> = {};
  for (const c of safe) {
    bySport[c.sport] = (bySport[c.sport] ?? 0) + 1;
  }
  const thinSports = Object.entries(bySport)
    .filter(([, n]) => n < 2)
    .map(([s]) => s);

  return { safeEligible: safe.length, bySport, thinSports };
}

// ── Parlay timing quality summary ─────────────────────────────────────────────

export interface ParlayTimingQuality {
  /** Average timingScore across the parlay legs (0–1). */
  avgTimingScore: number;
  /** % of legs that are "now". */
  nowPct: number;
  /** % of legs that are "wait". */
  waitPct: number;
  /** Human label: "Strong" | "Neutral" | "Weak". */
  quality: "Strong" | "Neutral" | "Weak";
}

export function parlayTimingQuality(legs: ValueBetCandidate[]): ParlayTimingQuality {
  const n = legs.length;
  if (n === 0) return { avgTimingScore: 0.55, nowPct: 0, waitPct: 0, quality: "Neutral" };

  const avgTimingScore = legs.reduce((s, l) => s + (l.timingScore ?? 0.55), 0) / n;
  const nowPct = Math.round((legs.filter((l) => l.timingUrgency === "now").length / n) * 100);
  const waitPct = Math.round((legs.filter((l) => l.timingUrgency === "wait").length / n) * 100);

  const quality: ParlayTimingQuality["quality"] =
    avgTimingScore >= 0.68 ? "Strong"
    : avgTimingScore <= 0.40 ? "Weak"
    : "Neutral";

  return { avgTimingScore, nowPct, waitPct, quality };
}

// ── Dev console dump ──────────────────────────────────────────────────────────

/**
 * Pretty-print analytics to console.group.
 * Call this in dev mode to catch overfire / under-depth issues quickly.
 */
export function logCandidateAnalytics(
  candidates: ValueBetCandidate[],
  label = "Candidate pool"
): void {
  if (typeof window === "undefined") return;

  const excl = analyzeExclusionDistribution(candidates);
  const timing = analyzeTimingBuckets(candidates);
  const safe = analyzeSafePoolDepth(candidates);

  console.group(`[GameLens Analytics] ${label}`);
  console.log(
    `Candidates: ${excl.total} total · ${excl.recommended} recommended (${excl.recommendedPct}%) · ${excl.excluded} excluded`
  );
  if (excl.excluded > 0) {
    console.table(excl.byReason);
    if (excl.overfireWarning) {
      console.warn(`⚠ Overfire warning: "${excl.topReason}" accounts for > 60% of exclusions`);
    }
  }
  console.log(
    `Timing: now=${timing.now} · monitor=${timing.monitor} · wait=${timing.wait} · untagged=${timing.untagged}`,
    `· avg score=${timing.avgTimingScore}`
  );
  if (timing.tooManyWaits) console.warn("⚠ >50% of ML-tagged candidates are 'wait' — timing model may be too conservative");
  if (timing.tooManyNows)  console.warn("⚠ >60% of ML-tagged candidates are 'now'  — timing model may be too aggressive");
  console.log(`Safe pool: ${safe.safeEligible} eligible`, safe.bySport);
  if (safe.thinSports.length > 0) {
    console.warn(`⚠ Thin safe pool for sports: ${safe.thinSports.join(", ")} — safe mode may struggle`);
  }
  console.groupEnd();
}
