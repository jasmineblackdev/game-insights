/**
 * Boxing data layer.
 *
 * Primary source: The Odds API (fetchBoxingEvents) — works with no DB data.
 * Enhanced source: Supabase boxing_fights / boxing_fighters — richer model
 *   inputs when fighter records exist. Supabase is tried first; Odds API is
 *   the fallback when DB tables are empty or Supabase is not configured.
 *
 * Fighter data is written by backend ingestion.
 * Learning weights are read from boxing_learning_history (sport-isolated).
 */

import type { GamePrediction, BoxingIntel, BoxingFighterProfile } from "@/data/mockGames";
import { supabase } from "@/lib/supabase";
import {
  applyBoxingModel,
  boxingWinProbability,
  boxingConfidence,
  DEFAULT_BOXING_WEIGHTS,
  type BoxingFactorWeights,
} from "@/lib/boxingPredictionModel";
import {
  fetchBoxingOdds,
  americanToImplied,
  deVigTwoWay,
  type BoxingOddsLine,
  type BoxingCombatEvent,
} from "@/lib/boxingOddsApi";
import {
  fetchCombatOddsWithFallback,
  type CombatOddsEvent,
} from "@/lib/multiOddsProvider";
import { easternYmd } from "@/lib/espnShared";

// ── Supabase row shapes ───────────────────────────────────────────────────────

interface DbFighter {
  fighter_id: string;
  name: string;
  wins: number;
  losses: number;
  draws: number;
  ko_wins: number;
  weight_class: string;
  reach_inches: number | null;
  height_inches: number | null;
  stance: string | null;
  age: number | null;
  last_fight_date: string | null;
  opponent_quality_score: number | null;
  ko_pct: number | null;
  decision_pct: number | null;
  style_tag: string | null;
  chin_score: number | null;
}

interface DbFight {
  fight_id: string;
  home_fighter_id: string;
  away_fighter_id: string;
  weight_class: string;
  scheduled_rounds: number;
  fight_date: string;
  fight_time: string | null;
  venue: string | null;
  is_title_fight: boolean;
  title_description: string | null;
  promoter: string | null;
  status: "upcoming" | "live" | "final";
  result_winner_id: string | null;
}

// ── Map DB row to BoxingFighterProfile ────────────────────────────────────────

function dbFighterToProfile(row: DbFighter): BoxingFighterProfile {
  const wins = row.wins ?? 0;
  const losses = row.losses ?? 0;
  const draws = row.draws ?? 0;
  const ko = row.ko_wins ?? 0;
  return {
    fighterId: row.fighter_id,
    name: row.name,
    record: `${wins}-${losses}-${draws} (${ko} KOs)`,
    wins, losses, draws, koWins: ko,
    weightClass: row.weight_class,
    reach: row.reach_inches ?? undefined,
    height: row.height_inches ?? undefined,
    stance: (row.stance as BoxingFighterProfile["stance"]) ?? undefined,
    age: row.age ?? undefined,
    lastFightDate: row.last_fight_date ?? undefined,
    opponentQualityScore: row.opponent_quality_score ?? undefined,
    koPct: row.ko_pct ?? undefined,
    decisionPct: row.decision_pct ?? undefined,
    styleTag: row.style_tag ?? undefined,
    chinScore: row.chin_score ?? undefined,
  };
}

// ── Minimal profile from fighter name (Odds-API-only path) ────────────────────

