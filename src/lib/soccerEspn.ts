import type { GamePrediction, League, PlayerTrendData, SoccerIntel, TeamData } from "@/data/mockGames";
import {
  buildEdges,
  buildLines,
  confidenceFromSoccerThreeWay,
  easternYmd,
  fetchEspnScoreboardEvents,
  formatGameTime,
  gameDateFromEasternTip,
  isoToEasternYmd,
  mapStatus,
  mergeScoreboardDays,
  nextCalendarYmd,
  overallRecord,
  probThreeWayFromAmerican,
  probThreeWayFromSoccerRecords,
  seasonStrengthFromRecord,
  sortCompetitors,
  type EspnCompetitor,
  type EspnEvent,
  ymdToParam,
} from "@/lib/espnShared";
import { enrichGamePredictions } from "@/lib/espnEnrichment";
import { mergeTheOddsApiNotes } from "@/lib/theOddsApi";
import { mergeSoccerVendorIntel } from "@/lib/soccerVendorIntel";

export { easternYmd } from "@/lib/espnShared";

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard";

function soccerTeamHeuristics(tableStrength: number): Pick<TeamData, "offensiveRating" | "defensiveRating" | "pace"> {
  const s = Math.min(0.95, Math.max(0.05, tableStrength));
  return {
    offensiveRating: Math.round((0.85 + s * 1.1) * 100) / 100,
    defensiveRating: Math.round((1.55 - s * 0.45) * 100) / 100,
    pace: Math.round(42 + s * 22),
  };
}

function leadersToTrendsSoccer(c: EspnCompetitor): PlayerTrendData[] {
  const goalsBlock = c.leaders?.find((l) => l.name === "goals" || l.name === "goalsLeaders");
  const astBlock = c.leaders?.find((l) => l.name === "assists");
  const fromGoals = goalsBlock?.leaders?.[0];
  const fromAst = astBlock?.leaders?.[0];
  const g = fromGoals ?? fromAst;
  if (!g?.athlete) return [];
  const v = g.value ?? Number.parseFloat(g.displayValue);
  const val = Number.isFinite(v) ? v : 0;
  const pos = g.athlete.position?.abbreviation ?? "—";
  const metric = fromAst && !fromGoals ? "AST" : "G";
  return [
    {
      name: g.athlete.fullName,
      position: pos,
      trend: "steady",
      last5Avg: Math.round(val * 10) / 10,
      seasonAvg: Math.round(val * 10) / 10,
      keyMetric: metric,
      keyMetricValue: g.displayValue,
    },
  ];
}

function buildSoccerIntel(): SoccerIntel {
  return {
    competition: "Premier League (EPL)",
    modelNotes: [
      "Possession style & field tilt: distinguish patient buildup vs transition-heavy sides — shapes how the game state evolves, not just who is favored.",
      "xG for/against and last-5 xG trend beat raw goals for signal; finishing runs hot/cold — track over/underperformance vs xG when you have event data.",
      "Fixture congestion (7/14-day load), travel, and rotation risk often swing lineup quality more than casual models admit.",
      "Style-vs-style: press vs press resistance, low block vs cross volume, transition vs turnover vulnerability — this is the explanation layer fans feel.",
      "Set-piece threat (aerial dominance, fouls conceded high up) moves many tight EPL results.",
      "Show draw probability explicitly and keep confidence conservative — low scores mean higher randomness.",
    ],
    dataGaps: [
      "StatsBomb xG, confirmed XIs, and set-piece models are not wired — headline 1X2 is still de-vig from the book.",
      "Wire football-data.org (token) or SportsDataIO for richer schedules & lineups; without a token we still estimate last-7-day EPL load from ESPN finals on the scoreboard.",
    ],
  };
}

