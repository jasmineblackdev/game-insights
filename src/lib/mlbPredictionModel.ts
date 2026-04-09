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
 *   • pendingConfirmation until both probable pitchers are confirmed AND lineup is confirmed
 *   • pitcherCertainty === "unknown"  → cap at LOW
 *   • pitcherCertainty === "partial"  → cap at MED
 *   • lineup / volatile weather / extreme park → cap HIGH at MED
 */

import type { GamePrediction, ConfidenceLevel, MlbModelOutput, PitcherCertainty } from "@/data/mockGames";
import {
  fetchMatchupPitcherStats,
  fetchPitcherRestDays,
  resolveEspnMlbAthleteIdByDisplayName,
} from "@/lib/mlbEspnStats";
import type { PitcherStats } from "@/lib/mlbEspnStats";
import { MLB_PARK_FACTORS } from "@/lib/mlbConstants";
import { parseRecord } from "@/lib/espnShared";
import { supabase } from "@/lib/supabase";
import { applyAdvancedIntelligenceToGames } from "@/lib/advancedIntelligenceLayer";
import { applyPredictionQualityPipeline } from "@/lib/predictionQualityPipeline";
import { fetchMlbModelWeights, writeGameOutcome, type MlbFactorWeights } from "@/lib/mlbModelWeights";
import {
  blendPitcherEra,
  blendTeamOps,
  bullpenEmergencyNote,
  fetchBullpenFatigueRow,
  fetchLineupStrengthRow,
  fetchPitcherLogBaselines,
  fetchPitcherRecentFormRow,
  fetchTeamBattingSplit,
  type BullpenFatigueRow,
  type LineupStrengthRow,
  type PitcherRecentFormRow,
} from "@/lib/mlbHistoricalFeatures";

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

// ── Factor scorers ─────────────────────────────────────────────────────────────

const MLB_MODEL_SCHEMA_VERSION = "2.0";
const MLB_PREDICTION_VERSION = "2.0-historical";

function pitcherMicroAdjust(form: PitcherRecentFormRow | null): number {
  let m = 0;
  if (form?.last_5_starts_fip != null && form?.last_3_starts_fip != null) {
    m += clamp((form.last_5_starts_fip - form.last_3_starts_fip) / 12, -0.04, 0.04);
  }
  if (form?.avg_pitch_count != null && form.avg_pitch_count > 103) m -= 0.035;
  if (form?.avg_innings_pitched != null && form.avg_innings_pitched < 4.8) m -= 0.025;
  return m;
}

/**
 * Pitcher score: -1 (away SP dominant) to +1 (home SP dominant).
 * Expects pre-blended ERA (50% season / 30% L5 / 20% historical log or league prior).
 */
