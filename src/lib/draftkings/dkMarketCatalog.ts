/**
 * DraftKings market catalog.
 *
 * Maps the app's internal `stat_type` strings (used in PlayerEdgePrediction)
 * onto the DraftKings market keys exposed by The Odds API and the user-facing
 * DraftKings bet-type labels shown on draftkings.com.
 *
 * Source for market keys / availability:
 *   https://the-odds-api.com/sports-odds-data/betting-markets.html
 *   (DraftKings is the `bookmaker` reference. Keys marked "unsupported" are
 *   either not offered by DK or only offered intermittently for select games.)
 *
 * Usage: call `getDkMapping(sport, stat_type)` to look up the DK label,
 * The-Odds-API market key, and an `available` flag. UI should HIDE picks
 * with `available === false` (spec: "If a bet type is missing from
 * DraftKings, mark it as unavailable instead of guessing.").
 */

import type { PlayerPropInput } from "@/lib/edgeCardScoring";

export type DkSport = PlayerPropInput["sport"];

export interface DkMarketMapping {
  /** Internal stat_type string used inside PlayerEdgePrediction. */
  internalKey: string;
  /** Internal normalised market key used for filtering / analytics. */
  marketKey: string;
  /** The Odds API `markets` parameter value for DraftKings. */
  oddsApiKey: string;
  /** Customer-facing DK label (matches what shows on draftkings.com). */
  dkLabel: string;
  /** Short label for tight UI (chips, list rows). */
  shortLabel: string;
  /** False when DK does not offer this market — UI must mark as unavailable. */
  available: boolean;
  /** Priority order within the sport (1 = top). Drives "best DK-compatible bet" tie-breaks. */
  priority: number;
}

type SportMap = Record<string, DkMarketMapping>;

/** NBA — single-player props prioritised per spec. */
const NBA_MAP: SportMap = {
  points:        { internalKey: "points",        marketKey: "player_points",          oddsApiKey: "player_points",            dkLabel: "Points",                       shortLabel: "Pts",     available: true, priority: 1 },
  rebounds:      { internalKey: "rebounds",      marketKey: "player_rebounds",        oddsApiKey: "player_rebounds",          dkLabel: "Rebounds",                     shortLabel: "Reb",     available: true, priority: 2 },
  assists:       { internalKey: "assists",       marketKey: "player_assists",         oddsApiKey: "player_assists",           dkLabel: "Assists",                      shortLabel: "Ast",     available: true, priority: 3 },
  pra:           { internalKey: "pra",           marketKey: "player_pra",             oddsApiKey: "player_points_rebounds_assists", dkLabel: "Pts + Reb + Ast",         shortLabel: "PRA",     available: true, priority: 4 },
  pts_ast:       { internalKey: "pts_ast",       marketKey: "player_pts_ast",         oddsApiKey: "player_points_assists",    dkLabel: "Pts + Ast",                    shortLabel: "P+A",     available: true, priority: 5 },
  reb_ast:       { internalKey: "reb_ast",       marketKey: "player_reb_ast",         oddsApiKey: "player_rebounds_assists",  dkLabel: "Reb + Ast",                    shortLabel: "R+A",     available: true, priority: 6 },
  pts_reb:       { internalKey: "pts_reb",       marketKey: "player_pts_reb",         oddsApiKey: "player_points_rebounds",   dkLabel: "Pts + Reb",                    shortLabel: "P+R",     available: true, priority: 7 },
  threes:        { internalKey: "threes",        marketKey: "player_threes",          oddsApiKey: "player_threes",            dkLabel: "3-Pointers Made",              shortLabel: "3PM",     available: true, priority: 8 },
  // DK lists Blocks and Steals separately, NOT a combined market — keep both available individually.
  blocks:        { internalKey: "blocks",        marketKey: "player_blocks",          oddsApiKey: "player_blocks",            dkLabel: "Blocks",                       shortLabel: "Blk",     available: true, priority: 9 },
  steals:        { internalKey: "steals",        marketKey: "player_steals",          oddsApiKey: "player_steals",            dkLabel: "Steals",                       shortLabel: "Stl",     available: true, priority: 10 },
};

