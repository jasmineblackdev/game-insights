/**
 * Unit tests for pure functions exported from multiOddsProvider.ts.
 *
 * These functions are the core math layer: converting odds, removing vig,
 * computing edge, and fuzzy-matching fighter names. Tests run in Vitest
 * with no network access — pure input/output.
 */

import { describe, it, expect } from "vitest";
import {
  americanToImplied,
  deVig,
  computeEdge,
  fuzzyNameMatch,
} from "@/lib/multiOddsProvider";

// ── americanToImplied ─────────────────────────────────────────────────────────

describe("americanToImplied", () => {
  it("converts +100 (even money) → 0.5", () => {
    expect(americanToImplied(100)).toBeCloseTo(0.5);
  });

  it("converts +300 (underdog) → 0.25", () => {
    // 100 / (300 + 100) = 0.25
    expect(americanToImplied(300)).toBeCloseTo(0.25);
  });

  it("converts -300 (heavy favorite) → 0.75", () => {
    // 300 / (300 + 100) = 0.75
    expect(americanToImplied(-300)).toBeCloseTo(0.75);
  });

  it("converts -400 (Jones-level favorite) → 0.8", () => {
    // 400 / (400 + 100) = 0.8
    expect(americanToImplied(-400)).toBeCloseTo(0.8);
  });

  it("converts +400 → 0.2", () => {
    expect(americanToImplied(400)).toBeCloseTo(0.2);
  });

  it("converts -110 (juice line) → ~0.524", () => {
    // 110 / 210 ≈ 0.5238
    expect(americanToImplied(-110)).toBeCloseTo(0.5238, 3);
  });

  it("implied probability is always in [0, 1]", () => {
    for (const ml of [-1000, -500, -200, -110, 100, 200, 500, 1000]) {
      const p = americanToImplied(ml);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("handles Infinity → 0.5 (safe default)", () => {
    expect(americanToImplied(Infinity)).toBe(0.5);
  });

  it("handles -Infinity → 0.5 (safe default)", () => {
    expect(americanToImplied(-Infinity)).toBe(0.5);
  });

  it("handles NaN → 0.5 (safe default)", () => {
    expect(americanToImplied(NaN)).toBe(0.5);
  });

  it("favorite implied > 0.5, underdog implied < 0.5", () => {
    expect(americanToImplied(-200)).toBeGreaterThan(0.5);
    expect(americanToImplied(200)).toBeLessThan(0.5);
  });

  it("standard juice line -110/-110 has vig: implied sum > 1", () => {
    // Both sides at -110 means the book takes vig — implied probs sum > 1
    const sum = americanToImplied(-110) + americanToImplied(-110);
    expect(sum).toBeGreaterThan(1);
    expect(sum).toBeCloseTo(1.0476, 3); // 2 * (110/210) ≈ 1.0476
  });
});

// ── deVig ─────────────────────────────────────────────────────────────────────

describe("deVig", () => {
  it("two 50/50 raw probs → each devigged to exactly 0.5", () => {
    const { p1, p2 } = deVig(0.5, 0.5);
    expect(p1).toBeCloseTo(0.5);
    expect(p2).toBeCloseTo(0.5);
  });

  it("devigged probabilities always sum to exactly 1.0", () => {
    const cases: [number, number][] = [
      [0.5238, 0.5238],   // -110 / -110 juice market
      [0.8, 0.25],        // -400 / +300 (Jones/Miocic-style)
      [0.75, 0.4],        // typical main event line
      [0.909, 0.2],       // heavy favorite
    ];
    for (const [a, b] of cases) {
      const { p1, p2 } = deVig(a, b);
      expect(p1 + p2).toBeCloseTo(1.0, 10);
    }
  });

  it("preserves favorite/underdog ordering after vig removal", () => {
    // Jones -400 (0.8 raw implied), Miocic +300 (0.25 raw implied)
    const { p1, p2 } = deVig(0.8, 0.25);
    expect(p1).toBeGreaterThan(p2);
    expect(p1).toBeGreaterThan(0.5);
    expect(p2).toBeLessThan(0.5);
  });

  it("-110/-110 juice line: each side devigged > 0.5 before removal, ~0.5 after", () => {
    const raw = americanToImplied(-110); // ~0.5238
    const { p1, p2 } = deVig(raw, raw);
    expect(p1).toBeCloseTo(0.5, 4);
    expect(p2).toBeCloseTo(0.5, 4);
  });

  it("realistic fight: -200/+160 sums to 1 after devig", () => {
    const p1Raw = americanToImplied(-200); // 0.6667
    const p2Raw = americanToImplied(160);  // 0.3846
    const { p1, p2 } = deVig(p1Raw, p2Raw);
    expect(p1 + p2).toBeCloseTo(1.0, 10);
    expect(p1).toBeGreaterThan(p2);
  });
});

// ── computeEdge ───────────────────────────────────────────────────────────────

describe("computeEdge", () => {
  it("returns 0 when model matches market exactly", () => {
    // If model says 50% and market is +100 (50%), edge = 0
    expect(computeEdge(0.5, 100)).toBe(0);
  });

  it("positive edge when model probability > market implied", () => {
    // Market: +200 → implied 33.3%. Model says 40% → edge should be positive.
    expect(computeEdge(0.4, 200)).toBeGreaterThan(0);
  });

  it("negative edge when model probability < market implied", () => {
    // Market: -300 → implied 75%. Model says 60% → edge should be negative.
    expect(computeEdge(0.6, -300)).toBeLessThan(0);
  });

  it("returns percentage in reasonable range (not fraction, not >100)", () => {
    // Edge is returned as percentage points, e.g. 5.8 not 0.058
    const edge = computeEdge(0.4, 200);
    expect(edge).toBeGreaterThan(1);    // 6.7%, should be well above 1
    expect(edge).toBeLessThan(100);     // never exceeds 100pp
  });

  it("edge rounds to one decimal place", () => {
    const edge = computeEdge(0.4, 200);
    // 0.4 - 0.333... = 0.0666... → 6.7%
    expect(edge).toBeCloseTo(6.7, 1);
  });

  it("large edge: model 0.9 vs +500 (16.7% implied) → ~73.3%", () => {
    const edge = computeEdge(0.9, 500);
    expect(edge).toBeCloseTo(73.3, 1);
  });

  it("zero edge: model exactly matches -400 favorite (0.8 implied)", () => {
    expect(computeEdge(0.8, -400)).toBeCloseTo(0, 1);
  });
});

// ── fuzzyNameMatch ────────────────────────────────────────────────────────────

describe("fuzzyNameMatch", () => {
  it("exact match → true", () => {
    expect(fuzzyNameMatch("Jon Jones", "Jon Jones")).toBe(true);
  });

  it("case insensitive → true", () => {
    expect(fuzzyNameMatch("jon jones", "JON JONES")).toBe(true);
  });

  it("extra punctuation/hyphen stripped → true", () => {
    expect(fuzzyNameMatch("T.J. Dillashaw", "TJ Dillashaw")).toBe(true);
  });

  it("substring match: last name only → true", () => {
    // Providers sometimes emit just "Jones" vs "Jon Jones"
    expect(fuzzyNameMatch("Jones", "Jon Jones")).toBe(true);
  });

  it("word-level match: sharing a significant word → true", () => {
    expect(fuzzyNameMatch("Conor McGregor", "McGregor")).toBe(true);
  });

  it("completely different names → false", () => {
    expect(fuzzyNameMatch("Jon Jones", "Stipe Miocic")).toBe(false);
  });

  it("first name only (short, filtered out) doesn't false-positive", () => {
    // "Jon" is 3 chars — filtered by > 2 length. "Jon" alone should not match "Stipe Miocic"
    expect(fuzzyNameMatch("Jon", "Stipe Miocic")).toBe(false);
  });

  it("sharing a short word (<= 2 chars) does not trigger a match", () => {
    // Both contain "de" or "al" — too short to be meaningful
    expect(fuzzyNameMatch("De La Hoya", "De Bruyne")).toBe(false);
  });

  it("real fighter: Islam Makhachev vs Makhachev → true", () => {
    expect(fuzzyNameMatch("Islam Makhachev", "Makhachev")).toBe(true);
  });

  it("real fighter: Charles Oliveira vs Oliveira → true", () => {
    expect(fuzzyNameMatch("Charles Oliveira", "Oliveira")).toBe(true);
  });

  it("common suffix doesn't conflate different fighters", () => {
    // "Ngannou" vs "Gane" — no overlap
    expect(fuzzyNameMatch("Francis Ngannou", "Ciryl Gane")).toBe(false);
  });
});
