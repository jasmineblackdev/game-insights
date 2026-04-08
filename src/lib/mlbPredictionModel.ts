/**
 * MLB Weighted Prediction Model
 * ─────────────────────────────────────────────────────────────────────────────
 * Factor weights (applied to a home-positive score, -1 → +1):
 *
 *   Starting pitcher quality       40%
 *   Team batting vs handedness     20%
 *   Bullpen fatigue                15%
 *   Recent team form               10%
 *   Ballpark factor                10%  (affects confidence, not direction)
 *   Travel / rest                   5%
 *
 * Pipeline: runs AFTER enrichGamePredictions(), so B2B tags and injury-adjusted
 * probabilities are already in place. Pitcher ERA/WHIP/K/BB are fetched fresh.
 *
 * Prediction gating:
 *   • pitcherCertainty === "unknown"  → pendingConfirmation = true, cap at LOW
 *   • pitcherCertainty === "partial"  → one starter unknown, cap at MED
 *   • lineup not confirmed            → risk flag added
 *   • extreme park (factor ≥1.08 or ≤0.92) → cap HIGH → MED
 */

import type { GamePrediction, ConfidenceLevel, MlbModelOutput } from "@/data/mockGames";
import { fetchMatchupPitcherStats } from "@/lib/mlbEspnStats";
import type { PitcherStats } from "@/lib/mlbEspnStats";
import { MLB_PARK_FACTORS } from "@/lib/mlbConstants";
import { parseRecord } from "@/lib/espnShared";
import { supabase } from "@/lib/supabase";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lastTenPct(record: string): number | null {
  const m = record.match(/^(\d+)-(\d+)/);
  if (!m) return null;
  const w = Number(m[1]);
  const l = Number(m[2]);
  const t = w + l;
  return t > 0 ? w / t : null;
}

// ── Supabase: recent pitcher form ─────────────────────────────────────────────

/** Try to read last-5-start ERA from Supabase. Returns null when not seeded. */
async function fetchRecentEra(pitcherId: string | undefined): Promise<number | null> {
  if (!supabase || !pitcherId) return null;
  try {
    const { data } = await supabase
      .from("mlb_pitcher_recent_form")
      .select("last_5_starts_era")
      .eq("pitcher_id", pitcherId)
      .maybeSingle();
    const v = data?.last_5_starts_era;
    return typeof v === "number" && v > 0 ? v : null;
  } catch {
    return null;
  }
}

// ── Factor scorers ─────────────────────────────────────────────────────────────

/**
 * Pitcher score: -1 (away SP dominant) to +1 (home SP dominant).
 *
 * Layers:
 *   60% ERA gap (primary)
 *   25% WHIP gap (secondary)
 *   15% K/BB ratio gap (command quality — changes faster within a season)
 *
 * If Supabase `mlb_pitcher_recent_form` is seeded, recent ERA (L5 starts) is
 * blended: 50% season ERA + 50% recent ERA per the model spec.
 * Falls back to season ERA only when recent data is unavailable.
 */
