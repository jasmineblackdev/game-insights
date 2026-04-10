/** American odds → implied win probability (0–1). */
export function americanToImpliedProb(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 0.5;
  if (american < 0) {
    const a = Math.abs(american);
    return a / (a + 100);
  }
  return 100 / (american + 100);
}

export function americanFromImpliedProb(p: number): number {
  const clamped = Math.min(0.99, Math.max(0.01, p));
  if (clamped >= 0.5) {
    return Math.round((-100 * clamped) / (1 - clamped));
  }
  return Math.round((100 * (1 - clamped)) / clamped);
}

export function parseAmericanOddsString(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[^\d+.-]/g, "").trim();
  if (!cleaned) return null;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function americanToDecimal(a: number): number {
  if (a > 0) return 1 + a / 100;
  return 1 + 100 / Math.abs(a);
}

/** Combined American odds for independent legs (same book, multiplicative). */
export function parlayAmericanOdds(legs: number[]): number {
  if (!legs.length) return 0;
  let d = 1;
  for (const a of legs) {
    d *= americanToDecimal(a);
  }
  if (d < 2) return Math.round(-100 / (d - 1));
  return Math.round((d - 1) * 100);
}

export function parlayHitProbability(modelProbs: number[]): number {
  if (!modelProbs.length) return 0;
  return modelProbs.reduce((acc, p) => acc * Math.min(0.999, Math.max(0.001, p)), 1);
}

/** Payout multiplier (profit + stake) per $1 staked, from American combined price. */
export function payoutMultiplierFromAmerican(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 1;
  if (american > 0) return 1 + american / 100;
  return 1 + 100 / Math.abs(american);
}