/** WNBA mirrors NBA market keys at DK. */
const WNBA_MAP: SportMap = NBA_MAP;

/** NFL — single-player props prioritised per spec. */
const NFL_MAP: SportMap = {
  passing_yards:    { internalKey: "passing_yards",    marketKey: "player_passing_yards",    oddsApiKey: "player_pass_yds",        dkLabel: "Passing Yards",          shortLabel: "Pass Yds", available: true, priority: 1 },
  passing_tds:      { internalKey: "passing_tds",      marketKey: "player_passing_tds",      oddsApiKey: "player_pass_tds",        dkLabel: "Passing Touchdowns",     shortLabel: "Pass TD",  available: true, priority: 2 },
  rushing_yards:    { internalKey: "rushing_yards",    marketKey: "player_rushing_yards",    oddsApiKey: "player_rush_yds",        dkLabel: "Rushing Yards",          shortLabel: "Rush Yds", available: true, priority: 3 },
  rush_attempts:    { internalKey: "rush_attempts",    marketKey: "player_rush_attempts",    oddsApiKey: "player_rush_attempts",   dkLabel: "Rush Attempts",          shortLabel: "Rush Att", available: true, priority: 4 },
  receiving_yards:  { internalKey: "receiving_yards",  marketKey: "player_receiving_yards",  oddsApiKey: "player_reception_yds",   dkLabel: "Receiving Yards",        shortLabel: "Rec Yds",  available: true, priority: 5 },
  receptions:       { internalKey: "receptions",       marketKey: "player_receptions",       oddsApiKey: "player_receptions",      dkLabel: "Receptions",             shortLabel: "Rec",      available: true, priority: 6 },
  longest_reception:{ internalKey: "longest_reception",marketKey: "player_longest_reception",oddsApiKey: "player_reception_longest", dkLabel: "Longest Reception",    shortLabel: "Long Rec", available: true, priority: 7 },
  anytime_td:       { internalKey: "anytime_td",       marketKey: "player_anytime_td",       oddsApiKey: "player_anytime_td",      dkLabel: "Anytime Touchdown",      shortLabel: "ATD",      available: true, priority: 8 },
};

