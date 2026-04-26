/**
 * Model Status — derives a single transparency badge per pick so users can
 * see at a glance whether a probability came from rules-only output, an
 * actively-blended ML layer, calibration in progress, or a low-data-quality
 * vector that should be discounted.
 *
 * Inputs:
 *   sampleSize       — resolved-outcome count for this (sport, market)
 *   dataQuality      — 0–1 from the feature vector (lower = fewer real fields)
 *   plattAvailable   — true when nightly Platt params have been synced
 *
 * Decision priority (first match wins):
 *   LOW_DATA_QUALITY  → data_quality < 0.4 (regardless of ML state)
 *   RULES_MODE        → sampleSize < ML_ACTIVATION_THRESHOLD (25)
 *   CALIBRATING       → ML active but no Platt params yet
 *   ML_ACTIVE         → ML active AND Platt params present
 */

import { mlIsActive } from "@/lib/ml/weights";

export type ModelStatus =
  | "rules_mode"
  | "ml_active"
  | "calibrating"
  | "low_data_quality";

export interface ModelStatusBadge {
  status: ModelStatus;
  label: string;
  short: string;
  /** Tone hint for badge styling. */
  tone: "neutral" | "active" | "warning" | "info";
  description: string;
}

/** Below this data_quality value, we flag the prop regardless of ML state. */
const LOW_DATA_QUALITY_FLOOR = 0.4;

export function deriveModelStatus(args: {
  sport: string;
  market: string;
  sampleSize: number;
  dataQuality: number;
  plattAvailable: boolean;
}): ModelStatusBadge {
  const { sport, market, sampleSize, dataQuality, plattAvailable } = args;

  if (dataQuality < LOW_DATA_QUALITY_FLOOR) {
    return {
      status: "low_data_quality",
      label:  "Low Data Quality",
      short:  "LOW DATA",
      tone:   "warning",
      description:
        `Feature vector has data_quality ${dataQuality.toFixed(2)} (below ${LOW_DATA_QUALITY_FLOOR}). ` +
        "Projection relies on placeholders; treat the edge with caution until the feed enriches.",
    };
  }

  if (!mlIsActive(sampleSize)) {
    return {
      status: "rules_mode",
      label:  "Rules Mode",
      short:  "RULES",
      tone:   "neutral",
      description:
        `${sport.toUpperCase()} ${market} has ${sampleSize} resolved samples (need 25+ for ML to activate). ` +
        "Probability is pure rules-engine output with no ML blend.",
    };
  }

  if (!plattAvailable) {
    return {
      status: "calibrating",
      label:  "Calibrating",
      short:  "CALIBRATING",
      tone:   "info",
      description:
        `${sport.toUpperCase()} ${market}: ML is active (n=${sampleSize}) but Platt calibration ` +
        "params haven't synced yet. Probabilities will sharpen after the next nightly fit.",
    };
  }

  return {
    status: "ml_active",
    label:  "ML Active",
    short:  "ML ACTIVE",
    tone:   "active",
    description:
      `${sport.toUpperCase()} ${market}: ML blended with Platt-calibrated probabilities (n=${sampleSize}). ` +
      "Edge reflects calibrated model output.",
  };
}