function minimalProfile(name: string): BoxingFighterProfile {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    fighterId: `odds-${slug}`,
    name,
    record: "—",
    wins: 0, losses: 0, draws: 0, koWins: 0,
    weightClass: "Unknown",
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

async function fetchBoxingModelWeights(): Promise<BoxingFactorWeights> {
  if (!supabase) return DEFAULT_BOXING_WEIGHTS;
  try {
    const { data, error } = await supabase
      .from("boxing_learning_history")
      .select("*")
      .eq("model_version", "2.0")
      .order("computed_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return DEFAULT_BOXING_WEIGHTS;
    if ((data.sample_size ?? 0) < 50) return DEFAULT_BOXING_WEIGHTS;

    return {
      opponentQuality:     data.w_opponent_quality     ?? DEFAULT_BOXING_WEIGHTS.opponentQuality,
      styleMatchup:        data.w_style_matchup        ?? DEFAULT_BOXING_WEIGHTS.styleMatchup,
      recentForm:          data.w_recent_form          ?? DEFAULT_BOXING_WEIGHTS.recentForm,
      koPowerVsDurability: data.w_ko_power_durability  ?? DEFAULT_BOXING_WEIGHTS.koPowerVsDurability,
      reachHeight:         data.w_reach_height         ?? DEFAULT_BOXING_WEIGHTS.reachHeight,
      activityInactivity:  data.w_activity_inactivity  ?? DEFAULT_BOXING_WEIGHTS.activityInactivity,
      ageCurve:            data.w_age_curve            ?? DEFAULT_BOXING_WEIGHTS.ageCurve,
      defenseEfficiency:   data.w_defense_efficiency   ?? DEFAULT_BOXING_WEIGHTS.defenseEfficiency,
      marketMovement:      data.w_market_movement      ?? DEFAULT_BOXING_WEIGHTS.marketMovement,
      learned: true,
      sampleSize: data.sample_size,
    };
  } catch {
    return DEFAULT_BOXING_WEIGHTS;
  }
}

// ── Build GamePrediction ──────────────────────────────────────────────────────

function buildPrediction(
  fight: DbFight,
  home: BoxingFighterProfile,
  away: BoxingFighterProfile,
  intel: BoxingIntel,
  weights: BoxingFactorWeights,
  oddsLine: BoxingOddsLine | undefined,
): GamePrediction {
  const modeledIntel = applyBoxingModel(intel, weights);
  const winProb      = boxingWinProbability(home, away, weights);
  const confidence   = boxingConfidence(home, away, winProb);

  const topReasons  = modeledIntel.modelNotes.slice(0, 3);
  const riskFactors = modeledIntel.modelOutput?.riskFlag ? [modeledIntel.modelOutput.riskFlag] : [];

  const method = modeledIntel.modelOutput?.methodProbabilities;
  const keyMatchup = method
    ? `KO/TKO ${Math.round(method.ko_tko * 100)}% · Decision ${Math.round(method.decision * 100)}%`
    : `${home.name} vs ${away.name}`;

  const upsetPath =
    winProb.away > winProb.home
      ? `${home.name} wins by late stoppage if ${away.name} tires`
      : `${away.name} wins by points if fight goes the distance`;

  let lines: GamePrediction["lines"] | undefined;
  if (oddsLine?.homeMoneyline != null && oddsLine?.awayMoneyline != null) {
    lines = {
      homeMl: oddsLine.homeMoneyline > 0 ? `+${oddsLine.homeMoneyline}` : `${oddsLine.homeMoneyline}`,
      awayMl: oddsLine.awayMoneyline > 0 ? `+${oddsLine.awayMoneyline}` : `${oddsLine.awayMoneyline}`,
    };
  }

  let threeWay: GamePrediction["threeWay"] | undefined;
  if (oddsLine?.homeMoneyline != null && oddsLine?.awayMoneyline != null) {
    const homeRaw  = americanToImplied(oddsLine.homeMoneyline);
    const awayRaw  = americanToImplied(oddsLine.awayMoneyline);
    const { p1: homeImplied, p2: awayImplied } = deVigTwoWay(homeRaw, awayRaw);
    const drawBase = 0.04;
    const homeAdj  = Math.round(homeImplied * (1 - drawBase) * 100);
    const awayAdj  = Math.round(awayImplied * (1 - drawBase) * 100);
    threeWay = { home: homeAdj, away: awayAdj, draw: Math.round(drawBase * 100) };
  }

  const homeTeam = {
    name: home.name,
    abbreviation: home.name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 3),
    record: home.record,
    logo: "", recentForm: "", offensiveRating: 0, defensiveRating: 0, pace: 0,
  };
  const awayTeam = {
    name: away.name,
    abbreviation: away.name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 3),
    record: away.record,
    logo: "", recentForm: "", offensiveRating: 0, defensiveRating: 0, pace: 0,
  };

  const gameTime = fight.fight_time
    ? new Date(`${fight.fight_date}T${fight.fight_time}`).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true,
      })
    : "TBD";

  const homeImplied = oddsLine?.homeMoneyline != null ? americanToImplied(oddsLine.homeMoneyline) : 0.5;
  const modelProb   = winProb.home / 100;
  const edge        = modelProb - homeImplied;

  return {
    id: `boxing-${fight.fight_id}`,
    league: "boxing",
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
      fight.is_title_fight ? "TITLE FIGHT" : null,
      `${fight.scheduled_rounds} ROUNDS`,
      fight.weight_class !== "Unknown" ? intel.weightClass : null,
    ].filter(Boolean) as string[],
    lines,
    boxing: modeledIntel,
    _meta: {
      easternYmd: fight.fight_date,
      sortTime: new Date(`${fight.fight_date}T${fight.fight_time ?? "00:00:00"}`).getTime(),
      boxingFightId: fight.fight_id,
      bettingIntel: edge > 0.02 && confidence !== "low" ? {
        pickSide: winProb.home >= winProb.away ? "home" : "away",
        pickAbbrev: winProb.home >= winProb.away
          ? homeTeam.abbreviation : awayTeam.abbreviation,
        americanOdds: oddsLine?.homeMoneyline ?? 100,
        modelProbability: modelProb,
        impliedProbability: homeImplied,
        sportsbookProbability: homeImplied,
        edge,
        edgeScore: Math.round(edge * 100),
        betQualityRating: edge >= 0.08 ? "A" : edge >= 0.04 ? "B" : "C",
        valueRating: edge >= 0.08 ? "high" : edge >= 0.04 ? "medium" : "low",
        parlayFitScore: Math.round(50 + edge * 300),
        parlaySafetyScore: Math.round(40 + edge * 200),
        recommendedForParlay: edge >= 0.04,
        filterNotes: [],
      } : undefined,
    },
  };
}

