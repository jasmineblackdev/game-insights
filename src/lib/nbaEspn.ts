import type { GameLines, GamePrediction, League, PlayerTrendData, TeamData } from "@/data/mockGames";
import {
  buildEdges,
  buildLines,
  confidenceFromSpreadNba,
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

export { easternYmd } from "@/lib/espnShared";

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard";

function ratingHeuristics(pct: number): Pick<TeamData, "offensiveRating" | "defensiveRating" | "pace"> {
  return {
    offensiveRating: Math.round((105 + pct * 22) * 10) / 10,
    defensiveRating: Math.round((118 - pct * 18) * 10) / 10,
    pace: Math.round((99 + (pct - 0.5) * 6) * 10) / 10,
  };
}

function leadersToTrends(c: EspnCompetitor): PlayerTrendData[] {
  const pts = c.leaders?.find((l) => l.name === "points")?.leaders?.[0];
  if (!pts?.athlete) return [];
  const v = pts.value ?? Number.parseFloat(pts.displayValue);
  const val = Number.isFinite(v) ? v : 0;
  const pos = pts.athlete.position?.abbreviation ?? "—";
  return [
    {
      name: pts.athlete.fullName,
      position: pos,
      trend: "steady",
      last5Avg: Math.round(val * 10) / 10,
      seasonAvg: Math.round(val * 10) / 10,
      keyMetric: "PTS",
      keyMetricValue: pts.displayValue,
    },
  ];
}

function buildTeam(c: EspnCompetitor): TeamData {
  const { pct } = parseRecord(overallRecord(c));
  const r = ratingHeuristics(pct);
  const logo = c.team.logo?.replace("500/scoreboard", "500") ?? c.team.logo ?? "🏀";
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

  const confidence = confidenceFromSpreadNba(spread, prob.home);

  const easternGameYmd = isoToEasternYmd(comp.date);
  const gameDate = gameDateFromEasternTip(easternGameYmd, todayEastern);
  const tags: string[] = [];
  if (status === "live") tags.push("LIVE");
  else if (status === "final") tags.push("FINAL");
  else tags.push("NBA");

  const topReasons = [
    `${home.abbreviation} ${home.record} at home vs ${away.abbreviation} ${away.record} on the road.`,
    odd?.details
      ? `Market: ${odd.details} (O/U ${odd.overUnder ?? "—"}).`
      : `Implied win chance: ${home.abbreviation} ${prob.home}%, ${away.abbreviation} ${prob.away}%.`,
    `Tip / status (ET): ${formatGameTime(comp, status)}.`,
  ];

  const riskFactors = [
    status === "upcoming"
      ? "Lines and injury news move — refresh before you lock a read."
      : "Past results don't guarantee future performance.",
    spread != null && Math.abs(spread) <= 3
      ? "Tight spread — matchup variance is high."
      : "Late scratches and rest days can flip the script.",
  ];

  const upsetTeam = prob.home >= prob.away ? away.abbreviation : home.abbreviation;
  const upsetPath = `${upsetTeam} wins if shooting variance breaks their way and ${prob.home >= prob.away ? home.abbreviation : away.abbreviation} cools off from deep.`;

  const league: League = "nba";

  return {
    id: `espn-nba-${event.id}`,
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
    keyMatchup: `${away.abbreviation} offense vs ${home.abbreviation} defense — pace ${away.pace} vs ${home.pace}.`,
    injuries: { home: [], away: [] },
    playerTrends: {
      home: leadersToTrends(homeC),
      away: leadersToTrends(awayC),
    },
    matchupEdges: buildEdges(away, home, spread, odd?.details, prob, "nba"),
    upsetPath,
    lastUpdated: new Date().toISOString(),
    situationalTags: tags,
    lines: odd ? buildLines(odd, away.abbreviation, home.abbreviation) : undefined,
    _meta: {
      easternYmd: easternGameYmd,
      sortTime: new Date(comp.date).getTime(),
      eventId: event.id,
      homeTeamId: homeC.team.id,
      awayTeamId: awayC.team.id,
    },
  };
}

export async function fetchNbaGamePredictions(): Promise<GamePrediction[]> {
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

  let out = await enrichGamePredictions(predictions, "nba");
  out = await mergeTheOddsApiNotes(out, "basketball_nba");
  return out;
}
