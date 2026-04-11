/**
 * Boxing data layer — reads upcoming fights from Supabase boxing tables,
 * merges odds from The Odds API, applies the prediction model, and returns
 * GamePrediction[] using the same contract as NBA/NFL/MLB fetchers.
 *
 * Fighter data is written by backend ingestion (not called client-side).
 * Odds are fetched client-side via boxingOddsApi.ts.
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
} from "@/lib/boxingOddsApi";
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
  fight_date: string;  // ISO date YYYY-MM-DD
  fight_time: string | null;  // HH:MM local (optional)
  venue: string | null;
  is_title_fight: boolean;
  title_description: string | null;
  promoter: string | null;
  status: "upcoming" | "live" | "final";
  result_winner_id: string | null;
}

// ── Learned weights from Supabase ─────────────────────────────────────────────

async function fetchBoxingModelWeights(): Promise<BoxingFactorWeights> {
  if (!supabase) return DEFAULT_BOXING_WEIGHTS;
  try {
    const { data, error } = await supabase
      .from("boxing_learning_history")
      .select("*")
      .eq("model_version", "1.0")
      .order("computed_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return DEFAULT_BOXING_WEIGHTS;

    const MIN_SAMPLE = 50;
    if ((data.sample_size ?? 0) < MIN_SAMPLE) return DEFAULT_BOXING_WEIGHTS;

    return {
      reach: data.w_reach ?? DEFAULT_BOXING_WEIGHTS.reach,
      age: data.w_age ?? DEFAULT_BOXING_WEIGHTS.age,
      stance: data.w_stance ?? DEFAULT_BOXING_WEIGHTS.stance,
      inactivity: data.w_inactivity ?? DEFAULT_BOXING_WEIGHTS.inactivity,
      opponentQuality: data.w_opponent_quality ?? DEFAULT_BOXING_WEIGHTS.opponentQuality,
      style: data.w_style ?? DEFAULT_BOXING_WEIGHTS.style,
      koPct: data.w_ko_pct ?? DEFAULT_BOXING_WEIGHTS.koPct,
      chin: data.w_chin ?? DEFAULT_BOXING_WEIGHTS.chin,
      learned: true,
      sampleSize: data.sample_size,
    };
  } catch {
    return DEFAULT_BOXING_WEIGHTS;
  }
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
    wins,
    losses,
    draws,
    koWins: ko,
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

// ── Determine gameDate bucket ─────────────────────────────────────────────────

function fightGameDate(fightDate: string): "today" | "tomorrow" | "week" {
  const today = easternYmd();
  const tomorrow = easternYmd(new Date(Date.now() + 86_400_000));
  if (fightDate === today) return "today";
  if (fightDate === tomorrow) return "tomorrow";
  return "week";
}

// ── Build GamePrediction from fight + fighters + odds ─────────────────────────

function buildPrediction(
  fight: DbFight,
  home: BoxingFighterProfile,
  away: BoxingFighterProfile,
  intel: BoxingIntel,
  weights: BoxingFactorWeights,
  oddsLine: BoxingOddsLine | undefined,
): GamePrediction {
  const modeledIntel = applyBoxingModel(intel, weights);
  const winProb = boxingWinProbability(home, away, weights);
  const confidence = boxingConfidence(home, away, winProb);

  const topReasons = modeledIntel.modelNotes.slice(0, 3);
  const riskFactors = modeledIntel.modelOutput?.riskFlag
    ? [modeledIntel.modelOutput.riskFlag]
    : [];

  // Method of victory summary
  const method = modeledIntel.modelOutput?.methodProbabilities;
  const keyMatchup = method
    ? `KO/TKO ${Math.round(method.ko_tko * 100)}% · Decision ${Math.round(method.decision * 100)}%`
    : `${home.name} vs ${away.name}`;

  const upsetPath =
    winProb.away > winProb.home
      ? `${home.name} wins by late stoppage if ${away.name} tires`
      : `${away.name} wins by points if fight goes the distance`;

  // Build GameLines from odds
  let lines: GamePrediction["lines"] | undefined;
  if (oddsLine?.homeMoneyline != null && oddsLine?.awayMoneyline != null) {
    lines = {
      homeMl: oddsLine.homeMoneyline > 0 ? `+${oddsLine.homeMoneyline}` : `${oddsLine.homeMoneyline}`,
      awayMl: oddsLine.awayMoneyline > 0 ? `+${oddsLine.awayMoneyline}` : `${oddsLine.awayMoneyline}`,
    };
  }

  // Implied probability from odds (de-vig)
  let threeWay: GamePrediction["threeWay"] | undefined;
  if (oddsLine?.homeMoneyline != null && oddsLine?.awayMoneyline != null) {
    const homeRaw = americanToImplied(oddsLine.homeMoneyline);
    const awayRaw = americanToImplied(oddsLine.awayMoneyline);
    const { p1: homeImplied, p2: awayImplied } = deVigTwoWay(homeRaw, awayRaw);
    // Boxing has draws so we keep a tiny draw probability and renormalize
    const drawBase = 0.04;
    const homeAdj = Math.round(homeImplied * (1 - drawBase) * 100);
    const awayAdj = Math.round(awayImplied * (1 - drawBase) * 100);
    threeWay = { home: homeAdj, away: awayAdj, draw: Math.round(drawBase * 100) };
  }

  const homeTeam = {
    name: home.name,
    abbreviation: home.name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 3),
    record: home.record,
    logo: "",
    recentForm: "",
    offensiveRating: 0,
    defensiveRating: 0,
    pace: 0,
  };
  const awayTeam = {
    name: away.name,
    abbreviation: away.name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 3),
    record: away.record,
    logo: "",
    recentForm: "",
    offensiveRating: 0,
    defensiveRating: 0,
    pace: 0,
  };

  const gameTime = fight.fight_time
    ? new Date(`${fight.fight_date}T${fight.fight_time}`).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : "TBD";

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
      fight.scheduled_rounds === 12 ? "12 ROUNDS" : `${fight.scheduled_rounds} ROUNDS`,
      intel.weightClass,
    ].filter(Boolean) as string[],
    lines,
    boxing: modeledIntel,
    _meta: {
      easternYmd: fight.fight_date,
      sortTime: new Date(`${fight.fight_date}T${fight.fight_time ?? "00:00:00"}`).getTime(),
      boxingFightId: fight.fight_id,
    },
  };
}

// ── Main fetch function ───────────────────────────────────────────────────────

export async function fetchBoxingPredictions(): Promise<GamePrediction[]> {
  if (!supabase) return [];

  const today = easternYmd();
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + 14);
  const windowEndYmd = easternYmd(windowEnd);

  // Fetch upcoming fights in the next 2 weeks
  const { data: fights, error: fightsErr } = await supabase
    .from("boxing_fights")
    .select("*")
    .in("status", ["upcoming", "live"])
    .gte("fight_date", today)
    .lte("fight_date", windowEndYmd)
    .order("fight_date", { ascending: true });

  if (fightsErr || !fights?.length) return [];

  // Collect all fighter IDs
  const fighterIds = new Set<string>();
  for (const f of fights as DbFight[]) {
    fighterIds.add(f.home_fighter_id);
    fighterIds.add(f.away_fighter_id);
  }

  // Fetch all fighters in one query
  const { data: fighters, error: fightersErr } = await supabase
    .from("boxing_fighters")
    .select("*")
    .in("fighter_id", [...fighterIds]);

  if (fightersErr || !fighters?.length) return [];

  const fighterMap = new Map<string, DbFighter>();
  for (const f of fighters as DbFighter[]) {
    fighterMap.set(f.fighter_id, f);
  }

  // Fetch weights and odds in parallel
  const [weights, oddsLines] = await Promise.all([
    fetchBoxingModelWeights(),
    fetchBoxingOdds().catch(() => [] as BoxingOddsLine[]),
  ]);

  // Build odds lookup by fight_id (Odds API uses its own event IDs — best-effort match)
  // In production, store the Odds API event ID in boxing_fights.odds_event_id
  const oddsMap = new Map<string, BoxingOddsLine>();
  for (const line of oddsLines) {
    oddsMap.set(line.fightId, line);
  }

  const predictions: GamePrediction[] = [];

  for (const fight of fights as DbFight[]) {
    const homeDb = fighterMap.get(fight.home_fighter_id);
    const awayDb = fighterMap.get(fight.away_fighter_id);
    if (!homeDb || !awayDb) continue;

    const home = dbFighterToProfile(homeDb);
    const away = dbFighterToProfile(awayDb);

    const intel: BoxingIntel = {
      homeFighter: home,
      awayFighter: away,
      weightClass: fight.weight_class,
      scheduledRounds: fight.scheduled_rounds,
      venue: fight.venue ?? undefined,
      isTitleFight: fight.is_title_fight,
      titleDescription: fight.title_description ?? undefined,
      promoter: fight.promoter ?? undefined,
      modelNotes: [],
      oddsSource: "The Odds API",
    };

    // Try to find odds by fight_id stored in boxing_fights.odds_event_id
    const oddsLine = oddsMap.get(fight.fight_id);

    predictions.push(buildPrediction(fight, home, away, intel, weights, oddsLine));
  }

  return predictions;
}
