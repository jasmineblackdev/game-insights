/**
 * Combat-sport fighter features — days since last fight (layoff) and
 * strength-of-schedule (SOS) across recent bouts.
 *
 * These materially improve combat predictions because:
 *   - A long layoff (> 18 months) typically drops win probability ~5pp
 *     due to ring rust; short-notice (< 21 days) drops similarly
 *   - Fighters built on weak competition don't generalise — SOS-adjusted
 *     records carry more predictive signal than raw records
 *
 * The helpers here return an additive probability delta per fighter, and
 * a pair-level adjustment that mma/boxing confidence scoring can apply
 * on top of the existing scoreMmaFight / boxingScore outputs.
 */

export interface CombatRecentBout {
  /** ISO date string. */
  date: string;
  /** "W" | "L" | "D" | "NC". */
  result?: string;
  /** Opponent quality at time of bout, 0–100. */
  opponentQuality?: number | null;
}

export interface CombatFighterFeaturesInput {
  recentBouts?: CombatRecentBout[];
  /** If already precomputed by an upstream feed, prefer these over recentBouts. */
  daysSinceLastFight?: number | null;
  recentSosAvg?: number | null;      // average opponent quality over last N bouts
}

// ── Layoff ────────────────────────────────────────────────────────────────────

/**
 * Returns days since the most recent bout, or null when no data.
 * Bouts with unparseable dates are ignored.
 */
export function daysSinceLastFight(
  input: CombatFighterFeaturesInput,
): number | null {
  if (input.daysSinceLastFight != null) return input.daysSinceLastFight;
  const bouts = input.recentBouts ?? [];
  if (!bouts.length) return null;
  const times = bouts
    .map((b) => new Date(b.date).getTime())
    .filter((t) => Number.isFinite(t));
  if (!times.length) return null;
  const latest = Math.max(...times);
  return Math.max(0, Math.floor((Date.now() - latest) / 86_400_000));
}

/**
 * Layoff probability adjustment — additive delta in [0, 1] hit-prob space.
 * Sweet spot is 90–180 days; long layoffs (> 18 months) or camp-short
 * (< 30 days) notice drop win probability.
 */
export function layoffWinProbAdj(days: number | null): number {
  if (days == null) return 0;
  if (days >= 30 && days <= 210) return 0;         // neutral, normal camp
  if (days < 14)                 return -0.04;     // short-notice
  if (days < 30)                 return -0.02;
  if (days <= 365)               return -0.01;     // mildly long
  if (days <= 540)               return -0.03;     // ~18 months — rust
  return -0.05;                                    // > 18 months
}

// ── SOS (strength of schedule) ────────────────────────────────────────────────

/**
 * Average opponent quality over the last N=5 bouts (or whatever's available),
 * returning a 0–100 score. Null when data is missing.
 */
export function recentSos(input: CombatFighterFeaturesInput): number | null {
  if (input.recentSosAvg != null) return input.recentSosAvg;
  const bouts = input.recentBouts ?? [];
  const scored = bouts
    .slice(0, 5)
    .map((b) => b.opponentQuality)
    .filter((q): q is number => q != null && Number.isFinite(q));
  if (!scored.length) return null;
  const avg = scored.reduce((s, q) => s + q, 0) / scored.length;
  return Math.round(avg * 10) / 10;
}

/**
 * SOS probability adjustment. Fighters with very weak recent schedules
 * have inflated records, so we discount their predicted win probability
 * against a tougher opponent. Strong-SOS fighters get a small boost.
 *
 * Returns an additive delta in hit-prob space, clamped to ±0.03.
 */
export function sosWinProbAdj(
  fighterSos: number | null,
  opponentSos: number | null,
): number {
  if (fighterSos == null || opponentSos == null) return 0;
  // Difference scaled: 100-point spread maps to ±0.03
  const diff = (fighterSos - opponentSos) / 100;
  return Math.max(-0.03, Math.min(0.03, diff * 0.15));
}

// ── Pair-level combined adjustment ────────────────────────────────────────────

/**
 * Combine layoff + SOS adjustments for a fighter into one additive delta.
 * Called per side, then the caller applies it to the win probability of
 * that side (with opposite sign applied to the other side if it's a
 * moneyline-style bet).
 */
export function combatFighterWinProbAdj(
  fighter: CombatFighterFeaturesInput,
  opponent: CombatFighterFeaturesInput,
): number {
  const fighterLayoff = daysSinceLastFight(fighter);
  const layoffAdj     = layoffWinProbAdj(fighterLayoff);
  const fighterSosVal = recentSos(fighter);
  const oppSosVal     = recentSos(opponent);
  const sosAdj        = sosWinProbAdj(fighterSosVal, oppSosVal);
  // Clamp total so a badly-rested tomato can's probability doesn't collapse
  return Math.max(-0.08, Math.min(0.08, layoffAdj + sosAdj));
}
