import type { GamePrediction, League, MlbIntel, PlayerTrendData, TeamData } from "@/data/mockGames";
import {
  buildEdges,
  buildLines,
  buildSituationalTags,
  confidenceFromSpreadMlb,
  easternYmd,
  fetchEspnScoreboardEvents,
  formatGameTime,
  gameDateFromEasternTip,
  isoToEasternYmd,
  mapStatus,
  mergeScoreboardDays,
  overallRecord,
  lastTenRecordSummary,
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
import { mergeTheOddsApiNotes } from "@/lib/theOddsApi";
import { applyMlbPredictionModel } from "@/lib/mlbPredictionModel";

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard";

/** Run-environment park factor by home team abbreviation. >1 = hitter's park, <1 = pitcher's park. */
export const MLB_PARK_FACTORS: Record<string, { factor: number; note: string }> = {
  COL: { factor: 1.18, note: "Coors Field — extreme hitter's park; run totals and WHIP are inflated." },
  TEX: { factor: 1.10, note: "Globe Life Field — hitter-friendly; warm air and dimensions aid fly balls." },
  CIN: { factor: 1.08, note: "Great American Ball Park — HR-prone; starters need ground-ball tendencies." },
  PHI: { factor: 1.06, note: "Citizens Bank Park — slight hitter's edge; right-center gap is generous." },
  BOS: { factor: 1.04, note: "Fenway Park — Green Monster inflates doubles; modest overall hitter edge." },
  CHC: { factor: 1.03, note: "Wrigley Field — wind-dependent; out-blowing days flip it to a hitter's park." },
  HOU: { factor: 0.97, note: "Minute Maid Park — dome; slight pitcher edge on off-days without roof issues." },
  MIA: { factor: 0.96, note: "loanDepot Park — retractable roof; controlled conditions, slight pitcher edge." },
  NYM: { factor: 0.95, note: "Citi Field — spacious outfield suppresses HRs; pitcher-friendly." },
  OAK: { factor: 0.94, note: "Oakland Coliseum — wide foul territory and sea-level air favor pitchers." },
  SF:  { factor: 0.93, note: "Oracle Park — marine layer and ocean wind create strong pitcher-friendly conditions." },
  SEA: { factor: 0.92, note: "T-Mobile Park — retractable roof and deep alleys suppress offense." },
  DET: { factor: 0.96, note: "Comerica Park — deep outfield, slight pitcher advantage on fly balls." },
  SD:  { factor: 0.84, note: "Petco Park — strongest pitcher's park in MLB; run totals reliably suppressed." },
};

interface ProbablePitcher {
  id?: string;   // ESPN athlete ID — used to fetch ERA/WHIP stats
  name: string;
  hand?: "L" | "R";
  homeAway: "home" | "away";
}

function parseProbablePitchers(comp: EspnCompetition): ProbablePitcher[] {
  const raw = (comp as unknown as Record<string, unknown>).probables as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => {
    const athlete = p.athlete as Record<string, unknown> | undefined;
    const name = (athlete?.displayName ?? athlete?.fullName ?? "") as string;
    if (!name) return [];
    const id = (athlete?.id as string | undefined) ?? undefined;
    const homeAway = (p.homeAway as string) === "home" ? "home" : "away";
    const stats = p.statistics as Array<Record<string, unknown>> | undefined;
    const throwingStat = stats?.find((s) => s.name === "throws" || s.name === "throwingHand");
    // Guard: displayValue/value could be non-string if ESPN changes schema
    const rawHandRaw = throwingStat?.displayValue ?? throwingStat?.value ?? "";
    const rawHand = typeof rawHandRaw === "string" ? rawHandRaw : "";
    const hand: "L" | "R" | undefined =
      rawHand.toLowerCase().startsWith("l") ? "L" : rawHand.toLowerCase().startsWith("r") ? "R" : undefined;
    return [{ id, name, hand, homeAway }];
  });
}

function parsePitcherAthleteIds(comp: EspnCompetition): { homeId?: string; awayId?: string } {
  const pitchers = parseProbablePitchers(comp);
  return {
    homeId: pitchers.find((p) => p.homeAway === "home")?.id,
    awayId: pitchers.find((p) => p.homeAway === "away")?.id,
  };
}

