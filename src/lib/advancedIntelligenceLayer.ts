/**
 * Layered advanced intelligence — additive adjustments on top of the base model.
 * Reads Supabase tables when populated; if empty or offline, returns games unchanged.
 * Does not replace ESPN enrichment or sport-specific models.
 */

import type { ConfidenceLevel, GamePrediction, League } from "@/data/mockGames";
import { supabase } from "@/lib/supabase";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type TeamRow = { team_id: string; metrics: Record<string, unknown>; confidence_adjustment_weight: number | null };

const teamMetricsCache = new Map<string, { t: number; map: Map<string, TeamRow> }>();

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const x = Number.parseFloat(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

function seasonFromGame(g: GamePrediction): number {
  const y = g._meta?.easternYmd?.slice(0, 4);
  const n = y ? Number(y) : NaN;
  return Number.isFinite(n) ? n : new Date().getFullYear();
}

function clampWinPct(n: number): number {
  return Math.max(5, Math.min(95, Math.round(n)));
}

function shiftTwoWay(wp: { home: number; away: number }, homeDeltaPp: number): { home: number; away: number } {
  let h = clampWinPct(wp.home + homeDeltaPp);
  let a = clampWinPct(wp.away - homeDeltaPp);
  const sum = h + a;
  if (sum !== 100) {
    h = Math.round((h / sum) * 100);
    a = 100 - h;
  }
  return { home: h, away: a };
}

function shiftThreeWay(
  tw: { home: number; away: number; draw: number },
  homeDelta: number
): { home: number; away: number; draw: number } {
  let h = tw.home + homeDelta;
  let a = tw.away - homeDelta * 0.55;
  let d = tw.draw - homeDelta * 0.45;
  h = Math.max(4, Math.min(90, h));
  a = Math.max(4, Math.min(90, a));
  d = Math.max(4, Math.min(90, d));
  const s = h + a + d;
  const nh = Math.round((h / s) * 100);
  const na = Math.round((a / s) * 100);
  return { home: nh, away: na, draw: 100 - nh - na };
}

function bumpConfidence(c: ConfidenceLevel, signals: number): ConfidenceLevel {
  if (signals < 2) return c;
  let x: ConfidenceLevel = c;
  if (x === "low") x = "medium";
  if (signals >= 3 && x === "medium") x = "high";
  return x;
}

/** Shift probability mass toward draw when xG profiles match (1X2 only). */
function nudgeDrawUp(tw: { home: number; away: number; draw: number }, drawGain: number): { home: number; away: number; draw: number } {
  let h = tw.home - drawGain / 2;
  let a = tw.away - drawGain / 2;
  let d = tw.draw + drawGain;
  h = Math.max(4, h);
  a = Math.max(4, a);
  d = Math.max(4, Math.min(50, d));
  const s = h + a + d;
  const nh = Math.round((h / s) * 100);
  const na = Math.round((a / s) * 100);
  return { home: nh, away: na, draw: 100 - nh - na };
}

async function loadTeamMetricsMap(
  sport: League,
  season: number,
  abbreviations: string[],
  rollingWindow: "season" | "last_5" | "last_10" = "season"
): Promise<Map<string, TeamRow>> {
  const uniq = [...new Set(abbreviations.map((a) => a.toUpperCase()))].filter(Boolean);
  if (!uniq.length) return new Map();
  const cacheKey = `${sport}-${season}-${rollingWindow}-${uniq.sort().join(",")}`;
  const hit = teamMetricsCache.get(cacheKey);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.map;

  const map = new Map<string, TeamRow>();
  if (!supabase) {
    teamMetricsCache.set(cacheKey, { t: Date.now(), map });
    return map;
  }

  const { data, error } = await supabase
    .from("advanced_team_metrics")
    .select("team_id,metrics,confidence_adjustment_weight")
    .eq("sport", sport)
    .eq("season", season)
    .eq("rolling_window", rollingWindow)
    .in("team_id", uniq);

  if (error) {
    teamMetricsCache.set(cacheKey, { t: Date.now(), map });
    return map;
  }

  for (const row of data ?? []) {
    const tid = String(row.team_id ?? "").toUpperCase();
    const m = row.metrics;
    map.set(tid, {
      team_id: tid,
      metrics: m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {},
      confidence_adjustment_weight: row.confidence_adjustment_weight ?? null,
    });
  }
  teamMetricsCache.set(cacheKey, { t: Date.now(), map });
  return map;
}

/** Canonical H2H key regardless of which side is home in the DB row. */
function matchupPairKey(a: string, b: string): string {
  const [x, y] = [a.toUpperCase(), b.toUpperCase()].sort();
  return `${x}|${y}`;
}

async function loadMatchupMap(
  sport: League,
  season: number,
  teamAbbrs: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  const uniq = [...new Set(teamAbbrs.map((t) => t.toUpperCase()))].filter(Boolean);
  if (!supabase || uniq.length < 2) return map;

  const { data } = await supabase
    .from("matchup_history")
    .select("team_a_id,team_b_id,metrics")
    .eq("sport", sport)
    .eq("season", season)
    .in("team_a_id", uniq)
    .in("team_b_id", uniq);

  for (const row of data ?? []) {
    const ta = String(row.team_a_id ?? "").toUpperCase();
    const tb = String(row.team_b_id ?? "").toUpperCase();
    const m = row.metrics;
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    map.set(matchupPairKey(ta, tb), m as Record<string, unknown>);
  }
  return map;
}

/** One query per league: all (date, team) pairs needed for the slate. */
async function loadFatigueMap(
  sport: League,
  dateToTeams: Map<string, Set<string>>
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!supabase || dateToTeams.size === 0) return out;

  const dates = [...dateToTeams.keys()];
  const teamSet = new Set<string>();
  for (const s of dateToTeams.values()) {
    for (const t of s) teamSet.add(t.toUpperCase());
  }
  const teams = [...teamSet];
  if (!dates.length || !teams.length) return out;

  const { data } = await supabase
    .from("fatigue_scores")
    .select("team_id,as_of_date,rolling_window_metrics")
    .eq("sport", sport)
    .in("as_of_date", dates)
    .in("team_id", teams);

  for (const row of data ?? []) {
    const tid = String(row.team_id ?? "").toUpperCase();
    const raw = row.as_of_date;
    const d =
      typeof raw === "string"
        ? raw.slice(0, 10)
        : raw instanceof Date
          ? raw.toISOString().slice(0, 10)
          : String(raw ?? "").slice(0, 10);
    const m = row.rolling_window_metrics;
    if (!d || !m || typeof m !== "object" || Array.isArray(m)) continue;
    out.set(`${sport}|${tid}|${d}`, m as Record<string, unknown>);
  }
  return out;
}

