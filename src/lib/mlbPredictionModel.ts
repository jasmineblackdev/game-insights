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
import { fetchMatchupPitcherStats, fetchPitcherRestDays } from "@/lib/mlbEspnStats";
import type { PitcherStats } from "@/lib/mlbEspnStats";
import { MLB_PARK_FACTORS } from "@/lib/mlbConstants";
import { parseRecord } from "@/lib/espnShared";
import { supabase } from "@/lib/supabase";
import { fetchMlbModelWeights, writeGameOutcome, type MlbFactorWeights } from "@/lib/mlbModelWeights";

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
  awayName: string | undefined,
  homeRestDays: number | null,
  awayRestDays: number | null
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

  // Rest-day adjustment: short rest hurts ERA performance, extra rest helps slightly
  // Short rest (<3 days) → ERA rises ~0.8 runs/game → apply ∓0.10 score adjustment
  // Long rest (5+ days) → small benefit → apply ∓0.05 score adjustment
  const restAdj = (restDays: number | null, isHome: boolean): number => {
    if (restDays == null) return 0;
    const sign = isHome ? 1 : -1;
    if (restDays <= 2) return sign * -0.10; // short rest hurts the team
    if (restDays >= 5) return sign * 0.05;  // extra rest helps slightly
    return 0;
  };
  const homeRestAdj = restAdj(homeRestDays, true);
  const awayRestAdj = restAdj(awayRestDays, false);
  score = clamp(score + homeRestAdj + awayRestAdj, -1, 1);

  const recentNote = homeRecentEra != null || awayRecentEra != null ? " (blended L5/season)" : "";
  const homeRestNote =
    homeRestDays != null && homeRestDays <= 2 ? ` ${hName} on short rest (${homeRestDays}d).` :
    homeRestDays != null && homeRestDays >= 5 ? ` ${hName} extra-rested (${homeRestDays}d).` : "";
  const awayRestNote =
    awayRestDays != null && awayRestDays <= 2 ? ` ${aName} on short rest (${awayRestDays}d).` :
    awayRestDays != null && awayRestDays >= 5 ? ` ${aName} extra-rested (${awayRestDays}d).` : "";

  let edge: string;
  if (score >= 0.15 && homeEraValid) {
    edge = `${hName} ERA ${homeEraBlended!.toFixed(2)}${recentNote}${awayEraValid ? ` vs ${aName} ${awayEraBlended!.toFixed(2)}` : ""} — home starter has the clear edge.${homeRestNote}${awayRestNote}`;
  } else if (score <= -0.15 && awayEraValid) {
    edge = `${aName} ERA ${awayEraBlended!.toFixed(2)}${recentNote}${homeEraValid ? ` vs ${hName} ${homeEraBlended!.toFixed(2)}` : ""} — away starter projects stronger.${homeRestNote}${awayRestNote}`;
  } else {
    edge = homeEraValid && awayEraValid
      ? `${hName} (${homeEraBlended!.toFixed(2)}) vs ${aName} (${awayEraBlended!.toFixed(2)})${recentNote} — starting pitcher matchup is roughly even.${homeRestNote}${awayRestNote}`
      : `Starting pitcher data partially available — lean is modest.${homeRestNote}${awayRestNote}`;
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
 * Bullpen score: from B2B and CONSEC situational tags set during enrichment.
 * B2B games deplete bullpen depth — relievers average ~20% fewer available
 * innings on B2B days based on historical leverage patterns.
 * CONSEC (3rd straight game) amplifies this: bullpen is severely taxed.
 */
function scoreBullpen(
  homeB2B: boolean,
  awayB2B: boolean,
  homeConsec: boolean,
  awayConsec: boolean
): { score: number; edge: string } {
  const homeScore = homeConsec ? -0.45 : homeB2B ? -0.30 : 0;
  const awayScore = awayConsec ? 0.45 : awayB2B ? 0.30 : 0;
  const score = clamp(homeScore + awayScore, -0.45, 0.45);

  if (!homeB2B && !awayB2B) return { score: 0, edge: "Both bullpens at full rest — no fatigue differential." };
  if (homeB2B && awayB2B) {
    const net = homeScore + awayScore;
    if (Math.abs(net) < 0.05) return { score, edge: "Both teams on back-to-back — bullpen fatigue roughly cancels out." };
  }
  const homeSuffix = homeConsec ? " (3rd game in 3 days — severely taxed)" : "";
  const awaySuffix = awayConsec ? " (3rd game in 3 days — road bullpen depleted)" : "";
  if (homeB2B && !awayB2B) return { score, edge: `Home bullpen on B2B${homeSuffix} — thin relief depth tonight.` };
  if (awayB2B && !homeB2B) return { score, edge: `Away bullpen on B2B${awaySuffix} — home carries meaningful relief advantage.` };
  return { score, edge: `Bullpen fatigue: home${homeSuffix}, away${awaySuffix}.` };
}

/**
 * Recent form: uses home/road split win% when available (more predictive for MLB
 * than overall L10, since home-field advantage compounds with lineup familiarity).
 * Falls back to L10 overall → season record when split data is unavailable.
 */
function scoreForm(
  homeTeam: GamePrediction["homeTeam"],
  awayTeam: GamePrediction["awayTeam"]
): { score: number; edge: string } {
  // Prefer home/road split win% (set by fetchTeamPatch after enrichment)
  if (homeTeam.homeWinPct != null && awayTeam.roadWinPct != null) {
    const diff = homeTeam.homeWinPct - awayTeam.roadWinPct;
    const score = clamp(diff * 0.9, -0.5, 0.5);
    const homeHomePct = Math.round(homeTeam.homeWinPct * 100);
    const awayRoadPct = Math.round(awayTeam.roadWinPct * 100);
    if (Math.abs(diff) < 0.06) {
      return { score, edge: `Home/road splits even — ${homeTeam.abbreviation} at home ${homeHomePct}% · ${awayTeam.abbreviation} on road ${awayRoadPct}%.` };
    }
    const better = diff > 0 ? homeTeam.abbreviation : awayTeam.abbreviation;
    return { score, edge: `${better} has split edge — ${homeTeam.abbreviation} home ${homeHomePct}% vs ${awayTeam.abbreviation} road ${awayRoadPct}%.` };
  }

  // Fallback: L10 overall
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

  // Fallback: season record
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

async function modelOneGame(
  ctx: MlbGameContext,
  weights: MlbFactorWeights
): Promise<GamePrediction> {
  const { game } = ctx;
  if (game.league !== "mlb") return game;

  const mlbIntel = game.mlb;
  if (!mlbIntel) return game;

  // ── Write outcome if game is already final (fire-and-forget) ─────────────
  if (game.status === "final" && game._meta?.eventId) {
    const fh = game._meta.finalHomeScore;
    const fa = game._meta.finalAwayScore;
    if (fh != null && fa != null) {
      const actualWinner = fh > fa ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
      const predicted = game.winProbability.home >= 50
        ? game.homeTeam.abbreviation
        : game.awayTeam.abbreviation;
      writeGameOutcome(game._meta.eventId, actualWinner, predicted, fh, fa);
    }
    // Don't re-run the model on final games — return as-is
    return game;
  }

  // ── Fetch pitcher stats + recent form + rest days in parallel ──────────────
  const [{ home: homeStats, away: awayStats }, homeRecentEra, awayRecentEra, homeRestDays, awayRestDays] =
    await Promise.all([
      fetchMatchupPitcherStats(ctx.homeAthleteId, ctx.awayAthleteId),
      fetchRecentEra(ctx.homeAthleteId),
      fetchRecentEra(ctx.awayAthleteId),
      ctx.homeAthleteId ? fetchPitcherRestDays(ctx.homeAthleteId) : Promise.resolve(null),
      ctx.awayAthleteId ? fetchPitcherRestDays(ctx.awayAthleteId) : Promise.resolve(null),
    ]);

  // ── Contextual flags ─────────────────────────────────────────────────────────
  const tags = game.situationalTags;
  const homeB2B = tags.includes("HOME B2B");
  const awayB2B = tags.includes("AWAY B2B");
  const homeConsec = tags.includes("HOME CONSEC");
  const awayConsec = tags.includes("AWAY CONSEC");
  const pitcherCertainty = mlbIntel.pitcherCertainty;
  const isPending = pitcherCertainty === "unknown";
  const isPartial = pitcherCertainty === "partial";
  const hasOdds = !!(game.lines?.homeMl && game.lines?.awayMl);
  const parkEntry = MLB_PARK_FACTORS[game.homeTeam.abbreviation.toUpperCase()];
  const parkFactor = parkEntry?.factor ?? 1.0;
  const extremePark = parkFactor >= 1.08 || parkFactor <= 0.92;

  // ── Factor scores ─────────────────────────────────────────────────────────────
  const pitcher = scorePitcher(
    homeStats, awayStats, homeRecentEra, awayRecentEra,
    mlbIntel.homeProbablePitcher, mlbIntel.awayProbablePitcher,
    homeRestDays, awayRestDays
  );
  const batting = scoreBatting(mlbIntel.awayPitcherHand, mlbIntel.homePitcherHand);
  const bullpen = scoreBullpen(homeB2B, awayB2B, homeConsec, awayConsec);
  const form    = scoreForm(game.homeTeam, game.awayTeam);
  const rest    = scoreRest(homeB2B, awayB2B);

  // ── Probability adjustment (using dynamic or default weights) ─────────────────
  const baseProb = game.winProbability.home;
  let adjustedProb: number;
  let combinedDelta: number;

  if (hasOdds) {
    // Market bakes in form + basic pitcher knowledge.
    // Layer only residual pitcher ERA edge, bullpen, rest (proportional to weights).
    combinedDelta =
      pitcher.score * weights.pitcher * 9 +
      bullpen.score * weights.bullpen * 5 +
      rest.score    * weights.rest    * 4;
    adjustedProb = clamp(Math.round(baseProb + combinedDelta), 5, 95);
  } else {
    // No market signal — apply full weighted model and blend with record-based base.
    const weightedScore =
      pitcher.score * weights.pitcher +
      batting.score * weights.batting +
      bullpen.score * weights.bullpen +
      form.score    * weights.form    +
      rest.score    * weights.rest;
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
 * Fetches learned weights once, then processes pitcher ERA/WHIP/K/BB, rest days,
 * home/away form splits, and recent form in parallel (batches of 5).
 * Non-MLB games pass through unchanged.
 */
export async function applyMlbPredictionModel(
  games: GamePrediction[]
): Promise<GamePrediction[]> {
  // Fetch learned weights once — falls back to defaults when sample_size < 50
  const weights = await fetchMlbModelWeights();

  const contexts: MlbGameContext[] = games.map((g) => ({
    game: g,
    homeAthleteId: g._meta?.homePitcherAthleteId,
    awayAthleteId: g._meta?.awayPitcherAthleteId,
  }));

  const results: GamePrediction[] = [];
  const batchSize = 5;
  for (let i = 0; i < contexts.length; i += batchSize) {
    const batch = contexts.slice(i, i + batchSize);
    const done = await Promise.all(batch.map((ctx) => modelOneGame(ctx, weights)));
    results.push(...done);
  }
  return results;
}
