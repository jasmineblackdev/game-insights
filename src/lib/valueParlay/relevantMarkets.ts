/**
 * Catalog from Parlay-Intelligence-Bot `betting_options.RELEVANT_BETS` (API-Sports bet names).
 * Use for UX copy, future market filters, and mapping hints to The Odds API keys where noted.
 */
export type RelevantBetCategory =
  | "primary"
  | "player_props"
  | "defense_props"
  | "kicking_props"
  | "team_props"
  | "quarters"
  | "innings"
  | "pitcher_props";

export const RELEVANT_BETS_BY_LEAGUE: Record<
  "NFL" | "NCAAF" | "NBA" | "MLB",
  Partial<Record<RelevantBetCategory, readonly string[]>>
> = {
  NFL: {
    primary: [
      "Home/Away",
      "Asian Handicap",
      "Over/Under",
      "Total - Home",
      "Total - Away",
      "Total Touchdowns",
      "First Team to Score",
      "Race to 20 Points",
      "Half Time/Full Time",
      "First Half Winner",
    ],
    player_props: [
      "Player Passing Yards",
      "Player Rushing Yards",
      "Player Receiving Yards",
      "Player Completions",
      "Player Pass Attempts",
      "Player Pass Touchdowns",
      "Player Receptions",
      "Player Targets",
      "Player Rush Attempts",
      "Player Total Touchdowns",
      "Player Interceptions Thrown",
      "Player Longest Pass",
      "Player Longest Rush",
      "Player Longest Reception",
    ],
    defense_props: ["Team Total Sacks", "Team Interceptions", "Team Defensive Touchdowns"],
    kicking_props: ["Player Field Goals Made", "Player Extra Points Made", "Longest Field Goal"],
  },
  NCAAF: {
    primary: [
      "Home/Away",
      "Asian Handicap",
      "Over/Under",
      "Total - Home",
      "Total - Away",
      "Total Touchdowns",
      "First Team to Score",
      "Half Time/Full Time",
    ],
    player_props: [
      "Player Passing Yards",
      "Player Rushing Yards",
      "Player Receiving Yards",
      "Player Total Touchdowns",
      "Player Pass Touchdowns",
      "Player Rush Touchdowns",
    ],
    team_props: ["Team Total Points", "Team First Downs", "Team Total Yards"],
  },
  NBA: {
    primary: [
      "Home/Away",
      "Asian Handicap",
      "Over/Under",
      "Total - Home",
      "Total - Away",
      "First Quarter Winner",
      "First Half Winner",
      "Race to 20 Points",
      "Will There Be Overtime",
      "Winning Margin",
    ],
    player_props: [
      "Player Points",
      "Player Rebounds",
      "Player Assists",
      "Player Threes Made",
      "Player Blocks",
      "Player Steals",
      "Player Double Double",
      "Player Triple Double",
      "Player Points + Rebounds + Assists",
      "Player Points + Rebounds",
      "Player Points + Assists",
      "Player Rebounds + Assists",
    ],
    quarters: [
      "Quarter - Winner",
      "Quarter - Total Points",
      "Quarter - Race to",
      "Quarter - Team Total Points",
    ],
    team_props: [
      "Team Total Points",
      "Team First To Score",
      "Team Field Goal Percentage",
      "Team Three Point Percentage",
    ],
  },
  MLB: {
    primary: [
      "Home/Away",
      "Asian Handicap",
      "Over/Under",
      "Total - Home",
      "Total - Away",
      "First Five Innings Winner",
      "First Inning Winner",
      "Will There Be Extra Innings",
    ],
    player_props: [
      "Player Total Bases",
      "Player Hits",
      "Player Runs",
      "Player RBIs",
      "Player Home Runs",
      "Player Strikeouts",
      "Player Walks",
      "Player Stolen Bases",
    ],
    pitcher_props: [
      "Pitcher Strikeouts",
      "Pitcher Hits Allowed",
      "Pitcher Walks",
      "Pitcher Earned Runs",
      "Pitcher Outs Recorded",
    ],
    innings: [
      "Inning - Winner",
      "Inning - Total Runs",
      "Inning - Team Total Runs",
      "First Five Innings - Total",
    ],
  },
};

/** Rough map: API-Sports style label → common The Odds API `markets` keys (subset). */
export const ODDS_API_MARKET_HINTS: Record<string, string> = {
  "Home/Away": "h2h",
  "Asian Handicap": "spreads",
  "Over/Under": "totals",
};

export function flattenRelevantBets(league: keyof typeof RELEVANT_BETS_BY_LEAGUE): string[] {
  const bag = RELEVANT_BETS_BY_LEAGUE[league];
  const out: string[] = [];
  for (const arr of Object.values(bag)) {
    if (arr) out.push(...arr);
  }
  return [...new Set(out)];
}
