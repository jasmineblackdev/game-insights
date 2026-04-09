/**
 * Reads empirical confidence calibration from Supabase (optional).
 * When the table is empty or samples are small, the pipeline keeps raw confidence.
 */

import type { ConfidenceLevel, League } from "@/data/mockGames";
import { supabase } from "@/lib/supabase";

export type CalibrationRow = {
  sport: string;
  confidence_bucket: string;
  calibration_window: string;
  sample_count: number;
  empirical_hit_rate: number | null;
};

export async function fetchConfidenceCalibration(): Promise<CalibrationRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("prediction_confidence_calibration").select(
    "sport,confidence_bucket,calibration_window,sample_count,empirical_hit_rate"
  );
  if (error || !data?.length) return [];
  return data as CalibrationRow[];
}

type BucketRates = { rate: number; n: number };

function bucketMapForSport(league: League, rows: CalibrationRow[]): Record<string, BucketRates> {
  const sportRows = rows.filter((r) => r.sport === league);
  const byBucket: Record<string, BucketRates> = {};
  for (const r of sportRows) {
    const rate = r.empirical_hit_rate;
    if (rate == null || r.sample_count < 20) continue;
    const prev = byBucket[r.confidence_bucket];
    if (!prev || r.sample_count > prev.n) {
      byBucket[r.confidence_bucket] = { rate: Number(rate), n: r.sample_count };
    }
  }
  return byBucket;
}

function downgrade(c: ConfidenceLevel): ConfidenceLevel {
  if (c === "high") return "medium";
  if (c === "medium") return "low";
  return "low";
}

/**
 * Downgrade labels only when empirical ordering contradicts high > medium > low.
 */
export function calibrateConfidenceForSport(
  league: League,
  raw: ConfidenceLevel,
  rows: CalibrationRow[]
): { confidence: ConfidenceLevel; empirical_hit_rate?: number | null; calibration_window?: string } {
  if (!rows.length) return { confidence: raw };

  const m = bucketMapForSport(league, rows);
  const hi = m.high;
  const med = m.medium;
  const lo = m.low;

  let out = raw;
  if (hi && med && hi.n >= 25 && med.n >= 25 && hi.rate < med.rate - 0.02) {
    if (out === "high") out = downgrade(out);
  }
  if (med && lo && med.n >= 25 && lo.n >= 25 && med.rate < lo.rate - 0.02) {
    if (out === "medium") out = downgrade(out);
  }
  if (hi && hi.n >= 40 && hi.rate < 0.51 && out === "high") {
    out = downgrade(out);
  }

  const emp =
    out === "high" ? m.high?.rate ?? null
    : out === "medium" ? m.medium?.rate ?? null
    : m.low?.rate ?? null;

  const windowRow = rows.find((r) => r.sport === league && r.confidence_bucket === out);
  return {
    confidence: out,
    empirical_hit_rate: emp,
    calibration_window: windowRow?.calibration_window,
  };
}