function scorePitcher(
  homeStats: PitcherStats | null,
  awayStats: PitcherStats | null,
  homeEraBlended: number | null,
  awayEraBlended: number | null,
  homeName: string | undefined,
  awayName: string | undefined,
  homeRestDays: number | null,
  awayRestDays: number | null,
  homeForm: PitcherRecentFormRow | null,
  awayForm: PitcherRecentFormRow | null,
  blendLabel: string
): { score: number; edge: string; hasStats: boolean } {
  const hName = homeName ?? "Home SP";
  const aName = awayName ?? "Away SP";

  const homeSample = homeStats?.ip ?? 0;
  const awaySample = awayStats?.ip ?? 0;

  const homeEraValid =
    homeEraBlended != null &&
    ((homeSample >= 8 && homeStats?.era != null) ||
      (homeForm?.last_5_starts_era != null && homeForm.last_5_starts_era > 0 && homeForm.last_5_starts_era < 30));
  const awayEraValid =
    awayEraBlended != null &&
    ((awaySample >= 8 && awayStats?.era != null) ||
      (awayForm?.last_5_starts_era != null && awayForm.last_5_starts_era > 0 && awayForm.last_5_starts_era < 30));

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
  if (homeEraValid && awayEraValid) {
    eraScore = clamp((awayEraBlended! - homeEraBlended!) / 4.0, -0.8, 0.8);
  } else if (homeEraValid) {
    eraScore = clamp((4.0 - homeEraBlended!) / 8.0, -0.4, 0.4);
  } else {
    eraScore = clamp((awayEraBlended! - 4.0) / 8.0, -0.4, 0.4);
  }

  let whipScore = 0;
  if (homeStats?.whip != null && awayStats?.whip != null) {
    whipScore = clamp((awayStats.whip - homeStats.whip) / 0.8, -0.6, 0.6);
  }

  let kbbScore = 0;
  if (homeStats?.kbb != null && awayStats?.kbb != null) {
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

  const restAdj = (restDays: number | null, isHome: boolean): number => {
    if (restDays == null) return 0;
    const sign = isHome ? 1 : -1;
    if (restDays <= 2) return sign * -0.10;
    if (restDays >= 5) return sign * 0.05;
    return 0;
  };
  const homeRestAdj = restAdj(homeRestDays, true);
  const awayRestAdj = restAdj(awayRestDays, false);
  const micro = pitcherMicroAdjust(homeForm) - pitcherMicroAdjust(awayForm);
  score = clamp(score + homeRestAdj + awayRestAdj + micro, -1, 1);

  const recentNote = blendLabel ? ` (${blendLabel})` : "";
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

  const fipNudge =
    homeForm?.last_5_starts_fip != null && awayForm?.last_5_starts_fip != null
      ? ` Recent FIP: ${hName} ${homeForm.last_5_starts_fip.toFixed(2)} vs ${aName} ${awayForm.last_5_starts_fip.toFixed(2)}.`
      : "";
  if (fipNudge && homeEraValid && awayEraValid) edge += fipNudge;

  return { score, edge, hasStats: true };
}

/** Handedness-only fallback when splits are not seeded. */
function scoreBattingHeuristic(
  awayPitcherHand: "L" | "R" | undefined,
  homePitcherHand: "L" | "R" | undefined
): { score: number; edge: string } {
  if (!awayPitcherHand && !homePitcherHand) {
    return { score: 0, edge: "Pitcher handedness unknown — batting split adjustment skipped." };
  }

  let score = 0;
  const notes: string[] = [];

  if (awayPitcherHand === "L") {
    score -= 0.10;
    notes.push("Away LHP suppresses home lineup — league average: ~0.3 fewer runs/game vs LHP.");
  } else if (awayPitcherHand === "R") {
    notes.push("Away RHP — standard handedness; no platoon adjustment for home lineup.");
  }

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
 * Team batting vs opponent starter handedness: 50% season split / 25% L14 / 25% league prior
 * when `mlb_team_batting_splits` is seeded; else heuristic.
 */
function scoreBatting(
  awayPitcherHand: "L" | "R" | undefined,
  homePitcherHand: "L" | "R" | undefined,
  homeOpsBlend: number | null,
  awayOpsBlend: number | null,
  usedDbSplits: boolean,
  homeAbbr: string,
  awayAbbr: string,
  homeLineup: LineupStrengthRow | null,
  awayLineup: LineupStrengthRow | null
): { score: number; edge: string } {
  if (usedDbSplits && homeOpsBlend != null && awayOpsBlend != null) {
    let score = clamp((homeOpsBlend - awayOpsBlend) * 2.8, -0.2, 0.2);
    const hPen = (homeLineup?.star_absence_penalty ?? 0) * 0.014;
    const aPen = (awayLineup?.star_absence_penalty ?? 0) * 0.014;
    score = clamp(score + aPen - hPen, -0.22, 0.22);
    const better = score > 0.02 ? homeAbbr : score < -0.02 ? awayAbbr : null;
    const vsHand =
      better === homeAbbr
        ? awayPitcherHand === "L"
          ? "LHP"
          : awayPitcherHand === "R"
            ? "RHP"
            : "starter"
        : homePitcherHand === "L"
          ? "LHP"
          : homePitcherHand === "R"
            ? "RHP"
            : "starter";
    const edge = better
      ? `${better} lineup stronger vs ${vsHand} (layered OPS: ${homeAbbr} ${homeOpsBlend.toFixed(3)} vs ${awayAbbr} ${awayOpsBlend.toFixed(3)}).`
      : `Batting vs handedness is close (${homeAbbr} OPS blend ${homeOpsBlend.toFixed(3)} vs ${awayAbbr} ${awayOpsBlend.toFixed(3)}).`;
    return { score, edge };
  }
  return scoreBattingHeuristic(awayPitcherHand, homePitcherHand);
}

function normBullpenQuality(r: BullpenFatigueRow | null): number {
  const x = r?.season_bullpen_quality_score;
  return x != null ? clamp(x / 10, 0, 1) : 0.5;
}

function normBullpenFatigue(r: BullpenFatigueRow | null): number {
  const x = r?.fatigue_score;
  return x != null ? clamp(x / 10, 0, 1) : 0.5;
}

/**
 * Bullpen: B2B/CONSEC tags plus optional 50% season pen quality / 50% fatigue rows from Supabase.
 */
function scoreBullpen(
  homeB2B: boolean,
  awayB2B: boolean,
  homeConsec: boolean,
  awayConsec: boolean,
  homeFat: BullpenFatigueRow | null,
  awayFat: BullpenFatigueRow | null,
  homeAbbr: string,
  awayAbbr: string
): { score: number; edge: string } {
  const homeScore = homeConsec ? -0.45 : homeB2B ? -0.30 : 0;
  const awayScore = awayConsec ? 0.45 : awayB2B ? 0.30 : 0;
  let score = clamp(homeScore + awayScore, -0.45, 0.45);

  const hasRows = !!(homeFat || awayFat);
  if (hasRows) {
    const hComp = 0.5 * normBullpenQuality(homeFat) + 0.5 * (1 - normBullpenFatigue(homeFat));
    const aComp = 0.5 * normBullpenQuality(awayFat) + 0.5 * (1 - normBullpenFatigue(awayFat));
    const layered = clamp((hComp - aComp) * 0.42, -0.22, 0.22);
    score = clamp(score * 0.5 + layered, -0.45, 0.45);
  }

  const emergH = bullpenEmergencyNote(homeFat, homeAbbr);
  const emergA = bullpenEmergencyNote(awayFat, awayAbbr);

  if (!homeB2B && !awayB2B && !hasRows) {
    return { score: 0, edge: "Both bullpens at full rest — no fatigue differential." };
  }
  if (homeB2B && awayB2B) {
    const net = homeScore + awayScore;
    if (Math.abs(net) < 0.05 && !hasRows) {
      return { score, edge: "Both teams on back-to-back — bullpen fatigue roughly cancels out." };
    }
  }
  const homeSuffix = homeConsec ? " (3rd game in 3 days — severely taxed)" : "";
  const awaySuffix = awayConsec ? " (3rd game in 3 days — road bullpen depleted)" : "";
  let edge: string;
  if (homeB2B && !awayB2B) edge = `Home bullpen on B2B${homeSuffix} — thin relief depth tonight.`;
  else if (awayB2B && !homeB2B) edge = `Away bullpen on B2B${awaySuffix} — home carries meaningful relief advantage.`;
  else if (homeB2B && awayB2B) edge = `Bullpen fatigue: home${homeSuffix}, away${awaySuffix}.`;
  else edge = "Bullpen context neutral on schedule tags.";

  if (emergH) edge = `${emergH} ${edge}`;
  if (emergA) edge = `${emergA} ${edge}`;
  if (hasRows && !homeB2B && !awayB2B) {
    edge = `${edge} (season pen + recent usage from database.)`;
  }
  return { score, edge };
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
  hasOdds: boolean,
  opts: {
    lineupConfirmed: boolean;
    volatileWeather: boolean;
    awaitingFullPregameLock: boolean;
  }
): ConfidenceLevel {
  if (pitcherCertainty === "unknown") return "low";
  if (pitcherCertainty === "partial") return probGap >= 8 ? "medium" : "low";

  const canBeHigh = hasStats || hasOdds;
  let tier: ConfidenceLevel = "low";
  if (probGap >= 14 && canBeHigh && !extremePark) tier = "high";
  else if (probGap >= 8) tier = "medium";

  if (opts.awaitingFullPregameLock && tier === "high") tier = "medium";
  if (!opts.lineupConfirmed && tier === "high") tier = "medium";
  if (opts.volatileWeather && tier === "high") tier = "medium";
  if (extremePark && tier === "high") tier = "medium";

  return tier;
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
  hasOdds: boolean,
  pitcherCertaintyRecorded: string | null,
  modelInputsSnapshot: Record<string, unknown> | null,
  edgeNotes: string | null
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
        model_version: MLB_MODEL_SCHEMA_VERSION,
        prediction_version: MLB_PREDICTION_VERSION,
        home_pitcher_id: game._meta.homePitcherAthleteId ?? null,
        away_pitcher_id: game._meta.awayPitcherAthleteId ?? null,
        home_pitcher_era: homeStats?.era ?? null,
        away_pitcher_era: awayStats?.era ?? null,
        home_pitcher_whip: homeStats?.whip ?? null,
        away_pitcher_whip: awayStats?.whip ?? null,
        pitcher_certainty: pitcherCertaintyRecorded ?? game.mlb?.pitcherCertainty ?? null,
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
        model_inputs_snapshot: modelInputsSnapshot,
        edge_notes: edgeNotes,
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

async function ensureMlbPitcherEspnIds(ctx: MlbGameContext): Promise<MlbGameContext> {
  const mlb = ctx.game.mlb;
  let home = ctx.homeAthleteId;
  let away = ctx.awayAthleteId;
  if (!home && mlb?.homeProbablePitcher) {
    home = await resolveEspnMlbAthleteIdByDisplayName(mlb.homeProbablePitcher);
  }
  if (!away && mlb?.awayProbablePitcher) {
    away = await resolveEspnMlbAthleteIdByDisplayName(mlb.awayProbablePitcher);
  }
  return { ...ctx, homeAthleteId: home, awayAthleteId: away };
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

  const seasonYear = Number(game._meta.easternYmd.slice(0, 4)) || new Date().getFullYear();
  const eid = game._meta.eventId;

  // ── Fetch pitcher stats, historical rows, fatigue, lineups in parallel ───────
  const [
    { home: homeStats, away: awayStats },
    homeRestDays,
    awayRestDays,
    homeForm,
    awayForm,
    homeLogs,
    awayLogs,
    homeSplit,
    awaySplit,
    homeFat,
    awayFat,
    homeLu,
    awayLu,
  ] = await Promise.all([
    fetchMatchupPitcherStats(ctx.homeAthleteId, ctx.awayAthleteId),
    ctx.homeAthleteId ? fetchPitcherRestDays(ctx.homeAthleteId) : Promise.resolve(null),
    ctx.awayAthleteId ? fetchPitcherRestDays(ctx.awayAthleteId) : Promise.resolve(null),
    fetchPitcherRecentFormRow(ctx.homeAthleteId),
    fetchPitcherRecentFormRow(ctx.awayAthleteId),
    fetchPitcherLogBaselines(ctx.homeAthleteId),
    fetchPitcherLogBaselines(ctx.awayAthleteId),
    fetchTeamBattingSplit(game.homeTeam.abbreviation, seasonYear, mlbIntel.awayPitcherHand),
    fetchTeamBattingSplit(game.awayTeam.abbreviation, seasonYear, mlbIntel.homePitcherHand),
    fetchBullpenFatigueRow(game.homeTeam.abbreviation, game._meta.easternYmd),
    fetchBullpenFatigueRow(game.awayTeam.abbreviation, game._meta.easternYmd),
    eid ? fetchLineupStrengthRow(eid, game.homeTeam.abbreviation) : Promise.resolve(null),
    eid ? fetchLineupStrengthRow(eid, game.awayTeam.abbreviation) : Promise.resolve(null),
  ]);

  const homeBlend = blendPitcherEra(
    homeStats?.era ?? null,
    homeForm?.last_5_starts_era ?? null,
    homeLogs?.era9 ?? null
  );
  const awayBlend = blendPitcherEra(
    awayStats?.era ?? null,
    awayForm?.last_5_starts_era ?? null,
    awayLogs?.era9 ?? null
  );
  const homeEraEff = homeBlend.value;
  const awayEraEff = awayBlend.value;
  const blendLabel =
    homeBlend.usedRecent || awayBlend.usedRecent || homeBlend.usedLogs || awayBlend.usedLogs
      ? "50% season / 30% L5 / 20% hist prior"
      : "";

  const homeOpsB = blendTeamOps(homeSplit, mlbIntel.awayPitcherHand);
  const awayOpsB = blendTeamOps(awaySplit, mlbIntel.homePitcherHand);
  const usedDbSplits = homeOpsB.usedDb && awayOpsB.usedDb;

  // ── Contextual flags ─────────────────────────────────────────────────────────
  const userStartersConfirm =
    game._meta?.userConfirmedMlbStarters === true &&
    !!mlbIntel.homeProbablePitcher &&
    !!mlbIntel.awayProbablePitcher;
  let baseTags = [...game.situationalTags];
  if (userStartersConfirm) {
    baseTags = baseTags.filter((t) => t !== "PENDING CONFIRM");
  }
  const tags = baseTags;
  const homeB2B = tags.includes("HOME B2B");
  const awayB2B = tags.includes("AWAY B2B");
  const homeConsec = tags.includes("HOME CONSEC");
  const awayConsec = tags.includes("AWAY CONSEC");
  const pitcherCertaintyRaw = mlbIntel.pitcherCertainty;
  const pitcherCertaintyEff: PitcherCertainty = userStartersConfirm
    ? "confirmed"
    : pitcherCertaintyRaw;
  const isPending = pitcherCertaintyEff === "unknown";
  const isPartial = pitcherCertaintyEff === "partial";
  const lineupConfirmed = mlbIntel.lineupConfirmed === true;
  const pitchersConfirmed = pitcherCertaintyEff === "confirmed" || userStartersConfirm;
  const awaitingFullPregameLock = !pitchersConfirmed || !lineupConfirmed;
  const pendingConfirmation = awaitingFullPregameLock;

  const wx = game._meta?.mlbWeather;
  const volatileWeather =
    (wx?.windMph != null && wx.windMph >= 15) || (wx?.tempF != null && wx.tempF < 40);

  const hasOdds = !!(game.lines?.homeMl && game.lines?.awayMl);
  const parkEntry = MLB_PARK_FACTORS[game.homeTeam.abbreviation.toUpperCase()];
  const parkFactor = parkEntry?.factor ?? 1.0;
  const extremePark = parkFactor >= 1.08 || parkFactor <= 0.92;

  // ── Factor scores ─────────────────────────────────────────────────────────────
  const pitcher = scorePitcher(
    homeStats,
    awayStats,
    homeEraEff,
    awayEraEff,
    mlbIntel.homeProbablePitcher,
    mlbIntel.awayProbablePitcher,
    homeRestDays,
    awayRestDays,
    homeForm,
    awayForm,
    blendLabel
  );
  const batting = scoreBatting(
    mlbIntel.awayPitcherHand,
    mlbIntel.homePitcherHand,
    homeOpsB.ops,
    awayOpsB.ops,
    usedDbSplits,
    game.homeTeam.abbreviation,
    game.awayTeam.abbreviation,
    homeLu,
    awayLu
  );
  const bullpen = scoreBullpen(
    homeB2B,
    awayB2B,
    homeConsec,
    awayConsec,
    homeFat,
    awayFat,
    game.homeTeam.abbreviation,
    game.awayTeam.abbreviation
  );
  const form = scoreForm(game.homeTeam, game.awayTeam);
  const rest = scoreRest(homeB2B, awayB2B);

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
  const confidence = deriveConfidence(probGap, pitcher.hasStats, pitcherCertaintyEff, extremePark, hasOdds, {
    lineupConfirmed,
    volatileWeather,
    awaitingFullPregameLock,
  });

  // ── Risk flag ─────────────────────────────────────────────────────────────────
  let riskFlag: string | null = null;
  if (isPending) {
    riskFlag = "Probable pitchers not confirmed — prediction will update once announced.";
  } else if (isPartial) {
    const known = mlbIntel.homeProbablePitcher ?? mlbIntel.awayProbablePitcher ?? "one starter";
    riskFlag = `Only ${known} confirmed — opponent's starter unknown. Confidence capped until both are set.`;
  } else if (!lineupConfirmed) {
    riskFlag = "Lineup not fully confirmed — marked Pending Confirmation; model will tighten when lineups post.";
  } else if (homeLu?.star_absence_penalty != null && homeLu.star_absence_penalty >= 4) {
    riskFlag = `${game.homeTeam.abbreviation} lineup missing a major bat — star absence penalty applied.`;
  } else if (awayLu?.star_absence_penalty != null && awayLu.star_absence_penalty >= 4) {
    riskFlag = `${game.awayTeam.abbreviation} lineup missing a major bat — star absence penalty applied.`;
  } else if (volatileWeather) {
    riskFlag = "Strong wind or cold at this outdoor park — higher variance; confidence capped.";
  } else if (extremePark && parkFactor >= 1.08) {
    riskFlag = `Hitter-friendly park (${game.homeTeam.abbreviation}) increases run-environment variance.`;
  } else if (extremePark && parkFactor <= 0.92) {
    riskFlag = `Pitcher-friendly park (${game.homeTeam.abbreviation}) compresses scoring.`;
  }

  const computedAt = new Date().toISOString();

  // ── Model output ─────────────────────────────────────────────────────────────
  const modelOutput: MlbModelOutput = {
    pitcherEdge: pitcher.edge,
    battingEdge: batting.edge,
    bullpenEdge: bullpen.edge,
    formEdge: form.edge,
    parkNote: parkEntry?.note ?? `${game.homeTeam.abbreviation} — neutral park environment.`,
    riskFlag,
    pendingConfirmation,
    lastUpdated: computedAt,
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
      layerDebug: {
        historicalBaselineEra: { home: homeLogs?.era9 ?? null, away: awayLogs?.era9 ?? null },
        seasonEra: { home: homeStats?.era ?? null, away: awayStats?.era ?? null },
        recentEraL5: { home: homeForm?.last_5_starts_era ?? null, away: awayForm?.last_5_starts_era ?? null },
        blendedEra: { home: homeEraEff, away: awayEraEff },
        battingUsedDbSplits: usedDbSplits,
        bullpenUsedFatigueRows: !!(homeFat || awayFat),
        todayContext: {
          pitchersConfirmed,
          lineupConfirmed,
          parkFactor,
          weatherVolatile: volatileWeather,
        },
      },
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
  if (pendingConfirmation && !updatedTags.includes("PENDING CONFIRM")) {
    updatedTags.push("PENDING CONFIRM");
  }

  const edgeNotes = [
    blendLabel && `pitcher_blend:${blendLabel}`,
    usedDbSplits && "batting:db_splits",
    (homeFat || awayFat) && "bullpen:fatigue_rows",
    awaitingFullPregameLock && "status:pending_confirmation",
    volatileWeather && "context:volatile_weather",
  ]
    .filter(Boolean)
    .join(" | ");

  const oddsF5LegNote =
    game.enrichmentNotes?.find((n) => n.includes("F5") || n.includes("1st 5 inn")) ?? null;

  const modelInputsSnapshot: Record<string, unknown> = {
    prediction_version: MLB_PREDICTION_VERSION,
    schema_version: MLB_MODEL_SCHEMA_VERSION,
    computed_at: computedAt,
    odds_f5_leg_note: oddsF5LegNote,
    market_leg_context: oddsF5LegNote
      ? { source: "the_odds_api_enrichment", note: oddsF5LegNote }
      : null,
    pitchers_confirmed: pitchersConfirmed,
    lineup_confirmed: lineupConfirmed,
    pending_confirmation: pendingConfirmation,
    historical_baseline_era: { home: homeLogs?.era9 ?? null, away: awayLogs?.era9 ?? null },
    season_era: { home: homeStats?.era ?? null, away: awayStats?.era ?? null },
    recent_l5_era: { home: homeForm?.last_5_starts_era ?? null, away: awayForm?.last_5_starts_era ?? null },
    blended_era: { home: homeEraEff, away: awayEraEff },
    batting_ops_blend: { home: homeOpsB.ops, away: awayOpsB.ops, used_db: usedDbSplits },
    bullpen_fatigue_ids: {
      home: `${game.homeTeam.abbreviation}-${game._meta.easternYmd}`,
      away: `${game.awayTeam.abbreviation}-${game._meta.easternYmd}`,
    },
    factor_scores: {
      pitcher: pitcher.score,
      batting: batting.score,
      bullpen: bullpen.score,
      form: form.score,
      rest: rest.score,
    },
    park_factor: parkFactor,
    weather: wx ?? null,
  };

  // ── Persist snapshot (fire-and-forget) ───────────────────────────────────────
  persistSnapshot(
    game,
    homeStats,
    awayStats,
    { pitcher: pitcher.score, batting: batting.score, bullpen: bullpen.score, form: form.score, rest: rest.score },
    combinedDelta,
    adjustedProb,
    confidence,
    pendingConfirmation,
    riskFlag,
    parkFactor,
    hasOdds,
    pitcherCertaintyEff,
    modelInputsSnapshot,
    edgeNotes || null
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
    const resolved = await Promise.all(batch.map((ctx) => ensureMlbPitcherEspnIds(ctx)));
    const done = await Promise.all(resolved.map((ctx) => modelOneGame(ctx, weights)));
    results.push(...done);
  }
  return applyPredictionQualityPipeline(await applyAdvancedIntelligenceToGames(results));
}
