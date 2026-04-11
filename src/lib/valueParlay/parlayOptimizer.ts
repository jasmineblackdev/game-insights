import type { ConfidenceLevel } from "@/data/mockGames";
import { MIN_EDGE_RECOMMEND } from "@/lib/bettingIntelligence";
import {
  parlayAmericanOdds,
  parlayHitProbability,
  payoutMultiplierFromAmerican,
} from "@/lib/valueParlay/oddsMath";
import type { ParlayBuildMode, ParlayTriple, SmartParlayResult, ValueBetCandidate } from "@/lib/valueParlay/types";

function confidenceNumeric(c: ConfidenceLevel): number {
  if (c === "high") return 0.92;
  if (c === "medium") return 0.62;
  return 0.35;
}

function diversificationScore(legs: ValueBetCandidate[]): number {
  const sports = new Set(legs.map((l) => l.sport));
  return Math.min(1, sports.size / 4);
}

function correlationPenalty(legs: ValueBetCandidate[]): number {
  const byGame = new Map<string, ValueBetCandidate[]>();
  for (const l of legs) {
    const arr = byGame.get(l.gameId) ?? [];
    arr.push(l);
    byGame.set(l.gameId, arr);
  }
  let pen = 0;
  for (const [, arr] of byGame) {
    const n = arr.length;
    if (n >= 3) pen += 32;
    else if (n === 2) {
      pen += 22;
      const types = new Set(arr.map((x) => x.pickType));
      if (types.size > 1) pen += 14;
    }
  }
  const byCorr = new Map<string, number>();
  for (const l of legs) {
    const g = l.correlationGroupId.split("-").slice(0, 3).join("-");
    byCorr.set(g, (byCorr.get(g) ?? 0) + 1);
  }
  for (const n of byCorr.values()) {
    if (n >= 2) pen += 8;
  }
  return Math.min(100, pen);
}

function sportCounts(legs: ValueBetCandidate[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const l of legs) {
    m[l.sport] = (m[l.sport] ?? 0) + 1;
  }
  return m;
}

function passesHardRules(legs: ValueBetCandidate[], maxPerSport: number): boolean {
  const byGame = new Map<string, number>();
  for (const l of legs) {
    const next = (byGame.get(l.gameId) ?? 0) + 1;
    byGame.set(l.gameId, next);
    if (next > 2) return false;
  }
  const sc = sportCounts(legs);
  for (const n of Object.values(sc)) {
    if (n > maxPerSport) return false;
  }
  for (const l of legs) {
    if (l.confidence === "low") return false;
    if (l.edge <= 0) return false;
    if (l.americanOdds <= -400 && l.edge < 0.06) return false;
  }
  return true;
}

/** Prefer sweet-spot prices; block structurally bad legs for parlay construction. */
function legPassesParlayBuildFilters(c: ValueBetCandidate): boolean {
  if (c.edge <= 0) return false;
  if (c.americanOdds <= -350 && c.edge < 0.07) return false;
  if (c.americanOdds > 0 && c.volatilityScore >= 55 && c.edge <= 0.08) return false;
  return true;
}

function oddsSweetSpotBonus(american: number): number {
  if (american <= -110 && american >= -200) return 0.12;
  if (american <= -110 && american >= -220) return 0.06;
  if (american > 0 && american <= 160) return 0.04;
  return 0;
}

function buildWarnings(legs: ValueBetCandidate[]): string[] {
  const w: string[] = [];
  const byGame = new Map<string, number>();
  for (const l of legs) {
    byGame.set(l.gameId, (byGame.get(l.gameId) ?? 0) + 1);
  }
  if ([...byGame.values()].some((n) => n >= 2)) {
    w.push("Some legs may share the same game script — correlation elevated.");
  }
  const mlbPitch = legs.some(
    (l) => l.sport === "mlb" && l.riskNote.toLowerCase().includes("pitcher")
  );
  if (mlbPitch) w.push("MLB leg(s) may still be moving on pitcher confirmation.");
  const vol = legs.filter((l) => l.volatilityScore >= 58).length;
  if (vol >= 2) w.push("Volatility stack — card is sensitive to late news.");
  return w;
}

