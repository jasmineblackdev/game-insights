/**
 * MMA data layer — reads upcoming fights from Supabase mma_fights/mma_fighters,
 * merges odds from The Odds API, applies the prediction model, and returns
 * GamePrediction[] using the same contract as all other sport fetchers.
 *
 * Fighter data is written by backend ingestion (Boxing Data API + manual entry).
 * Learning weights are read from mma_learning_history (sport-isolated).
 */

import type { GamePrediction, MmaIntel, MmaFighterProfile } from "@/data/mockGames";
import { supabase } from "@/lib/supabase";
import {
  applyMmaModel,
  mmaWinProbability,
  mmaConfidence,
  mmaParlayFitScore,
  DEFAULT_MMA_WEIGHTS,
  type MmaFactorWeights,
} from "@/lib/mmaPredictionModel";
import {
  fetchMmaOdds,
  americanToImplied,
  deVigTwoWay,
  type MmaOddsLine,
} from "@/lib/mmaOddsApi";
import { easternYmd } from "@/lib/espnShared";

// ── Supabase row shapes ───────────────────────────────────────────────────────

interface DbMmaFighter {
  fighter_id: string;
  name: string;
  wins: number;
  losses: number;
  draws: number;
  no_contests: number;
  ko_tko_wins: number;
  sub_wins: number;
  decision_wins: number;
  weight_class: string;
  reach_inches: number | null;
  height_inches: number | null;
  stance: string | null;
  age: number | null;
  last_fight_date: string | null;
  opponent_quality_score: number | null;
  ko_tko_pct: number | null;
  sub_pct: number | null;
  decision_pct: number | null;
  style_tag: string | null;
  sig_strikes_landed_per_min: number | null;
  sig_strikes_absorbed_per_min: number | null;
  strike_accuracy: number | null;
  strike_defense: number | null;
  avg_takedowns_per15: number | null;
  takedown_accuracy: number | null;
  takedown_defense: number | null;
  avg_sub_attempts_per15: number | null;
  control_time_per15: number | null;
  knockdowns_received: number | null;
  ko_penalty: number | null;
  cardio_rating: number | null;
  recent_wins: number | null;
  recent_fights: number | null;
  short_notice: boolean;
  weight_class_moves: number | null;
}

interface DbMmaFight {
  fight_id: string;
  home_fighter_id: string;
  away_fighter_id: string;
  weight_class: string;
  scheduled_rounds: number;
  fight_date: string;
  fight_time: string | null;
  venue: string | null;
  is_main_event: boolean;
  is_championship_bout: boolean;
  title_description: string | null;
  promotion: string | null;
  status: "upcoming" | "live" | "final";
  odds_event_id: string | null;
  result_winner_id: string | null;
}

// ── Map DB row → MmaFighterProfile ────────────────────────────────────────────

function dbFighterToProfile(row: DbMmaFighter): MmaFighterProfile {
  const w = row.wins ?? 0;
  const l = row.losses ?? 0;
  const d = row.draws ?? 0;
  const nc = row.no_contests ?? 0;
  const ko = row.ko_tko_wins ?? 0;
  const sub = row.sub_wins ?? 0;
  const dec = row.decision_wins ?? 0;
  return {
    fighterId: row.fighter_id,
    name: row.name,
    record: `${w}-${l}-${d}${nc > 0 ? ` (${nc} NC)` : ""} (${ko} KO, ${sub} Sub)`,
    wins: w, losses: l, draws: d, noContests: nc,
    koTkoWins: ko, subWins: sub, decisionWins: dec,
    weightClass: row.weight_class,
    reach: row.reach_inches ?? undefined,
    height: row.height_inches ?? undefined,
    stance: (row.stance as MmaFighterProfile["stance"]) ?? undefined,
    age: row.age ?? undefined,
    lastFightDate: row.last_fight_date ?? undefined,
    opponentQualityScore: row.opponent_quality_score ?? undefined,
    koTkoPct: row.ko_tko_pct ?? undefined,
    subPct: row.sub_pct ?? undefined,
    decisionPct: row.decision_pct ?? undefined,
    styleTag: row.style_tag ?? undefined,
    sigStrikesLandedPerMin: row.sig_strikes_landed_per_min ?? undefined,
    sigStrikesAbsorbedPerMin: row.sig_strikes_absorbed_per_min ?? undefined,
    strikeAccuracy: row.strike_accuracy ?? undefined,
    strikeDefense: row.strike_defense ?? undefined,
    avgTakedownsPer15: row.avg_takedowns_per15 ?? undefined,
    takedownAccuracy: row.takedown_accuracy ?? undefined,
    takedownDefense: row.takedown_defense ?? undefined,
    avgSubAttemptsPer15: row.avg_sub_attempts_per15 ?? undefined,
    controlTimePer15: row.control_time_per15 ?? undefined,
    knockdownsReceived: row.knockdowns_received ?? undefined,
    koPenalty: row.ko_penalty ?? undefined,
    cardioRating: row.cardio_rating ?? undefined,
    recentWins: row.recent_wins ?? undefined,
    recentFights: row.recent_fights ?? undefined,
    shortNotice: row.short_notice ?? false,
    weightClassMoves: row.weight_class_moves ?? undefined,
  };
}