function scorePitcher(
  homeStats: PitcherStats | null,
  awayStats: PitcherStats | null,
  homeRecentEra: number | null,
  awayRecentEra: number | null,
  homeName: string | undefined,
  awayName: string | undefined
): { score: number; edge: string; hasStats: boolean } {
  const hName = homeName ?? "Home SP";
  const aName = awayName ?? "Away SP";

  // Blend season + recent (50/50 per spec) when recent data is available
  const homeEraBlended =
    homeStats?.era != null && homeRecentEra != null
      ? (homeStats.era + homeRecentEra) / 2
      : homeStats?.era ?? null;
  const awayEraBlended =
    awayStats?.era != null && awayRecentEra != null
      ? (awayStats.era + awayRecentEra) / 2
      : awayStats?.era ?? null;

  const homeSample = homeStats?.ip ?? 0;
  const awaySample = awayStats?.ip ?? 0;

  // Small-sample guard: require ≥8 IP for ERA to be meaningful
  const homeEraValid = homeEraBlended != null && homeSample >= 8;
  const awayEraValid = awayEraBlended != null && awaySample >= 8;

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

  // ERA score: each 1-run gap ≈ 0.25 score units (league avg ~4.0)
  let eraScore = 0;
  if (homeEraValid && awayEraValid) {
    eraScore = clamp((awayEraBlended - homeEraBlended!) / 4.0, -0.8, 0.8);
  } else if (homeEraValid) {
    eraScore = clamp((4.0 - homeEraBlended!) / 8.0, -0.4, 0.4);
  } else {
    eraScore = clamp((awayEraBlended! - 4.0) / 8.0, -0.4, 0.4);
  }

  // WHIP score: 0.2-pt gap ≈ 0.25 units
  let whipScore = 0;
  if (homeStats?.whip != null && awayStats?.whip != null) {
    whipScore = clamp((awayStats.whip - homeStats.whip) / 0.8, -0.6, 0.6);
  }

  // K/BB ratio score: command quality, more reactive to recent form
  let kbbScore = 0;
  if (homeStats?.kbb != null && awayStats?.kbb != null) {
    // Typical K/BB range: 1.5–5.0. A 1-unit gap ≈ 0.20 score.
    kbbScore = clamp((homeStats.kbb - awayStats.kbb) / 5.0, -0.3, 0.3);
  }

  const hasWhip = homeStats?.whip != null && awayStats?.whip != null;
  const hasKbb = homeStats?.kbb != null && awayStats?.kbb != null;

  let score: number;
  if (hasWhip && hasKbb) {
    score = eraScore * 0.60 + whipScore * 0.25 + kbbScore * 0.15;
  } else if (hasWhip) {
    score = eraScore * 0.65 + whipScore * 0.35;
  } else {
    score = eraScore;
  }

  const recentNote = homeRecentEra != null || awayRecentEra != null ? " (blended L5/season)" : "";
  let edge: string;
  if (score >= 0.15 && homeEraValid) {
    edge = `${hName} ERA ${homeEraBlended!.toFixed(2)}${recentNote}${awayEraValid ? ` vs ${aName} ${awayEraBlended!.toFixed(2)}` : ""} — home starter has the clear edge.`;
  } else if (score <= -0.15 && awayEraValid) {
    edge = `${aName} ERA ${awayEraBlended!.toFixed(2)}${recentNote}${homeEraValid ? ` vs ${hName} ${homeEraBlended!.toFixed(2)}` : ""} — away starter projects stronger.`;
  } else {
    edge = homeEraValid && awayEraValid
      ? `${hName} (${homeEraBlended!.toFixed(2)}) vs ${aName} (${awayEraBlended!.toFixed(2)})${recentNote} — starting pitcher matchup is roughly even.`
      : "Starting pitcher data partially available — lean is modest.";
  }

  return { score, edge, hasStats: true };
}

/**
 * Batting/handedness score: league-average platoon effect.
 *
 * Historical MLB data (team-level, mixed lineups):
 *   • LHP starters suppress opposing offense by ~0.30 runs/game vs RHP
 *     (partly selection bias — LHP rotation spots tend to be high-quality;
 *      partly preparation: teams face LHP in ~30% of starts, less drill time)
 *   • Platoon advantage translates to ~1-2pp win probability at team level
 *
 * This will be replaced by real split data once mlb_team_batting_splits is seeded.
 * Score range: ±0.10 per pitcher (home-positive = home lineup has advantage).
 */
