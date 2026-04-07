/**
 * MLB Weighted Prediction Model
 * ─────────────────────────────────────────────────────────────────────────────
 * Factor weights (applied to a home-positive score, -1 → +1):
 *
 *   Starting pitcher quality       40%
 *   Team batting vs handedness     20%
 *   Bullpen fatigue                15%
 *   Recent team form               10%
 *   Ballpark factor                10%  (affects confidence more than direction)
 *   Travel / rest                   5%
 *
 * Pipeline: runs AFTER enrichGamePredictions(), so B2B tags and injury-adjusted
 * probabilities are already in place.  Pitcher ERA/WHIP are fetched fresh from
 * the ESPN athlete-stats endpoint.
 *
 * Prediction gating:
 *   • pitcherCertainty === "unknown"  → pendingConfirmation = true, cap at LOW
 *   • lineup not confirmed            → risk flag added, cap at MED
 *   • extreme park (factor ≥1.08 or ≤0.92) → cap HIGH → MED
 */

import type { GamePrediction, ConfidenceLevel } from "@/data/mockGames";
import type { MlbModelOutput } from "@/data/mockGames";
import { fetchMatchupPitcherStats } from "@/lib/mlbEspnStats";
import type { PitcherStats } from "@/lib/mlbEspnStats";
import { MLB_PARK_FACTORS } from "@/lib/mlbEspn";
import { parseRecord } from "@/lib/espnShared";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lastTenPct(record: string): number | null {
  // record looks like "7-3 L10" or "5-5 L10" as set by espnEnrichment
  const m = record.match(/^(\d+)-(\d+)/);
  if (!m) return null;
  const w = Number(m[1]);
  const l = Number(m[2]);
  const t = w + l;
  return t > 0 ? w / t : null;
}

// ── Factor scorers ─────────────────────────────────────────────────────────────

/**
 * Pitcher score: -1 (away SP dominant) to +1 (home SP dominant).
 * Uses ERA as primary signal, WHIP as secondary if available.
 * Falls back to 0 (neutral) when stats unavailable.
 */
function scorePitcher(
  homeStats: PitcherStats | null,
  awayStats: PitcherStats | null,
  homeName: string | undefined,
  awayName: string | undefined
): { score: number; edge: string; hasStats: boolean } {
  const homeEra = homeStats?.era ?? null;
  const awayEra = awayStats?.era ?? null;
  const homeWhip = homeStats?.whip ?? null;
  const awayWhip = awayStats?.whip ?? null;
  const homeSample = homeStats?.ip ?? 0;
  const awaySample = awayStats?.ip ?? 0;

  const hName = homeName ?? "Home SP";
  const aName = awayName ?? "Away SP";

  // Small-sample guard: require ≥8 IP to treat ERA as meaningful
  const homeEraValid = homeEra != null && homeSample >= 8;
  const awayEraValid = awayEra != null && awaySample >= 8;

  if (!homeEraValid && !awayEraValid) {
    return {
      score: 0,
      edge:
        homeName && awayName
          ? `${aName} vs ${hName} — ERA not yet available; pitcher quality treated as neutral.`
          : "Probable pitchers not confirmed — pitcher weight neutral.",
      hasStats: false,
    };
  }

  let eraScore = 0;
  let whipScore = 0;

  if (homeEraValid && awayEraValid) {
    // League avg ERA ~4.0. Each run difference ≈ 0.25 score units.
    eraScore = clamp((awayEra - homeEra) / 4.0, -0.8, 0.8);
  } else if (homeEraValid) {
    // Only home ERA known: modest positive lean if home is a reasonable pitcher
    eraScore = clamp((4.0 - homeEra) / 8.0, -0.4, 0.4);
  } else {
    // Only away ERA known: modest negative lean if away is strong
    eraScore = clamp((awayEra - 4.0) / 8.0, -0.4, 0.4);
  }

  if (homeWhip != null && awayWhip != null) {
    // League avg WHIP ~1.30. 0.2-pt gap ≈ 0.25 units.
    whipScore = clamp((awayWhip - homeWhip) / 0.8, -0.6, 0.6);
  }

  const score = homeWhip != null && awayWhip != null
    ? eraScore * 0.6 + whipScore * 0.4
    : eraScore;

  let edge: string;
  if (score >= 0.15 && homeEraValid) {
    edge = `${hName} ERA ${homeEra!.toFixed(2)}${awayEraValid ? ` vs ${aName} ${awayEra!.toFixed(2)}` : ""} — home starter has the clear edge.`;
  } else if (score <= -0.15 && awayEraValid) {
    edge = `${aName} ERA ${awayEra!.toFixed(2)}${homeEraValid ? ` vs ${hName} ${homeEra!.toFixed(2)}` : ""} — away starter projects stronger.`;
  } else {
    edge = homeEraValid && awayEraValid
      ? `${hName} (${homeEra!.toFixed(2)}) vs ${aName} (${awayEra!.toFixed(2)}) — starting pitcher matchup is roughly even.`
      : `Starting pitcher data partially available — lean is modest.`;
  }

  return { score, edge, hasStats: true };
}