// ── Learned weights from Supabase ─────────────────────────────────────────────

async function fetchMmaModelWeights(): Promise<MmaFactorWeights> {
  if (!supabase) return DEFAULT_MMA_WEIGHTS;
  try {
    const { data, error } = await supabase
      .from("mma_learning_history")
      .select("*")
      .eq("model_version", "1.0")
      .order("computed_at", { ascending: false })
      .limit(1)
      .single();
    if (error || !data) return DEFAULT_MMA_WEIGHTS;
    if ((data.sample_size ?? 0) < 50) return DEFAULT_MMA_WEIGHTS;
    return {
      opponentQuality:   data.w_opponent_quality  ?? DEFAULT_MMA_WEIGHTS.opponentQuality,
      styleMatchup:      data.w_style_matchup      ?? DEFAULT_MMA_WEIGHTS.styleMatchup,
      cardioAndPace:     data.w_cardio_pace        ?? DEFAULT_MMA_WEIGHTS.cardioAndPace,
      grapplingControl:  data.w_grappling_control  ?? DEFAULT_MMA_WEIGHTS.grapplingControl,
      durability:        data.w_durability         ?? DEFAULT_MMA_WEIGHTS.durability,
      physical:          data.w_physical           ?? DEFAULT_MMA_WEIGHTS.physical,
      activityLayoff:    data.w_activity_layoff    ?? DEFAULT_MMA_WEIGHTS.activityLayoff,
      defenseEfficiency: data.w_defense_efficiency ?? DEFAULT_MMA_WEIGHTS.defenseEfficiency,
      marketMovement:    data.w_market_movement    ?? DEFAULT_MMA_WEIGHTS.marketMovement,
      learned: true,
      sampleSize: data.sample_size,
    };
  } catch {
    return DEFAULT_MMA_WEIGHTS;
  }
}

// ── Date bucket helper ────────────────────────────────────────────────────────

function fightGameDate(fightDate: string): "today" | "tomorrow" | "week" {
  const today = easternYmd();
  const tomorrow = easternYmd(new Date(Date.now() + 86_400_000));
  if (fightDate === today) return "today";
  if (fightDate === tomorrow) return "tomorrow";
  return "week";
}

// ── Build GamePrediction ──────────────────────────────────────────────────────

