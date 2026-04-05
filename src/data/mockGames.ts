export type ConfidenceLevel = "high" | "medium" | "low";
export type PlayerTrend = "hot" | "cold" | "steady";
export type InjuryStatus = "OUT" | "QUESTIONABLE" | "PROBABLE" | "GTD";
export type League = "nba" | "nfl";
export type GameDate = "today" | "tomorrow";

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
  // NBA: offensiveRating, defensiveRating, pace
  // NFL: yardsPerGame, pointsAllowed, playsPerGame
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
  league: League;
  gameDate: GameDate;
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

export const allGames: GamePrediction[] = [
  // ── NBA TODAY ──────────────────────────────────────────────────────────────
  {
    id: "nba-1",
    league: "nba",
    gameDate: "today",
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
    lastUpdated: "2026-04-04T18:30:00Z",
    situationalTags: ["BACK-TO-BACK", "RIVALRY"],
  },
  {
    id: "nba-2",
    league: "nba",
    gameDate: "today",
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
    lastUpdated: "2026-04-04T19:00:00Z",
    situationalTags: ["PLAYOFF PREVIEW", "HIGH MOTIVATION"],
  },

  // ── NBA TOMORROW ───────────────────────────────────────────────────────────
  {
    id: "nba-3",
    league: "nba",
    gameDate: "tomorrow",
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
    lastUpdated: "2026-04-04T20:15:00Z",
    situationalTags: ["ALTITUDE ADVANTAGE", "MUST-WIN (GSW)"],
  },
  {
    id: "nba-4",
    league: "nba",
    gameDate: "tomorrow",
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
    lastUpdated: "2026-04-04T19:45:00Z",
    situationalTags: ["TRAP GAME", "PLAYOFF SEEDING"],
  },

  // ── NFL TODAY ──────────────────────────────────────────────────────────────
  {
    id: "nfl-1",
    league: "nfl",
    gameDate: "today",
    gameTime: "4:25 PM ET",
    status: "upcoming",
    homeTeam: {
      name: "Kansas City Chiefs",
      abbreviation: "KC",
      record: "13-4",
      logo: "⚔️",
      recentForm: "W-W-L-W-W",
      offensiveRating: 385.2, // yards/game
      defensiveRating: 21.4,  // points allowed/game
      pace: 64.8,             // plays/game
    },
    awayTeam: {
      name: "Baltimore Ravens",
      abbreviation: "BAL",
      record: "12-5",
      logo: "🪶",
      recentForm: "W-L-W-W-W",
      offensiveRating: 368.4,
      defensiveRating: 19.8,
      pace: 68.2,
    },
    winProbability: { home: 58, away: 42 },
    confidence: "medium",
    topReasons: [
      "Mahomes 8-2 at home in playoff-seeded matchups",
      "Chiefs' red zone efficiency ranks 3rd in NFL (64% TD rate)",
      "Ravens' secondary ranked 18th — vulnerable to play-action",
    ],
    riskFactors: [
      "Lamar Jackson's dual-threat ability creates containment problems",
      "Ravens defense allows fewest rushing yards in AFC",
      "Chiefs offensive line dealing with injury attrition",
    ],
    keyMatchup: "Mahomes' pocket presence vs Ravens' elite pass rush",
    injuries: {
      home: [
        { name: "Travis Kelce", position: "TE", status: "QUESTIONABLE", impactScore: 8, detail: "Knee soreness — game-time decision" },
      ],
      away: [
        { name: "Mark Andrews", position: "TE", status: "OUT", impactScore: 6, detail: "Shoulder — missed 2 games" },
      ],
    },
    playerTrends: {
      home: [
        { name: "Patrick Mahomes", position: "QB", trend: "hot", last5Avg: 298.4, seasonAvg: 271.2, keyMetric: "QBR", keyMetricValue: "84.2" },
        { name: "Rashee Rice", position: "WR", trend: "hot", last5Avg: 94.6, seasonAvg: 78.4, keyMetric: "YAC", keyMetricValue: "6.8/rec" },
      ],
      away: [
        { name: "Lamar Jackson", position: "QB", trend: "steady", last5Avg: 284.8, seasonAvg: 280.2, keyMetric: "Rush Yds", keyMetricValue: "58/game" },
        { name: "Derrick Henry", position: "RB", trend: "cold", last5Avg: 74.2, seasonAvg: 96.8, keyMetric: "Yards/Carry", keyMetricValue: "4.1" },
      ],
    },
    matchupEdges: [
      { label: "Red Zone Offense", team: "home", description: "Chiefs convert 64% of red zone trips to TDs" },
      { label: "Run Defense", team: "away", description: "Ravens allow fewest rush yards in AFC (82/game)" },
      { label: "3rd Down Conv.", team: "home", description: "Chiefs convert 47% of 3rd downs — 2nd in NFL" },
      { label: "Turnover Margin", team: "away", description: "Ravens +8 turnover margin, best in AFC" },
    ],
    upsetPath: "Ravens win if Lamar rushes for 80+ yards and Chiefs fail to convert red zone trips",
    lastUpdated: "2026-04-04T10:30:00Z",
    situationalTags: ["AFC SHOWDOWN", "PLAYOFF IMPLICATIONS"],
  },
  {
    id: "nfl-2",
    league: "nfl",
    gameDate: "today",
    gameTime: "8:20 PM ET",
    status: "upcoming",
    homeTeam: {
      name: "San Francisco 49ers",
      abbreviation: "SF",
      record: "12-5",
      logo: "🌁",
      recentForm: "W-W-W-L-W",
      offensiveRating: 391.6,
      defensiveRating: 18.2,
      pace: 63.4,
    },
    awayTeam: {
      name: "Dallas Cowboys",
      abbreviation: "DAL",
      record: "9-8",
      logo: "⭐",
      recentForm: "L-W-L-W-L",
      offensiveRating: 354.8,
      defensiveRating: 24.6,
      pace: 61.8,
    },
    winProbability: { home: 65, away: 35 },
    confidence: "high",
    topReasons: [
      "49ers' run game averaging 162 yards/game — best in NFC",
      "Dallas defense ranks 21st in yards allowed over last 5 weeks",
      "SF 9-1 at home under Kyle Shanahan this season",
    ],
    riskFactors: [
      "Cowboys' Micah Parsons can single-handedly disrupt game plans",
      "49ers QB situation uncertain — Purdy battling finger soreness",
      "Dallas offense dangerous when CeeDee Lamb gets isolated",
    ],
    keyMatchup: "49ers' dominant run game vs Cowboys' struggling front seven",
    injuries: {
      home: [
        { name: "Brock Purdy", position: "QB", status: "PROBABLE", impactScore: 6, detail: "Finger soreness — expected to start" },
        { name: "Christian McCaffrey", position: "RB", status: "QUESTIONABLE", impactScore: 9, detail: "Calf — limited practice all week" },
      ],
      away: [
        { name: "Dak Prescott", position: "QB", status: "GTD", impactScore: 8, detail: "Thumb injury — game-time decision" },
      ],
    },
    playerTrends: {
      home: [
        { name: "Christian McCaffrey", position: "RB", trend: "steady", last5Avg: 112.4, seasonAvg: 118.6, keyMetric: "YAC", keyMetricValue: "8.2/carry" },
        { name: "Deebo Samuel", position: "WR", trend: "hot", last5Avg: 88.2, seasonAvg: 71.4, keyMetric: "YAC", keyMetricValue: "9.4/rec" },
      ],
      away: [
        { name: "CeeDee Lamb", position: "WR", trend: "hot", last5Avg: 108.6, seasonAvg: 96.2, keyMetric: "Sep. Rate", keyMetricValue: "62%" },
        { name: "Tony Pollard", position: "RB", trend: "cold", last5Avg: 48.4, seasonAvg: 74.8, keyMetric: "Rush Avg", keyMetricValue: "3.6 ypc" },
      ],
    },
    matchupEdges: [
      { label: "Run Game", team: "home", description: "SF averages 162 rush yards/game — #1 in NFC" },
      { label: "Pass Rush", team: "away", description: "Micah Parsons 14.5 sacks, #2 in NFL" },
      { label: "Red Zone D", team: "home", description: "49ers limit opponents to 47% red zone TD rate" },
      { label: "Receiving", team: "away", description: "CeeDee Lamb 108+ rec yards in 3 of last 5" },
    ],
    upsetPath: "Cowboys win if Parsons pressures Purdy into turnovers and Lamb goes for 150+",
    lastUpdated: "2026-04-04T12:00:00Z",
    situationalTags: ["PRIME TIME", "NFC RIVALRY"],
  },

  // ── NFL TOMORROW ───────────────────────────────────────────────────────────
  {
    id: "nfl-3",
    league: "nfl",
    gameDate: "tomorrow",
    gameTime: "8:15 PM ET",
    status: "upcoming",
    homeTeam: {
      name: "Buffalo Bills",
      abbreviation: "BUF",
      record: "11-6",
      logo: "🦬",
      recentForm: "W-L-W-W-W",
      offensiveRating: 374.2,
      defensiveRating: 20.8,
      pace: 66.1,
    },
    awayTeam: {
      name: "Miami Dolphins",
      abbreviation: "MIA",
      record: "10-7",
      logo: "🐬",
      recentForm: "L-W-W-L-W",
      offensiveRating: 381.8,
      defensiveRating: 22.4,
      pace: 71.4,
    },
    winProbability: { home: 62, away: 38 },
    confidence: "medium",
    topReasons: [
      "Bills 8-2 at home in division games under McDermott",
      "Josh Allen dominant in cold weather — 71% win rate under 40°F",
      "Miami's zone defense vulnerable to Bills' crossing routes",
    ],
    riskFactors: [
      "Dolphins' pace creates tempo issues for Bills defense",
      "Tua Tagovailoa historically good vs Buffalo secondary",
      "Bills offensive line inconsistent in pass protection last 3 games",
    ],
    keyMatchup: "Josh Allen's scramble ability vs Miami's edge contain scheme",
    injuries: {
      home: [
        { name: "Stefon Diggs", position: "WR", status: "OUT", impactScore: 7, detail: "Hamstring — placed on IR" },
      ],
      away: [
        { name: "Tyreek Hill", position: "WR", status: "QUESTIONABLE", impactScore: 8, detail: "Ankle — limited in practice" },
        { name: "Raheem Mostert", position: "RB", status: "OUT", impactScore: 4, detail: "Knee — ruled out" },
      ],
    },
    playerTrends: {
      home: [
        { name: "Josh Allen", position: "QB", trend: "hot", last5Avg: 312.6, seasonAvg: 286.4, keyMetric: "Rush Yds", keyMetricValue: "48/game" },
        { name: "James Cook", position: "RB", trend: "steady", last5Avg: 84.8, seasonAvg: 82.4, keyMetric: "Yards/Carry", keyMetricValue: "4.9" },
      ],
      away: [
        { name: "Tua Tagovailoa", position: "QB", trend: "cold", last5Avg: 224.2, seasonAvg: 268.8, keyMetric: "TD/INT", keyMetricValue: "1.2" },
        { name: "Jaylen Waddle", position: "WR", trend: "steady", last5Avg: 76.4, seasonAvg: 78.2, keyMetric: "Sep. Rate", keyMetricValue: "58%" },
      ],
    },
    matchupEdges: [
      { label: "Home Field", team: "home", description: "Buffalo's crowd and weather advantage in April" },
      { label: "Pace/No-Huddle", team: "away", description: "Dolphins' 71.4 plays/game pressures Bills D" },
      { label: "QB Mobility", team: "home", description: "Allen averages 48 rush yards vs Miami historically" },
      { label: "Speed at WR", team: "away", description: "Miami WR depth speed rating #1 in AFC East" },
    ],
    upsetPath: "Dolphins win if Hill plays through injury and Tua exploits Bills' press coverage",
    lastUpdated: "2026-04-04T14:00:00Z",
    situationalTags: ["AFC EAST RIVALRY", "DIVISIONAL"],
  },
  {
    id: "nfl-4",
    league: "nfl",
    gameDate: "tomorrow",
    gameTime: "7:30 PM ET",
    status: "upcoming",
    homeTeam: {
      name: "Philadelphia Eagles",
      abbreviation: "PHI",
      record: "14-3",
      logo: "🦅",
      recentForm: "W-W-W-W-W",
      offensiveRating: 398.4,
      defensiveRating: 17.6,
      pace: 65.8,
    },
    awayTeam: {
      name: "New York Giants",
      abbreviation: "NYG",
      record: "5-12",
      logo: "🗽",
      recentForm: "L-L-W-L-L",
      offensiveRating: 318.2,
      defensiveRating: 28.4,
      pace: 60.2,
    },
    winProbability: { home: 71, away: 29 },
    confidence: "high",
    topReasons: [
      "Eagles riding 5-game win streak with dominant O-line play",
      "Giants rank 28th in scoring offense — bottom 5 in NFL",
      "Philadelphia's defense leads NFC in sacks per game (3.8)",
    ],
    riskFactors: [
      "Eagles resting starters may affect execution with playoff seeding locked",
      "Giants' division familiarity — Daboll schemes well vs Philly",
      "Late season trap game with eyes on playoffs",
    ],
    keyMatchup: "Eagles' dominant O-line vs Giants' depleted defensive front",
    injuries: {
      home: [],
      away: [
        { name: "Daniel Jones", position: "QB", status: "OUT", impactScore: 6, detail: "Neck injury — on IR" },
        { name: "Saquon Barkley", position: "RB", status: "QUESTIONABLE", impactScore: 7, detail: "Ribs — questionable to play" },
      ],
    },
    playerTrends: {
      home: [
        { name: "Jalen Hurts", position: "QB", trend: "hot", last5Avg: 286.4, seasonAvg: 264.8, keyMetric: "Rush Yds", keyMetricValue: "52/game" },
        { name: "A.J. Brown", position: "WR", trend: "steady", last5Avg: 94.2, seasonAvg: 96.4, keyMetric: "ADOT", keyMetricValue: "14.8 yds" },
      ],
      away: [
        { name: "Tommy DeVito", position: "QB", trend: "cold", last5Avg: 188.6, seasonAvg: 214.2, keyMetric: "QBR", keyMetricValue: "38.4" },
        { name: "Saquon Barkley", position: "RB", trend: "steady", last5Avg: 88.4, seasonAvg: 91.2, keyMetric: "Yards/Carry", keyMetricValue: "4.4" },
      ],
    },
    matchupEdges: [
      { label: "O-Line Dominance", team: "home", description: "Eagles' O-line PFF grade 91.4 — #1 in NFL" },
      { label: "Pass Rush", team: "home", description: "Philadelphia 3.8 sacks/game leads the NFC" },
      { label: "Run After Contact", team: "away", description: "Barkley 3.2 yards after contact per carry" },
      { label: "Scoring Offense", team: "home", description: "Eagles average 31.4 pts/game vs Giants' 17.2 allowed" },
    ],
    upsetPath: "Giants win if Barkley plays and rushes for 120+, forcing Eagles to abandon game plan",
    lastUpdated: "2026-04-04T15:30:00Z",
    situationalTags: ["NFC EAST RIVALRY", "DOMINANT FAVORITE"],
  },
];

// Legacy export — kept for any direct consumers
export const todaysGames = allGames.filter(
  (g) => g.league === "nba" && g.gameDate === "today"
);
