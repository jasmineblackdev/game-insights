/**
 * Client-side learning + calibration artifacts (localStorage).
 * Feeds dynamic edge floors, accuracy summaries, and miss tagging — no UI.
 */
import type { League } from "@/data/mockGames";

const PREFIX = "gamelens-learn-v1";
const KEY_THRESHOLDS = `${PREFIX}-edge-floors`;
const KEY_ACCURACY = `${PREFIX}-accuracy-summary`;
const KEY_FAILURES = `${PREFIX}-correlation-failures`;
const KEY_CURVE = `${PREFIX}-confidence-curve`;
const KEY_ERRORS = `${PREFIX}-prediction-error-tags`;
const KEY_EDGE_SNAP = `${PREFIX}-edge-snap`;

export type AccuracyBucket = {
  hits: number;
  misses: number;
};

export type PredictionAccuracySummary = {
  bySport: Partial<Record<League, AccuracyBucket>>;
  byConfidence: Partial<Record<"high" | "medium" | "low", AccuracyBucket>>;
  byPickType: Partial<Record<string, AccuracyBucket>>;
  lastUpdated: string;
};

export type ConfidenceAccuracyCurve = {
  highRate: number | null;
  mediumRate: number | null;
  lowRate: number | null;
  samples: { high: number; medium: number; low: number };
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    if (!s) return fallback;
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* quota */
  }
}

export function getLearnedEdgeFloor(league: League): number {
  const m = readJson<Partial<Record<League, number>>>(KEY_THRESHOLDS, {});
  const v = m[league];
  return typeof v === "number" && v > 0 && v < 0.12 ? v : 0;
}

/** Nudge floor up slightly when a bucket underperforms; down when sharp. */
export function adjustEdgeFloorFromOutcome(league: League, hit: boolean, confidence: "high" | "medium" | "low"): void {
  const m = readJson<Partial<Record<League, number>>>(KEY_THRESHOLDS, {});
  const cur = m[league] ?? 0;
  const delta = confidence === "high" ? (hit ? -0.002 : 0.004) : confidence === "medium" ? (hit ? -0.0015 : 0.003) : hit ? -0.001 : 0.002;
  const next = Math.min(0.055, Math.max(0.02, cur + delta));
  m[league] = Math.round(next * 10000) / 10000;
  writeJson(KEY_THRESHOLDS, m);
}

export function getPredictionAccuracySummary(): PredictionAccuracySummary {
  return readJson(KEY_ACCURACY, {
    bySport: {},
    byConfidence: {},
    byPickType: {},
    lastUpdated: new Date(0).toISOString(),
  });
}

function bumpBucket(b: AccuracyBucket | undefined, hit: boolean): AccuracyBucket {
  const x = b ?? { hits: 0, misses: 0 };
  if (hit) x.hits += 1;
  else x.misses += 1;
  return x;
}

/**
 * Record a finalized game for accuracy + optional miss tags (injury, pace, etc.).
 */
export function recordPredictionOutcome(args: {
  league: League;
  confidence: "high" | "medium" | "low";
  pickType: string;
  hit: boolean;
  errorTags?: string[];
}): void {
  const sum = getPredictionAccuracySummary();
  sum.bySport[args.league] = bumpBucket(sum.bySport[args.league], args.hit);
  sum.byConfidence[args.confidence] = bumpBucket(sum.byConfidence[args.confidence], args.hit);
  sum.byPickType[args.pickType] = bumpBucket(sum.byPickType[args.pickType], args.hit);
  sum.lastUpdated = new Date().toISOString();
  writeJson(KEY_ACCURACY, sum);

  adjustEdgeFloorFromOutcome(args.league, args.hit, args.confidence);

  if (args.errorTags?.length) {
    const prev = readJson<Record<string, number>>(KEY_ERRORS, {});
    for (const t of args.errorTags) {
      prev[t] = (prev[t] ?? 0) + 1;
    }
    writeJson(KEY_ERRORS, prev);
  }

  const curve = buildConfidenceCurveFromSummary(sum);
  writeJson(KEY_CURVE, curve);
}

function buildConfidenceCurveFromSummary(sum: PredictionAccuracySummary): ConfidenceAccuracyCurve {
  const rate = (b: AccuracyBucket | undefined) => {
    if (!b) return null;
    const t = b.hits + b.misses;
    if (t < 8) return null;
    return b.hits / t;
  };
  const hi = sum.byConfidence.high;
  const med = sum.byConfidence.medium;
  const lo = sum.byConfidence.low;
  return {
    highRate: rate(hi),
    mediumRate: rate(med),
    lowRate: rate(lo),
    samples: {
      high: (hi?.hits ?? 0) + (hi?.misses ?? 0),
      medium: (med?.hits ?? 0) + (med?.misses ?? 0),
      low: (lo?.hits ?? 0) + (lo?.misses ?? 0),
    },
  };
}

export function getConfidenceAccuracyCurve(): ConfidenceAccuracyCurve {
  return readJson(KEY_CURVE, {
    highRate: null,
    mediumRate: null,
    lowRate: null,
    samples: { high: 0, medium: 0, low: 0 },
  });
}

export function recordCorrelationFailurePattern(legKeys: string[]): void {
  const key = [...legKeys].sort().join("|");
  if (!key) return;
  const m = readJson<Record<string, number>>(KEY_FAILURES, {});
  m[key] = (m[key] ?? 0) + 1;
  writeJson(KEY_FAILURES, m);
}

/** Edge snapshot for decay rate (per game id). */
export function updateEdgeDecaySnapshot(gameId: string, edge: number): { ratePpPerMin: number } {
  const k = `${KEY_EDGE_SNAP}:${gameId}`;
  const now = Date.now();
  let ratePpPerMin = 0;
  try {
    const prev = localStorage.getItem(k);
    if (prev) {
      const o = JSON.parse(prev) as { edge: number; t: number };
      const dtMin = (now - o.t) / 60_000;
      if (dtMin > 0.08 && dtMin < 240) {
        ratePpPerMin = ((o.edge - edge) / dtMin) * 100;
      }
    }
  } catch {
    /* ignore */
  }
  writeJson(k, { edge, t: now });
  return { ratePpPerMin: Math.round(ratePpPerMin * 100) / 100 };
}

export const LEARNING_STORE_KEYS = {
  accuracy_summary: KEY_ACCURACY,
  correlation_failures: KEY_FAILURES,
  confidence_curve: KEY_CURVE,
} as const;
