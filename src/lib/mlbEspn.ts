import type { GamePrediction, League, MlbIntel, PlayerTrendData, TeamData } from "@/data/mockGames";
import {
  buildEdges,
  buildLines,
  confidenceFromSpreadMlb,
  easternYmd,
  fetchEspnScoreboardEvents,
  formatGameTime,
  gameDateFromEasternTip,
  isoToEasternYmd,
  mapStatus,
  mergeScoreboardDays,
  overallRecord,
  parseRecord,
  sortCompetitors,
  winProbFromOdds,
  winProbFromRecords,
  type EspnCompetitor,
  type EspnEvent,
  ymdToParam,
  nextCalendarYmd,
} from "@/lib/espnShared";
import { enrichGamePredictions } from "@/lib/espnEnrichment";
import { mergeTheOddsApiNotes } from "@/lib/theOddsApi";

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard";

function defaultMlbIntel(): MlbIntel {
  return {
    pitcherCertainty: "unknown",
    modelNotes: [
      "MLB is driven by confirmed starter, bullpen workload, handedness splits, and lineup quality — re-run when probables confirm.",
      "Treat tiny batter-vs-pitcher samples as secondary; lean on season wOBA/OPS splits vs LHP/RHP when you add them from Savant or a data vendor.",
      "Park factors and wind matter for totals; outdoor games in wind deserve a lower total confidence.",
    ],
  };
}

function ratingHeuristics(pct: number): Pick<TeamData, "offensiveRating" | "defensiveRating" | "pace"> {
  return {
    offensiveRating: Math.round((3.8 + pct * 2.2) * 100) / 100,
    defensiveRating: Math.round((5.0 - pct * 1.8) * 100) / 100,
    pace: 9,
  };
}

const MLB_LEADERS: { leaderName: string; keyMetric: string }[] = [
  { leaderName: "hits", keyMetric: "Hits" },
  { leaderName: "homeRuns", keyMetric: "HR" },
  { leaderName: "RBIs", keyMetric: "RBI" },
  { leaderName: "runs", keyMetric: "R" },
];

function leadersToTrends(c: EspnCompetitor): PlayerTrendData[] {
  for (const { leaderName, keyMetric } of MLB_LEADERS) {
    const row = c.leaders?.find((l) => l.name === leaderName)?.leaders?.[0];
    if (!row?.athlete) continue;
    const v = row.value ?? Number.parseFloat(String(row.displayValue).replace(/[^\d.-]/g, ""));
    const val = Number.isFinite(v) ? v : 0;
    const pos = row.athlete.position?.abbreviation ?? "—";
    return [
      {
        name: row.athlete.fullName,
        position: pos,
        trend: "steady",
        last5Avg: Math.round(val * 10) / 10,
        seasonAvg: Math.round(val * 10) / 10,
        keyMetric,
        keyMetricValue: row.displayValue,
      },
    ];
  }
  return [];
}

function buildTeam(c: EspnCompetitor): TeamData {
  const { pct } = parseRecord(overallRecord(c));
  const r = ratingHeuristics(pct);
  const logo = c.team.logo?.replace("500/scoreboard", "500") ?? c.team.logo ?? "⚾";
  return {
    name: c.team.displayName,
    abbreviation: c.team.abbreviation,
    record: overallRecord(c),
    logo,
    recentForm: "—",
    ...r,
  };
}