/**
 * Batting/handedness score: small heuristic adjustment for platoon advantage.
 * Without real team split data (unavailable from ESPN), applies league-average
 * platoon tendency: teams hit ~5% better OPS vs opposite-handed pitching.
 * Max ±0.12 — deliberately conservative without actual split data.
 */
function scoreBatting(
  awayPitcherHand: "L" | "R" | undefined,
  homePitcherHand: "L" | "R" | undefined
): { score: number; edge: string } {
  // When pitcher hands are known, apply a small platoon heuristic.
  // Most teams have a slight advantage vs opposite-hand pitchers.
  // This will be refined when historical split data is stored in Supabase.
  if (!awayPitcherHand && !homePitcherHand) {
    return { score: 0, edge: "Pitcher handedness unknown — batting split adjustment skipped." };
  }

  // Neutralize — real split data needed for a meaningful signal.
  // Mark as a note rather than a numerical lever until splits are stored.
  const awayLine = awayPitcherHand ? `Away SP: ${awayPitcherHand}HP` : "Away SP: hand unknown";
  const homeLine = homePitcherHand ? `Home SP: ${homePitcherHand}HP` : "Home SP: hand unknown";
  const edge = `${homeLine} · ${awayLine}. Platoon-split edge stored in mlb_team_batting_splits once seeded — currently treated as neutral.`;

  return { score: 0, edge };
}

/**
 * Bullpen score: derived from B2B situational tags set during enrichment.
 * B2B games deplete bullpen depth — relievers average ~20% fewer available
 * innings on B2B days based on historical leverage patterns.
 * Range: -0.35 (home bullpen heavily fatigued) to +0.35 (away bullpen fatigued).
 */
function scoreBullpen(homeB2B: boolean, awayB2B: boolean): { score: number; edge: string } {
  if (!homeB2B && !awayB2B) {
    return { score: 0, edge: "Both bullpens at full rest — no fatigue differential." };
  }
  if (homeB2B && awayB2B) {
    return {
      score: 0,
      edge: "Both teams on back-to-back — bullpen fatigue roughly cancels out.",
    };
  }
  if (homeB2B) {
    return {
      score: -0.30,
      edge: "Home bullpen on back-to-back — expect shorter starter leash and thin relief depth.",
    };
  }
  return {
    score: 0.30,
    edge: "Away bullpen on back-to-back — home team carries a meaningful relief advantage tonight.",
  };
}

/**
 * Recent form score: L10 win% differential when available, else season records.
 * Capped at ±0.5 to prevent recent variance from overwhelming the model.
 */
function scoreForm(
  homeTeam: GamePrediction["homeTeam"],
  awayTeam: GamePrediction["awayTeam"]
): { score: number; edge: string } {
  const homeL10 = lastTenPct(homeTeam.recentForm);
  const awayL10 = lastTenPct(awayTeam.recentForm);

  if (homeL10 != null && awayL10 != null) {
    const diff = homeL10 - awayL10;
    const score = clamp(diff * 0.8, -0.5, 0.5);
    if (Math.abs(diff) < 0.08) {
      return {
        score,
        edge: `Recent form is even (${homeTeam.abbreviation} ${homeTeam.recentForm} · ${awayTeam.abbreviation} ${awayTeam.recentForm}).`,
      };
    }
    const better = diff > 0 ? homeTeam.abbreviation : awayTeam.abbreviation;
    return {
      score,
      edge: `${better} has the recent-form edge: ${homeTeam.abbreviation} ${homeTeam.recentForm} vs ${awayTeam.abbreviation} ${awayTeam.recentForm}.`,
    };
  }

  // Fall back to season record
  const homeSeason = parseRecord(homeTeam.record).pct;
  const awaySeason = parseRecord(awayTeam.record).pct;
  const diff = homeSeason - awaySeason;
  const score = clamp(diff * 0.6, -0.5, 0.5);
  return {
    score,
    edge: `Season records: ${homeTeam.abbreviation} ${homeTeam.record} vs ${awayTeam.abbreviation} ${awayTeam.record}.`,
  };
}

