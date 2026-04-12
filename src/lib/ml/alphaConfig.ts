/**
 * Sport-specific alpha (ML trust) ranges.
 *
 * Alpha controls how much the ML layer blends into the rules engine output.
 * Ranges are tighter for combat sports (smaller sample pools) and wider
 * for high-volume sports like NBA where the model accumulates evidence faster.
 *
 * step: the ±increment used by the feedback loop when adjusting alpha
 * based on model contribution analytics.
 */

export interface AlphaRange {
  min:  number;
  max:  number;
  step: number;
}

export const ALPHA_RANGES: Record<string, AlphaRange> = {
  nba:    { min: 0.08, max: 0.35, step: 0.02 },
  nfl:    { min: 0.06, max: 0.28, step: 0.02 },
  mlb:    { min: 0.05, max: 0.25, step: 0.02 },
  boxing: { min: 0.03, max: 0.18, step: 0.02 },
  mma:    { min: 0.03, max: 0.20, step: 0.02 },
};

/** Fallback range for unknown sports. */
const DEFAULT_RANGE: AlphaRange = { min: 0.03, max: 0.28, step: 0.02 };

/** Clamp `alpha` within the sport's allowed range. */
export function clampAlpha(sport: string, alpha: number): number {
  const range = ALPHA_RANGES[sport.toLowerCase()] ?? DEFAULT_RANGE;
  return Math.min(range.max, Math.max(range.min, alpha));
}

/** Return the alpha range for a sport (or the default if unknown). */
export function getAlphaRange(sport: string): AlphaRange {
  return ALPHA_RANGES[sport.toLowerCase()] ?? DEFAULT_RANGE;
}
