import type { GameLines, GamePrediction, League, PlayerTrendData, TeamData } from "@/data/mockGames";
import {
  buildEdges,
  buildLines,
  confidenceFromSpreadNfl,
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

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

/** Yards/game, points allowed/game, plays/game — heuristics from record until you ingest real team stats. */
function nflRatingHeuristics(pct: number): Pick<TeamData, "offensiveRating" | "defensiveRating" | "pace"> {
  return {
    offensiveRating: Math.round(300 + pct * 95),
    defensiveRating: Math.round((27 - pct * 11) * 10) / 10,
    pace: Math.round((63 + (pct - 0.5) * 8) * 10) / 10,
  };
}

const NFL_LEADER_METRICS: { leaderName: string; keyMetric: string }[] = [
  { leaderName: "passingYards", keyMetric: "Pass Yds" },
  { leaderName: "rushingYards", keyMetric: "Rush Yds" },
  { leaderName: "receivingYards", keyMetric: "Rec Yds" },
  { leaderName: "points", keyMetric: "PTS" },
];

function leadersToTrends(c: EspnCompetitor): PlayerTrendData[] {
  const results: PlayerTrendData[] = [];
  const seen = new Set<string>();

  for (const { leaderName, keyMetric } of NFL_LEADER_METRICS) {
    const row = c.leaders?.find((l) => l.name === leaderName)?.leaders?.[0];
    if (!row?.athlete) continue;
    const fullName = row.athlete.fullName;
    if (seen.has(fullName)) continue; // same player won't appear twice
    seen.add(fullName);
    const v = row.value ?? Number.parseFloat(row.displayValue.replace(/[^\d.-]/g, ""));
    const val = Number.isFinite(v) ? v : 0;
    const pos = row.athlete.position?.abbreviation ?? "—";
    results.push({
      name: fullName,
      position: pos,
      trend: "steady",
      last5Avg: Math.round(val * 10) / 10,
      seasonAvg: Math.round(val * 10) / 10,
      keyMetric,
      keyMetricValue: row.displayValue,
    });
  }
  return results.slice(0, 3);
}

function buildTeam(c: EspnCompetitor): TeamData {
  const { pct } = parseRecord(overallRecord(c));
  const r = nflRatingHeuristics(pct);
  const logo = c.team.logo?.replace("500/scoreboard", "500") ?? c.team.logo ?? "🏈";
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

  const confidence = confidenceFromSpreadNfl(spread, prob.home);

  const easternGameYmd = isoToEasternYmd(comp.date);
  const gameDate = gameDateFromEasternTip(easternGameYmd, todayEastern);
  const tags: string[] = [];
  if (status === "live") tags.push("LIVE");
  else if (status === "final") tags.push("FINAL");
  else tags.push("NFL");

  const topReasons = [
    `${home.abbreviation} ${home.record} at home vs ${away.abbreviation} ${away.record} on the road.`,
    odd?.details
      ? `Market: ${odd.details} (O/U ${odd.overUnder ?? "—"}).`
      : `Implied win chance: ${home.abbreviation} ${prob.home}%, ${away.abbreviation} ${prob.away}%.`,
    `Kickoff / status (ET): ${formatGameTime(comp, status)}.`,
  ];

  const riskFactors = [
    status === "upcoming"
      ? "Lines and injury reports move all week — double-check before kickoff."
      : "Past results don't guarantee future performance.",
    spread != null && Math.abs(spread) <= 3
      ? "Field-goal game — one-score variance is normal."
      : "Turnovers and special teams can swing any NFL matchup.",
  ];

  const upsetTeam = prob.home >= prob.away ? away.abbreviation : home.abbreviation;
  const upsetPath = `${upsetTeam} wins if they win turnover margin and keep ${prob.home >= prob.away ? home.abbreviation : away.abbreviation} off schedule on early downs.`;

  const league: League = "nfl";

  return {
    id: `espn-nfl-${event.id}`,
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
    keyMatchup: `${away.abbreviation} offense (${away.offensiveRating} yds/g est.) vs ${home.abbreviation} defense (${home.defensiveRating} PA/g est.).`,
    injuries: { home: [], away: [] },
    playerTrends: {
      home: leadersToTrends(homeC),
      away: leadersToTrends(awayC),
    },
    matchupEdges: buildEdges(away, home, spread, odd?.details, prob),
    upsetPath,
    lastUpdated: new Date().toISOString(),
    situationalTags: tags,
    lines: odd ? buildLines(odd, away.abbreviation, home.abbreviation) : undefined,
    _meta: {
      easternYmd: easternGameYmd,
      sortTime: new Date(comp.date).getTime(),
    },
  };
}

export async function fetchNflGamePredictions(): Promise<GamePrediction[]> {
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

  return predictions;
}