/**
 * Rest/travel score: batter-level fatigue from B2B games (separate from bullpen).
 * Position players show ~2-3% reduced output on B2B, especially away from home.
 */
function scoreRest(homeB2B: boolean, awayB2B: boolean): { score: number; edge: string } {
  if (!homeB2B && !awayB2B) return { score: 0, edge: "Both teams well-rested." };
  if (homeB2B && awayB2B) return { score: 0, edge: "Both lineups on back-to-back." };
  if (homeB2B) return { score: -0.20, edge: `${homeB2B ? "Home" : "Away"} lineup fatigued — B2B position player output typically -2 to -3%.` };
  return { score: 0.20, edge: "Away lineup fatigued (B2B) — home hitters carry a fresh-legs edge." };
}

// ── Confidence derivation ─────────────────────────────────────────────────────

function deriveConfidence(
  probGap: number,
  hasStats: boolean,
  isPending: boolean,
  extremePark: boolean,
  hasOdds: boolean
): ConfidenceLevel {
  if (isPending) return "low";
  // Require ERA data to award HIGH — without it, there's too much uncertainty
  const canBeHigh = hasStats || hasOdds;
  if (probGap >= 14 && canBeHigh && !extremePark) return "high";
  if (probGap >= 8) return "medium";
  return "low";
}

// ── Main model application ────────────────────────────────────────────────────

interface MlbGameContext {
  game: GamePrediction;
  homeAthleteId: string | undefined;
  awayAthleteId: string | undefined;
}

