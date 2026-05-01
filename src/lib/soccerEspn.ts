import type { GamePrediction, League, PlayerTrendData, SoccerIntel, TeamData } from "@/data/mockGames";
import {
  addCalendarDaysYmd,
  buildEdges,
  buildLines,
  buildSituationalTags,
  confidenceFromSoccerThreeWay,
  easternYmd,
  fetchEspnSoccerScoreboardRange,
  formatGameTime,
  isoToEasternYmd,
  mapStatus,
  nextCalendarYmd,
  overallRecord,
  parseEspnIsoToUtcMs,
  parseLiveState,
  probThreeWayFromAmerican,
  probThreeWayFromSoccerRecords,
  seasonStrengthFromRecord,
  sortCompetitors,
  marketMlSnapshot,
  type EspnCompetitor,
  type EspnEvent,
} from "@/lib/espnShared";
import type { GameDate } from "@/data/mockGames";
import { enrichGamePredictions } from "@/lib/espnEnrichment";
import { applyAdvancedIntelligenceToGames } from "@/lib/advancedIntelligenceLayer";
import { applyPredictionQualityPipeline } from "@/lib/predictionQualityPipeline";
import { mergeSoccerOddsFromTheOddsApi } from "@/lib/theOddsApi";
import { mergeSoccerVendorIntel } from "@/lib/soccerVendorIntel";

export { easternYmd } from "@/lib/espnShared";

/** Supported competitions — ESPN `soccer/{slug}/scoreboard`. Order: fetch priority only. */
const SOCCER_LEAGUES: { slug: string; label: string; listTag: string }[] = [
  { slug: "uefa.champions", label: "UEFA Champions League", listTag: "UCL" },
  { slug: "uefa.europa", label: "UEFA Europa League", listTag: "UEL" },
  { slug: "eng.1", label: "Premier League", listTag: "EPL" },
  { slug: "esp.1", label: "La Liga", listTag: "LALIGA" },
  { slug: "ger.1", label: "Bundesliga", listTag: "BUND" },
  { slug: "ita.1", label: "Serie A", listTag: "SERIEA" },
  { slug: "usa.1", label: "MLS", listTag: "MLS" },
];

function scoreboardUrl(slug: string): string {
  return `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard`;
}

/** Map kickoff (US Eastern calendar day) to UI bucket — Today / Tomorrow / Next 7 days. */
function soccerGameDateBucket(easternGameYmd: string, todayEastern: string): GameDate {
  if (easternGameYmd === todayEastern) return "today";
  const tom = nextCalendarYmd(todayEastern);
  if (easternGameYmd === tom) return "tomorrow";
  return "week";
}

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

function buildSoccerIntel(competition: string): SoccerIntel {
  return {
    competition,
    modelNotes: [
      "Possession style & field tilt: distinguish patient buildup vs transition-heavy sides — shapes how the game state evolves, not just who is favored.",
      "xG for/against and last-5 xG trend beat raw goals for signal; finishing runs hot/cold — track over/underperformance vs xG when you have event data.",
      "Fixture congestion (7/14-day load), travel, and rotation risk often swing lineup quality more than casual models admit.",
      "Style-vs-style: press vs press resistance, low block vs cross volume, transition vs turnover vulnerability — this is the explanation layer fans feel.",
      "Set-piece threat (aerial dominance, fouls conceded high up) moves many tight results.",
      "Show draw probability explicitly and keep confidence conservative — low scores mean higher randomness.",
    ],
    dataGaps: [
      "StatsBomb xG, confirmed XIs, and set-piece models are not wired — headline 1X2 is still de-vig from the book.",
      `Wire football-data.org (token) or SportsDataIO for richer schedules & lineups; without a token we still estimate fixture load from ESPN finals on the scoreboard (${competition}).`,
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

function eventToPrediction(
  event: EspnEvent,
  todayEastern: string,
  weekEndYmd: string,
  leagueLabel: string,
  soccerLeagueSlug: string,
  listTag: string
): GamePrediction | null {
  const comp = event.competitions?.[0];
  if (!comp?.competitors || comp.competitors.length < 2) return null;

  const [awayC, homeC] = sortCompetitors(comp.competitors);
  const away = buildTeam(awayC);
  const home = buildTeam(homeC);
  const status = mapStatus(comp.status.type.state);

  const easternGameYmd = isoToEasternYmd(comp.date);
  if (easternGameYmd > weekEndYmd) return null;
  if (easternGameYmd < todayEastern && status !== "live") return null;
  if (comp.status.type.state === "post") return null;

  const venueName = comp.venue?.fullName?.trim() || null;

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

  const gameDate = soccerGameDateBucket(easternGameYmd, todayEastern);
  const tags = buildSituationalTags(status, "soccer", away.record, home.record, prob, spread, threeWay, listTag);
  const sortTime = parseEspnIsoToUtcMs(comp.date);
  if (gameDate === "week") {
    const short = new Date(sortTime).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    tags.push(short.toUpperCase());
  }

  const topSide = threeWay.home >= threeWay.away ? home.abbreviation : away.abbreviation;
  const topWin = Math.max(threeWay.home, threeWay.away);

  const topReasons = [
    `${home.abbreviation} ${home.record} hosts ${away.abbreviation} ${away.record} (W-D-L) · ${leagueLabel}.`,
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
      : "European minutes may add hidden load — check midweek fixtures when odds tighten.",
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
    soccer: buildSoccerIntel(leagueLabel),
    _meta: {
      easternYmd: easternGameYmd,
      sortTime,
      eventId: event.id,
      homeTeamId: homeC.team.id,
      awayTeamId: awayC.team.id,
      liveState: parseLiveState(comp),
      soccerLeagueSlug,
      soccerFixture: {
        matchId: event.id,
        competition: leagueLabel,
        homeTeam: home.name,
        awayTeam: away.name,
        startTimeIso: comp.date,
        venue: venueName,
        status,
      },
      marketMl: marketMlSnapshot(odd),
    },
  };
}

export async function fetchSoccerGamePredictions(): Promise<GamePrediction[]> {
  const today = easternYmd();
  const weekEnd = addCalendarDaysYmd(today, 7);

  const byEventId = new Map<string, GamePrediction>();

  for (const L of SOCCER_LEAGUES) {
    let raw: EspnEvent[] = [];
    try {
      raw = await fetchEspnSoccerScoreboardRange(scoreboardUrl(L.slug), today, weekEnd);
    } catch (e) {
      console.warn(
        `[GameLens soccer] Scoreboard request failed for ${L.label} (${L.slug}) — ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (raw.length === 0) {
      console.warn(
        `[GameLens soccer] No fixtures from ESPN for ${L.label} (${L.slug}) between ${today} and ${weekEnd} (US Eastern dates). The public scoreboard may omit this competition for this window or require a narrower date query.`
      );
    }

    for (const event of raw) {
      const p = eventToPrediction(event, today, weekEnd, L.label, L.slug, L.listTag);
      if (!p) continue;
      byEventId.set(event.id, p);
    }
  }

  const predictions = [...byEventId.values()].sort((a, b) => (a._meta?.sortTime ?? 0) - (b._meta?.sortTime ?? 0));

  let out = await enrichGamePredictions(predictions, "soccer");
  out = await mergeSoccerVendorIntel(out);
  out = await mergeSoccerOddsFromTheOddsApi(out);
  out = await applyAdvancedIntelligenceToGames(out);
  out = await applyPredictionQualityPipeline(out);
  return out.sort((a, b) => (a._meta?.sortTime ?? 0) - (b._meta?.sortTime ?? 0));
}