/** MLB — single-player props prioritised per spec. */
const MLB_MAP: SportMap = {
  hits:             { internalKey: "hits",             marketKey: "player_hits",             oddsApiKey: "batter_hits",            dkLabel: "Hits",                   shortLabel: "Hits",     available: true, priority: 1 },
  total_bases:      { internalKey: "total_bases",      marketKey: "player_total_bases",      oddsApiKey: "batter_total_bases",     dkLabel: "Total Bases",            shortLabel: "TB",       available: true, priority: 2 },
  runs:             { internalKey: "runs",             marketKey: "player_runs",             oddsApiKey: "batter_runs_scored",     dkLabel: "Runs",                   shortLabel: "R",        available: true, priority: 3 },
  rbis:             { internalKey: "rbis",             marketKey: "player_rbis",             oddsApiKey: "batter_rbis",            dkLabel: "RBIs",                   shortLabel: "RBI",      available: true, priority: 4 },
  home_runs:        { internalKey: "home_runs",        marketKey: "player_home_runs",        oddsApiKey: "batter_home_runs",       dkLabel: "Home Runs",              shortLabel: "HR",       available: true, priority: 5 },
  stolen_bases:     { internalKey: "stolen_bases",     marketKey: "player_stolen_bases",     oddsApiKey: "batter_stolen_bases",    dkLabel: "Stolen Bases",           shortLabel: "SB",       available: true, priority: 6 },
  strikeouts:       { internalKey: "strikeouts",       marketKey: "pitcher_strikeouts",      oddsApiKey: "pitcher_strikeouts",     dkLabel: "Pitcher Strikeouts",     shortLabel: "K",        available: true, priority: 7 },
  pitcher_outs:     { internalKey: "pitcher_outs",     marketKey: "pitcher_outs",            oddsApiKey: "pitcher_outs",           dkLabel: "Pitcher Outs Recorded",  shortLabel: "Outs",     available: true, priority: 8 },
  walks_allowed:    { internalKey: "walks_allowed",    marketKey: "pitcher_walks",           oddsApiKey: "pitcher_walks",          dkLabel: "Walks Allowed",          shortLabel: "BB",       available: true, priority: 9 },
  // ── Internal combos / extras DK does NOT offer as standalone props ──
  walks:            { internalKey: "walks",            marketKey: "player_walks",            oddsApiKey: "",                       dkLabel: "Batter Walks",           shortLabel: "BB",       available: false, priority: 99 },
  singles:          { internalKey: "singles",          marketKey: "player_singles",          oddsApiKey: "",                       dkLabel: "Singles",                shortLabel: "1B",       available: false, priority: 99 },
  doubles:          { internalKey: "doubles",          marketKey: "player_doubles",          oddsApiKey: "",                       dkLabel: "Doubles",                shortLabel: "2B",       available: false, priority: 99 },
  triples:          { internalKey: "triples",          marketKey: "player_triples",          oddsApiKey: "",                       dkLabel: "Triples",                shortLabel: "3B",       available: false, priority: 99 },
  extra_base_hits:  { internalKey: "extra_base_hits",  marketKey: "player_extra_base_hits",  oddsApiKey: "",                       dkLabel: "Extra Base Hits",        shortLabel: "XBH",      available: false, priority: 99 },
  hits_runs_rbis:   { internalKey: "hits_runs_rbis",   marketKey: "player_hits_runs_rbis",   oddsApiKey: "batter_hits_runs_rbis",  dkLabel: "Hits + Runs + RBIs",     shortLabel: "H+R+RBI",  available: true, priority: 10 },
  hits_runs:        { internalKey: "hits_runs",        marketKey: "player_hits_runs",        oddsApiKey: "",                       dkLabel: "Hits + Runs",            shortLabel: "H+R",      available: false, priority: 99 },
  runs_rbis:        { internalKey: "runs_rbis",        marketKey: "player_runs_rbis",        oddsApiKey: "",                       dkLabel: "Runs + RBIs",            shortLabel: "R+RBI",    available: false, priority: 99 },
  hits_stolen_bases:{ internalKey: "hits_stolen_bases",marketKey: "player_hits_sb",          oddsApiKey: "",                       dkLabel: "Hits + Stolen Bases",    shortLabel: "H+SB",     available: false, priority: 99 },
  hits_walks_stolen_bases: { internalKey: "hits_walks_stolen_bases", marketKey: "player_hits_walks_sb", oddsApiKey: "",            dkLabel: "Hits + Walks + SB",      shortLabel: "H+BB+SB",  available: false, priority: 99 },
};

/** NHL — DK markets per spec. App doesn't yet ingest NHL but catalog ready. */
const NHL_MAP: SportMap = {
  shots_on_goal:    { internalKey: "shots_on_goal",    marketKey: "player_shots_on_goal",    oddsApiKey: "player_shots_on_goal",   dkLabel: "Shots on Goal",          shortLabel: "SOG",      available: true, priority: 1 },
  points:           { internalKey: "points",           marketKey: "player_points",           oddsApiKey: "player_points",          dkLabel: "Points",                 shortLabel: "Pts",      available: true, priority: 2 },
  assists:          { internalKey: "assists",          marketKey: "player_assists",          oddsApiKey: "player_assists",         dkLabel: "Assists",                shortLabel: "Ast",      available: true, priority: 3 },
  goals:            { internalKey: "goals",            marketKey: "player_goals",            oddsApiKey: "player_goal_scorer_anytime", dkLabel: "Goals",              shortLabel: "G",        available: true, priority: 4 },
  saves:            { internalKey: "saves",            marketKey: "player_saves",            oddsApiKey: "player_total_saves",     dkLabel: "Saves",                  shortLabel: "Sv",       available: true, priority: 5 },
  power_play_points:{ internalKey: "power_play_points",marketKey: "player_power_play_points",oddsApiKey: "player_power_play_points", dkLabel: "Power Play Points",    shortLabel: "PPP",      available: true, priority: 6 },
};

