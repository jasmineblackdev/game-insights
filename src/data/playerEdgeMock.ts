import type { PlayerPropInput } from "@/lib/edgeCardScoring";

export type PlayerEdgeSportFilter = "all" | "NBA" | "NFL" | "MLB" | "Soccer";

export type PlayerEdgeStatFilter =
  | "all"
  | "points"
  | "rebounds"
  | "assists"
  | "passing_yards"
  | "rushing_yards"
  | "receiving_yards"
  | "strikeouts"
  | "hits"
  | "total_bases"
  | "shots"
  | "shots_on_target";

export type PlayerRiskTier = "safe" | "balanced" | "high_upside" | "longshot";

export type PlayerConsistencyLabel = "stable" | "medium" | "volatile";

export type PlayerEdgePrediction = PlayerPropInput & {
  /** Lower = earlier kick / tip for default sort tie-breaker */
  game_sort: number;
  /** 0–100 model confidence (optional; API / future engine). */
  confidence_score_0_100?: number;
  /** Transparency bullets — falls back to reason_1 / reason_2 in UI when absent. */
  explanations?: string[];
  risk_tier?: PlayerRiskTier;
  consistency_label?: PlayerConsistencyLabel;
  trend_note?: string;
};

const CONF_RANK = { HIGH: 0, MED: 1, LOW: 2 } as const;

export const PLAYER_EDGE_MOCK: PlayerEdgePrediction[] = [
  {
    id: "pred_001",
    player_name: "Jayson Tatum",
    sport: "NBA",
    game_id: "nba_mock_bos_mia",
    player_id: "player_tatum",
    team: "BOS",
    opponent: "MIA",
    game_time: "7:30 PM ET",
    stat_type: "points",
    line_value: 28.5,
    projected_value: 31.2,
    prediction_direction: "MORE",
    edge: 2.7,
    confidence: "HIGH",
    reason_1: "Usage increased over last 5 games",
    reason_2: "Opponent allows strong scoring output to primary wings",
    risk_factor: "Blowout risk may reduce late-game minutes",
    game_sort: 100,
    confidence_score_0_100: 78,
    explanations: [
      "Opponent allows top-10 points to primary wings this month",
      "Last 5 games: +3.1 pts vs season average",
      "Starter minutes up ~2 mpg vs prior 10",
      "Pace environment +2.4 poss vs league avg",
    ],
    risk_tier: "balanced",
    consistency_label: "medium",
    trend_note: "▲ 4-game increase in scoring volume",
  },
  {
    id: "pred_002",
    player_name: "Anthony Edwards",
    sport: "NBA",
    game_id: "nba_mock_min_okc",
    player_id: "player_edwards",
    team: "MIN",
    opponent: "OKC",
    game_time: "8:00 PM ET",
    stat_type: "points",
    line_value: 26.5,
    projected_value: 24.1,
    prediction_direction: "LESS",
    edge: -2.4,
    confidence: "MED",
    reason_1: "OKC defense ranks top-5 in wing containment",
    reason_2: "Minutes slightly down vs prior week",
    risk_factor: "Garbage-time scoring could flip closing stretch",
    game_sort: 110,
    confidence_score_0_100: 61,
    risk_tier: "high_upside",
    consistency_label: "volatile",
    trend_note: "▼ Slightly lower shot share last 3 games",
  },
  {
    id: "pred_003",
    player_name: "Domantas Sabonis",
    sport: "NBA",
    game_id: "nba_mock_sac_den",
    player_id: "player_sabonis",
    team: "SAC",
    opponent: "DEN",
    game_time: "9:00 PM ET",
    stat_type: "rebounds",
    line_value: 12.5,
    projected_value: 13.8,
    prediction_direction: "MORE",
    edge: 1.3,
    confidence: "HIGH",
    reason_1: "Pace-up spot vs Denver frontcourt",
    reason_2: "Defensive rebound chances trending up",
    risk_factor: "Foul trouble vs Jokić minutes",
    game_sort: 120,
  },
  {
    id: "pred_004",
    player_name: "Tyrese Haliburton",
    sport: "NBA",
    game_id: "nba_mock_ind_nyk",
    player_id: "player_hali",
    team: "IND",
    opponent: "NYK",
    game_time: "7:00 PM ET",
    stat_type: "assists",
    line_value: 9.5,
    projected_value: 10.6,
    prediction_direction: "MORE",
    edge: 1.1,
    confidence: "MED",
    reason_1: "Pacers pace creates extra assist opportunities",
    reason_2: "NYK allows drive-and-kick chains",
    risk_factor: "Knicks may switch everything and shorten reads",
    game_sort: 90,
  },
  {
    id: "pred_005",
    player_name: "Josh Allen",
    sport: "NFL",
    game_id: "nfl_mock_buf_kc",
    player_id: "player_allen",
    team: "BUF",
    opponent: "KC",
    game_time: "4:25 PM ET",
    stat_type: "passing_yards",
    line_value: 262.5,
    projected_value: 288.0,
    prediction_direction: "MORE",
    edge: 25.5,
    confidence: "HIGH",
    reason_1: "Shootout script with elevated pass rate",
    reason_2: "Secondary injuries on opponent depth chart",
    risk_factor: "Weather or early lead could shift to run-heavy plan",
    game_sort: 70,
  },
  {
    id: "pred_006",
    player_name: "Christian McCaffrey",
    sport: "NFL",
    game_id: "nfl_mock_sf_sea",
    player_id: "player_cmc",
    team: "SF",
    opponent: "SEA",
    game_time: "1:00 PM ET",
    stat_type: "rushing_yards",
    line_value: 78.5,
    projected_value: 71.0,
    prediction_direction: "LESS",
    edge: -7.5,
    confidence: "MED",
    reason_1: "Seattle front seven trending better vs run",
    reason_2: "Red-zone vulture touches to backup",
    risk_factor: "Game script blowout adds empty calories",
    game_sort: 50,
  },
  {
    id: "pred_007",
    player_name: "Ja'Marr Chase",
    sport: "NFL",
    game_id: "nfl_mock_cin_bal",
    player_id: "player_chase",
    team: "CIN",
    opponent: "BAL",
    game_time: "1:00 PM ET",
    stat_type: "receiving_yards",
    line_value: 84.5,
    projected_value: 91.2,
    prediction_direction: "MORE",
    edge: 6.7,
    confidence: "HIGH",
    reason_1: "Target share stable with Burrow healthy",
    reason_2: "Baltimore secondary allowing explosive WR1 weeks",
    risk_factor: "Press rate could shorten timing windows",
    game_sort: 60,
  },
  {
    id: "pred_008",
    player_name: "Shohei Ohtani",
    sport: "MLB",
    game_id: "mlb_mock_lad_ari",
    player_id: "player_ohtani",
    team: "LAD",
    opponent: "ARI",
    game_time: "6:40 PM ET",
    stat_type: "total_bases",
    line_value: 2.5,
    projected_value: 3.4,
    prediction_direction: "MORE",
    edge: 0.9,
    confidence: "HIGH",
    reason_1: "Platoon edge vs RHP in hitter-friendly park",
    reason_2: "Barrel rate up last 10 games",
    risk_factor: "Pitcher scratch or lineup swap late",
    game_sort: 130,
  },
  {
    id: "pred_009",
    player_name: "Spencer Strider",
    sport: "MLB",
    game_id: "mlb_mock_atl_nym",
    player_id: "player_strider",
    team: "ATL",
    opponent: "NYM",
    game_time: "7:20 PM ET",
    stat_type: "strikeouts",
    line_value: 7.5,
    projected_value: 6.2,
    prediction_direction: "LESS",
    edge: -1.3,
    confidence: "LOW",
    reason_1: "Mets contact profile limits whiff windows",
    reason_2: "Pitch count / hook risk in close games",
    risk_factor: "Umpire zone or weather can swing K totals",
    game_sort: 140,
  },
  {
    id: "pred_010",
    player_name: "Juan Soto",
    sport: "MLB",
    game_id: "mlb_mock_nyy_tb",
    player_id: "player_soto",
    team: "NYY",
    opponent: "TB",
    game_time: "1:05 PM ET",
    stat_type: "hits",
    line_value: 1.5,
    projected_value: 1.9,
    prediction_direction: "MORE",
    edge: 0.4,
    confidence: "MED",
    reason_1: "On-base skill stabilizes hit floor",
    reason_2: "Rays pen day can mean extra PA",
    risk_factor: "Shift / matchup LOOGY late",
    game_sort: 40,
  },
  {
    id: "pred_011",
    player_name: "Mohamed Salah",
    sport: "Soccer",
    game_id: "soccer_mock_liv_ful",
    player_id: "player_salah",
    team: "LIV",
    opponent: "FUL",
    game_time: "10:00 AM ET",
    stat_type: "shots",
    line_value: 3.5,
    projected_value: 4.2,
    prediction_direction: "MORE",
    edge: 0.7,
    confidence: "HIGH",
    reason_1: "Home fixture with elevated shot volume role",
    reason_2: "Fulham allowing wide overloads on Salah side",
    risk_factor: "Early sub if scoreline breaks open",
    game_sort: 20,
  },
  {
    id: "pred_012",
    player_name: "Erling Haaland",
    sport: "Soccer",
    game_id: "soccer_mock_mci_tot",
    player_id: "player_haaland",
    team: "MCI",
    opponent: "TOT",
    game_time: "12:30 PM ET",
    stat_type: "shots_on_target",
    line_value: 1.5,
    projected_value: 1.2,
    prediction_direction: "LESS",
    edge: -0.3,
    confidence: "MED",
    reason_1: "Spurs low block reduces central SoT",
    reason_2: "City rotation risk in congested week",
    risk_factor: "Penalties not captured in SoT prop",
    game_sort: 30,
  },
];