function scoreBatting(
  awayPitcherHand: "L" | "R" | undefined,
  homePitcherHand: "L" | "R" | undefined
): { score: number; edge: string } {
  if (!awayPitcherHand && !homePitcherHand) {
    return { score: 0, edge: "Pitcher handedness unknown — batting split adjustment skipped." };
  }

  let score = 0;
  const notes: string[] = [];

  // Away LHP → home lineup sees a less common hand → slight away advantage
  if (awayPitcherHand === "L") {
    score -= 0.10;
    notes.push("Away LHP suppresses home lineup — league average: ~0.3 fewer runs/game vs LHP.");
  } else if (awayPitcherHand === "R") {
    notes.push("Away RHP — standard handedness; no platoon adjustment for home lineup.");
  }

  // Home LHP → away lineup sees a less common hand → slight home advantage
  if (homePitcherHand === "L") {
    score += 0.10;
    notes.push("Home LHP suppresses away lineup — away team faces the less-prepared hand.");
  } else if (homePitcherHand === "R") {
    notes.push("Home RHP — standard handedness; no platoon adjustment for away lineup.");
  }

  const edge = notes.join(" ");
  return { score: clamp(score, -0.20, 0.20), edge };
}

/**
 * Bullpen score: from B2B situational tags set during enrichment.
 * B2B games deplete bullpen depth — relievers average ~20% fewer available
 * innings on B2B days based on historical leverage patterns.
 */
function scoreBullpen(homeB2B: boolean, awayB2B: boolean): { score: number; edge: string } {
  if (!homeB2B && !awayB2B) return { score: 0, edge: "Both bullpens at full rest — no fatigue differential." };
  if (homeB2B && awayB2B) return { score: 0, edge: "Both teams on back-to-back — bullpen fatigue roughly cancels out." };
  if (homeB2B) return { score: -0.30, edge: "Home bullpen on back-to-back — expect shorter starter leash and thin relief depth." };
  return { score: 0.30, edge: "Away bullpen on back-to-back — home team carries a meaningful relief advantage tonight." };
}

/** Recent form: L10 pct differential, capped at ±0.5. */
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
      return { score, edge: `Recent form is even (${homeTeam.abbreviation} ${homeTeam.recentForm} · ${awayTeam.abbreviation} ${awayTeam.recentForm}).` };
    }
    const better = diff > 0 ? homeTeam.abbreviation : awayTeam.abbreviation;
    return { score, edge: `${better} has the recent-form edge: ${homeTeam.abbreviation} ${homeTeam.recentForm} vs ${awayTeam.abbreviation} ${awayTeam.recentForm}.` };
  }

  const homeSeason = parseRecord(homeTeam.record).pct;
  const awaySeason = parseRecord(awayTeam.record).pct;
  const diff = homeSeason - awaySeason;
  return {
    score: clamp(diff * 0.6, -0.5, 0.5),
    edge: `Season records: ${homeTeam.abbreviation} ${homeTeam.record} vs ${awayTeam.abbreviation} ${awayTeam.record}.`,
  };
}

/** Rest/travel: batter-level fatigue from B2B (separate from bullpen). */
function scoreRest(homeB2B: boolean, awayB2B: boolean): { score: number; edge: string } {
  if (!homeB2B && !awayB2B) return { score: 0, edge: "Both teams well-rested." };
  if (homeB2B && awayB2B) return { score: 0, edge: "Both lineups on back-to-back." };
  if (homeB2B) return { score: -0.20, edge: "Home lineup fatigued — B2B position player output typically -2 to -3%." };
  return { score: 0.20, edge: "Away lineup fatigued (B2B) — home hitters carry a fresh-legs edge." };
}

// ── Confidence ────────────────────────────────────────────────────────────────

function deriveConfidence(
  probGap: number,
  hasStats: boolean,
  pitcherCertainty: string,
  extremePark: boolean,
  hasOdds: boolean
): ConfidenceLevel {
  if (pitcherCertainty === "unknown") return "low";
  // Partial (one starter unknown) → cap at medium
  if (pitcherCertainty === "partial") return probGap >= 8 ? "medium" : "low";
  const canBeHigh = hasStats || hasOdds;
  if (probGap >= 14 && canBeHigh && !extremePark) return "high";
  if (probGap >= 8) return "medium";
  return "low";
}

// ── Snapshot write (fire-and-forget) ─────────────────────────────────────────