function buildMlbIntel(comp: EspnCompetition): MlbIntel {
  const pitchers = parseProbablePitchers(comp);
  const home = pitchers.find((p) => p.homeAway === "home");
  const away = pitchers.find((p) => p.homeAway === "away");
  const certainty: MlbIntel["pitcherCertainty"] =
    home && away ? "probable" : home || away ? "probable" : "unknown";
  return {
    homeProbablePitcher: home?.name,
    awayProbablePitcher: away?.name,
    homePitcherHand: home?.hand,
    awayPitcherHand: away?.hand,
    pitcherCertainty: certainty,
    modelNotes: [
      home && away
        ? `Probable starters: ${away.name}${away.hand ? ` (${away.hand}HP)` : ""} vs ${home.name}${home.hand ? ` (${home.hand}HP)` : ""}.`
        : "Probable starters not yet announced — treat win probability as low-certainty.",
      "MLB model: starter quality, bullpen workload, handedness splits, and lineup OPS drive the edge.",
      "Park factors and wind matter for totals; outdoor games in wind lean lower.",
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
  const results: PlayerTrendData[] = [];
  const seen = new Set<string>();
  for (const { leaderName, keyMetric } of MLB_LEADERS) {
    const row = c.leaders?.find((l) => l.name === leaderName)?.leaders?.[0];
    if (!row?.athlete) continue;
    const name = row.athlete.fullName;
    if (seen.has(name)) continue;
    seen.add(name);
    const v = row.value ?? Number.parseFloat(String(row.displayValue).replace(/[^\d.-]/g, ""));
    const val = Number.isFinite(v) ? v : 0;
    const pos = row.athlete.position?.abbreviation ?? "—";
    results.push({
      name,
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

/**
 * Season win% with small-sample shrink toward .500, blended with last-10 when available.
 * Feeds winProbFromRecords so home-field boost applies once on the combined strengths.
 */
function mlbAdjustedStrengthPct(c: EspnCompetitor): number {
  const overall = parseRecord(overallRecord(c));
  const n = overall.w + overall.l;
  const seasonShrunk = 0.5 + (overall.pct - 0.5) * Math.min(1, n / 22);

  const l10s = lastTenRecordSummary(c);
  if (!l10s) return seasonShrunk;
  const l10 = parseRecord(l10s);
  const n10 = l10.w + l10.l;
  if (n10 < 5) return seasonShrunk;

  const seasonWeight = Math.min(0.82, 0.38 + (n / 130) * 0.44);
  return seasonWeight * seasonShrunk + (1 - seasonWeight) * l10.pct;
}

function winProbFromMlbCompetitors(homeC: EspnCompetitor, awayC: EspnCompetitor) {
  return winProbFromRecords(mlbAdjustedStrengthPct(homeC), mlbAdjustedStrengthPct(awayC), "mlb");
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
    prob = winProbFromMlbCompetitors(homeC, awayC);
  }

  const mlbIntel = buildMlbIntel(comp);
  const pitcherIds = parsePitcherAthleteIds(comp);
  const parkEntry = MLB_PARK_FACTORS[home.abbreviation.toUpperCase()];
  if (parkEntry) {
    mlbIntel.modelNotes.push(parkEntry.note);
  }

  let confidence = confidenceFromSpreadMlb(spread, prob.home);
  // MLB is uniquely pitcher-dependent: downgrade all tiers when starters unconfirmed
  if (mlbIntel.pitcherCertainty === "unknown") {
    if (confidence === "high") confidence = "medium";
    else if (confidence === "medium") confidence = "low";
  }
  // Extreme park factors increase run-environment variance — downgrade from HIGH
  if (parkEntry && (parkEntry.factor >= 1.08 || parkEntry.factor <= 0.92)) {
    if (confidence === "high") confidence = "medium";
  }

  const easternGameYmd = isoToEasternYmd(comp.date);
  const gameDate = gameDateFromEasternTip(easternGameYmd, todayEastern);
  const tags = buildSituationalTags(status, "mlb", away.record, home.record, prob, spread);

  const pitcherLine =
    mlbIntel.awayProbablePitcher && mlbIntel.homeProbablePitcher
      ? `Probable starters: ${mlbIntel.awayProbablePitcher}${mlbIntel.awayPitcherHand ? ` (${mlbIntel.awayPitcherHand}HP)` : ""} vs ${mlbIntel.homeProbablePitcher}${mlbIntel.homePitcherHand ? ` (${mlbIntel.homePitcherHand}HP)` : ""}.`
      : "Probable starters not yet announced — confidence downgraded until confirmed.";

  const topReasons = [
    `${home.abbreviation} ${home.record} hosts ${away.abbreviation} ${away.record}.`,
    pitcherLine,
    odd?.details
      ? `Market: ${odd.details} (O/U ${odd.overUnder ?? "—"}).`
      : `Implied win chance: ${home.abbreviation} ${prob.home}%, ${away.abbreviation} ${prob.away}%.`,
    `First pitch / status (ET): ${formatGameTime(comp, status)}.`,
  ];

  const riskFactors = [
    "Probable pitchers and bullpen leverage change late — refresh near lock.",
    "Handedness mismatches (LHP vs LHB-heavy lineup) can move run expectancy quickly.",
    spread != null && Math.abs(spread) <= 1.5
      ? "Tight runline — one swing can flip the cover."
      : "Late scratching of a key bat or reliever changes the script.",
    ...(parkEntry && parkEntry.factor >= 1.08
      ? [`Park factor risk: ${home.abbreviation}'s hitter-friendly park inflates run totals — totals bets and runline are higher variance here.`]
      : parkEntry && parkEntry.factor <= 0.92
      ? [`Park factor risk: ${home.abbreviation}'s pitcher-friendly park suppresses offense — low-total and starter-lean plays benefit.`]
      : []),
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
      liveState: parseLiveState(comp),
      ...(status === "final" && homeC.score != null && awayC.score != null
        ? { finalHomeScore: Number(homeC.score), finalAwayScore: Number(awayC.score) }
        : {}),
      ...(pitcherIds.homeId ? { homePitcherAthleteId: pitcherIds.homeId } : {}),
      ...(pitcherIds.awayId ? { awayPitcherAthleteId: pitcherIds.awayId } : {}),
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
  // Apply the weighted MLB prediction model (pitcher ERA/WHIP, bullpen fatigue, etc.)
  // Runs after enrichment so B2B tags and injury-adjusted probabilities are in place.
  out = await applyMlbPredictionModel(out);
  return out;
}
