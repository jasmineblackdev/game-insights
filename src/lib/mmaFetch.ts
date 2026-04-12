/**
 * MMA data layer.
 *
 * Primary source: The Odds API (fetchMmaEvents) — works with no DB data.
 * Enhanced source: Supabase mma_fights / mma_fighters — richer model inputs
 *   when fighter records exist. Supabase is tried first; Odds API is the
 *   fallback when DB tables are empty or Supabase is not configured.
 *
 * Fighter data is written by backend ingestion.
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
  type MmaCombatEvent,
} from "@/lib/mmaOddsApi";
import {
  fetchCombatOddsWithFallback,
  type CombatOddsEvent,
} from "@/lib/multiOddsProvider";
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

// ── Minimal profile from fighter name (Odds-API-only path) ────────────────���───
// All stat fields are undefined — model uses neutral defaults.
// Record is shown as "—" until DB records are available.

function minimalProfile(name: string): MmaFighterProfile {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    fighterId: `odds-${slug}`,
    name,
    record: "—",
    wins: 0, losses: 0, draws: 0, noContests: 0,
    koTkoWins: 0, subWins: 0, decisionWins: 0,
    weightClass: "Unknown",
    shortNotice: false,
  };
}

// ── Convert UTC ISO commence_time → Eastern YYYY-MM-DD ────────────────────────

function commenceToEasternYmd(iso: string): string {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return easternYmd();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const y   = parts.find((p) => p.type === "year")?.value  ?? "2026";
    const m   = parts.find((p) => p.type === "month")?.value ?? "01";
    const day = parts.find((p) => p.type === "day")?.value   ?? "01";
    return `${y}-${m}-${day}`;
  } catch {
    return easternYmd();
  }
}

// ── Date bucket helper ─────────────────────────────────────────────────────���──

function fightGameDate(fightDate: string): "today" | "tomorrow" | "week" {
  const today    = easternYmd();
  const tomorrow = easternYmd(new Date(Date.now() + 86_400_000));
  if (fightDate === today)    return "today";
  if (fightDate === tomorrow) return "tomorrow";
  return "week";
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
      styleMatchup:       data.w_style_matchup       ?? DEFAULT_MMA_WEIGHTS.styleMatchup,
      opponentQuality:    data.w_opponent_quality    ?? DEFAULT_MMA_WEIGHTS.opponentQuality,
      strikingEfficiency: data.w_striking_efficiency ?? DEFAULT_MMA_WEIGHTS.strikingEfficiency,
      grapplingControl:   data.w_grappling_control   ?? DEFAULT_MMA_WEIGHTS.grapplingControl,
      cardioAndPace:      data.w_cardio_pace         ?? DEFAULT_MMA_WEIGHTS.cardioAndPace,
      durability:         data.w_durability          ?? DEFAULT_MMA_WEIGHTS.durability,
      physical:           data.w_physical            ?? DEFAULT_MMA_WEIGHTS.physical,
      activityLayoff:     data.w_activity_layoff     ?? DEFAULT_MMA_WEIGHTS.activityLayoff,
      ageCurve:           data.w_age_curve           ?? DEFAULT_MMA_WEIGHTS.ageCurve,
      marketMovement:     data.w_market_movement     ?? DEFAULT_MMA_WEIGHTS.marketMovement,
      learned: true,
      sampleSize: data.sample_size,
    };
  } catch {
    return DEFAULT_MMA_WEIGHTS;
  }
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
  let marketCtx: { homeOpenImplied?: number; homeCurrentImplied?: number } | undefined;
  if (oddsLine?.homeMoneylineOpen != null && oddsLine?.homeMoneyline != null) {
    const open = americanToImplied(oddsLine.homeMoneylineOpen);
    const curr = americanToImplied(oddsLine.homeMoneyline);
    marketCtx = { homeOpenImplied: open, homeCurrentImplied: curr };
  }

  const modeledIntel = applyMmaModel(intel, weights, marketCtx);
  const winProb      = mmaWinProbability(home, away, weights, intel.scheduledRounds, marketCtx);
  const confidence   = mmaConfidence(home, away, winProb);

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

  let lines: GamePrediction["lines"] | undefined;
  if (oddsLine?.homeMoneyline != null && oddsLine?.awayMoneyline != null) {
    lines = {
      homeMl: oddsLine.homeMoneyline > 0 ? `+${oddsLine.homeMoneyline}` : `${oddsLine.homeMoneyline}`,
      awayMl: oddsLine.awayMoneyline > 0 ? `+${oddsLine.awayMoneyline}` : `${oddsLine.awayMoneyline}`,
      ...(oddsLine.overRounds != null ? { total: oddsLine.overRounds } : {}),
    };
  }

  let threeWay: GamePrediction["threeWay"] | undefined;
  if (oddsLine?.homeMoneyline != null && oddsLine?.awayMoneyline != null) {
    const hRaw = americanToImplied(oddsLine.homeMoneyline);
    const aRaw = americanToImplied(oddsLine.awayMoneyline);
    const { p1: hImp, p2: aImp } = deVigTwoWay(hRaw, aRaw);
    const hAdj = Math.round(hImp * 100);
    const aAdj = 100 - hAdj;
    threeWay = { home: hAdj, away: aAdj, draw: 0 };
  }

  const rf = modeledIntel.modelOutput?.riskFlag ?? "";
  const volatilityScore = Math.min(
    100,
    (rf.includes("inactive") ? 20 : 0) +
    (rf.includes("short notice") ? 25 : 0) +
    (rf.includes("age") ? 15 : 0) +
    (rf.includes("KO durability") ? 20 : 0) +
    (rf.includes("instability") ? 10 : 0),
  );

  const keyFields = [
    home.opponentQualityScore, away.opponentQualityScore,
    home.styleTag,             away.styleTag,
    home.koTkoPct,             away.koTkoPct,
    home.sigStrikesLandedPerMin, away.sigStrikesLandedPerMin,
    home.takedownAccuracy,     away.takedownAccuracy,
  ];
  const dataCompleteness = Math.round(keyFields.filter(Boolean).length / keyFields.length * 100);

  const homeImplied = oddsLine?.homeMoneyline != null ? americanToImplied(oddsLine.homeMoneyline) : 0.5;
  const modelProb   = winProb.home / 100;
  const edge        = modelProb - homeImplied;
  const styleStability = (home.styleTag != null ? 50 : 0) + (away.styleTag != null ? 50 : 0);
  const parlayFit = mmaParlayFitScore({
    confidence,
    edge,
    volatilityScore,
    dataCompleteness,
    styleStability,
    marketConfirmed: (marketCtx?.homeCurrentImplied ?? 0) > (marketCtx?.homeOpenImplied ?? 0)
      ? modelProb > 0.5
      : modelProb < 0.5,
  });

  const abbr = (name: string) =>
    name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 3);

  const homeTeam = {
    name: home.name, abbreviation: abbr(home.name), record: home.record,
    logo: "", recentForm: "", offensiveRating: 0, defensiveRating: 0, pace: 0,
  };
  const awayTeam = {
    name: away.name, abbreviation: abbr(away.name), record: away.record,
    logo: "", recentForm: "", offensiveRating: 0, defensiveRating: 0, pace: 0,
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
      fight.weight_class !== "Unknown" ? intel.weightClass : null,
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

// ── Convert multi-provider CombatOddsEvent → MmaCombatEvent ──────────────────

function combatEventToMma(ev: CombatOddsEvent): MmaCombatEvent {
  const now = new Date().toISOString();
  const line: MmaOddsLine = {
    fightId:       ev.id,
    oddsEventId:   ev.id,
    homeMoneyline: ev.homeMoneyline,
    awayMoneyline: ev.awayMoneyline,
    ...(ev.drawMoneyline != null ? { drawMoneyline: ev.drawMoneyline } : {}),
    ...(ev.totalRounds   != null ? { overRounds: ev.totalRounds }      : {}),
    ...(ev.overOdds      != null ? { overOdds:   ev.overOdds }         : {}),
    ...(ev.underOdds     != null ? { underOdds:  ev.underOdds }        : {}),
    sportsbook: ev.source,
    fetchedAt:  now,
  };
  return {
    eventId:     ev.id,
    commenceTime: ev.commenceTime,
    homeName:    ev.homeName,
    awayName:    ev.awayName,
    line,
  };
}

// ── Build predictions from raw Odds API events (no DB required) ──────────────

function buildPredictionsFromOddsEvents(
  events: MmaCombatEvent[],
  weights: MmaFactorWeights,
  sourceLabel?: string,
): GamePrediction[] {
  const predictions: GamePrediction[] = [];
  for (const ev of events) {
    const fightDate = commenceToEasternYmd(ev.commenceTime);
    const home = minimalProfile(ev.homeName);
    const away = minimalProfile(ev.awayName);

    // Estimate scheduled rounds from over/under line: >3.5 → likely 5-round; else 3-round
    const scheduledRounds =
      ev.line?.overRounds != null && ev.line.overRounds > 3 ? 5 : 3;

    const fight: DbMmaFight = {
      fight_id: ev.eventId,
      home_fighter_id: home.fighterId,
      away_fighter_id: away.fighterId,
      weight_class: "Unknown",
      scheduled_rounds: scheduledRounds,
      fight_date: fightDate,
      fight_time: null,
      venue: null,
      is_main_event: false,
      is_championship_bout: false,
      title_description: null,
      promotion: "UFC / MMA",
      status: "upcoming",
      odds_event_id: ev.eventId,
      result_winner_id: null,
    };

    const intel: MmaIntel = {
      homeFighter: home,
      awayFighter: away,
      weightClass: "Unknown",
      scheduledRounds,
      isMainEvent: false,
      isChampionshipBout: false,
      modelNotes: [],
      oddsSource: sourceLabel ?? "The Odds API",
    };

    const line: MmaOddsLine | undefined = ev.line ?? undefined;
    predictions.push(buildMmaPrediction(fight, home, away, intel, weights, line));
  }
  return predictions;
}

// ── Supabase-enhanced path (when fighter DB is populated) ─────────────────────

async function fetchMmaFromSupabase(weights: MmaFactorWeights): Promise<GamePrediction[]> {
  if (!supabase) return [];

  const today      = easternYmd();
  const windowEnd  = new Date();
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

  const oddsLines = await fetchMmaOdds().catch(() => [] as MmaOddsLine[]);
  const oddsMap = new Map<string, MmaOddsLine>();
  for (const line of oddsLines) oddsMap.set(line.oddsEventId, line);

  const predictions: GamePrediction[] = [];
  for (const fight of fights as DbMmaFight[]) {
    const homeDb = fighterMap.get(fight.home_fighter_id);
    const awayDb = fighterMap.get(fight.away_fighter_id);
    if (!homeDb || !awayDb) continue;

    const home  = dbFighterToProfile(homeDb);
    const away  = dbFighterToProfile(awayDb);
    const intel: MmaIntel = {
      homeFighter: home, awayFighter: away,
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
    const oddsLine = fight.odds_event_id ? oddsMap.get(fight.odds_event_id) : undefined;
    predictions.push(buildMmaPrediction(fight, home, away, intel, weights, oddsLine));
  }
  return predictions;
}

// ── Main fetch function ───────────────────────────────────────────────────────
// Strategy:
//   1. Try Supabase (fighter DB populated) → richest model output
//   2. Fallback: Odds API events → minimal profiles, market-signal-only model
//   3. Both empty → return []

export async function fetchMmaPredictions(): Promise<GamePrediction[]> {
  const weights = await fetchMmaModelWeights();

  // Path 1: Supabase has fight + fighter records
  const supabasePredictions = await fetchMmaFromSupabase(weights);
  if (supabasePredictions.length > 0) return supabasePredictions;

  // Path 2: Multi-provider fallback (no DB required)
  try {
    const combatEvents = await fetchCombatOddsWithFallback("mma");
    if (combatEvents.length > 0) {
      const source = combatEvents[0].source;
      return buildPredictionsFromOddsEvents(combatEvents.map(combatEventToMma), weights, source);
    }
  } catch {
    // All providers exhausted — fall through to empty
  }

  return [];
}