function persistSnapshot(
  game: GamePrediction,
  homeStats: PitcherStats | null,
  awayStats: PitcherStats | null,
  scores: { pitcher: number; batting: number; bullpen: number; form: number; rest: number },
  combinedDelta: number,
  adjustedProb: number,
  confidence: ConfidenceLevel,
  isPending: boolean,
  riskFlag: string | null,
  parkFactor: number,
  hasOdds: boolean
): void {
  if (!supabase || !game._meta?.eventId || game.status === "final") return;
  const predicted = adjustedProb >= 50 ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
  supabase
    .from("mlb_prediction_inputs_snapshot")
    .upsert(
      {
        id: `${game._meta.eventId}-pregame`,
        espn_event_id: game._meta.eventId,
        game_date: game._meta.easternYmd,
        home_team: game.homeTeam.abbreviation,
        away_team: game.awayTeam.abbreviation,
        phase: "pregame",
        model_version: "1.0",
        home_pitcher_id: game._meta.homePitcherAthleteId ?? null,
        away_pitcher_id: game._meta.awayPitcherAthleteId ?? null,
        home_pitcher_era: homeStats?.era ?? null,
        away_pitcher_era: awayStats?.era ?? null,
        home_pitcher_whip: homeStats?.whip ?? null,
        away_pitcher_whip: awayStats?.whip ?? null,
        pitcher_certainty: game.mlb?.pitcherCertainty ?? null,
        home_b2b: game.situationalTags.includes("HOME B2B"),
        away_b2b: game.situationalTags.includes("AWAY B2B"),
        park_factor: parkFactor,
        has_odds: hasOdds,
        pitcher_score: scores.pitcher,
        batting_score: scores.batting,
        bullpen_score: scores.bullpen,
        form_score: scores.form,
        rest_score: scores.rest,
        combined_delta: Math.round(combinedDelta * 10) / 10,
        predicted_winner: predicted,
        win_probability: adjustedProb,
        confidence,
        pending_confirmation: isPending,
        risk_flag: riskFlag ?? null,
      },
      { onConflict: "id" }
    )
    .then(() => null)
    .catch(() => null);
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

  // ── Fetch pitcher stats + recent form in parallel ─────────────────────────
  const [{ home: homeStats, away: awayStats }, homeRecentEra, awayRecentEra] = await Promise.all([
    fetchMatchupPitcherStats(ctx.homeAthleteId, ctx.awayAthleteId),
    fetchRecentEra(ctx.homeAthleteId),
    fetchRecentEra(ctx.awayAthleteId),
  ]);

  // ── Contextual flags ─────────────────────────────────────────────────────────
  const tags = game.situationalTags;
  const homeB2B = tags.includes("HOME B2B");
  const awayB2B = tags.includes("AWAY B2B");
  const pitcherCertainty = mlbIntel.pitcherCertainty;
  const isPending = pitcherCertainty === "unknown";
  const isPartial = pitcherCertainty === "partial";
  const hasOdds = !!(game.lines?.homeMl && game.lines?.awayMl);
  const parkEntry = MLB_PARK_FACTORS[game.homeTeam.abbreviation.toUpperCase()];
  const parkFactor = parkEntry?.factor ?? 1.0;
  const extremePark = parkFactor >= 1.08 || parkFactor <= 0.92;

  // ── Factor scores ─────────────────────────────────────────────────────────────
  const pitcher = scorePitcher(homeStats, awayStats, homeRecentEra, awayRecentEra, mlbIntel.homeProbablePitcher, mlbIntel.awayProbablePitcher);
  const batting = scoreBatting(mlbIntel.awayPitcherHand, mlbIntel.homePitcherHand);
  const bullpen = scoreBullpen(homeB2B, awayB2B);
  const form    = scoreForm(game.homeTeam, game.awayTeam);
  const rest    = scoreRest(homeB2B, awayB2B);

  // ── Probability adjustment ────────────────────────────────────────────────────
  const baseProb = game.winProbability.home;
  let adjustedProb: number;
  let combinedDelta: number;

  if (hasOdds) {
    // Market bakes in form + basic pitcher knowledge.
    // Layer only residual pitcher ERA edge (40%), bullpen (15%), rest (5%).
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
    adjustedProb = clamp(Math.round(baseProb * 0.4 + modelProb * 0.6), 5, 95);
    combinedDelta = adjustedProb - baseProb;
  }

  const probGap = Math.abs(adjustedProb - 50);
  const confidence = deriveConfidence(probGap, pitcher.hasStats, pitcherCertainty, extremePark, hasOdds);

  // ── Risk flag ─────────────────────────────────────────────────────────────────
  let riskFlag: string | null = null;
  if (isPending) {
    riskFlag = "Probable pitchers not confirmed — prediction will update once announced.";
  } else if (isPartial) {
    const known = mlbIntel.homeProbablePitcher ?? mlbIntel.awayProbablePitcher ?? "one starter";
    riskFlag = `Only ${known} confirmed — opponent's starter unknown. Confidence capped until both are set.`;
  } else if (!mlbIntel.lineupConfirmed) {
    riskFlag = "Starting lineup not yet posted — prediction may shift when confirmed.";
  } else if (extremePark && parkFactor >= 1.08) {
    riskFlag = `Hitter-friendly park (${game.homeTeam.abbreviation}) increases run-environment variance.`;
  } else if (extremePark && parkFactor <= 0.92) {
    riskFlag = `Pitcher-friendly park (${game.homeTeam.abbreviation}) compresses scoring.`;
  }

  // ── Model output ─────────────────────────────────────────────────────────────
  const modelOutput: MlbModelOutput = {
    pitcherEdge: pitcher.edge,
    battingEdge: batting.edge,
    bullpenEdge: bullpen.edge,
    formEdge: form.edge,
    parkNote: parkEntry?.note ?? `${game.homeTeam.abbreviation} — neutral park environment.`,
    riskFlag,
    pendingConfirmation: isPending || isPartial,
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

  // ── Update topReasons with ERA insight ────────────────────────────────────────
  const topReasons = [...game.topReasons];
  if (pitcher.hasStats && !topReasons.some((r) => r.includes("ERA"))) {
    const idx = topReasons.findIndex((r) => r.toLowerCase().includes("starter"));
    if (idx >= 0) {
      topReasons[idx] = pitcher.edge;
    } else {
      topReasons.splice(1, 0, pitcher.edge);
    }
  }

  // ── Situational tags ──────────────────────────────────────────────────────────
  const updatedTags = [...tags];
  if ((isPending || isPartial) && !updatedTags.includes("PENDING CONFIRM")) {
    updatedTags.push("PENDING CONFIRM");
  }

  // ── Persist snapshot (fire-and-forget) ───────────────────────────────────────
  persistSnapshot(
    game, homeStats, awayStats,
    { pitcher: pitcher.score, batting: batting.score, bullpen: bullpen.score, form: form.score, rest: rest.score },
    combinedDelta, adjustedProb, confidence, isPending, riskFlag, parkFactor, hasOdds
  );

  const riskFactors = riskFlag && !game.riskFactors.some((r) => r.includes(riskFlag!.slice(0, 30)))
    ? [riskFlag, ...game.riskFactors].slice(0, 4)
    : game.riskFactors;

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

/**
 * Apply the full MLB prediction model to all MLB games.
 * Fetches pitcher ERA/WHIP/K/BB and recent form in parallel (batches of 5).
 * Non-MLB games pass through unchanged.
 */
export async function applyMlbPredictionModel(
  games: GamePrediction[]
): Promise<GamePrediction[]> {
  const contexts: MlbGameContext[] = games.map((g) => ({
    game: g,
    homeAthleteId: g._meta?.homePitcherAthleteId,
    awayAthleteId: g._meta?.awayPitcherAthleteId,
  }));

  const results: GamePrediction[] = [];
  const batchSize = 5;
  for (let i = 0; i < contexts.length; i += batchSize) {
    const batch = contexts.slice(i, i + batchSize);
    const done = await Promise.all(batch.map(modelOneGame));
    results.push(...done);
  }
  return results;
}