function buildMmaPrediction(
  fight: DbMmaFight,
  home: MmaFighterProfile,
  away: MmaFighterProfile,
  intel: MmaIntel,
  weights: MmaFactorWeights,
  oddsLine: MmaOddsLine | undefined,
): GamePrediction {
  // Compute market context for market movement factor
  let marketCtx: { homeOpenImplied?: number; homeCurrentImplied?: number } | undefined;
  if (oddsLine?.homeMoneylineOpen != null && oddsLine?.homeMoneyline != null) {
    const open = americanToImplied(oddsLine.homeMoneylineOpen);
    const curr = americanToImplied(oddsLine.homeMoneyline);
    marketCtx = { homeOpenImplied: open, homeCurrentImplied: curr };
  }

  const modeledIntel = applyMmaModel(intel, weights, marketCtx);
  const winProb = mmaWinProbability(home, away, weights, marketCtx);
  const confidence = mmaConfidence(home, away, winProb);

  const topReasons = modeledIntel.modelNotes.slice(0, 3);
  const riskFactors = modeledIntel.modelOutput?.riskFlag
    ? [modeledIntel.modelOutput.riskFlag]
    : [];

  const method = modeledIntel.modelOutput?.methodProbabilities;
  const keyMatchup = method
    ? `KO/TKO ${Math.round(method.ko_tko * 100)}% · Sub ${Math.round(method.submission * 100)}% · Decision ${Math.round(method.decision * 100)}%`
    : `${home.name} vs ${away.name}`;

  const upsetPath =
    winProb.away > winProb.home
      ? `${home.name} wins if grappling neutralized and fight stays standing`
      : `${away.name} wins by late submission if ${home.name} gasses`;

  // Build lines from odds
  let lines: GamePrediction["lines"] | undefined;
  if (oddsLine?.homeMoneyline != null && oddsLine?.awayMoneyline != null) {
    lines = {
      homeMl: oddsLine.homeMoneyline > 0 ? `+${oddsLine.homeMoneyline}` : `${oddsLine.homeMoneyline}`,
      awayMl: oddsLine.awayMoneyline > 0 ? `+${oddsLine.awayMoneyline}` : `${oddsLine.awayMoneyline}`,
      ...(oddsLine.overRounds != null ? { total: oddsLine.overRounds } : {}),
    };
  }

  // De-vig implied probability
  let threeWay: GamePrediction["threeWay"] | undefined;
  if (oddsLine?.homeMoneyline != null && oddsLine?.awayMoneyline != null) {
    const hRaw = americanToImplied(oddsLine.homeMoneyline);
    const aRaw = americanToImplied(oddsLine.awayMoneyline);
    const { p1: hImp, p2: aImp } = deVigTwoWay(hRaw, aRaw);
    // MMA draws are extremely rare (~1%) — use 0 for display
    const hAdj = Math.round(hImp * 100);
    const aAdj = 100 - hAdj;
    threeWay = { home: hAdj, away: aAdj, draw: 0 };
  }

  // Compute volatility score from risk flags
  const rf = modeledIntel.modelOutput?.riskFlag ?? "";
  const volatilityScore = Math.min(
    100,
    (rf.includes("inactive") ? 20 : 0) +
    (rf.includes("short notice") ? 25 : 0) +
    (rf.includes("age") ? 15 : 0) +
    (rf.includes("KO durability") ? 20 : 0) +
    (rf.includes("instability") ? 10 : 0),
  );

  // Data completeness (how many key fields are populated)
  const keyFields = [
    home.opponentQualityScore, away.opponentQualityScore,
    home.styleTag, away.styleTag,
    home.koTkoPct, away.koTkoPct,
    home.sigStrikesLandedPerMin, away.sigStrikesLandedPerMin,
    home.takedownAccuracy, away.takedownAccuracy,
  ];
  const dataCompleteness = Math.round(keyFields.filter(Boolean).length / keyFields.length * 100);

  // Parlay fit
  const homeImplied = oddsLine?.homeMoneyline != null ? americanToImplied(oddsLine.homeMoneyline) : 0.5;
  const modelProb = winProb.home / 100;
  const edge = modelProb - homeImplied;
  const parlayFit = mmaParlayFitScore({
    confidence,
    edge,
    volatilityScore,
    dataCompleteness,
    marketConfirmed: (marketCtx?.homeCurrentImplied ?? 0) > (marketCtx?.homeOpenImplied ?? 0)
      ? modelProb > 0.5
      : modelProb < 0.5,
  });

  const abbr = (name: string) =>
    name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 3);

  const homeTeam = {
    name: home.name,
    abbreviation: abbr(home.name),
    record: home.record,
    logo: "",
    recentForm: "",
    offensiveRating: 0,
    defensiveRating: 0,
    pace: 0,
  };
  const awayTeam = {
    name: away.name,
    abbreviation: abbr(away.name),
    record: away.record,
    logo: "",
    recentForm: "",
    offensiveRating: 0,
    defensiveRating: 0,
    pace: 0,
  };

  const gameTime = fight.fight_time
    ? new Date(`${fight.fight_date}T${fight.fight_time}`).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true,
      })
    : "TBD";

  return {
    id: `mma-${fight.fight_id}`,
    league: "mma",
    gameDate: fightGameDate(fight.fight_date),
    gameTime,
    status: fight.status,
    homeTeam,
    awayTeam,
    winProbability: winProb,
    ...(threeWay ? { threeWay } : {}),
    confidence,
    topReasons,
    riskFactors,
    keyMatchup,
    injuries: { home: [], away: [] },
    playerTrends: { home: [], away: [] },
    matchupEdges: [],
    upsetPath,
    lastUpdated: new Date().toISOString(),
    situationalTags: [
      fight.is_championship_bout ? "TITLE BOUT" : fight.is_main_event ? "MAIN EVENT" : null,
      fight.scheduled_rounds === 5 ? "5 ROUNDS" : "3 ROUNDS",
      intel.weightClass,
      fight.promotion ?? null,
    ].filter(Boolean) as string[],
    lines,
    mma: modeledIntel,
    _meta: {
      easternYmd: fight.fight_date,
      sortTime: new Date(`${fight.fight_date}T${fight.fight_time ?? "00:00:00"}`).getTime(),
      bettingIntel: edge > 0.02 && confidence !== "low" ? {
        pickSide: winProb.home >= winProb.away ? "home" : "away",
        pickAbbrev: winProb.home >= winProb.away ? abbr(home.name) : abbr(away.name),
        americanOdds: oddsLine?.homeMoneyline ?? 100,
        modelProbability: modelProb,
        impliedProbability: homeImplied,
        sportsbookProbability: homeImplied,
        edge,
        edgeScore: Math.round(edge * 100),
        betQualityRating: edge >= 0.08 ? "A" : edge >= 0.04 ? "B" : "C",
        valueRating: edge >= 0.08 ? "high" : edge >= 0.04 ? "medium" : "low",
        parlayFitScore: parlayFit,
        parlaySafetyScore: Math.round(parlayFit * 0.8),
        recommendedForParlay: parlayFit >= 55 && confidence !== "low",
        filterNotes: [],
      } : undefined,
    },
  };
}

