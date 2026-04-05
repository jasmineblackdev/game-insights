export type ConfidenceLevel = "high" | "medium" | "low";
export type PlayerTrend = "hot" | "cold" | "steady";
export type InjuryStatus = "OUT" | "QUESTIONABLE" | "PROBABLE" | "GTD";

export interface PlayerInjury {
  name: string;
  position: string;
  status: InjuryStatus;
  impactScore: number; // 1-10
  detail: string;
}

export interface PlayerTrendData {
  name: string;
  position: string;
  trend: PlayerTrend;
  last5Avg: number;
  seasonAvg: number;
  keyMetric: string;
  keyMetricValue: string;
}

export interface TeamData {
  name: string;
  abbreviation: string;
  record: string;
  logo: string;
  recentForm: string; // e.g., "W-W-L-W-W"
  offensiveRating: number;
  defensiveRating: number;
  pace: number;
}

export interface MatchupEdge {
  label: string;
  team: "home" | "away";
  description: string;
}

export interface GamePrediction {
  id: string;
  gameTime: string;
  status: "upcoming" | "live" | "final";
  homeTeam: TeamData;
  awayTeam: TeamData;
  winProbability: { home: number; away: number };
  confidence: ConfidenceLevel;
  topReasons: string[];
  riskFactors: string[];
  keyMatchup: string;
  injuries: { home: PlayerInjury[]; away: PlayerInjury[] };
  playerTrends: { home: PlayerTrendData[]; away: PlayerTrendData[] };
  matchupEdges: MatchupEdge[];
  upsetPath: string;
  lastUpdated: string;
  situationalTags: string[];
}