function getFatigueFromMap(
  fatigueMap: Map<string, Record<string, unknown>> | undefined,
  sport: League,
  teamAbbr: string,
  asOfYmd: string | undefined
): Record<string, unknown> | null {
  if (!fatigueMap || !asOfYmd) return null;
  return fatigueMap.get(`${sport}|${teamAbbr.toUpperCase()}|${asOfYmd}`) ?? null;
}

function netXg(m: Record<string, unknown> | undefined): number | null {
  if (!m) return null;
  const xf = num(m.team_xg_for);
  const xa = num(m.team_xg_against);
  if (xf == null || xa == null) return null;
  return xf - xa;
}

function applySoccer(
  g: GamePrediction,
  homeM: TeamRow | undefined,
  awayM: TeamRow | undefined,
  matchup: Record<string, unknown> | null,
  fatH: Record<string, unknown> | null,
  fatA: Record<string, unknown> | null
): GamePrediction {
  const reasons: string[] = [];
  let homeDelta = 0;
  let signals = 0;

  const hn = netXg(homeM?.metrics);
  const an = netXg(awayM?.metrics);
  let threeWayOut = g.threeWay ? { ...g.threeWay } : undefined;
  if (hn != null && an != null) {
    const diff = hn - an;
    homeDelta += clamp(diff * 2.2, -4, 4);
    if (Math.abs(diff) >= 0.12) {
      signals += 1;
      reasons.push(
        diff > 0
          ? `${g.homeTeam.abbreviation} carrying a higher xG profile than ${g.awayTeam.abbreviation} recently.`
          : `${g.awayTeam.abbreviation} carrying a higher xG profile than ${g.homeTeam.abbreviation} recently.`
      );
    }
    if (Math.abs(diff) < 0.08 && threeWayOut) {
      signals += 1;
      threeWayOut = nudgeDrawUp(threeWayOut, 2);
      reasons.push("Similar underlying xG profiles — draw mass adjusted slightly.");
    }
  }

  const possH = num(homeM?.metrics?.possession_percentage);
  const possA = num(awayM?.metrics?.possession_percentage);
  if (possH != null && possA != null && Math.abs(possH - possA) >= 8) {
    signals += 1;
    homeDelta += possH > possA ? 0.8 : -0.8;
    reasons.push(
      possH > possA
        ? `${g.homeTeam.abbreviation} controlling possession more reliably in the sample.`
        : `${g.awayTeam.abbreviation} seeing more of the ball in the sample.`
    );
  }

  const pressH = num(homeM?.metrics?.pressing_intensity);
  const pressA = num(awayM?.metrics?.pressing_intensity);
  if (pressH != null && pressA != null && Math.abs(pressH - pressA) >= 10) {
    signals += 1;
    homeDelta += pressH > pressA ? 0.6 : -0.6;
    reasons.push("Pressing intensity differential shows up in the advanced sample.");
  }

  const congH = num(fatH?.congestion_penalty ?? fatH?.fixture_congestion_games_7d ?? homeM?.metrics?.fixture_congestion_games_7d);
  const congA = num(fatA?.congestion_penalty ?? fatA?.fixture_congestion_games_7d ?? awayM?.metrics?.fixture_congestion_games_7d);
  if (congH != null && congA != null && Math.abs(congH - congA) >= 1) {
    signals += 1;
    if (congH > congA) {
      homeDelta -= 1.2;
      reasons.push(`${g.homeTeam.abbreviation} schedule congestion — slight negative adjustment.`);
    } else {
      homeDelta += 1.2;
      reasons.push(`${g.awayTeam.abbreviation} schedule congestion — slight edge to the home side.`);
    }
  }

  const travelA = num(fatA?.travel_km_last_7d ?? awayM?.metrics?.travel_km_last_7d);
  if (travelA != null && travelA > 3500) {
    signals += 1;
    homeDelta += 1;
    reasons.push("Long travel load on the road team in the rolling window.");
  }

  const mh = num(matchup?.home_win_rate_in_sample);
  if (mh != null && mh > 0.35 && mh < 0.85) {
    signals += 1;
    homeDelta += clamp((mh - 0.5) * 8, -2.5, 2.5);
    reasons.push("Head-to-head sample tilts the matchup history (advanced table).");
  }

  if (signals === 0) return g;

  let winProbability = { ...g.winProbability };
  let threeWay = threeWayOut ?? (g.threeWay ? { ...g.threeWay } : undefined);
  if (threeWay) {
    threeWay = shiftThreeWay(threeWay, homeDelta * 0.35);
    winProbability = { home: threeWay.home, away: threeWay.away };
  } else {
    winProbability = shiftTwoWay(winProbability, Math.round(homeDelta));
  }

  const topReasons = [...g.topReasons];
  for (const r of reasons) {
    if (!topReasons.some((x) => x.includes(r.slice(0, 28)))) topReasons.splice(Math.min(2, topReasons.length), 0, r);
  }

  return {
    ...g,
    winProbability,
    threeWay,
    confidence: bumpConfidence(g.confidence, signals),
    topReasons: topReasons.slice(0, 8),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function applyNbaNflMlb(
  g: GamePrediction,
  league: "nba" | "nfl" | "mlb",
  homeM: TeamRow | undefined,
  awayM: TeamRow | undefined,
  matchup: Record<string, unknown> | null,
  fatH: Record<string, unknown> | null,
  fatA: Record<string, unknown> | null
): GamePrediction {
  const reasons: string[] = [];
  let homeDelta = 0;
  let signals = 0;

  if (league === "nba") {
    const tsH = num(homeM?.metrics?.true_shooting_pct);
    const tsA = num(awayM?.metrics?.true_shooting_pct);
    if (tsH != null && tsA != null && Math.abs(tsH - tsA) >= 0.04) {
      signals += 1;
      homeDelta += tsH > tsA ? 1.8 : -1.8;
      reasons.push(
        tsH > tsA
          ? "True shooting efficiency favors the home offense in the advanced window."
          : "True shooting efficiency favors the away offense in the advanced window."
      );
    }
    const benchH = num(homeM?.metrics?.bench_net_rating);
    const benchA = num(awayM?.metrics?.bench_net_rating);
    if (benchH != null && benchA != null && Math.abs(benchH - benchA) >= 2) {
      signals += 1;
      homeDelta += benchH > benchA ? 1.2 : -1.2;
      reasons.push("Bench stability differential shows in the rolling advanced metrics.");
    }
    const paceH = num(homeM?.metrics?.pace_factor);
    const paceA = num(awayM?.metrics?.pace_factor);
    if (paceH != null && paceA != null && g.situationalTags.some((t) => t.includes("B2B"))) {
      signals += 1;
      if (paceH > paceA + 2) reasons.push("Higher pace profile with rest flags — monitor rotation depth.");
    }
  }

  if (league === "nfl") {
    const prH = num(homeM?.metrics?.qb_pressure_rate_allowed);
    const prA = num(awayM?.metrics?.qb_pressure_rate_allowed);
    if (prH != null && prA != null) {
      signals += 1;
      homeDelta += prA > prH ? 1.4 : prA < prH ? -1.4 : 0;
      reasons.push("QB pressure trends in the advanced sample favor one pass-protection profile.");
    }
    const rdH = num(homeM?.metrics?.red_zone_td_rate);
    const rdA = num(awayM?.metrics?.red_zone_td_rate);
    if (rdH != null && rdA != null && Math.abs(rdH - rdA) >= 0.05) {
      signals += 1;
      homeDelta += rdH > rdA ? 1.2 : -1.2;
      reasons.push("Red-zone efficiency split from advanced team metrics.");
    }
    const tdH = num(homeM?.metrics?.third_down_rate);
    const tdA = num(awayM?.metrics?.third_down_rate);
    if (tdH != null && tdA != null && Math.abs(tdH - tdA) >= 0.06) {
      signals += 1;
      homeDelta += tdH > tdA ? 1 : -1;
      reasons.push("Third-down conversion profile differs in the rolling window.");
    }
  }

  if (league === "mlb") {
    const brH = num(homeM?.metrics?.barrel_rate);
    const brA = num(awayM?.metrics?.barrel_rate);
    if (brH != null && brA != null && Math.abs(brH - brA) >= 0.02) {
      signals += 1;
      homeDelta += brH > brA ? 1.5 : -1.5;
      reasons.push("Barrel / hard-contact profile tilts slightly in advanced hitting data.");
    }
    const kTrend = num(homeM?.metrics?.pitcher_k_rate_trend);
    const kTrendA = num(awayM?.metrics?.pitcher_k_rate_trend);
    if (kTrend != null && kTrendA != null) {
      signals += 1;
      homeDelta += kTrend > kTrendA ? 1 : -1;
      reasons.push("Pitcher strikeout trend differential in the advanced layer.");
    }
    const bull = num(homeM?.metrics?.bullpen_reliability_score);
    const bullA = num(awayM?.metrics?.bullpen_reliability_score);
    if (bull != null && bullA != null && Math.abs(bull - bullA) >= 1.5) {
      signals += 1;
      homeDelta += bull > bullA ? 1.2 : -1.2;
      reasons.push("Bullpen reliability score from advanced data favors one side.");
    }
  }

  const mh = num(matchup?.home_margin_avg);
  if (mh != null && Math.abs(mh) >= 3) {
    signals += 1;
    homeDelta += clamp(mh * 0.15, -2.5, 2.5);
    reasons.push("Matchup history margin (advanced table) aligns with one side.");
  }

  const injH = num(fatH?.ol_injury_penalty ?? homeM?.metrics?.ol_injury_penalty);
  const injA = num(fatA?.ol_injury_penalty ?? awayM?.metrics?.ol_injury_penalty);
  if (league === "nfl" && injH != null && injA != null && Math.abs(injH - injA) >= 0.5) {
    signals += 1;
    homeDelta += injA > injH ? 1 : -1;
    reasons.push("Offensive-line injury pressure index differs between teams.");
  }

  if (signals === 0) return g;

  const winProbability = shiftTwoWay(g.winProbability, Math.round(homeDelta));
  const topReasons = [...g.topReasons];
  for (const r of reasons) {
    if (!topReasons.some((x) => x.includes(r.slice(0, 26)))) topReasons.splice(Math.min(2, topReasons.length), 0, r);
  }

  return {
    ...g,
    winProbability,
    confidence: bumpConfidence(g.confidence, signals),
    topReasons: topReasons.slice(0, 8),
  };
}

/**
 * Batch-load metrics once per sport, then apply small additive adjustments + reasoning bullets.
 */
export async function applyAdvancedIntelligenceToGames(predictions: GamePrediction[]): Promise<GamePrediction[]> {
  if (!predictions.length) return predictions;

  const byLeague: Record<League, GamePrediction[]> = { nba: [], nfl: [], mlb: [], boxing: [], mma: [] };
  for (const g of predictions) {
    byLeague[g.league].push(g);
  }

  const maps: Partial<Record<League, Map<string, TeamRow>>> = {};
  const matchupMaps: Partial<Record<League, Map<string, Record<string, unknown>>>> = {};
  const fatigueMaps: Partial<Record<League, Map<string, Record<string, unknown>>>> = {};

  for (const league of ["nba", "nfl", "mlb"] as League[]) {
    const list = byLeague[league];
    if (!list.length) continue;
    const season = Math.max(...list.map(seasonFromGame));
    const abbrs: string[] = [];
    for (const g of list) {
      abbrs.push(g.homeTeam.abbreviation, g.awayTeam.abbreviation);
    }
    maps[league] = await loadTeamMetricsMap(league, season, abbrs, "season");

    const teamMap = maps[league];
    if (!teamMap || teamMap.size === 0) continue;

    const candidates = list.filter((g) => {
      const h = g.homeTeam.abbreviation.toUpperCase();
      const a = g.awayTeam.abbreviation.toUpperCase();
      return Boolean(teamMap.get(h) || teamMap.get(a));
    });
    if (!candidates.length) continue;

    const teamsForMatchup: string[] = [];
    const dateTeams = new Map<string, Set<string>>();
    for (const g of candidates) {
      const h = g.homeTeam.abbreviation.toUpperCase();
      const a = g.awayTeam.abbreviation.toUpperCase();
      teamsForMatchup.push(h, a);
      const d = g._meta?.easternYmd;
      if (d) {
        if (!dateTeams.has(d)) dateTeams.set(d, new Set());
        dateTeams.get(d)!.add(h);
        dateTeams.get(d)!.add(a);
      }
    }

    matchupMaps[league] = await loadMatchupMap(league, season, teamsForMatchup);
    fatigueMaps[league] = await loadFatigueMap(league, dateTeams);
  }

  const out: GamePrediction[] = [];
  for (const g of predictions) {
    const league = g.league;
    const map = maps[league];
    if (!map || map.size === 0) {
      out.push(g);
      continue;
    }

    const hAbbr = g.homeTeam.abbreviation.toUpperCase();
    const aAbbr = g.awayTeam.abbreviation.toUpperCase();
    const homeM = map.get(hAbbr);
    const awayM = map.get(aAbbr);
    if (!homeM && !awayM) {
      out.push(g);
      continue;
    }

    const season = seasonFromGame(g);
    const matchup = matchupMaps[league]?.get(matchupPairKey(hAbbr, aAbbr)) ?? null;
    const fatM = fatigueMaps[league];
    const fatH = getFatigueFromMap(fatM, league, hAbbr, g._meta?.easternYmd);
    const fatA = getFatigueFromMap(fatM, league, aAbbr, g._meta?.easternYmd);

    if (league === "boxing" || league === "mma") {
      // Combat sports use a different pipeline — skip team-matchup apply.
      out.push(g);
      continue;
    }
    out.push(applyNbaNflMlb(g, league, homeM, awayM, matchup, fatH, fatA));
  }

  return out;
}