export function statFilterLabel(f: PlayerEdgeStatFilter): string {
  const labels: Record<PlayerEdgeStatFilter, string> = {
    all: "All",
    points: "Points",
    rebounds: "Rebounds",
    assists: "Assists",
    passing_yards: "Passing Yards",
    rushing_yards: "Rushing Yards",
    receiving_yards: "Receiving Yards",
    strikeouts: "Strikeouts",
    hits: "Hits",
    total_bases: "Total Bases",
    shots: "Shots",
    shots_on_target: "Shots on Target",
  };
  return labels[f];
}

export function sortPlayerEdgePredictions(list: PlayerEdgePrediction[]): PlayerEdgePrediction[] {
  return [...list].sort((a, b) => {
    const cr = CONF_RANK[a.confidence] - CONF_RANK[b.confidence];
    if (cr !== 0) return cr;
    const ae = Math.abs(a.edge);
    const be = Math.abs(b.edge);
    if (ae !== be) return be - ae;
    return a.game_sort - b.game_sort;
  });
}

export function filterPlayerEdgePredictions(
  list: PlayerEdgePrediction[],
  sport: PlayerEdgeSportFilter,
  stat: PlayerEdgeStatFilter
): PlayerEdgePrediction[] {
  return list.filter((p) => {
    if (sport !== "all" && p.sport !== sport) return false;
    if (stat !== "all" && p.stat_type !== stat) return false;
    return true;
  });
}

export function getPlayerEdgeById(id: string): PlayerEdgePrediction | undefined {
  return PLAYER_EDGE_MOCK.find((p) => p.id === id);
}
