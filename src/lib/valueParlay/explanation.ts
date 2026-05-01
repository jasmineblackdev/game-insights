/**
 * Deterministic "why this pick" generator.
 *
 * Pure derivation from existing ValueBetCandidate fields. No LLM,
 * no external calls — runs at candidate-build time and writes the
 * one-line string into c.whyThisPick.
 *
 * Format:
 *   "Model: 64% · Book: 56% · +8.0% · 36 min projection vs avg"
 *
 * Strongest-factor priority chain (first match wins):
 *   1. Opportunity / matchup multiplier deviation (≥8% off neutral)
 *   2. Matchup quality flag (tough / soft)
 *   3. Recent form deviation (≥10% off baseline)
 *   4. Line movement (≥4pp shift)
 *   5. Hit rate signal (last10 ≥ 70% or ≤ 30% with adequate sample)
 *   6. Stability (very low → "small-sample prop")
 *   7. Fallback — "pure de-vig edge"
 */

import type { ValueBetCandidate } from "./types";

export function whyThisPick(c: ValueBetCandidate): string {
  const m = Math.round((c.modelProbability ?? 0) * 100);
  const b = Math.round((c.impliedProbability ?? 0) * 100);
  const e = ((c.edge ?? 0) * 100).toFixed(1);
  const sign = (c.edge ?? 0) >= 0 ? "+" : "−";
  const factor = pickStrongestFactor(c);
  return `Model: ${m}% · Book: ${b}% · ${sign}${Math.abs(Number(e)).toFixed(1)}% · ${factor}`;
}

function pickStrongestFactor(c: ValueBetCandidate): string {
  // 1. Hit rate first when sample is strong — it's the most concrete
  //    factor for player props ("Hit 7 of last 10").
  const hr = c.hitRates;
  if (hr?.last10 != null && hr.samples.last10 >= 8) {
    if (hr.last10 >= 0.70) {
      const wins = Math.round(hr.last10 * hr.samples.last10);
      return `Hit ${wins} of last ${hr.samples.last10}`;
    }
    if (hr.last10 <= 0.30) {
      const wins = Math.round(hr.last10 * hr.samples.last10);
      return `Fade signal — ${wins}/${hr.samples.last10} L10`;
    }
  }

  // 2. Late line movement — sharps moved the line; surface it.
  const lm = c.lineMovementDeltaPp;
  if (lm != null && Math.abs(lm) >= 4) {
    return lm > 0 ? `Line moved +${lm.toFixed(1)}pp toward this side` : `Line moved ${lm.toFixed(1)}pp against`;
  }

  // 3. Stability is poor — explicit warning over a vague "edge".
  if ((c.stabilityScore ?? 1) < 0.40 && (c.recentHitRateSamples ?? 0) >= 5) {
    return `Volatile — small-sample prop`;
  }

  // 4. Recent form via the legacy recentHitRate alias (last5).
  if (hr?.last5 != null && hr.samples.last5 >= 3) {
    if (hr.last5 >= 0.80) return `Hot — ${Math.round(hr.last5 * hr.samples.last5)}/${hr.samples.last5} L5`;
    if (hr.last5 <= 0.20) return `Cold — ${Math.round(hr.last5 * hr.samples.last5)}/${hr.samples.last5} L5`;
  }

  // 5. Season hit rate — gentler signal but useful when L10 isn't there.
  if (hr?.season != null && hr.samples.season >= 20) {
    if (hr.season >= 0.62) return `Season hit rate ${(hr.season * 100).toFixed(0)}%`;
  }

  // 6. NFL injury opportunity (already computed upstream).
  if ((c.injuryImpactAdj ?? 0) >= 0.04) {
    return `Role boost from teammate injury`;
  }
  if ((c.injuryImpactAdj ?? 0) <= -0.04) {
    return `Injury risk — pressure / coverage degraded`;
  }

  // 7. Confidence ceiling.
  if (c.confidence === "high" && (c.edge ?? 0) >= 0.06) {
    return `High-confidence + sizeable mispricing`;
  }

  // 8. Honest fallback — never invent context.
  return `Pure de-vig edge`;
}