function buildTeam(c: EspnCompetitor): TeamData {
  const rec = overallRecord(c);
  const str = seasonStrengthFromRecord(rec, "soccer");
  const r = soccerTeamHeuristics(str);
  const logo = c.team.logo?.replace("500/scoreboard", "500") ?? c.team.logo ?? "⚽";
  return {
    name: c.team.displayName,
    abbreviation: c.team.abbreviation,
    record: rec,
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
  const drawMl = odd?.moneyline?.draw?.close?.odds ?? odd?.moneyline?.draw?.open?.odds;

  let threeWay = probThreeWayFromAmerican(homeMl, awayMl, drawMl);
  if (!threeWay) {
    threeWay = probThreeWayFromSoccerRecords(home.record, away.record);
  }

  const prob = { home: threeWay.home, away: threeWay.away };
  const confidence = confidenceFromSoccerThreeWay(threeWay, spread != null ? Math.abs(spread) : undefined);

  const easternGameYmd = isoToEasternYmd(comp.date);
  const gameDate = gameDateFromEasternTip(easternGameYmd, todayEastern);
  const tags: string[] = [];
  if (status === "live") tags.push("LIVE");
  else if (status === "final") tags.push("FINAL");
  else tags.push("EPL", "SOCCER");

  const topSide = threeWay.home >= threeWay.away ? home.abbreviation : away.abbreviation;
  const topWin = Math.max(threeWay.home, threeWay.away);

  const topReasons = [
    `${home.abbreviation} ${home.record} hosts ${away.abbreviation} ${away.record} (W-D-L).`,
    `1X2 de-vig (approx.): ${away.abbreviation} ${threeWay.away}% · Draw ${threeWay.draw}% · ${home.abbreviation} ${threeWay.home}%.`,
    odd?.details
      ? `Market line: ${odd.details}${odd.overUnder != null ? ` · O/U ${odd.overUnder}` : ""}.`
      : `Low-score variance — treat any single probability as fuzzy until xG and lineups are in the loop.`,
    `Kick / status (ET): ${formatGameTime(comp, status)}.`,
  ];

  const riskFactors = [
    `Draw ~${threeWay.draw}% — soccer outcomes cluster on small margins; avoid overconfidence.`,
    "Late XI news, suspensions, and congestion-driven rotation can flip the run of play.",
    spread != null && Math.abs(spread) <= 0.25
      ? "Tight handicap (often pick-em) — book sees a coin flip."
      : "Cup / European minutes are not in EPL-only fixture counts — midweek Europe can still add hidden load.",
  ];

  const upsetPath = `Draw or ${threeWay.home > threeWay.away ? away.abbreviation : home.abbreviation} if set pieces, transition moments, or a red card skew a low-scoring script — ${topSide} is only ~${topWin}% to take three points.`;

  const league: League = "soccer";

  return {
    id: `espn-soccer-${event.id}`,
    league,
    gameDate,
    gameTime: formatGameTime(comp, status),
    status,
    homeTeam: home,
    awayTeam: away,
    winProbability: prob,
    threeWay,
    confidence,
    topReasons,
    riskFactors,
    keyMatchup: `Style vs style in the final third — who controls territory and chance quality (xG layer pending) may matter more than the ${topSide} moneyline lean.`,
    injuries: { home: [], away: [] },
    playerTrends: {
      home: leadersToTrendsSoccer(homeC),
      away: leadersToTrendsSoccer(awayC),
    },
    matchupEdges: buildEdges(away, home, spread, odd?.details, prob, "soccer", threeWay),
    upsetPath,
    lastUpdated: new Date().toISOString(),
    situationalTags: tags,
    lines: odd ? buildLines(odd, away.abbreviation, home.abbreviation) : undefined,
    soccer: buildSoccerIntel(),
    _meta: {
      easternYmd: easternGameYmd,
      sortTime: new Date(comp.date).getTime(),
      eventId: event.id,
      homeTeamId: homeC.team.id,
      awayTeamId: awayC.team.id,
    },
  };
}

export async function fetchSoccerGamePredictions(): Promise<GamePrediction[]> {
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

  let out = await enrichGamePredictions(predictions, "soccer");
  out = await mergeSoccerVendorIntel(out);
  out = await mergeTheOddsApiNotes(out, "soccer_epl");
  return out;
}
