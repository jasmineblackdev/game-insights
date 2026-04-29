/**
 * Client-side learning + calibration artifacts (localStorage).
 * Feeds dynamic edge floors, accuracy summaries, and miss tagging — no UI.
 */
import type { GamePrediction, League } from "@/data/mockGames";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

const PREFIX = "gamelens-learn-v1";
const KEY_THRESHOLDS = `${PREFIX}-edge-floors`;
const KEY_ACCURACY = `${PREFIX}-accuracy-summary`;
const KEY_FAILURES = `${PREFIX}-correlation-failures`;
const KEY_CURVE = `${PREFIX}-confidence-curve`;
const KEY_ERRORS = `${PREFIX}-prediction-error-tags`;
const KEY_EDGE_SNAP = `${PREFIX}-edge-snap`;
const KEY_SPORT_ENGINE = `${PREFIX}-sport-engine-v1`;

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

/** Per-league rolling engine state — never mix sports. */
export type SportInteractionRow = {
  n: number;
  missEma: number;
  tiltPp: number;
};

export type SportEngineLearningState = {
  n: number;
  hitEma: number;
  recencyAlpha: number;
  probTiltPp: number;
  driftBaselinePp: number;
  interactions: Record<string, SportInteractionRow>;
  lastUpdated: string;
};

function defaultSportEngineState(): SportEngineLearningState {
  return {
    n: 0,
    hitEma: 0.525,
    recencyAlpha: 0.55,
    probTiltPp: 0,
    driftBaselinePp: 0,
    interactions: {},
    lastUpdated: new Date(0).toISOString(),
  };
}

function readSportEngineMap(): Partial<Record<League, SportEngineLearningState>> {
  return readJson(KEY_SPORT_ENGINE, {});
}

export function getSportEngineLearningState(league: League): SportEngineLearningState {
  const m = readSportEngineMap();
  return { ...defaultSportEngineState(), ...m[league] };
}

/**
 * Gradual updates from settled picks; optional context tags tune interaction rows.
 */
export function bumpSportEngineFromOutcome(
  league: League,
  hit: boolean,
  confidence: "high" | "medium" | "low",
  contextTags?: string[]
): void {
  const all = { ...readSportEngineMap() };
  const prev = all[league];
  const s: SportEngineLearningState = {
    ...defaultSportEngineState(),
    ...prev,
    interactions: { ...(prev?.interactions ?? {}) },
  };

  const noisyLeague = league === "mlb" || league === "boxing" || league === "mma";
  const emaKeep = noisyLeague ? 0.982 : 0.985;
  const emaTake = noisyLeague ? 0.018 : 0.015;

  s.n += 1;
  s.hitEma = s.n === 1 ? (hit ? 1 : 0) : clamp01Ema(s.hitEma, hit ? 1 : 0, emaKeep, emaTake);

  const minNForCal = noisyLeague ? 28 : 35;
  if (s.n >= minNForCal) {
    const gap = s.hitEma - 0.525;
    const tiltUp = noisyLeague ? 0.038 : 0.032;
    const tiltDown = noisyLeague ? 0.024 : 0.02;
    const recDown = noisyLeague ? 0.007 : 0.006;
    const recUp = noisyLeague ? 0.0045 : 0.004;
    if (gap < -0.028) {
      s.probTiltPp = clampNum(s.probTiltPp + tiltUp, -1.2, 1.2);
      s.recencyAlpha = clampNum(s.recencyAlpha - recDown, 0.4, 0.62);
    } else if (gap > 0.045) {
      s.probTiltPp = clampNum(s.probTiltPp - tiltDown, -1.2, 1.2);
      s.recencyAlpha = clampNum(s.recencyAlpha + recUp, 0.4, 0.62);
    }
  }

  if (s.n >= 50) {
    if (confidence === "high" && !hit) {
      s.recencyAlpha = clampNum(s.recencyAlpha - (noisyLeague ? 0.005 : 0.004), 0.4, 0.62);
    } else if (confidence === "high" && hit) {
      s.recencyAlpha = clampNum(s.recencyAlpha + (noisyLeague ? 0.003 : 0.0025), 0.4, 0.62);
    }
  }

  if (s.n >= 60 && s.n % 30 === 0) {
    const driftK = noisyLeague ? 0.017 : 0.014;
    const driftCap = noisyLeague ? 0.4 : 0.35;
    s.driftBaselinePp = clampNum(s.driftBaselinePp + (s.hitEma - 0.525) * driftK, -driftCap, driftCap);
  }

  const minTagN = noisyLeague ? 22 : 28;
  for (const tag of contextTags ?? []) {
    if (!tag || tag.length > 48) continue;
    const cur = s.interactions[tag] ?? { n: 0, missEma: 0.35, tiltPp: 0 };
    const nextRow: SportInteractionRow = {
      n: cur.n + 1,
      missEma: 0.94 * cur.missEma + 0.06 * (hit ? 0 : 1),
      tiltPp: cur.tiltPp,
    };
    const tagTiltUp = noisyLeague ? 0.026 : 0.022;
    const tagTiltDown = noisyLeague ? 0.016 : 0.014;
    if (nextRow.n >= minTagN && nextRow.missEma > 0.5) {
      nextRow.tiltPp = clampNum(nextRow.tiltPp + tagTiltUp, -0.45, 0.45);
    } else if (nextRow.n >= minTagN && nextRow.missEma < 0.38) {
      nextRow.tiltPp = clampNum(nextRow.tiltPp - tagTiltDown, -0.45, 0.45);
    }
    s.interactions[tag] = nextRow;
  }

  s.lastUpdated = new Date().toISOString();
  all[league] = s;
  writeJson(KEY_SPORT_ENGINE, all);
}