export const todaysGames: GamePrediction[] = [
  {
    id: "1",
    gameTime: "7:30 PM ET",
    status: "upcoming",
    homeTeam: {
      name: "Los Angeles Lakers",
      abbreviation: "LAL",
      record: "48-28",
      logo: "🏀",
      recentForm: "W-W-L-W-W",
      offensiveRating: 116.2,
      defensiveRating: 110.8,
      pace: 100.4,
    },
    awayTeam: {
      name: "Phoenix Suns",
      abbreviation: "PHX",
      record: "44-32",
      logo: "☀️",
      recentForm: "L-W-W-L-W",
      offensiveRating: 114.7,
      defensiveRating: 112.1,
      pace: 98.6,
    },
    winProbability: { home: 61, away: 39 },
    confidence: "medium",
    topReasons: [
      "Lakers rank 5th in defensive rating over last 10 games",
      "Suns missing key wing defender disrupts perimeter scheme",
      "LeBron averaging 28.4 PPG in last 5, usage rate up to 34%",
    ],
    riskFactors: [
      "Second night of a back-to-back for Lakers",
      "Suns 3PT variance high — could shoot lights out",
      "Bench scoring differential only +1.2",
    ],
    keyMatchup: "LeBron's paint dominance vs Suns' weakened rim protection",
    injuries: {
      home: [
        { name: "Anthony Davis", position: "PF/C", status: "PROBABLE", impactScore: 3, detail: "Knee soreness — expected to play" },
      ],
      away: [
        { name: "Bradley Beal", position: "SG", status: "OUT", impactScore: 7, detail: "Hamstring strain — out 2-3 weeks" },
        { name: "Jusuf Nurkic", position: "C", status: "QUESTIONABLE", impactScore: 5, detail: "Ankle — game-time decision" },
      ],
    },
    playerTrends: {
      home: [
        { name: "LeBron James", position: "SF", trend: "hot", last5Avg: 28.4, seasonAvg: 25.1, keyMetric: "Usage Rate", keyMetricValue: "34%" },
        { name: "Austin Reaves", position: "SG", trend: "hot", last5Avg: 22.1, seasonAvg: 18.8, keyMetric: "3PT%", keyMetricValue: "42%" },
      ],
      away: [
        { name: "Kevin Durant", position: "SF", trend: "steady", last5Avg: 27.2, seasonAvg: 27.0, keyMetric: "TS%", keyMetricValue: "63%" },
        { name: "Devin Booker", position: "SG", trend: "cold", last5Avg: 21.8, seasonAvg: 26.3, keyMetric: "FG%", keyMetricValue: "41%" },
      ],
    },
    matchupEdges: [
      { label: "Interior Defense", team: "home", description: "Lakers +4.2 paint points allowed differential" },
      { label: "Perimeter Shooting", team: "away", description: "Suns 37.8% from 3 vs Lakers 35.1%" },
      { label: "Rebounding", team: "home", description: "Lakers +3.1 rebound margin last 10 games" },
      { label: "Transition", team: "home", description: "Lakers score 18.4 fast break PPG vs 14.2" },
    ],
    upsetPath: "Suns win if Booker breaks cold streak and Lakers bench fails on back-to-back fatigue",
    lastUpdated: "2026-04-05T18:30:00Z",
    situationalTags: ["BACK-TO-BACK", "RIVALRY"],
  },
  {
    id: "2",
    gameTime: "8:00 PM ET",
    status: "upcoming",
    homeTeam: {
      name: "Boston Celtics",
      abbreviation: "BOS",
      record: "58-18",
      logo: "☘️",
      recentForm: "W-W-W-W-L",
      offensiveRating: 120.1,
      defensiveRating: 108.3,
      pace: 99.8,
    },
    awayTeam: {
      name: "Milwaukee Bucks",
      abbreviation: "MIL",
      record: "50-26",
      logo: "🦌",
      recentForm: "W-L-W-W-W",
      offensiveRating: 117.4,
      defensiveRating: 111.0,
      pace: 101.2,
    },
    winProbability: { home: 68, away: 32 },
    confidence: "high",
    topReasons: [
      "Celtics have league-best net rating at home (+12.4)",
      "Bucks struggling on road — 20-16 away record",
      "Celtics defense holds opponents to 43% FG last 10 games",
    ],
    riskFactors: [
      "Giannis historically dominant vs Celtics interior",
      "Celtics could overlook Bucks with playoff seeding locked",
    ],
    keyMatchup: "Giannis' paint attacks vs Celtics' switching defense scheme",
    injuries: {
      home: [],
      away: [
        { name: "Khris Middleton", position: "SF", status: "OUT", impactScore: 6, detail: "Knee surgery recovery" },
      ],
    },
    playerTrends: {
      home: [
        { name: "Jayson Tatum", position: "SF", trend: "hot", last5Avg: 30.2, seasonAvg: 27.8, keyMetric: "PER", keyMetricValue: "28.1" },
        { name: "Jaylen Brown", position: "SG", trend: "steady", last5Avg: 24.1, seasonAvg: 23.6, keyMetric: "Def Rating", keyMetricValue: "105" },
      ],
      away: [
        { name: "Giannis Antetokounmpo", position: "PF", trend: "hot", last5Avg: 33.6, seasonAvg: 30.4, keyMetric: "Paint Points", keyMetricValue: "18.2" },
        { name: "Damian Lillard", position: "PG", trend: "cold", last5Avg: 22.0, seasonAvg: 25.8, keyMetric: "Ast/TO", keyMetricValue: "2.1" },
      ],
    },
    matchupEdges: [
      { label: "Home Court", team: "home", description: "Celtics 32-5 at home this season" },
      { label: "3PT Defense", team: "home", description: "Celtics hold opponents to 33.8% from 3" },
      { label: "Paint Scoring", team: "away", description: "Giannis averages 18.2 paint points per game" },
    ],
    upsetPath: "Bucks win if Giannis dominates paint and Lillard gets hot from deep",
    lastUpdated: "2026-04-05T19:00:00Z",
    situationalTags: ["PLAYOFF PREVIEW", "HIGH MOTIVATION"],
  },
  {
    id: "3",
    gameTime: "10:00 PM ET",
    status: "upcoming",
    homeTeam: {
      name: "Denver Nuggets",
      abbreviation: "DEN",
      record: "52-24",
      logo: "⛏️",
      recentForm: "W-W-W-L-W",
      offensiveRating: 118.6,
      defensiveRating: 109.2,
      pace: 97.8,
    },
    awayTeam: {
      name: "Golden State Warriors",
      abbreviation: "GSW",
      record: "42-34",
      logo: "🌉",
      recentForm: "L-L-W-L-W",
      offensiveRating: 113.9,
      defensiveRating: 113.4,
      pace: 102.1,
    },
    winProbability: { home: 72, away: 28 },
    confidence: "high",
    topReasons: [
      "Nuggets 29-4 at home — altitude advantage massive",
      "Jokic averaging triple-double in last 10 games",
      "Warriors defense ranks 22nd over last 15 games",
    ],
    riskFactors: [
      "Curry capable of explosive scoring outbursts",
      "Warriors play faster pace which can create variance",
    ],
    keyMatchup: "Jokic's playmaking vs Warriors' undersized frontcourt",
    injuries: {
      home: [
        { name: "Aaron Gordon", position: "PF", status: "QUESTIONABLE", impactScore: 4, detail: "Calf tightness" },
      ],
      away: [
        { name: "Andrew Wiggins", position: "SF", status: "OUT", impactScore: 5, detail: "Back spasms" },
        { name: "Gary Payton II", position: "SG", status: "OUT", impactScore: 3, detail: "Hamstring" },
      ],
    },
    playerTrends: {
      home: [
        { name: "Nikola Jokic", position: "C", trend: "hot", last5Avg: 29.8, seasonAvg: 26.4, keyMetric: "Triple-Doubles", keyMetricValue: "4 of 5" },
        { name: "Jamal Murray", position: "PG", trend: "steady", last5Avg: 21.4, seasonAvg: 21.0, keyMetric: "Clutch FG%", keyMetricValue: "52%" },
      ],
      away: [
        { name: "Stephen Curry", position: "PG", trend: "steady", last5Avg: 26.8, seasonAvg: 26.2, keyMetric: "3PT Made", keyMetricValue: "4.8/game" },
        { name: "Draymond Green", position: "PF", trend: "cold", last5Avg: 7.4, seasonAvg: 9.1, keyMetric: "Def Rating", keyMetricValue: "114" },
      ],
    },
    matchupEdges: [
      { label: "Altitude Factor", team: "home", description: "Denver's altitude advantage — opponents tire in 4th quarter" },
      { label: "Playmaking", team: "home", description: "Jokic 9.2 APG vs Warriors switching scheme" },
      { label: "3PT Volume", team: "away", description: "Warriors attempt 42.1 3PA/game" },
    ],
    upsetPath: "Warriors win if Curry goes nuclear (40+) and Warriors crash offensive glass",
    lastUpdated: "2026-04-05T20:15:00Z",
    situationalTags: ["ALTITUDE ADVANTAGE", "MUST-WIN (GSW)"],
  },
  {
    id: "4",
    gameTime: "9:00 PM ET",
    status: "upcoming",
    homeTeam: {
      name: "Dallas Mavericks",
      abbreviation: "DAL",
      record: "46-30",
      logo: "🐴",
      recentForm: "W-L-W-W-L",
      offensiveRating: 117.8,
      defensiveRating: 111.5,
      pace: 99.1,
    },
    awayTeam: {
      name: "Minnesota Timberwolves",
      abbreviation: "MIN",
      record: "53-23",
      logo: "🐺",
      recentForm: "W-W-W-W-W",
      offensiveRating: 115.2,
      defensiveRating: 106.8,
      pace: 96.4,
    },
    winProbability: { home: 44, away: 56 },
    confidence: "low",
    topReasons: [
      "Timberwolves riding 5-game win streak with elite defense",
      "Minnesota's defense ranks #1 in paint protection",
      "Anthony Edwards averaging 31.2 PPG in last 5",
    ],
    riskFactors: [
      "Luka historically dominates at home — 58% win rate",
      "Mavericks shooting 39% from 3 at home",
      "Close matchup — high variance game",
    ],
    keyMatchup: "Luka's isolation scoring vs Wolves' elite perimeter defense",
    injuries: {
      home: [
        { name: "Dereck Lively II", position: "C", status: "QUESTIONABLE", impactScore: 4, detail: "Knee soreness" },
      ],
      away: [],
    },
    playerTrends: {
      home: [
        { name: "Luka Doncic", position: "PG", trend: "hot", last5Avg: 32.6, seasonAvg: 28.4, keyMetric: "Ast", keyMetricValue: "9.8" },
        { name: "Kyrie Irving", position: "SG", trend: "cold", last5Avg: 19.2, seasonAvg: 24.1, keyMetric: "FG%", keyMetricValue: "43%" },
      ],
      away: [
        { name: "Anthony Edwards", position: "SG", trend: "hot", last5Avg: 31.2, seasonAvg: 26.8, keyMetric: "Points", keyMetricValue: "31.2" },
        { name: "Rudy Gobert", position: "C", trend: "steady", last5Avg: 13.4, seasonAvg: 14.0, keyMetric: "Blocks", keyMetricValue: "2.4" },
      ],
    },
    matchupEdges: [
      { label: "Defense Overall", team: "away", description: "Wolves #1 defensive rating in NBA" },
      { label: "Home Shooting", team: "home", description: "Mavs shoot 39% from 3 at home" },
      { label: "Rim Protection", team: "away", description: "Gobert anchors #1 ranked paint defense" },
      { label: "Isolation Scoring", team: "home", description: "Luka #1 in ISO points per possession" },
    ],
    upsetPath: "Could go either way — Luka home dominance vs Wolves defensive wall",
    lastUpdated: "2026-04-05T19:45:00Z",
    situationalTags: ["TRAP GAME", "PLAYOFF SEEDING"],
  },
];