// ── Main fetch function ───────────────────────────────────────────────────────

export async function fetchMmaPredictions(): Promise<GamePrediction[]> {
  if (!supabase) return [];

  const today = easternYmd();
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + 14);
  const windowEndYmd = easternYmd(windowEnd);

  const { data: fights, error: fightsErr } = await supabase
    .from("mma_fights")
    .select("*")
    .in("status", ["upcoming", "live"])
    .gte("fight_date", today)
    .lte("fight_date", windowEndYmd)
    .order("fight_date", { ascending: true });

  if (fightsErr || !fights?.length) return [];

  const fighterIds = new Set<string>();
  for (const f of fights as DbMmaFight[]) {
    fighterIds.add(f.home_fighter_id);
    fighterIds.add(f.away_fighter_id);
  }

  const { data: fighters, error: fightersErr } = await supabase
    .from("mma_fighters")
    .select("*")
    .in("fighter_id", [...fighterIds]);

  if (fightersErr || !fighters?.length) return [];

  const fighterMap = new Map<string, DbMmaFighter>();
  for (const f of fighters as DbMmaFighter[]) fighterMap.set(f.fighter_id, f);

  const [weights, oddsLines] = await Promise.all([
    fetchMmaModelWeights(),
    fetchMmaOdds().catch(() => [] as MmaOddsLine[]),
  ]);

  // Match odds lines to fights by odds_event_id stored in DB
  const oddsMap = new Map<string, MmaOddsLine>();
  for (const line of oddsLines) {
    oddsMap.set(line.oddsEventId, line);
  }

  const predictions: GamePrediction[] = [];

  for (const fight of fights as DbMmaFight[]) {
    const homeDb = fighterMap.get(fight.home_fighter_id);
    const awayDb = fighterMap.get(fight.away_fighter_id);
    if (!homeDb || !awayDb) continue;

    const home = dbFighterToProfile(homeDb);
    const away = dbFighterToProfile(awayDb);

    const intel: MmaIntel = {
      homeFighter: home,
      awayFighter: away,
      weightClass: fight.weight_class,
      scheduledRounds: fight.scheduled_rounds,
      venue: fight.venue ?? undefined,
      isMainEvent: fight.is_main_event,
      isChampionshipBout: fight.is_championship_bout,
      titleDescription: fight.title_description ?? undefined,
      promotion: fight.promotion ?? undefined,
      modelNotes: [],
      oddsSource: "The Odds API",
    };

    // Match odds by stored odds_event_id
    const oddsLine = fight.odds_event_id ? oddsMap.get(fight.odds_event_id) : undefined;

    predictions.push(buildMmaPrediction(fight, home, away, intel, weights, oddsLine));
  }

  return predictions;
}