function clampNum(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function clamp01Ema(prev: number, obs: number, keep: number, take: number): number {
  return keep * prev + take * obs;
}

export type LearningContextTagHints = {
  volatilityLabel?: string;
  publicBiasScore?: number;
};

/**
 * Context tags for interaction learning (must match keys used in learningSignalAdjustments).
 * `hints` supplies this-pass pipeline values when `_meta.quality` is not attached yet.
 */
export function deriveLearningContextTags(g: GamePrediction, hints?: LearningContextTagHints): string[] {
  const tags: string[] = [];
  const L = g.league;
  const joined = g.situationalTags.join(" ");
  if (joined.includes("B2B")) tags.push(`${L}:b2b`);
  if (joined.includes("SHORT WEEK")) tags.push(`${L}:short_week`);
  const vq = hints?.volatilityLabel ?? g._meta?.quality?.volatility?.volatility_label;
  if (vq === "high") tags.push(`${L}:high_vol`);
  const pub = hints?.publicBiasScore ?? g._meta?.quality?.predictionIntel?.public_bias_score;
  if (typeof pub === "number" && pub >= 56) tags.push(`${L}:pub_bias`);
  if (g.lines?.spreadNum != null && Math.abs(g.lines.spreadNum) >= 9) tags.push(`${L}:large_spread`);
  if (g.threeWay && g.threeWay.draw >= 28) tags.push(`${L}:draw_heavy`);
  const pc = g.mlb?.pitcherCertainty;
  if (pc === "unknown" || pc === "partial") tags.push(`${L}:pitcher_uncertain`);
  return tags;
}

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
  const m = getLearnedEdgeFloorsMap();
  const v = m[league];
  return typeof v === "number" && v > 0 && v < 0.12 ? v : 0;
}

export function getLearnedEdgeFloorsMap(): Partial<Record<League, number>> {
  return readJson(KEY_THRESHOLDS, {});
}

/** Nudge floor up slightly when a bucket underperforms; down when sharp. */
export function adjustEdgeFloorFromOutcome(league: League, hit: boolean, confidence: "high" | "medium" | "low"): void {
  const m = { ...getLearnedEdgeFloorsMap() };
  const cur = m[league] ?? 0;
  const delta = confidence === "high" ? (hit ? -0.002 : 0.004) : confidence === "medium" ? (hit ? -0.0015 : 0.003) : hit ? -0.001 : 0.002;
  const next = Math.min(0.055, Math.max(0.02, cur + delta));
  m[league] = Math.round(next * 10000) / 10000;
  writeJson(KEY_THRESHOLDS, m);
}

let learningFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * When `VITE_SYNC_CLIENT_LEARNING_TO_SUPABASE=1` and the user is signed in, debounce-sync
 * local learning JSON to `user_learning_snapshots` (see Supabase migration).
 */
export function scheduleUserLearningSnapshotSync(): void {
  const v = import.meta.env.VITE_SYNC_CLIENT_LEARNING_TO_SUPABASE;
  if (v !== "1" && v !== "true") return;
  if (learningFlushTimer) clearTimeout(learningFlushTimer);
  learningFlushTimer = setTimeout(() => {
    learningFlushTimer = null;
    void flushUserLearningSnapshotToSupabase();
  }, 4000);
}

async function flushUserLearningSnapshotToSupabase(): Promise<void> {
  if (!isSupabaseConfigured || !supabase) return;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user?.id) return;

  const { error } = await supabase.from("user_learning_snapshots").upsert(
    {
      user_id: session.user.id,
      accuracy_summary: getPredictionAccuracySummary(),
      edge_floors: getLearnedEdgeFloorsMap(),
      confidence_curve: getConfidenceAccuracyCurve(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error && import.meta.env.DEV) {
    console.warn("[user_learning_snapshots]", error.message);
  }
}

/**
 * One-shot rehydrate from `user_learning_snapshots` into localStorage.
 * Call once at app boot (App.tsx) — fixes the "lose calibration when
 * the user clears their browser" gap. Only overwrites local state when
 * the server snapshot is *newer* than what's in localStorage so a
 * fresh device gets the user's history without a logged-in user
 * having their in-flight session learning clobbered by a stale row.
 *
 * Gated on the same VITE_SYNC_CLIENT_LEARNING_TO_SUPABASE flag so the
 * push and pull stay symmetric. No-ops when not signed in.
 */
export async function rehydrateUserLearningFromSupabase(): Promise<void> {
  const v = import.meta.env.VITE_SYNC_CLIENT_LEARNING_TO_SUPABASE;
  if (v !== "1" && v !== "true") return;
  if (!isSupabaseConfigured || !supabase) return;
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.user?.id) return;

    const { data, error } = await supabase
      .from("user_learning_snapshots")
      .select("accuracy_summary, edge_floors, confidence_curve, updated_at")
      .eq("user_id", session.user.id)
      .maybeSingle();
    if (error || !data) return;

    const localUpdated = getPredictionAccuracySummary().lastUpdated;
    const remoteUpdated = data.updated_at as string | null;
    if (
      localUpdated &&
      remoteUpdated &&
      new Date(localUpdated).getTime() >= new Date(remoteUpdated).getTime()
    ) {
      // Local is fresher — keep it; the next push will sync up.
      return;
    }

    if (data.accuracy_summary) writeJson(KEY_ACCURACY, data.accuracy_summary);
    if (data.edge_floors)      writeJson(KEY_THRESHOLDS, data.edge_floors);
    if (data.confidence_curve) writeJson(KEY_CURVE,      data.confidence_curve);
  } catch {
    // Network / auth flake — silent. Next outcome write retriggers push.
  }
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
  /** When set, derives context tags for interaction learning (no UI change). */
  game?: GamePrediction;
}): void {
  const sum = getPredictionAccuracySummary();
  sum.bySport[args.league] = bumpBucket(sum.bySport[args.league], args.hit);
  sum.byConfidence[args.confidence] = bumpBucket(sum.byConfidence[args.confidence], args.hit);
  sum.byPickType[args.pickType] = bumpBucket(sum.byPickType[args.pickType], args.hit);
  sum.lastUpdated = new Date().toISOString();
  writeJson(KEY_ACCURACY, sum);

  const ctxTags = args.game ? deriveLearningContextTags(args.game) : [];
  bumpSportEngineFromOutcome(args.league, args.hit, args.confidence, ctxTags);

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

  scheduleUserLearningSnapshotSync();
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