/** Combat sports (MMA + Boxing) — DK fight markets per spec. */
const COMBAT_MAP: SportMap = {
  fight_winner:     { internalKey: "fight_winner",     marketKey: "fight_winner",            oddsApiKey: "h2h",                    dkLabel: "Fight Winner",           shortLabel: "ML",       available: true, priority: 1 },
  ko_tko:           { internalKey: "ko_tko",           marketKey: "method_ko_tko",           oddsApiKey: "method_of_victory",      dkLabel: "Method: KO/TKO",         shortLabel: "KO/TKO",   available: true, priority: 2 },
  submission:       { internalKey: "submission",       marketKey: "method_submission",       oddsApiKey: "method_of_victory",      dkLabel: "Method: Submission",     shortLabel: "Sub",      available: true, priority: 2 },
  decision:         { internalKey: "decision",         marketKey: "method_decision",         oddsApiKey: "method_of_victory",      dkLabel: "Method: Decision",       shortLabel: "Dec",      available: true, priority: 2 },
  draw:             { internalKey: "draw",             marketKey: "method_draw",             oddsApiKey: "method_of_victory",      dkLabel: "Method: Draw",           shortLabel: "Draw",     available: true, priority: 2 },
  goes_distance:    { internalKey: "goes_distance",    marketKey: "fight_goes_distance",     oddsApiKey: "fight_goes_distance",    dkLabel: "Fight Goes Distance",    shortLabel: "Distance", available: true, priority: 3 },
  total_rounds:     { internalKey: "total_rounds",     marketKey: "fight_total_rounds",      oddsApiKey: "totals",                 dkLabel: "Total Rounds",           shortLabel: "O/U Rds",  available: true, priority: 4 },
  significant_strikes: { internalKey: "significant_strikes", marketKey: "fighter_sig_strikes", oddsApiKey: "fighter_significant_strikes", dkLabel: "Significant Strikes", shortLabel: "Sig Str", available: true, priority: 5 },
  takedowns:        { internalKey: "takedowns",        marketKey: "fighter_takedowns",       oddsApiKey: "fighter_takedowns",      dkLabel: "Takedowns",              shortLabel: "TD",       available: true, priority: 6 },
};

const CATALOG: Record<DkSport, SportMap> = {
  NBA:    NBA_MAP,
  WNBA:   WNBA_MAP,
  NFL:    NFL_MAP,
  MLB:    MLB_MAP,
  Boxing: COMBAT_MAP,
  MMA:    COMBAT_MAP,
};

/**
 * Look up the DK mapping for a sport + internal stat_type.
 * Returns `null` when the stat is not in the catalog at all (treat as unknown).
 * Returns a mapping with `available: false` when DK simply doesn't offer it.
 */
export function getDkMapping(sport: DkSport, statType: string): DkMarketMapping | null {
  const sportMap = CATALOG[sport];
  if (!sportMap) return null;
  return sportMap[statType] ?? null;
}

/** True when the prop has a DK-supported market we can actually direct users to. */
export function isDraftKingsAvailable(sport: DkSport, statType: string): boolean {
  const m = getDkMapping(sport, statType);
  return !!m && m.available;
}

/** Customer-facing DK bet-type label, or a graceful fallback. */
export function dkLabelFor(sport: DkSport, statType: string): string {
  const m = getDkMapping(sport, statType);
  if (m) return m.dkLabel;
  return statType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Short DK label suited to chips / table cells. */
export function dkShortLabelFor(sport: DkSport, statType: string): string {
  const m = getDkMapping(sport, statType);
  if (m) return m.shortLabel;
  return statType.replace(/_/g, " ");
}

/** Priority for the per-sport ordering (lower = higher priority). */
export function dkPriorityFor(sport: DkSport, statType: string): number {
  return getDkMapping(sport, statType)?.priority ?? 999;
}

/** All DK-supported (`available: true`) mappings for a sport, ordered by priority. */
export function listAvailableDkMarkets(sport: DkSport): DkMarketMapping[] {
  const sportMap = CATALOG[sport];
  if (!sportMap) return [];
  return Object.values(sportMap)
    .filter((m) => m.available)
    .sort((a, b) => a.priority - b.priority);
}