function scoreParlay(legs: ValueBetCandidate[]): SmartParlayResult {
  const odds = legs.map((l) => l.americanOdds);
  const combined = parlayAmericanOdds(odds);
  const probs = legs.map((l) => l.modelProbability);
  const hit = parlayHitProbability(probs);
  const mult = payoutMultiplierFromAmerican(combined);
  const corrPen = correlationPenalty(legs);
  const volPen = legs.reduce((s, l) => s + l.volatilityScore, 0) / legs.length / 100;
  const uncPen = legs.reduce((s, l) => s + l.uncertaintyScore, 0) / legs.length / 100;
  const sumVal = legs.reduce((s, l) => s + l.valueScore, 0);
  const avgConf = legs.reduce((s, l) => s + confidenceNumeric(l.confidence), 0) / legs.length;
  const div = diversificationScore(legs);
  const payoutEff = Math.min(1, (mult - 1) / Math.max(1, legs.length * 0.35));
  const confirmQ = 1 - uncPen * 0.8;

  const smartParlayScore =
    sumVal * 0.35 +
    avgConf * 0.2 +
    payoutEff * 0.15 +
    confirmQ * 0.1 +
    div * 0.1 -
    (corrPen / 100) * 0.05 -
    volPen * 0.05;

  let cardConf: ConfidenceLevel = "high";
  if (avgConf < 0.55 || hit < 0.12) cardConf = "low";
  else if (avgConf < 0.72 || hit < 0.22) cardConf = "medium";

  return {
    legs,
    projectedHitProbability: Math.round(hit * 1000) / 1000,
    projectedPayoutMultiplier: Math.round(mult * 100) / 100,
    combinedAmericanOdds: combined,
    cardConfidence: cardConf,
    correlationPenalty: corrPen,
    volatilityPenalty: Math.round(volPen * 100),
    uncertaintyPenalty: Math.round(uncPen * 100),
    smartParlayScore: Math.round(smartParlayScore * 1000) / 1000,
    warnings: buildWarnings(legs),
  };
}

function greedyBuild(
  pool: ValueBetCandidate[],
  targetLegs: number,
  opts: {
    maxPerSport: number;
    preferSafer: boolean;
    preferPayout: boolean;
    /** When true, first pass ignores `isRecommended` (ranked-live pool). */
    skipRecommendedFilter?: boolean;
  }
): ValueBetCandidate[] {
  const sorted = [...pool].sort((a, b) => {
    if (opts.preferSafer) {
      const rd = a.riskScore - b.riskScore;
      if (Math.abs(rd) > 3) return rd;
    }
    if (opts.preferPayout) {
      const ad = b.americanOdds - a.americanOdds;
      if (Math.abs(ad) > 20) return ad;
    }
    const sa = a.valueScore + oddsSweetSpotBonus(a.americanOdds);
    const sb = b.valueScore + oddsSweetSpotBonus(b.americanOdds);
    return sb - sa;
  });

  const picked: ValueBetCandidate[] = [];
  const gameCounts = new Map<string, number>();
  const sportC: Record<string, number> = {};

  for (const c of sorted) {
    if (picked.length >= targetLegs) break;
    if (!opts.skipRecommendedFilter && !c.isRecommended) continue;
    const gc = (gameCounts.get(c.gameId) ?? 0) + 1;
    if (gc > 2) continue;
    const sc = (sportC[c.sport] ?? 0) + 1;
    if (sc > opts.maxPerSport) continue;
    picked.push(c);
    gameCounts.set(c.gameId, gc);
    sportC[c.sport] = sc;
  }

  if (picked.length < Math.min(3, targetLegs)) {
    for (const c of sorted) {
      if (picked.length >= targetLegs) break;
      if (picked.some((p) => p.id === c.id)) continue;
      const gc = (gameCounts.get(c.gameId) ?? 0) + 1;
      if (gc > 2) continue;
      const sc = (sportC[c.sport] ?? 0) + 1;
      if (sc > opts.maxPerSport) continue;
      if (c.confidence === "low") continue;
      if (c.edge <= 0) continue;
      if (c.edge < MIN_EDGE_RECOMMEND) continue;
      if (!legPassesParlayBuildFilters(c)) continue;
      picked.push(c);
      gameCounts.set(c.gameId, gc);
      sportC[c.sport] = sc;
    }
  }

  return picked;
}

