/**
 * Confidence calibration adjustment map.
 *
 * Stores per-market (sport × stat_type) calibration adjustment values derived
 * from analytics_confidence_calibration_by_market RPC data.
 *
 * localStorage key: `gamelens-conf-cal-map-v1`
 * Key format: "SPORT:stat_type"  (e.g. "NBA:points", "MLB:strikeouts")
 *
 * Adjustment values:
 *   +0.06 → ✓ calibrated + ↑ improving trend   (strong trust signal)
 *   +0.03 → ✓ calibrated + → stable trend       (modest positive)
 *   +0.02 → → partial    + gap↑ improving       (promising)
 *    0.00 → insufficient data / neutral         (no adjustment)
 *   -0.04 → ⚠ inverted   + → stable trend       (label unreliable)
 *   -0.08 → ⚠ inverted   + ↓ worsening trend    (high-priority dampen)
 *
 * Applied additively to conf01 in computeLegScore, clamped to ±0.08.
 */

const LS_KEY = "gamelens-conf-cal-map-v1";

export type CalibrationVerdict = "calibrated" | "partial" | "inverted" | "insufficient";
export type CalibrationTrend  = "up" | "flat" | "down";

export interface CalibrationEntry {
  /** Additive adjustment to conf01 in computeLegScore, clamped to ±0.08 externally. */
  adjustment:  number;
  verdict:     CalibrationVerdict;
  trend:       CalibrationTrend;
  /** ISO timestamp of last update. */
  updatedAt:   string;
}

type CalibrationMap = Record<string, CalibrationEntry>;

// ── Verdict × Trend → adjustment table ───────────────────────────────────────

export function verdictTrendToAdjustment(
  verdict: CalibrationVerdict,
  trend:   CalibrationTrend,
): number {
  if (verdict === "calibrated") {
    if (trend === "up")   return  0.06;
    if (trend === "flat") return  0.03;
    return                        0.01;  // down — still calibrated, mild positive
  }
  if (verdict === "partial") {
    if (trend === "up")   return  0.02;
    return                        0.00;
  }
  if (verdict === "inverted") {
    if (trend === "down") return -0.08;
    if (trend === "flat") return -0.04;
    return                       -0.02;  // up — recovering inverted, small dampen
  }
  return 0; // insufficient
}

// ── Storage ───────────────────────────────────────────────────────────────────

function readMap(): CalibrationMap {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as CalibrationMap;
  } catch {
    return {};
  }
}

function writeMap(map: CalibrationMap): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch { /* unavailable */ }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Upsert calibration entries for one or more sport × market combinations.
 * Called from feedbackLoop.maybeAdjustConfidenceFromCalibration().
 */
export function setCalibrationEntries(
  entries: Array<{ sport: string; statType: string } & CalibrationEntry>,
): void {
  const map = readMap();
  for (const e of entries) {
    const key = `${e.sport.toUpperCase()}:${e.statType.toLowerCase()}`;
    map[key] = {
      adjustment: e.adjustment,
      verdict:    e.verdict,
      trend:      e.trend,
      updatedAt:  e.updatedAt,
    };
  }
  writeMap(map);
}

/**
 * Read the calibration adjustment for a specific sport × stat_type.
 * Returns 0 when no entry exists (neutral — no adjustment).
 */
export function getConfidenceAdjustment(sport: string, statType: string | undefined): number {
  if (!statType) return 0;
  try {
    const map = readMap();
    const key = `${sport.toUpperCase()}:${statType.toLowerCase()}`;
    return map[key]?.adjustment ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Read all current calibration entries for display in the analytics dashboard.
 * Returns an object keyed by "SPORT:stat_type".
 */
export function getAllCalibrationEntries(): CalibrationMap {
  return readMap();
}
