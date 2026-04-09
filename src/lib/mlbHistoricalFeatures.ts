/**
 * MLB historical / derived features from Supabase.
 * Used by mlbPredictionModel for layered weighting; all reads are optional fallbacks.
 */

import { supabase } from "@/lib/supabase";

export const MLB_LEAGUE_PRIOR_ERA = 4.25;
export const MLB_LEAGUE_PRIOR_OPS_VS_LHP = 0.718;
export const MLB_LEAGUE_PRIOR_OPS_VS_RHP = 0.738;
export const MLB_LEAGUE_PRIOR_OPS_OVERALL = 0.728;

const MIN_PA_FOR_LAST14 = 30;

export interface PitcherRecentFormRow {
  last_3_starts_era: number | null;
  last_5_starts_era: number | null;
  last_3_starts_fip: number | null;
  last_5_starts_fip: number | null;
  avg_pitch_count: number | null;
  avg_innings_pitched: number | null;
}

export interface TeamBattingSplitRow {
  batting_avg: number | null;
  obp: number | null;
  slg: number | null;
  ops: number | null;
  strikeout_rate: number | null;
  runs_per_game: number | null;
  sample_pa: number | null;
  last_14d_ops: number | null;
  last_14d_batting_avg: number | null;
  last_14d_strikeout_rate: number | null;
  last_14d_sample_pa: number | null;
}

export interface BullpenFatigueRow {
  bullpen_innings_last_3_days: number | null;
  bullpen_pitches_last_3_days: number | null;
  closer_available_score: number | null;
  fatigue_score: number | null;
  season_bullpen_quality_score: number | null;
}

export interface LineupStrengthRow {
  confirmed_lineup_flag: boolean;
  lineup_strength_vs_lhp: number | null;
  lineup_strength_vs_rhp: number | null;
  star_absence_penalty: number | null;
}

export async function fetchPitcherRecentFormRow(
  pitcherId: string | undefined
): Promise<PitcherRecentFormRow | null> {
  if (!supabase || !pitcherId) return null;
  try {
    const { data, error } = await supabase
      .from("mlb_pitcher_recent_form")
      .select(
        "last_3_starts_era,last_5_starts_era,last_3_starts_fip,last_5_starts_fip,avg_pitch_count,avg_innings_pitched"
      )
      .eq("pitcher_id", pitcherId)
      .maybeSingle();
    if (error || !data) return null;
    return data as PitcherRecentFormRow;
  } catch {
    return null;
  }
}

/** Rolling game-log ERA/FIP from stored pitcher logs (minGames required). */
export async function fetchPitcherLogBaselines(
  pitcherId: string | undefined,
  minGames = 6,
  maxRows = 48
): Promise<{ era9: number; avgFip: number | null } | null> {
  if (!supabase || !pitcherId) return null;
  try {
    const { data, error } = await supabase
      .from("mlb_pitcher_game_logs")
      .select("earned_runs,innings_pitched,fip")
      .eq("athlete_id", pitcherId)
      .order("game_date", { ascending: false })
      .limit(maxRows);
    if (error || !data?.length) return null;

    let n = 0;
    let eraSum = 0;
    const fips: number[] = [];
    for (const row of data) {
      const ip = Number(row.innings_pitched);
      const er = Number(row.earned_runs);
      if (ip > 0 && er >= 0) {
        eraSum += (er / ip) * 9;
        n += 1;
      }
      if (row.fip != null && Number.isFinite(Number(row.fip))) {
        fips.push(Number(row.fip));
      }
    }
    if (n < minGames) return null;
    const avgFip = fips.length >= minGames ? fips.reduce((a, b) => a + b, 0) / fips.length : null;
    return { era9: eraSum / n, avgFip };
  } catch {
    return null;
  }
}

function splitTypeForOppHand(h: "L" | "R" | undefined): "vs_lhp" | "vs_rhp" | "overall" {
  if (h === "L") return "vs_lhp";
  if (h === "R") return "vs_rhp";
  return "overall";
}