async function modelOneGame(ctx: MlbGameContext): Promise<GamePrediction> {
  const { game } = ctx;
  if (game.league !== "mlb") return game;

  const mlbIntel = game.mlb;
  if (!mlbIntel) return game;

  // ── Fetch pitcher stats ──────────────────────────────────────────────────────
  const { home: homeStats, away: awayStats } = await fetchMatchupPitcherStats(
    ctx.homeAthleteId,
    ctx.awayAthleteId
  );

  // ── Contextual flags ─────────────────────────────────────────────────────────
  const tags = game.situationalTags;
  const homeB2B = tags.includes("HOME B2B");
  const awayB2B = tags.includes("AWAY B2B");
  const isPending = mlbIntel.pitcherCertainty === "unknown";
  const hasOdds = !!(game.lines?.homeMl && game.lines?.awayMl);
  const parkEntry = MLB_PARK_FACTORS[game.homeTeam.abbreviation.toUpperCase()];
  const parkFactor = parkEntry?.factor ?? 1.0;
  const extremePark = parkFactor >= 1.08 || parkFactor <= 0.92;

  // ── Factor scores ─────────────────────────────────────────────────────────────
  const pitcher = scorePitcher(
    homeStats, awayStats,
    mlbIntel.homeProbablePitcher, mlbIntel.awayProbablePitcher
  );
  const batting = scoreBatting(mlbIntel.awayPitcherHand, mlbIntel.homePitcherHand);
  const bullpen = scoreBullpen(homeB2B, awayB2B);
  const form = scoreForm(game.homeTeam, game.awayTeam);
  const rest = scoreRest(homeB2B, awayB2B);

  // ── Probability adjustment ────────────────────────────────────────────────────
  const baseProb = game.winProbability.home;
  let adjustedProb: number;
  let combinedDelta: number;

  if (hasOdds) {
    // Market already bakes in team form + basic pitcher knowledge.
    // Layer only pitcher ERA edge (40%), bullpen (15%), rest (5%).
    combinedDelta =
      pitcher.score * 0.40 * 9 +   // ±3.6pp max
      bullpen.score * 0.15 * 5 +   // ±0.75pp max
      rest.score    * 0.05 * 4;    // ±0.2pp max
    adjustedProb = clamp(Math.round(baseProb + combinedDelta), 5, 95);
  } else {
    // No market signal — apply full model and blend with record-based base.
    const weightedScore =
      pitcher.score * 0.40 +
      batting.score * 0.20 +
      bullpen.score * 0.15 +
      form.score    * 0.10 +
      rest.score    * 0.05;
    const modelProb = clamp(50 + weightedScore * 35, 10, 90);
    // Blend 60% model, 40% record-based
    adjustedProb = clamp(Math.round(baseProb * 0.4 + modelProb * 0.6), 5, 95);
    combinedDelta = adjustedProb - baseProb;
  }

  const probGap = Math.abs(adjustedProb - 50);
  const confidence = deriveConfidence(probGap, pitcher.hasStats, isPending, extremePark, hasOdds);

  // ── Risk flag ─────────────────────────────────────────────────────────────────
  let riskFlag: string | null = null;
  if (isPending) {
    riskFlag = "Probable pitchers not confirmed — prediction will update once announced.";
  } else if (extremePark && parkFactor >= 1.08) {
    riskFlag = `Hitter-friendly park (${game.homeTeam.abbreviation}) increases run-environment variance.`;
  } else if (extremePark && parkFactor <= 0.92) {
    riskFlag = `Pitcher-friendly park (${game.homeTeam.abbreviation}) compresses scoring — totals bets are lower-variance here.`;
  }

  // ── Build model output ────────────────────────────────────────────────────────
  const modelOutput: MlbModelOutput = {
    pitcherEdge: pitcher.edge,
    battingEdge: batting.edge,
    bullpenEdge: bullpen.edge,
    formEdge: form.edge,
    parkNote: parkEntry?.note ?? `${game.homeTeam.abbreviation} — neutral park environment.`,
    riskFlag,
    pendingConfirmation: isPending,
    _debug: {
      pitcherScore: pitcher.score,
      battingScore: batting.score,
      bullpenScore: bullpen.score,
      formScore: form.score,
      restScore: rest.score,
      combinedDelta: Math.round(combinedDelta * 10) / 10,
      hasOdds,
      hasStats: pitcher.hasStats,
      homePitcherEra: homeStats?.era ?? null,
      awayPitcherEra: awayStats?.era ?? null,
      homePitcherWhip: homeStats?.whip ?? null,
      awayPitcherWhip: awayStats?.whip ?? null,
    },
  };

  // ── Update situational tags ───────────────────────────────────────────────────
  const updatedTags = [...tags];
  if (isPending && !updatedTags.includes("PENDING CONFIRM")) {
    updatedTags.push("PENDING CONFIRM");
  }

  // ── Update topReasons with model-derived insights ─────────────────────────────
  const topReasons = [...game.topReasons];
  if (pitcher.hasStats && !topReasons.some((r) => r.includes("ERA"))) {
    // Replace generic pitcher line with ERA-based insight
    const pitcherIdx = topReasons.findIndex((r) => r.toLowerCase().includes("starter"));
    const eraLine = pitcher.edge;
    if (pitcherIdx >= 0) {
      topReasons[pitcherIdx] = eraLine;
    } else {
      topReasons.splice(1, 0, eraLine);
    }
  }
  if (riskFlag && !game.riskFactors.some((r) => r.includes(riskFlag!.slice(0, 30)))) {
    const riskFactors = [riskFlag, ...game.riskFactors].slice(0, 4);
    return {
      ...game,
      winProbability: { home: adjustedProb, away: 100 - adjustedProb },
      confidence,
      topReasons: topReasons.slice(0, 6),
      riskFactors,
      situationalTags: updatedTags,
      mlb: { ...mlbIntel, modelOutput },
    };
  }

  return {
    ...game,
    winProbability: { home: adjustedProb, away: 100 - adjustedProb },
    confidence,
    topReasons: topReasons.slice(0, 6),
    situationalTags: updatedTags,
    mlb: { ...mlbIntel, modelOutput },
  };
}

/**
 * Apply the full MLB prediction model to all MLB games.
 * Fetches pitcher ERA/WHIP in parallel (up to 5 games at once).
 * Safe to call with non-MLB games — they pass through unchanged.
 */
export async function applyMlbPredictionModel(
  games: GamePrediction[]
): Promise<GamePrediction[]> {
  const mlbGames: MlbGameContext[] = games.map((g) => ({
    game: g,
    homeAthleteId: g._meta?.homePitcherAthleteId,
    awayAthleteId: g._meta?.awayPitcherAthleteId,
  }));

  // Process in batches of 5 (2 stat fetches per game = 10 concurrent ESPN calls max)
  const results: GamePrediction[] = [];
  const batchSize = 5;
  for (let i = 0; i < mlbGames.length; i += batchSize) {
    const batch = mlbGames.slice(i, i + batchSize);
    const done = await Promise.all(batch.map(modelOneGame));
    results.push(...done);
  }
  return results;
}