// ── Convert multi-provider CombatOddsEvent → BoxingCombatEvent ───────────────

function combatEventToBoxing(ev: CombatOddsEvent): BoxingCombatEvent {
  const line: BoxingOddsLine = {
    fightId:       ev.id,
    homeMoneyline: ev.homeMoneyline,
    awayMoneyline: ev.awayMoneyline,
    ...(ev.totalRounds != null ? { overUnderRounds: ev.totalRounds } : {}),
    ...(ev.overOdds    != null ? { overOdds:        ev.overOdds }    : {}),
    ...(ev.underOdds   != null ? { underOdds:       ev.underOdds }   : {}),
    sportsbookKey: ev.source,
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
  events: BoxingCombatEvent[],
  weights: BoxingFactorWeights,
  sourceLabel?: string,
): GamePrediction[] {
  const predictions: GamePrediction[] = [];
  for (const ev of events) {
    const fightDate      = commenceToEasternYmd(ev.commenceTime);
    const home           = minimalProfile(ev.homeName);
    const away           = minimalProfile(ev.awayName);
    const scheduledRounds =
      ev.line?.overUnderRounds != null && ev.line.overUnderRounds > 9 ? 12 : 10;

    const fight: DbFight = {
      fight_id:         ev.eventId,
      home_fighter_id:  home.fighterId,
      away_fighter_id:  away.fighterId,
      weight_class:     "Unknown",
      scheduled_rounds: scheduledRounds,
      fight_date:       fightDate,
      fight_time:       null,
      venue:            null,
      is_title_fight:   false,
      title_description: null,
      promoter:         null,
      status:           "upcoming",
      result_winner_id: null,
    };

    const intel: BoxingIntel = {
      homeFighter:    home,
      awayFighter:    away,
      weightClass:    "Unknown",
      scheduledRounds,
      isTitleFight:   false,
      modelNotes:     [],
      oddsSource:     sourceLabel ?? "The Odds API",
    };

    const line: BoxingOddsLine | undefined = ev.line ?? undefined;
    predictions.push(buildPrediction(fight, home, away, intel, weights, line));
  }
  return predictions;
}

// ── Supabase-enhanced path (when fighter DB is populated) ─────────────────────

async function fetchBoxingFromSupabase(weights: BoxingFactorWeights): Promise<GamePrediction[]> {
  if (!supabase) return [];

  const today        = easternYmd();
  const windowEnd    = new Date();
  windowEnd.setDate(windowEnd.getDate() + 14);
  const windowEndYmd = easternYmd(windowEnd);

  const { data: fights, error: fightsErr } = await supabase
    .from("boxing_fights")
    .select("*")
    .in("status", ["upcoming", "live"])
    .gte("fight_date", today)
    .lte("fight_date", windowEndYmd)
    .order("fight_date", { ascending: true });

  if (fightsErr || !fights?.length) return [];

  const fighterIds = new Set<string>();
  for (const f of fights as DbFight[]) {
    fighterIds.add(f.home_fighter_id);
    fighterIds.add(f.away_fighter_id);
  }

  const { data: fighters, error: fightersErr } = await supabase
    .from("boxing_fighters")
    .select("*")
    .in("fighter_id", [...fighterIds]);

  if (fightersErr || !fighters?.length) return [];

  const fighterMap = new Map<string, DbFighter>();
  for (const f of fighters as DbFighter[]) fighterMap.set(f.fighter_id, f);

  const oddsLines = await fetchBoxingOdds().catch(() => [] as BoxingOddsLine[]);
  const oddsMap   = new Map<string, BoxingOddsLine>();
  for (const line of oddsLines) oddsMap.set(line.fightId, line);

  const predictions: GamePrediction[] = [];
  for (const fight of fights as DbFight[]) {
    const homeDb = fighterMap.get(fight.home_fighter_id);
    const awayDb = fighterMap.get(fight.away_fighter_id);
    if (!homeDb || !awayDb) continue;

    const home  = dbFighterToProfile(homeDb);
    const away  = dbFighterToProfile(awayDb);
    const intel: BoxingIntel = {
      homeFighter:    home, awayFighter: away,
      weightClass:    fight.weight_class,
      scheduledRounds: fight.scheduled_rounds,
      venue:          fight.venue ?? undefined,
      isTitleFight:   fight.is_title_fight,
      titleDescription: fight.title_description ?? undefined,
      promoter:       fight.promoter ?? undefined,
      modelNotes:     [],
      oddsSource:     "The Odds API",
    };
    const oddsLine = oddsMap.get(fight.fight_id);
    predictions.push(buildPrediction(fight, home, away, intel, weights, oddsLine));
  }
  return predictions;
}

// ── Main fetch function ───────────────────────────────────────────────────────
// Strategy:
//   1. Try Supabase (fighter DB populated) → richest model output
//   2. Fallback: Odds API events → minimal profiles, market-signal-only model
//   3. Both empty → return []

export async function fetchBoxingPredictions(): Promise<GamePrediction[]> {
  const weights = await fetchBoxingModelWeights();

  // Path 1: Supabase has fight + fighter records
  const supabasePredictions = await fetchBoxingFromSupabase(weights);
  if (supabasePredictions.length > 0) return supabasePredictions;

  // Path 2: Multi-provider fallback (no DB required)
  try {
    const combatEvents = await fetchCombatOddsWithFallback("boxing");
    if (combatEvents.length > 0) {
      const source = combatEvents[0].source;
      return buildPredictionsFromOddsEvents(combatEvents.map(combatEventToBoxing), weights, source);
    }
  } catch {
    // All providers exhausted — fall through to empty
  }

  return [];
}