export async function fetchTeamBattingSplit(
  teamAbbr: string,
  season: number,
  opponentStarterHand: "L" | "R" | undefined
): Promise<TeamBattingSplitRow | null> {
  if (!supabase || !teamAbbr) return null;
  const tid = teamAbbr.toUpperCase();
  const primary = splitTypeForOppHand(opponentStarterHand);
  try {
    const tryFetch = async (split: string) => {
      const { data } = await supabase
        .from("mlb_team_batting_splits")
        .select(
          "batting_avg,obp,slg,ops,strikeout_rate,runs_per_game,sample_pa,last_14d_ops,last_14d_batting_avg,last_14d_strikeout_rate,last_14d_sample_pa"
        )
        .eq("team_id", tid)
        .eq("season", season)
        .eq("split_type", split)
        .maybeSingle();
      return data as TeamBattingSplitRow | null;
    };

    let row = await tryFetch(primary);
    if (!row && primary !== "overall") {
      row = await tryFetch("overall");
    }
    if (!row) return null;
    return row;
  } catch {
    return null;
  }
}

export async function fetchBullpenFatigueRow(
  teamAbbr: string,
  scoreDate: string
): Promise<BullpenFatigueRow | null> {
  if (!supabase || !teamAbbr || !scoreDate) return null;
  const id = `${teamAbbr.toUpperCase()}-${scoreDate}`;
  try {
    const { data, error } = await supabase
      .from("mlb_bullpen_fatigue_scores")
      .select(
        "bullpen_innings_last_3_days,bullpen_pitches_last_3_days,closer_available_score,fatigue_score,season_bullpen_quality_score"
      )
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    return data as BullpenFatigueRow;
  } catch {
    return null;
  }
}

export async function fetchLineupStrengthRow(
  espnEventId: string,
  teamAbbr: string
): Promise<LineupStrengthRow | null> {
  if (!supabase || !espnEventId || !teamAbbr) return null;
  const id = `${espnEventId}-${teamAbbr.toUpperCase()}`;
  try {
    const { data, error } = await supabase
      .from("mlb_lineup_strength_scores")
      .select("confirmed_lineup_flag,lineup_strength_vs_lhp,lineup_strength_vs_rhp,star_absence_penalty")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    return data as LineupStrengthRow;
  } catch {
    return null;
  }
}

/** 50% season / 30% L5 / 20% historical log prior (or league ERA prior). */
export function blendPitcherEra(
  seasonEra: number | null,
  last5Era: number | null,
  logBaselineEra: number | null
): { value: number; usedRecent: boolean; usedLogs: boolean } {
  const hist = logBaselineEra != null && logBaselineEra > 0 ? logBaselineEra : MLB_LEAGUE_PRIOR_ERA;
  const wS = 0.5,
    wR = 0.3,
    wH = 0.2;
  let num = 0,
    den = 0;
  if (seasonEra != null && seasonEra > 0 && seasonEra < 30) {
    num += wS * seasonEra;
    den += wS;
  }
  const usedRecent = last5Era != null && last5Era > 0 && last5Era < 30;
  if (usedRecent) {
    num += wR * last5Era;
    den += wR;
  }
  const usedLogs = logBaselineEra != null && logBaselineEra > 0;
  num += wH * hist;
  den += wH;
  return { value: den > 0 ? num / den : MLB_LEAGUE_PRIOR_ERA, usedRecent, usedLogs };
}

export function leaguePriorOpsForHand(h: "L" | "R" | undefined): number {
  if (h === "L") return MLB_LEAGUE_PRIOR_OPS_VS_LHP;
  if (h === "R") return MLB_LEAGUE_PRIOR_OPS_VS_RHP;
  return MLB_LEAGUE_PRIOR_OPS_OVERALL;
}

/** 50% season split / 25% last-14 (if sample) / 25% league prior. */
export function blendTeamOps(
  row: TeamBattingSplitRow | null,
  opponentHand: "L" | "R" | undefined
): { ops: number | null; usedDb: boolean; usedLast14: boolean } {
  if (!row || row.ops == null || (row.sample_pa ?? 0) < 20) {
    return { ops: null, usedDb: false, usedLast14: false };
  }
  const prior = leaguePriorOpsForHand(opponentHand);
  const s = Number(row.ops);
  const l14 =
    row.last_14d_ops != null &&
    (row.last_14d_sample_pa ?? 0) >= MIN_PA_FOR_LAST14
      ? Number(row.last_14d_ops)
      : null;
  const usedLast14 = l14 != null;
  const trend = l14 ?? s;
  const ops = 0.5 * s + 0.25 * trend + 0.25 * prior;
  return { ops, usedDb: true, usedLast14 };
}

export function bullpenEmergencyNote(row: BullpenFatigueRow | null, label: string): string | null {
  if (!row) return null;
  const inn = row.bullpen_innings_last_3_days;
  if (inn != null && inn >= 12) {
    return `${label} bullpen heavily used last 3 days (~${inn} IP) — emergency leverage risk.`;
  }
  return null;
}