function legRange(mode: ParlayBuildMode): { min: number; max: number } {
  if (mode === "safe") return { min: 3, max: 5 };
  if (mode === "balanced") return { min: 4, max: 8 };
  return { min: 6, max: 12 };
}

export function optimizeSmartParlays(
  candidates: ValueBetCandidate[],
  mode: ParlayBuildMode
): ParlayTriple {
  const { min, max } = legRange(mode);
  let pool = candidates.filter(
    (c) =>
      c.edge >= MIN_EDGE_RECOMMEND &&
      c.edge > 0 &&
      c.confidence !== "low" &&
      legPassesParlayBuildFilters(c)
  );
  if (!pool.length) {
    pool = candidates.filter((c) => c.edge > 0 && c.confidence !== "low" && c.edge >= 0.03);
  }
  const maxPerSport = mode === "aggressive" ? 6 : 4;

  const targetBest = Math.min(12, max);
  let legsBest = greedyBuild(pool, targetBest, { maxPerSport, preferSafer: false, preferPayout: false });
  while (legsBest.length > 2 && !passesHardRules(legsBest, maxPerSport)) {
    legsBest = legsBest.slice(0, -1);
  }
  if (legsBest.length < 2) {
    legsBest = pool
      .filter((c) => c.confidence !== "low")
      .slice(0, Math.min(4, Math.max(2, pool.length)));
  }
  const bestValue = scoreParlay(legsBest.length ? legsBest : pool.slice(0, Math.min(3, pool.length)));

  const legsSafe = greedyBuild(pool, Math.max(min, Math.min(5, max)), {
    maxPerSport,
    preferSafer: true,
    preferPayout: false,
  });
  const safer = scoreParlay(legsSafe);

  const legsPay = greedyBuild(pool, Math.min(12, max + 2), {
    maxPerSport: maxPerSport + 1,
    preferSafer: false,
    preferPayout: true,
  });
  const higherPayout = scoreParlay(legsPay);

  return { bestValue, safer, higherPayout };
}

export function optimizeForMode(candidates: ValueBetCandidate[], mode: ParlayBuildMode): SmartParlayResult {
  return optimizeSmartParlays(candidates, mode).bestValue;
}

/**
 * Best-effort fixed-size parlay from a pre-filtered pool (e.g. main-screen ranked live ML legs).
 */
export function optimizeFixedLegCount(
  candidates: ValueBetCandidate[],
  legCount: number,
  maxPerSport = 4
): SmartParlayResult | null {
  const pool = candidates.filter(
    (c) => c.edge > 0 && c.confidence !== "low" && legPassesParlayBuildFilters(c)
  );
  if (pool.length < legCount) return null;

  let legs = greedyBuild(pool, legCount, {
    maxPerSport,
    preferSafer: false,
    preferPayout: false,
    skipRecommendedFilter: true,
  });
  while (legs.length > 2 && !passesHardRules(legs, maxPerSport)) {
    legs = legs.slice(0, -1);
  }
  if (legs.length < legCount) {
    legs = greedyBuild(pool, legCount, {
      maxPerSport,
      preferSafer: true,
      preferPayout: false,
      skipRecommendedFilter: true,
    });
    while (legs.length > 2 && !passesHardRules(legs, maxPerSport)) {
      legs = legs.slice(0, -1);
    }
  }
  if (legs.length < legCount) return null;
  return scoreParlay(legs);
}