function eventToPrediction(event: EspnEvent, todayEastern: string): GamePrediction | null {
  const comp = event.competitions?.[0];
  if (!comp?.competitors || comp.competitors.length < 2) return null;

  const [awayC, homeC] = sortCompetitors(comp.competitors);
  const away = buildTeam(awayC);
  const home = buildTeam(homeC);
  const status = mapStatus(comp.status.type.state);

  const odd = comp.odds?.[0];
  const spread = odd?.spread;
  const homeMl = odd?.moneyline?.home?.close?.odds ?? odd?.moneyline?.home?.open?.odds;
  const awayMl = odd?.moneyline?.away?.close?.odds ?? odd?.moneyline?.away?.open?.odds;

  let prob = winProbFromOdds(homeMl, awayMl);
  if (!prob) {
    prob = winProbFromRecords(parseRecord(away.record).pct, parseRecord(home.record).pct);
  }

  const confidence = confidenceFromSpreadMlb(spread, prob.home);

  const easternGameYmd = isoToEasternYmd(comp.date);
  const gameDate = gameDateFromEasternTip(easternGameYmd, todayEastern);
  const tags: string[] = [];
  if (status === "live") tags.push("LIVE");
  else if (status === "final") tags.push("FINAL");
  else tags.push("MLB");

  const mlbIntel = defaultMlbIntel();

  const topReasons = [
    `${home.abbreviation} ${home.record} hosts ${away.abbreviation} ${away.record}.`,
    odd?.details
      ? `Market: ${odd.details} (O/U ${odd.overUnder ?? "—"}).`
      : `Implied win chance: ${home.abbreviation} ${prob.home}%, ${away.abbreviation} ${prob.away}%.`,
    `First pitch / status (ET): ${formatGameTime(comp, status)}.`,
    "Prediction confidence should drop until starters and lineups are confirmed — see MLB factors below.",
  ];

  const riskFactors = [
    "Probable pitchers and bullpen leverage change late — refresh near lock.",
    "Handedness mismatches (LHP vs LHB-heavy lineup) can move run expectancy quickly.",
    spread != null && Math.abs(spread) <= 1.5
      ? "Tight runline — one swing can flip the cover."
      : "Late scratching of a key bat or reliever changes the script.",
  ];

  const upsetTeam = prob.home >= prob.away ? away.abbreviation : home.abbreviation;
  const upsetPath = `${upsetTeam} wins if the starter neutralizes the top of the order and the bullpen bridge holds in the middle innings.`;

  const league: League = "mlb";

  return {
    id: `espn-mlb-${event.id}`,
    league,
    gameDate,
    gameTime: formatGameTime(comp, status),
    status,
    homeTeam: home,
    awayTeam: away,
    winProbability: prob,
    confidence,
    topReasons,
    riskFactors,
    keyMatchup: `${away.abbreviation} lineup vs ${home.abbreviation} starter (handedness & pitch mix) — track confirmation before locking a lean.`,
    injuries: { home: [], away: [] },
    playerTrends: {
      home: leadersToTrends(homeC),
      away: leadersToTrends(awayC),
    },
    matchupEdges: buildEdges(away, home, spread, odd?.details, prob, "mlb"),
    upsetPath,
    lastUpdated: new Date().toISOString(),
    situationalTags: tags,
    lines: odd ? buildLines(odd, away.abbreviation, home.abbreviation) : undefined,
    mlb: mlbIntel,
    _meta: {
      easternYmd: easternGameYmd,
      sortTime: new Date(comp.date).getTime(),
      eventId: event.id,
      homeTeamId: homeC.team.id,
      awayTeamId: awayC.team.id,
    },
  };
}

export async function fetchMlbGamePredictions(): Promise<GamePrediction[]> {
  const today = easternYmd();
  const tomorrow = nextCalendarYmd(today);

  const [e0, e1] = await Promise.all([
    fetchEspnScoreboardEvents(SCOREBOARD, ymdToParam(today)),
    fetchEspnScoreboardEvents(SCOREBOARD, ymdToParam(tomorrow)),
  ]);

  const merged = mergeScoreboardDays(e0, e1);

  const predictions: GamePrediction[] = [];
  for (const event of merged) {
    const p = eventToPrediction(event, today);
    if (p) predictions.push(p);
  }

  predictions.sort((a, b) => (a._meta?.sortTime ?? 0) - (b._meta?.sortTime ?? 0));

  let out = await enrichGamePredictions(predictions, "mlb");
  out = await mergeTheOddsApiNotes(out, "baseball_mlb");
  return out;
}
