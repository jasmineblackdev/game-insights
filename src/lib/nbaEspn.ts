import type { GameLines, GamePrediction, League, PlayerTrendData, TeamData } from "@/data/mockGames";
import {
  buildEdges,
  buildLines,
  buildSituationalTags,
  confidenceFromSpreadNba,
  easternYmd,
  fetchEspnScoreboardEvents,
  formatGameTime,
  gameDateFromEasternTip,
  isoToEasternYmd,
  mapStatus,
  mergeScoreboardDays,
  marketMlSnapshot,
  overallRecord,
  parseRecord,
  parseLiveState,
  sortCompetitors,
  winProbFromOdds,
  winProbFromRecords,
  type EspnCompetitor,
  type EspnEvent,
  ymdToParam,
  nextCalendarYmd,
} from "@/lib/espnShared";
import { enrichGamePredictions } from "@/lib/espnEnrichment";
import { applyAdvancedIntelligenceToGames } from "@/lib/advancedIntelligenceLayer";
import { applyPredictionQualityPipeline } from "@/lib/predictionQualityPipeline";
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

const NBA_LEADER_METRICS: { leaderName: string; keyMetric: string }[] = [
  { leaderName: "points", keyMetric: "PTS" },
  { leaderName: "rebounds", keyMetric: "REB" },
  { leaderName: "assists", keyMetric: "AST" },
];

function leadersToTrends(c: EspnCompetitor): PlayerTrendData[] {
  const results: PlayerTrendData[] = [];
  const seen = new Set<string>();
  for (const { leaderName, keyMetric } of NBA_LEADER_METRICS) {
    const row = c.leaders?.find((l) => l.name === leaderName)?.leaders?.[0];
    if (!row?.athlete) continue;
    const fullName = row.athlete.fullName;
    if (seen.has(fullName)) continue;
    seen.add(fullName);
    const v = row.value ?? Number.parseFloat(String(row.displayValue).replace(/[^\d.-]/g, ""));
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
    prob = winProbFromRecords(parseRecord(home.record).pct, parseRecord(away.record).pct, "nba");
  }

  const confidence = confidenceFromSpreadNba(spread, prob.home);

  const easternGameYmd = isoToEasternYmd(comp.date);
  const gameDate = gameDateFromEasternTip(easternGameYmd, todayEastern);
  const tags = buildSituationalTags(status, "nba", away.record, home.record, prob, spread);

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
      liveState: parseLiveState(comp),
      ...(status === "final" && homeC.score != null && awayC.score != null
        ? { finalHomeScore: Number(homeC.score), finalAwayScore: Number(awayC.score) }
        : {}),
      marketMl: marketMlSnapshot(odd),
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
  return applyPredictionQualityPipeline(await applyAdvancedIntelligenceToGames(out));
}
