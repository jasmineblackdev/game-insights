/**
 * Live player edge predictions from ESPN scoreboard leader data.
 * Supports NBA, MLB, NFL (in-season only — NFL returns [] in offseason).
 *
 * Pipeline:
 *  1. Fetch today's scoreboard per sport (parallel)
 *  2. Extract top-5 team leaders per stat category
 *  3. Project vs opponent using win%, home/away, MLB park factor, MLB weather
 *  4. Track first-seen line in sessionStorage — surface line movement on cards
 *  5. Return PlayerEdgePrediction[] with opening_line_value + line_delta
 */

import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import { MLB_PARK_FACTORS, MLB_OUTDOOR_PARKS } from "@/lib/mlbConstants";
import { easternYmd, nextCalendarYmd, ymdToParam } from "@/lib/espnShared";
import {
  getMlbOpponentContext,
  pitcherMultiplier,
  type MlbOppContext,
} from "@/lib/ml/opponentContext/mlbOpponentContext";
import {
  getNbaOpponentContext,
  nbaOpponentMultiplier,
  type NbaOppContext,
} from "@/lib/ml/opponentContext/nbaOpponentContext";
import {
  getWnbaOpponentContext,
  wnbaOpponentMultiplier,
  type WnbaOppContext,
} from "@/lib/ml/opponentContext/wnbaOpponentContext";
import {
  getNflOpponentContext,
  nflOpponentMultiplier,
  type NflOppContext,
} from "@/lib/ml/opponentContext/nflOpponentContext";
import { getAthleteRecentForm } from "@/lib/ml/recentForm";

// ── ESPN scoreboard endpoints ─────────────────────────────────────────────────

const SCOREBOARDS: Record<string, string> = {
  NBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
  WNBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard",
  MLB: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
  NFL: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
};

const TEAM_LEADERS_URLS: Record<string, (teamId: string) => string> = {
  NBA: (id) => `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${id}/leaders`,
  WNBA: (id) => `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/${id}/leaders`,
  MLB: (id) => `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${id}/leaders`,
  NFL: (id) => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/leaders`,
};

/** Per-session cache so we don't refetch the same team repeatedly. */
const _teamLeadersCache = new Map<string, EspnLeaderCategory[]>();

/**
 * Fetch a team's season-leader categories. Used as a fallback when the
 * scoreboard event doesn't carry per-game leaders (common for upcoming
 * NBA / NFL games before tip / kickoff). Cached per session.
 */
async function fetchTeamLeaders(
  sport: "NBA" | "WNBA" | "MLB" | "NFL",
  teamId: string,
): Promise<EspnLeaderCategory[]> {
  const cacheKey = `${sport}:${teamId}`;
  const cached = _teamLeadersCache.get(cacheKey);
  if (cached) return cached;

  const url = TEAM_LEADERS_URLS[sport]?.(teamId);
  if (!url) {
    _teamLeadersCache.set(cacheKey, []);
    return [];
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      _teamLeadersCache.set(cacheKey, []);
      return [];
    }
    const data = (await res.json()) as {
      categories?: EspnLeaderCategory[];
      team?: { categories?: EspnLeaderCategory[] };
    };
    const cats = data.categories ?? data.team?.categories ?? [];
    _teamLeadersCache.set(cacheKey, cats);
    return cats;
  } catch {
    _teamLeadersCache.set(cacheKey, []);
    return [];
  }
}

// ── Stat maps ─────────────────────────────────────────────────────────────────
// ESPN's leader category names vary by sport AND by game state:
//   NBA upcoming: "pointsLeader" / "reboundsLeader" / "assistsLeader"
//   NBA in-game: "points" / "rebounds" / "assists"
//   NFL: "passingYards" / "passingLeader" depending on phase
//   MLB upcoming: "homeRuns" / "strikeouts" / "hits"
// Matcher is substring-based + case-insensitive so all variants resolve.

interface StatMapEntry { statType: string; unit: string; matches: string[] }

// NBA matcher expanded for the team-leaders endpoint, which uses
// averagePoints / averageRebounds / pointsPerGame style names rather
// than the scoreboard's "pointsLeader" / "points".
const NBA_STAT_MAP: Record<string, StatMapEntry> = {
  points: {
    statType: "points", unit: "pts",
    matches: [
      "points", "pointsleader", "pts",
      "averagepoints", "avgpoints", "pointspergame", "ppg",
    ],
  },
  rebounds: {
    statType: "rebounds", unit: "reb",
    matches: [
      "rebounds", "reboundsleader", "reb",
      "averagerebounds", "avgrebounds", "reboundspergame", "rpg",
    ],
  },
  assists: {
    statType: "assists", unit: "ast",
    matches: [
      "assists", "assistsleader", "ast",
      "averageassists", "avgassists", "assistspergame", "apg",
    ],
  },
  threes: {
    statType: "threes", unit: "3PM",
    matches: [
      "threes", "threepointers", "threepointersmade", "3pm",
      "averagethreepointers", "threepointerspergame",
    ],
  },
  steals: {
    statType: "steals", unit: "stl",
    matches: ["steals", "averagesteals", "stealspergame", "stl", "spg"],
  },
  blocks: {
    statType: "blocks", unit: "blk",
    matches: ["blocks", "averageblocks", "blockspergame", "blk", "bpg"],
  },
};

// Combined NBA picks (points + rebounds + assists, etc.) are derived by
// summing the same-athlete entries across the per-stat categories. The
// ESPN scoreboard doesn't expose them directly, but we can produce them
// from the source values we already pulled.
const NBA_COMBINED_PICKS: { statType: string; unit: string; parts: string[] }[] = [
  { statType: "pra",        unit: "PRA", parts: ["points", "rebounds", "assists"] },
  { statType: "pts_reb",    unit: "P+R", parts: ["points", "rebounds"] },
  { statType: "pts_ast",    unit: "P+A", parts: ["points", "assists"] },
  { statType: "reb_ast",    unit: "R+A", parts: ["rebounds", "assists"] },
];

const MLB_STAT_MAP: Record<string, StatMapEntry> = {
  homeRuns: {
    statType: "home_runs", unit: "HR",
    matches: ["homeruns", "hr", "homerunsleader", "homerun"],
  },
  strikeouts: {
    statType: "strikeouts", unit: "K",
    matches: [
      "strikeouts", "strikeoutsleader", "k", "ks", "so",
      "pitchingstrikeouts", "pitcherstrikeouts",
    ],
  },
  hits: {
    statType: "hits", unit: "hits",
    // Deliberately excludes battingAverage / avg — those return a
    // decimal rate (0.296), not a season hit total, and would be
    // incompatible with the per-game conversion logic below.
    matches: ["hits", "hitsleader", "h"],
  },
  rbis: {
    statType: "rbis", unit: "RBI",
    matches: ["rbis", "rbi", "rbisleader", "runsbattedin"],
  },
  runs: {
    statType: "runs", unit: "R",
    matches: ["runs", "runsleader", "runsscored", "r"],
  },
  walks: {
    statType: "walks", unit: "BB",
    matches: ["walks", "walksleader", "bb", "baseonballs"],
  },
  stolenBases: {
    statType: "stolen_bases", unit: "SB",
    matches: ["stolenbases", "stolenbasesleader", "sb", "stolen"],
  },
  doubles: {
    statType: "doubles", unit: "2B",
    matches: ["doubles", "doublesleader", "2b"],
  },
  triples: {
    statType: "triples", unit: "3B",
    matches: ["triples", "triplesleader", "3b"],
  },
  totalBases: {
    statType: "total_bases", unit: "TB",
    matches: ["totalbases", "totalbasesleader", "tb"],
  },
};

/**
 * MLB stats that DraftKings posts as a binary 0.5 O/U line (the real
 * sportsbook shape) — "did the player get any RBI / run / HR / SB /
 * BB / 2B / 3B this game?". The "Sal Stewart Over 29.5 RBIs" bug came
 * from treating ESPN's leader-endpoint *season total* as a per-game
 * line.
 *
 * For these stats the prop ships with lineValue=0.5 and projected_value
 * is the per-game rate (season_total / games_played_estimate). Bigger
 * targets like 2+/3+/4+ RBI live in DraftKings's Same-Game Parlay
 * (SGP) menu — a separate market we don't ingest from ESPN.
 */
const MLB_BINARY_OU_STATS = new Set([
  "rbis", "runs", "home_runs", "stolen_bases", "walks",
  "doubles", "triples",
]);

/**
 * MLB stats DraftKings posts as a *continuous* O/U line (1.5 / 2.5 hits,
 * 1.5 / 2.5 / 3.5 total bases, 4.5 / 5.5 / 6.5 strikeouts for SP,
 * 0.5 / 1.5 batter Ks). ESPN's leader endpoint still returns season
 * totals here, so projection AND line both have to be converted to
 * per-game scale before snapping to .5.
 *
 * Without this, a hits leader sitting on 50 H mid-April reads as
 * "Over 49.5 hits" — same shape of bug that produced the RBI mess.
 */
const MLB_CONTINUOUS_NEEDS_PER_GAME = new Set([
  "hits", "total_bases", "strikeouts",
]);

/**
 * Rough estimate of MLB games played per team as of `today`. The
 * regular season runs ~Mar 27 → Sep 28 (~186 days, 162 games). We
 * approximate with a ratio: gamesPlayed ≈ daysSinceStart × 162/186,
 * clamped to [1, 162]. Used to convert ESPN season totals into
 * per-game rates for binary-O/U props.
 */
function estimateMlbGamesPlayed(today: Date = new Date()): number {
  const year = today.getUTCFullYear();
  // Season start — approximate; ESPN doesn't expose a per-season start
  // date conveniently, so this is good enough for the projection scale.
  const start = new Date(Date.UTC(year, 2, 27)); // Mar 27
  const daysSinceStart = Math.max(1, Math.floor((today.getTime() - start.getTime()) / 86_400_000));
  const games = Math.round(daysSinceStart * 162 / 186);
  return Math.max(1, Math.min(162, games));
}

/**
 * Combined MLB picks. We don't get singles directly from ESPN, but we can
 * derive an "extra_base_hits" approximation from doubles + triples + HR
 * when those are present. Other combos sum existing per-game averages.
 */
const MLB_COMBINED_PICKS: { statType: string; unit: string; parts: string[] }[] = [
  { statType: "hits_runs_rbis",          unit: "H+R+RBI",   parts: ["hits", "runs", "rbis"] },
  { statType: "hits_runs",               unit: "H+R",       parts: ["hits", "runs"] },
  { statType: "runs_rbis",               unit: "R+RBI",     parts: ["runs", "rbis"] },
  { statType: "hits_stolen_bases",       unit: "H+SB",      parts: ["hits", "stolen_bases"] },
  { statType: "hits_walks_stolen_bases", unit: "H+BB+SB",   parts: ["hits", "walks", "stolen_bases"] },
  { statType: "extra_base_hits",         unit: "XBH",       parts: ["doubles", "triples", "home_runs"] },
];

const NFL_STAT_MAP: Record<string, StatMapEntry> = {
  passingYards: {
    statType: "passing_yards", unit: "pass yds",
    matches: [
      "passingyards", "passyards", "passingleader", "passing",
      "passingyardspergame", "yardsperpass", "passing yards",
    ],
  },
  rushingYards: {
    statType: "rushing_yards", unit: "rush yds",
    matches: [
      "rushingyards", "rushyards", "rushingleader", "rushing",
      "rushingyardspergame", "yardsperrush",
    ],
  },
  receivingYards: {
    statType: "receiving_yards", unit: "rec yds",
    matches: [
      "receivingyards", "receivingleader", "receiving",
      "receivingyardspergame",
    ],
  },
  receptions: {
    statType: "receptions", unit: "rec",
    matches: ["receptions", "receptionsleader", "rec"],
  },
};

const SPORT_STAT_MAP: Record<string, Record<string, StatMapEntry>> = {
  NBA: NBA_STAT_MAP,
  WNBA: NBA_STAT_MAP, // WNBA uses the same per-game stat names as NBA
  MLB: MLB_STAT_MAP,
  NFL: NFL_STAT_MAP,
};

/** Look up the stat-map entry for an ESPN leader category name (case-insensitive). */
function resolveStatMapping(
  statMap: Record<string, StatMapEntry>,
  rawCategory: string,
): StatMapEntry | undefined {
  const lc = rawCategory.toLowerCase().replace(/[\s_-]/g, "");
  for (const entry of Object.values(statMap)) {
    if (entry.matches.includes(lc)) return entry;
  }
  return undefined;
}

// ── ESPN raw types ────────────────────────────────────────────────────────────

interface EspnLeaderEntry {
  displayValue: string;
  value?: number;
  athlete?: {
    id?: string;
    displayName?: string;
    fullName?: string;
    team?: { id?: string; abbreviation?: string };
  };
}

interface EspnLeaderCategory {
  name?: string;
  leaders?: EspnLeaderEntry[];
}

interface EspnCompetitorRaw {
  homeAway?: string;
  team?: { id?: string; abbreviation?: string; displayName?: string };
  records?: { type?: string; summary?: string }[];
  leaders?: EspnLeaderCategory[];
}

interface EspnProbablePitcherRaw {
  homeAway?: string;
  athlete?: { id?: string; displayName?: string; fullName?: string };
  statistics?: { name?: string; displayValue?: unknown; value?: unknown }[];
}

interface EspnCompetitionRaw {
  date?: string;
  status?: { type?: { state?: string } };
  competitors?: EspnCompetitorRaw[];
  /** MLB only — pre-game starters with athlete IDs and handedness. */
  probables?: EspnProbablePitcherRaw[];
}

/** Parse MLB probable pitchers from a competition. Returns one entry per side. */
function parseMlbProbables(comp: EspnCompetitionRaw): {
  id?: string;
  name: string;
  hand?: "L" | "R";
  homeAway: "home" | "away";
}[] {
  const raw = comp.probables;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => {
    const name = (p.athlete?.displayName ?? p.athlete?.fullName ?? "").trim();
    if (!name) return [];
    const id = p.athlete?.id;
    const homeAway = p.homeAway === "home" ? "home" : "away";
    const throwingStat = p.statistics?.find(
      (s) => s.name === "throws" || s.name === "throwingHand",
    );
    const rawHandRaw = throwingStat?.displayValue ?? throwingStat?.value ?? "";
    const rawHand = typeof rawHandRaw === "string" ? rawHandRaw : "";
    const hand: "L" | "R" | undefined =
      rawHand.toLowerCase().startsWith("l") ? "L"
      : rawHand.toLowerCase().startsWith("r") ? "R"
      : undefined;
    return [{ id, name, hand, homeAway }];
  });
}

interface EspnEventRaw {
  id?: string;
  competitions?: EspnCompetitionRaw[];
}

// ── Opening line sessionStorage ───────────────────────────────────────────────

const PROP_OPENING_KEY = "gamelens-prop-opening-v1";

function readPropOpenings(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(PROP_OPENING_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch { return {}; }
}

function mergePropOpenings(entries: { id: string; line: number }[]): Record<string, number> {
  const map = readPropOpenings();
  let changed = false;
  for (const { id, line } of entries) {
    if (map[id] == null) { map[id] = line; changed = true; }
  }
  if (changed) {
    try { sessionStorage.setItem(PROP_OPENING_KEY, JSON.stringify(map)); } catch { /* quota */ }
  }
  return map;
}

// ── Weather cache (Open-Meteo, no API key, 15 min TTL) ──────────────────────
// Shared between MLB park weather and NFL outdoor-stadium weather. Cache key
// is sport-prefixed to avoid collisions on shared abbreviations (e.g. KC).

type WeatherData = { tempF: number | null; windMph: number | null };
const _weatherCache = new Map<string, { data: WeatherData; ts: number }>();
const WEATHER_TTL_MS = 15 * 60 * 1000;

/**
 * Outdoor NFL stadiums where weather meaningfully shifts passing /
 * receiving expectations. Domes and retractable roofs (closed by
 * default in cold-weather cities) are excluded — weather is irrelevant
 * inside. Coordinates are stadium centroids; precision is fine since
 * Open-Meteo grids are ~10 km.
 */
const NFL_OUTDOOR_STADIUMS: Record<string, { lat: number; lon: number; name: string }> = {
  BAL: { lat: 39.2780, lon: -76.6227, name: "M&T Bank Stadium" },
  BUF: { lat: 42.7738, lon: -78.7870, name: "Highmark Stadium" },
  CAR: { lat: 35.2258, lon: -80.8528, name: "Bank of America Stadium" },
  CHI: { lat: 41.8623, lon: -87.6167, name: "Soldier Field" },
  CIN: { lat: 39.0954, lon: -84.5160, name: "Paycor Stadium" },
  CLE: { lat: 41.5061, lon: -81.6995, name: "Cleveland Browns Stadium" },
  DEN: { lat: 39.7439, lon: -105.0201, name: "Empower Field" },
  GB:  { lat: 44.5013, lon: -88.0622, name: "Lambeau Field" },
  JAX: { lat: 30.3239, lon: -81.6373, name: "EverBank Stadium" },
  KC:  { lat: 39.0490, lon: -94.4839, name: "Arrowhead Stadium" },
  MIA: { lat: 25.9580, lon: -80.2389, name: "Hard Rock Stadium" },
  NE:  { lat: 42.0909, lon: -71.2643, name: "Gillette Stadium" },
  NYG: { lat: 40.8136, lon: -74.0744, name: "MetLife Stadium" },
  NYJ: { lat: 40.8136, lon: -74.0744, name: "MetLife Stadium" },
  PHI: { lat: 39.9008, lon: -75.1675, name: "Lincoln Financial Field" },
  PIT: { lat: 40.4468, lon: -80.0158, name: "Acrisure Stadium" },
  SEA: { lat: 47.5952, lon: -122.3316, name: "Lumen Field" },
  SF:  { lat: 37.4030, lon: -121.9697, name: "Levi's Stadium" },
  TB:  { lat: 27.9759, lon: -82.5033, name: "Raymond James Stadium" },
  TEN: { lat: 36.1665, lon: -86.7713, name: "Nissan Stadium" },
  WAS: { lat: 38.9078, lon: -76.8645, name: "Northwest Stadium" },
};

async function fetchOpenMeteoWeather(lat: number, lon: number): Promise<WeatherData> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,wind_speed_10m&wind_speed_unit=mph&temperature_unit=fahrenheit`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return { tempF: null, windMph: null };
    const j = (await res.json()) as {
      current?: { temperature_2m?: number; wind_speed_10m?: number };
    };
    return {
      tempF:   j.current?.temperature_2m  ?? null,
      windMph: j.current?.wind_speed_10m  ?? null,
    };
  } catch {
    return { tempF: null, windMph: null };
  }
}

async function fetchMlbWeather(homeAbbr: string): Promise<WeatherData> {
  const key = `MLB:${homeAbbr}`;
  const cached = _weatherCache.get(key);
  if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) return cached.data;

  const park = MLB_OUTDOOR_PARKS[homeAbbr.toUpperCase()];
  if (!park) return { tempF: null, windMph: null };

  const data = await fetchOpenMeteoWeather(park.lat, park.lon);
  _weatherCache.set(key, { data, ts: Date.now() });
  return data;
}

async function fetchNflWeather(homeAbbr: string): Promise<WeatherData> {
  const key = `NFL:${homeAbbr}`;
  const cached = _weatherCache.get(key);
  if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) return cached.data;

  const stadium = NFL_OUTDOOR_STADIUMS[homeAbbr.toUpperCase()];
  if (!stadium) return { tempF: null, windMph: null };

  const data = await fetchOpenMeteoWeather(stadium.lat, stadium.lon);
  _weatherCache.set(key, { data, ts: Date.now() });
  return data;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function overallWinPct(competitor: EspnCompetitorRaw): number {
  const rec = competitor.records?.find((r) => r.type === "total" || r.type === "overall");
  const summary = rec?.summary ?? "0-0";
  const parts = summary.split("-").map(Number);
  const w = parts[0] ?? 0;
  const l = parts[1] ?? 0;
  return w + l > 0 ? w / (w + l) : 0.5;
}

/**
 * Snap a raw projection (e.g. 28.803...) to a clean sportsbook line at .5
 * intervals (e.g. 28.5). Books always set lines at half-points so there
 * are no pushes. Used for line_value / projected_value display.
 */
function snapToHalfPoint(v: number): number {
  return Math.round(v - 0.5) + 0.5;
}

function projectValue(
  seasonAvg: number,
  opponentWinPct: number,
  isHome: boolean,
  sport: string,
  homeAbbr: string,
  weather?: WeatherData,
  statType?: string,
): number {
  // Opponent quality multiplier
  let m: number;
  if      (opponentWinPct < 0.35) m = 1.08;
  else if (opponentWinPct < 0.45) m = 1.04;
  else if (opponentWinPct > 0.65) m = 0.92;
  else if (opponentWinPct > 0.55) m = 0.96;
  else                             m = 1.00;

  if (isHome) m *= 1.025; // home-field boost

  // MLB: park factor + weather adjustments (half-weight for individual stats)
  if (sport === "MLB") {
    const park = MLB_PARK_FACTORS[homeAbbr.toUpperCase()];
    if (park) m *= 1 + (park.factor - 1) * 0.5;
    if (weather?.windMph != null && weather.windMph >= 15) m *= 1.04;
    if (weather?.tempF   != null && weather.tempF   <  45) m *= 0.96;
  }

  // NFL: wind > 15 mph and cold (<35°F) suppress passing-game volume.
  // Empirically passing yards drop ~6-9% in 15-20 mph wind and ~10-12%
  // in 20+ mph. Rushing is largely unaffected (slight bump from a more
  // run-heavy gameplan offsets weather drag), so we only adjust the
  // pass-game stat types.
  if (sport === "NFL" && statType && weather) {
    const isPassGame = statType === "passing_yards"
      || statType === "passing_tds"
      || statType === "completions"
      || statType === "receiving_yards"
      || statType === "receptions";
    if (isPassGame) {
      if (weather.windMph != null) {
        if (weather.windMph >= 20) m *= 0.90;
        else if (weather.windMph >= 15) m *= 0.94;
      }
      if (weather.tempF != null && weather.tempF < 35) m *= 0.97;
    }
  }

  return Math.round(seasonAvg * m * 10) / 10;
}

/** Sport-aware thresholds — NFL yardage numbers are much larger than NBA/MLB. */
function edgeThresholds(sport: string): { high: number; med: number } {
  if (sport === "NFL") return { high: 20, med: 8 };
  if (sport === "MLB") return { high: 1.5, med: 0.5 };
  return { high: 2.5, med: 1.0 }; // NBA default
}

function edgeToConfidence(edgeMag: number, sport: string): "HIGH" | "MED" | "LOW" {
  const t = edgeThresholds(sport);
  if (edgeMag >= t.high) return "HIGH";
  if (edgeMag >= t.med)  return "MED";
  return "LOW";
}

function formatGameTime(dateStr: string): string {
  try {
    return (
      new Date(dateStr).toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }) + " ET"
    );
  } catch { return "Today"; }
}

function buildReasons(
  name: string,
  statType: string,
  unit: string,
  seasonAvg: number,
  projected: number,
  oppAbbr: string,
  opponentWinPct: number,
  direction: "MORE" | "LESS",
  sport: string,
  homeAbbr: string,
  weather?: WeatherData
): { reason_1: string; reason_2: string; risk_factor: string } {
  const oppQ =
    opponentWinPct < 0.40 ? "weak" :
    opponentWinPct > 0.60 ? "strong" :
    "average";

  const trend = direction === "MORE" ? "above" : "below";

  // For MLB stats where ESPN gives season totals (binary O/U like
  // RBI/runs/HR/SB/BB/2B/3B AND continuous O/U like hits/TB/K),
  // `seasonAvg` is actually the season TOTAL and `projected` is the
  // per-game rate. Frame the reason honestly about both numbers — not
  // a misleading "Season avg 29 RBI" or "Season avg 50 hits".
  const isMlbBinary = sport === "MLB" && MLB_BINARY_OU_STATS.has(statType);
  const isMlbContinuousSeason = sport === "MLB" && MLB_CONTINUOUS_NEEDS_PER_GAME.has(statType);
  // Round seasonAvg for display — ESPN sometimes returns un-rounded
  // floats (e.g. 28.285714... PPG) which leak straight into the reason
  // text and look unprofessional.
  const seasonAvgDisplay = Number.isFinite(seasonAvg)
    ? Math.round(seasonAvg * 10) / 10
    : seasonAvg;
  const reason_1 = isMlbBinary
    ? `${seasonAvgDisplay} ${unit} on season → ~${projected.toFixed(2)} ${unit}/game projected. ${direction === "MORE" ? "Over" : "Under"} 0.5 vs ${oppAbbr}'s ${oppQ} defense.`
    : isMlbContinuousSeason
      ? `${seasonAvgDisplay} ${unit} on season → ~${projected.toFixed(1)} ${unit}/game projected vs ${oppAbbr}'s ${oppQ} defense.`
      : `Season avg ${seasonAvgDisplay} ${unit} — projected ${trend} average vs ${oppAbbr}'s ${oppQ} defense.`;

  let reason_2 = `${oppAbbr} win rate ${Math.round(opponentWinPct * 100)}% — ${
    oppQ === "weak"   ? "lighter opposition inflates opportunity" :
    oppQ === "strong" ? "top-tier opponent suppresses output" :
                        "matchup projects as neutral"
  }.`;

  if (sport === "MLB") {
    const park = MLB_PARK_FACTORS[homeAbbr.toUpperCase()];
    if (park && park.factor >= 1.06) {
      reason_2 += ` Hitter-friendly park (${park.note.split(" — ")[1] ?? ""}).`;
    } else if (park && park.factor <= 0.93) {
      reason_2 += ` Pitcher-friendly park (${park.note.split(" — ")[1] ?? ""}).`;
    }
    if (weather?.windMph != null && weather.windMph >= 15) {
      reason_2 += ` Wind ${Math.round(weather.windMph)} mph — may move fly balls.`;
    }
    if (weather?.tempF != null && weather.tempF < 45) {
      reason_2 += ` Cold (${Math.round(weather.tempF)}°F) — suppresses offense.`;
    }
  }

  if (sport === "NFL") {
    const isPassGame = statType === "passing_yards" || statType === "passing_tds"
      || statType === "completions" || statType === "receiving_yards" || statType === "receptions";
    if (isPassGame && weather?.windMph != null && weather.windMph >= 15) {
      reason_2 += ` Wind ${Math.round(weather.windMph)} mph at outdoor stadium — passing game suppressed.`;
    }
    if (isPassGame && weather?.tempF != null && weather.tempF < 35) {
      reason_2 += ` Cold (${Math.round(weather.tempF)}°F) — drops, glove issues.`;
    }
  }

  return {
    reason_1,
    reason_2,
    risk_factor: `Game script changes or usage decisions can shift ${name}'s ${statType} volume materially.`,
  };
}

// ── Core fetch ────────────────────────────────────────────────────────────────

async function fetchSportPlayerEdge(
  sport: "NBA" | "WNBA" | "MLB" | "NFL",
  sortBase: number
): Promise<PlayerEdgePrediction[]> {
  const baseUrl = SCOREBOARDS[sport];
  const statMap = SPORT_STAT_MAP[sport] ?? {};

  // Fetch today AND tomorrow so the Tomorrow tab has player props matching
  // tomorrow's game slate. The team-game fetchers already pull two days
  // this way; this keeps props aligned with that behaviour.
  const today    = easternYmd();
  const tomorrow = nextCalendarYmd(today);
  const urls = [
    `${baseUrl}?dates=${ymdToParam(today)}`,
    `${baseUrl}?dates=${ymdToParam(tomorrow)}`,
  ];

  const events: EspnEventRaw[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = (await res.json()) as { events?: EspnEventRaw[] };
      for (const ev of data.events ?? []) events.push(ev);
    } catch {
      // silent — fall through to any events we did pull
    }
  }
  if (!events.length) return [];
  const predictions: PlayerEdgePrediction[] = [];
  const t = edgeThresholds(sport);

  // Per-athlete per-event accumulator for combined NBA picks (PRA / P+R / etc).
  // Key: `${eventId}:${athleteId}`. Value: { name, team, opp, isHome, oppWinPct, stats: { points: n, ... } }
  type AthleteAcc = {
    athleteId: string;
    name: string;
    team: string;
    opponent: string;
    isHome: boolean;
    oppWinPct: number;
    eventId: string;
    gameTime: string;
    propSource: "scoreboard" | "team_leaders" | "unavailable";
    stats: Record<string, number>;
    /** MLB only — opposing SP context, used by combined-pick emitter. */
    mlbOpposingSp?: MlbOppContext | null;
    /** NBA only — opposing team-defense context, used by combined-pick emitter. */
    nbaOpposingDef?: NbaOppContext | null;
    /** WNBA only — opposing team-defense context, used by combined-pick emitter. */
    wnbaOpposingDef?: WnbaOppContext | null;
  };
  const athleteStatMap = new Map<string, AthleteAcc>();

  /** Parse "18.1 PPG, 7.5 RPG, 5.9 APG, 1.4 SPG, 1.5 BPG" into per-stat numbers. */
  function parseRatingString(raw: string | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    if (!raw) return out;
    const re = /(\d+\.?\d*)\s*(PPG|RPG|APG|SPG|BPG|3PM)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const v = Number(m[1]);
      const k = m[2].toUpperCase();
      if (!Number.isFinite(v)) continue;
      const stat = k === "PPG" ? "points"
                 : k === "RPG" ? "rebounds"
                 : k === "APG" ? "assists"
                 : k === "SPG" ? "steals"
                 : k === "BPG" ? "blocks"
                 : k === "3PM" ? "threes"
                 : null;
      if (stat) out[stat] = v;
    }
    return out;
  }

  for (const event of events) {
    const comp = event.competitions?.[0];
    if (!comp?.competitors || comp.competitors.length < 2) continue;
    if (comp.status?.type?.state === "post") continue; // skip completed games

    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    if (!home || !away) continue;

    const homeAbbr = home.team?.abbreviation ?? "HOM";
    const awayAbbr = away.team?.abbreviation ?? "AWY";
    const gameTime = formatGameTime(comp.date ?? "");
    const eventId  = event.id ?? `${sport}-${Date.now()}`;

    // Weather fetch (cached per team, per session). MLB uses outdoor
    // park coords; NFL uses outdoor stadium coords. Domes/closed roofs
    // return { tempF: null, windMph: null } and projectValue no-ops.
    const weather =
      sport === "MLB" ? await fetchMlbWeather(homeAbbr).catch(() => ({ tempF: null, windMph: null }))
      : sport === "NFL" ? await fetchNflWeather(homeAbbr).catch(() => ({ tempF: null, windMph: null }))
      : undefined;

    // MLB pitcher context — parse probable starters from the competition,
    // then resolve each side's full SP context (ERA/WHIP/K9/BB9/HR9) in
    // parallel. The context cache makes repeat fetches free across games
    // when an SP is reused (rare) and across all hitters on the opposing
    // team (common — every hitter on team A faces team B's same SP).
    let mlbHomeSpCtx: MlbOppContext | null = null;
    let mlbAwaySpCtx: MlbOppContext | null = null;
    if (sport === "MLB") {
      const probables = parseMlbProbables(comp);
      const homeSp = probables.find((p) => p.homeAway === "home");
      const awaySp = probables.find((p) => p.homeAway === "away");
      const [hCtx, aCtx] = await Promise.all([
        homeSp ? getMlbOpponentContext({ spId: homeSp.id, spName: homeSp.name, spHand: homeSp.hand }) : Promise.resolve(null),
        awaySp ? getMlbOpponentContext({ spId: awaySp.id, spName: awaySp.name, spHand: awaySp.hand }) : Promise.resolve(null),
      ]);
      mlbHomeSpCtx = hCtx;
      mlbAwaySpCtx = aCtx;
    }

    // NBA team-defense context — resolve each side's full team-stats
    // payload (pace, def rating, opponent stats allowed) in parallel.
    // Cached per teamId so every player on a roster shares one fetch.
    let nbaHomeDefCtx: NbaOppContext | null = null;
    let nbaAwayDefCtx: NbaOppContext | null = null;
    if (sport === "NBA") {
      const [hCtx, aCtx] = await Promise.all([
        getNbaOpponentContext(home.team?.id),
        getNbaOpponentContext(away.team?.id),
      ]);
      nbaHomeDefCtx = hCtx;
      nbaAwayDefCtx = aCtx;
    }

    // WNBA team-defense context — separate cache + league averages
    // from NBA so calibration buckets stay isolated.
    let wnbaHomeDefCtx: WnbaOppContext | null = null;
    let wnbaAwayDefCtx: WnbaOppContext | null = null;
    if (sport === "WNBA") {
      const [hCtx, aCtx] = await Promise.all([
        getWnbaOpponentContext(home.team?.id),
        getWnbaOpponentContext(away.team?.id),
      ]);
      wnbaHomeDefCtx = hCtx;
      wnbaAwayDefCtx = aCtx;
    }

    // NFL defense-by-phase context — pass/rush yds allowed, sacks,
    // takeaways, plays per game.
    let nflHomeDefCtx: NflOppContext | null = null;
    let nflAwayDefCtx: NflOppContext | null = null;
    if (sport === "NFL") {
      const [hCtx, aCtx] = await Promise.all([
        getNflOpponentContext(home.team?.id),
        getNflOpponentContext(away.team?.id),
      ]);
      nflHomeDefCtx = hCtx;
      nflAwayDefCtx = aCtx;
    }

    for (const competitor of [home, away]) {
      const teamAbbr = competitor.team?.abbreviation ?? "";
      const teamId   = competitor.team?.id;
      const isHome   = competitor === home;
      const oppAbbr  = isHome ? awayAbbr : homeAbbr;
      const oppComp  = isHome ? away : home;
      const oppWinPct = overallWinPct(oppComp);

      // For MLB hitters on team A, the opposing SP is team B's pitcher.
      const opposingSpCtx: MlbOppContext | null = sport === "MLB"
        ? (isHome ? mlbAwaySpCtx : mlbHomeSpCtx)
        : null;

      // For NBA players on team A, opposing team-defense is team B's.
      const opposingNbaDefCtx: NbaOppContext | null = sport === "NBA"
        ? (isHome ? nbaAwayDefCtx : nbaHomeDefCtx)
        : null;
      const opposingWnbaDefCtx: WnbaOppContext | null = sport === "WNBA"
        ? (isHome ? wnbaAwayDefCtx : wnbaHomeDefCtx)
        : null;
      const opposingNflDefCtx: NflOppContext | null = sport === "NFL"
        ? (isHome ? nflAwayDefCtx : nflHomeDefCtx)
        : null;

      // Scoreboard often omits leaders for upcoming games (especially NBA
      // pre-tip). Fall back to the team's season leaders endpoint so the
      // prop pool isn't empty just because tipoff hasn't happened yet.
      // Track which source we used so we can surface it in the UI badge.
      let leaderCategories = competitor.leaders ?? [];
      let propSource: "scoreboard" | "team_leaders" | "unavailable" = "scoreboard";
      if (!leaderCategories.length) {
        if (teamId) {
          leaderCategories = await fetchTeamLeaders(sport, teamId);
          propSource = leaderCategories.length ? "team_leaders" : "unavailable";
        } else {
          propSource = "unavailable";
        }
      }

      for (const category of leaderCategories) {
        const catName = category.name ?? "";

        // Special-case: NBA scoreboard's "rating" category packs SPG/BPG (and
        // sometimes 3PM) into displayValue. Parse it for the named athlete and
        // feed the per-athlete accumulator so combined picks can use these.
        if ((sport === "NBA" || sport === "WNBA") && catName.toLowerCase() === "rating") {
          const leaders = (category.leaders ?? []).slice(0, 5);
          for (const L of leaders) {
            const ath = L.athlete;
            if (!ath?.displayName) continue;
            const aid = String(ath.id ?? `ath-rating-${ath.displayName}`);
            const parsed = parseRatingString(L.displayValue);
            const accKey = `${eventId}:${aid}`;
            const acc = athleteStatMap.get(accKey) ?? {
              athleteId: aid, name: ath.displayName, team: teamAbbr,
              opponent: oppAbbr, isHome, oppWinPct, eventId, gameTime, propSource,
              stats: {},
            };
            for (const [k, v] of Object.entries(parsed)) {
              if (acc.stats[k] == null) acc.stats[k] = v;
            }
            athleteStatMap.set(accKey, acc);
          }
          continue;
        }

        const mapping = resolveStatMapping(statMap, catName);
        if (!mapping) continue;

        // Top 5 leaders per category for broader coverage
        const leaders = (category.leaders ?? []).slice(0, 5);

        // Pre-fetch recent form for all leaders in this category in
        // parallel — avoids serializing N HTTP calls inside the loop.
        // For MLB stats where ESPN returns season totals, divide by
        // games played first so the per-game baseline matches the
        // gamelog scale.
        const isMlbSeasonTotalStat = sport === "MLB" && (
          MLB_BINARY_OU_STATS.has(mapping.statType) ||
          MLB_CONTINUOUS_NEEDS_PER_GAME.has(mapping.statType)
        );
        const recentForms = await Promise.all(
          leaders.map(async (leader) => {
            const v = leader.value ?? Number.parseFloat(leader.displayValue);
            if (!Number.isFinite(v) || v <= 0 || !leader.athlete?.id) return null;
            const seasonPerGame = isMlbSeasonTotalStat
              ? v / estimateMlbGamesPlayed()
              : v;
            return getAthleteRecentForm({
              sport,
              athleteId: String(leader.athlete.id),
              statType: mapping.statType,
              seasonPerGame,
            });
          })
        );

        for (const [leaderIdx, leader] of leaders.entries()) {
          const name = leader.athlete?.displayName ?? leader.athlete?.fullName;
          if (!name) continue;

          const value = leader.value ?? Number.parseFloat(leader.displayValue);
          if (!Number.isFinite(value) || value <= 0) continue;

          // Accumulate this stat for the athlete so combined picks can use it
          if ((sport === "NBA" || sport === "WNBA" || sport === "MLB") && leader.athlete?.id) {
            const aid = String(leader.athlete.id);
            const accKey = `${eventId}:${aid}`;
            const acc = athleteStatMap.get(accKey) ?? {
              athleteId: aid, name, team: teamAbbr,
              opponent: oppAbbr, isHome, oppWinPct, eventId, gameTime, propSource,
              stats: {},
              mlbOpposingSp: sport === "MLB" ? opposingSpCtx : undefined,
              nbaOpposingDef: sport === "NBA" ? opposingNbaDefCtx : undefined,
              wnbaOpposingDef: sport === "WNBA" ? opposingWnbaDefCtx : undefined,
            };
            if (acc.stats[mapping.statType] == null) {
              acc.stats[mapping.statType] = value;
            }
            athleteStatMap.set(accKey, acc);
          }

          const baseProjection = projectValue(value, oppWinPct, isHome, sport, homeAbbr, weather, mapping.statType);
          const pitcherMult = sport === "MLB" && opposingSpCtx
            ? pitcherMultiplier(mapping.statType, opposingSpCtx)
            : 1.0;
          const nbaDefMult = sport === "NBA" && opposingNbaDefCtx
            ? nbaOpponentMultiplier(mapping.statType, opposingNbaDefCtx)
            : 1.0;
          const wnbaDefMult = sport === "WNBA" && opposingWnbaDefCtx
            ? wnbaOpponentMultiplier(mapping.statType, opposingWnbaDefCtx)
            : 1.0;
          const nflDefMult = sport === "NFL" && opposingNflDefCtx
            ? nflOpponentMultiplier(mapping.statType, opposingNflDefCtx)
            : 1.0;
          // Recent-form multiplier: blended last-5-game vs season
          // baseline, clamped to [0.6, 1.4]. Neutral (1.0) when the
          // athlete has <2 recent games or season baseline is missing.
          const recentForm = recentForms[leaderIdx];
          const recentFormMult = recentForm?.multiplier ?? 1.0;
          const projectedRaw = baseProjection * pitcherMult * nbaDefMult * wnbaDefMult * nflDefMult * recentFormMult;
          // ESPN's leader endpoint returns season totals, but books post
          // per-game lines. Two MLB cases that need conversion:
          //   1. Binary O/U stats (RBI / runs / HR / SB / BB / 2B / 3B):
          //      sportsbook line is fixed at 0.5; projection = per-game rate.
          //   2. Continuous O/U stats (hits / total_bases / strikeouts):
          //      both the line AND projection convert to per-game rate.
          // Other sports (NBA / WNBA / NFL) come back as per-game-ish
          // averages already, so the existing snapToHalfPoint logic stands.
          const isMlbBinary = sport === "MLB" && MLB_BINARY_OU_STATS.has(mapping.statType);
          const isMlbContinuousSeason = sport === "MLB" && MLB_CONTINUOUS_NEEDS_PER_GAME.has(mapping.statType);
          const mlbGamesPlayed = (isMlbBinary || isMlbContinuousSeason) ? estimateMlbGamesPlayed() : 1;
          const perGameProjection = (isMlbBinary || isMlbContinuousSeason)
            ? Math.round((projectedRaw / mlbGamesPlayed) * 100) / 100
            : Math.round(projectedRaw * 10) / 10;
          const projected = perGameProjection;
          const lineValue = isMlbBinary
            ? 0.5
            : isMlbContinuousSeason
              ? snapToHalfPoint(value / mlbGamesPlayed)
              : snapToHalfPoint(value);
          const edge      = projected - lineValue;
          const direction: "MORE" | "LESS" = edge >= 0 ? "MORE" : "LESS";
          const edgeMag      = Math.abs(edge);
          const confidence   = edgeToConfidence(edgeMag, sport);
          const athleteId    = leader.athlete?.id
            ?? `ath-${catName}-${name.replace(/\s+/g, "-")}`;
          const id = `espn-${sport.toLowerCase()}-${eventId}-${athleteId}-${catName}`;

          const built = buildReasons(
            name, mapping.statType, mapping.unit, value, projected,
            oppAbbr, oppWinPct, direction, sport, homeAbbr, weather
          );
          // Append the matchup note to reason_2 so the user sees why
          // the projection nudged.
          const matchupSuffix = sport === "MLB" && opposingSpCtx
            ? ` ${opposingSpCtx.matchupNote}`
            : sport === "NBA" && opposingNbaDefCtx?.hasData
              ? ` ${opposingNbaDefCtx.matchupNote}`
              : sport === "WNBA" && opposingWnbaDefCtx?.hasData
                ? ` ${opposingWnbaDefCtx.matchupNote}`
                : sport === "NFL" && opposingNflDefCtx?.hasData
                  ? ` ${opposingNflDefCtx.matchupNote}`
                  : "";
          const formSuffix = recentForm?.note ? ` ${recentForm.note}` : "";
          const reason_2 = `${built.reason_2}${matchupSuffix}${formSuffix}`;

          predictions.push({
            id,
            game_id:            eventId,
            player_id:          athleteId,
            player_name:        name,
            sport,
            team:               teamAbbr,
            opponent:           oppAbbr,
            game_time:          gameTime,
            stat_type:          mapping.statType,
            line_value:         lineValue,
            projected_value:    projected,
            prediction_direction: direction,
            edge:               Math.round(edge * 10) / 10,
            confidence,
            reason_1:           built.reason_1,
            reason_2,
            risk_factor:        built.risk_factor,
            game_sort:          sortBase + predictions.length,
            confidence_score_0_100: confidence === "HIGH" ? 72 : confidence === "MED" ? 58 : 44,
            risk_tier:   confidence === "HIGH" ? "safe" : confidence === "MED" ? "balanced" : "longshot",
            // Game-state features for the ML feature vector — these flow into
            // extractMinimalPropFeatures so the model has signal beyond the
            // current projection vs line.
            is_home:               isHome,
            opponent_win_pct:      oppWinPct,
            // recent_form intentionally undefined — the synthetic
            // edge-derived label was double-counting `edge` as a
            // "form" signal in topPropsRanker. The real recent-form
            // signal is computed asynchronously via
            // src/lib/ml/recentForm.ts and applied by
            // enrichWithRealRecentForm() in playerEdgeApi.ts after
            // the rules pass. Leaving undefined so recentHitRate01
            // returns its neutral 0.50 default until the real
            // value is bound.
            recent_form: undefined,
            // Transparency: where the leader came from (live scoreboard vs
            // team-leaders fallback) — surfaced in the Model Status badge.
            prop_source:           propSource,
            consistency_label:
              edgeMag >= t.high ? "stable" :
              edgeMag >= t.med  ? "medium" :
              "volatile",
            // Only signal a trend for meaningful edges to preserve scoring signal
            trend_note: edgeMag >= t.high
              ? (direction === "MORE" ? `Trending ↑ vs ${oppAbbr}` : `Fade vs ${oppAbbr}`)
              : undefined,
            // Matchup badge fields — MLB pitcher / NBA / WNBA / NFL team-defense
            matchup_quality: sport === "MLB"
              ? opposingSpCtx?.matchupQuality
              : sport === "NBA"
                ? opposingNbaDefCtx?.matchupQuality
                : sport === "WNBA"
                  ? opposingWnbaDefCtx?.matchupQuality
                  : sport === "NFL"
                    ? opposingNflDefCtx?.matchupQuality
                    : undefined,
            matchup_note: sport === "MLB"
              ? opposingSpCtx?.matchupNote
              : sport === "NBA"
                ? opposingNbaDefCtx?.matchupNote
                : sport === "WNBA"
                  ? opposingWnbaDefCtx?.matchupNote
                  : sport === "NFL"
                    ? opposingNflDefCtx?.matchupNote
                    : undefined,
          });
        }
      }
    }
  }

  // ── Emit NBA single-stat preds for steals/blocks/threes parsed from
  //    "rating" category, plus combined picks (PRA / P+R / P+A / R+A) for
  //    any athlete with all required parts. WNBA reuses the same shape.
  if (sport === "NBA" || sport === "WNBA") {
    const SINGLE_FROM_RATING: { stat: string; unit: string }[] = [
      { stat: "steals", unit: "stl" },
      { stat: "blocks", unit: "blk" },
      { stat: "threes", unit: "3PM" },
    ];

    // Sport-aware helpers — both NBA and WNBA reuse this branch with
    // different opp-context shapes.
    const sportTag = sport; // "NBA" | "WNBA"
    const idPrefix = sportTag.toLowerCase();

    for (const acc of athleteStatMap.values()) {
      const oppDef = sportTag === "NBA" ? acc.nbaOpposingDef : acc.wnbaOpposingDef;
      const oppMult = (statKey: string): number => {
        if (sportTag === "NBA" && acc.nbaOpposingDef) {
          return nbaOpponentMultiplier(statKey, acc.nbaOpposingDef);
        }
        if (sportTag === "WNBA" && acc.wnbaOpposingDef) {
          return wnbaOpponentMultiplier(statKey, acc.wnbaOpposingDef);
        }
        return 1.0;
      };

      // Single-stat picks for stats we couldn't get directly from a category
      // (steals/blocks/threes typically come from the rating string).
      for (const { stat, unit } of SINGLE_FROM_RATING) {
        const value = acc.stats[stat];
        if (value == null || !Number.isFinite(value) || value <= 0) continue;
        // Skip if we already emitted this exact stat via a category match
        const dupKey = `espn-${idPrefix}-${acc.eventId}-${acc.athleteId}-${stat}`;
        if (predictions.some((p) => p.id === dupKey)) continue;

        const baseProjection = projectValue(value, acc.oppWinPct, acc.isHome, sportTag, "");
        const projectedRaw = baseProjection * oppMult(stat);
        const projected    = Math.round(projectedRaw * 10) / 10;
        const lineValue    = snapToHalfPoint(value);
        const edge         = projected - lineValue;
        const direction: "MORE" | "LESS" = edge >= 0 ? "MORE" : "LESS";
        const edgeMag      = Math.abs(edge);
        const confidence   = edgeToConfidence(edgeMag, sportTag);
        const { reason_1, reason_2: rawReason2, risk_factor } = buildReasons(
          acc.name, stat, unit, value, projected,
          acc.opponent, acc.oppWinPct, direction, sportTag, "",
        );
        const reason_2 = oppDef?.hasData
          ? `${rawReason2} ${oppDef.matchupNote}`
          : rawReason2;

        predictions.push({
          id: dupKey,
          game_id: acc.eventId, player_id: acc.athleteId, player_name: acc.name,
          sport: sportTag, team: acc.team, opponent: acc.opponent, game_time: acc.gameTime,
          stat_type: stat, line_value: lineValue, projected_value: projected,
          prediction_direction: direction, edge: Math.round(edge * 10) / 10, confidence,
          reason_1, reason_2, risk_factor,
          game_sort: sortBase + predictions.length,
          confidence_score_0_100: confidence === "HIGH" ? 72 : confidence === "MED" ? 58 : 44,
          risk_tier: confidence === "HIGH" ? "safe" : confidence === "MED" ? "balanced" : "longshot",
          is_home: acc.isHome, opponent_win_pct: acc.oppWinPct,
          recent_form: undefined, // see #177 — synthetic field removed; bound async by enrichWithRealRecentForm
          prop_source: acc.propSource,
          consistency_label: edgeMag >= t.high ? "stable" : edgeMag >= t.med ? "medium" : "volatile",
          matchup_quality: oppDef?.matchupQuality,
          matchup_note: oppDef?.matchupNote,
        });
      }

      // Combined picks (PRA / P+R / P+A / R+A) — only when we have every
      // required part (no inferring missing values).
      for (const combo of NBA_COMBINED_PICKS) {
        if (!combo.parts.every((p) => acc.stats[p] != null)) continue;
        const sumVal = combo.parts.reduce((s, p) => s + acc.stats[p]!, 0);
        if (!Number.isFinite(sumVal) || sumVal <= 0) continue;

        const baseProjection = projectValue(sumVal, acc.oppWinPct, acc.isHome, sportTag, "");
        const projectedRaw = baseProjection * oppMult(combo.statType);
        const projected    = Math.round(projectedRaw * 10) / 10;
        const lineValue    = snapToHalfPoint(sumVal);
        const edge         = projected - lineValue;
        const direction: "MORE" | "LESS" = edge >= 0 ? "MORE" : "LESS";
        const edgeMag      = Math.abs(edge);
        // Combined-stat thresholds are ~3x single-stat (sum of three averages
        // is naturally noisier), so bump the high bar.
        const confidence: "HIGH" | "MED" | "LOW" =
          edgeMag >= t.high * 2.5 ? "HIGH"
          : edgeMag >= t.med * 2.5 ? "MED" : "LOW";

        const matchupSuffix = oppDef?.hasData
          ? ` ${oppDef.matchupNote}`
          : "";

        predictions.push({
          id: `espn-${idPrefix}-${acc.eventId}-${acc.athleteId}-${combo.statType}`,
          game_id: acc.eventId, player_id: acc.athleteId, player_name: acc.name,
          sport: sportTag, team: acc.team, opponent: acc.opponent, game_time: acc.gameTime,
          stat_type: combo.statType, line_value: lineValue, projected_value: projected,
          prediction_direction: direction, edge: Math.round(edge * 10) / 10, confidence,
          reason_1: `${combo.unit} season avg ${sumVal.toFixed(1)} — projected vs ${acc.opponent}.`,
          reason_2: `Combines ${combo.parts.join(" + ")} — combined props are noisier than singles.${matchupSuffix}`,
          risk_factor: `Combined-stat lines move with usage shifts; monitor late lineup news.`,
          game_sort: sortBase + predictions.length,
          confidence_score_0_100: confidence === "HIGH" ? 72 : confidence === "MED" ? 58 : 44,
          risk_tier: confidence === "HIGH" ? "safe" : confidence === "MED" ? "balanced" : "longshot",
          is_home: acc.isHome, opponent_win_pct: acc.oppWinPct,
          recent_form: undefined, // see #177 — synthetic field removed; bound async by enrichWithRealRecentForm
          prop_source: acc.propSource,
          consistency_label: edgeMag >= t.high * 2.5 ? "stable" : edgeMag >= t.med * 2.5 ? "medium" : "volatile",
          matchup_quality: oppDef?.matchupQuality,
          matchup_note: oppDef?.matchupNote,
        });
      }
    }
  }

  // ── Emit MLB combined picks (H+R+RBI, H+R, R+RBI, H+SB, H+BB+SB, XBH).
  //    Combined-stat lines are noisier than singles, so confidence
  //    threshold is widened (t.high is 1.5 hits; combined needs ~2x).
  //    Like single counting stats, ESPN gives season totals — we
  //    convert to per-game rates so the line lands in the real
  //    DraftKings band (H+R+RBI ~O/U 1.5–2.5, R+RBI ~O/U 0.5–1.5).
  if (sport === "MLB") {
    const mlbGamesPlayed = estimateMlbGamesPlayed();
    for (const acc of athleteStatMap.values()) {
      for (const combo of MLB_COMBINED_PICKS) {
        if (!combo.parts.every((p) => acc.stats[p] != null)) continue;
        const sumVal = combo.parts.reduce((s, p) => s + acc.stats[p]!, 0);
        if (!Number.isFinite(sumVal) || sumVal <= 0) continue;

        // Convert season-sum → per-game-sum so the line sits at the
        // sportsbook scale.
        const sumPerGame = sumVal / mlbGamesPlayed;
        const baseProjection = projectValue(sumPerGame, acc.oppWinPct, acc.isHome, "MLB", "");
        const pitcherMult = acc.mlbOpposingSp
          ? pitcherMultiplier(combo.statType, acc.mlbOpposingSp)
          : 1.0;
        const projectedRaw = baseProjection * pitcherMult;
        const projected    = Math.round(projectedRaw * 10) / 10;
        const lineValue    = snapToHalfPoint(sumPerGame);
        const edge         = projected - lineValue;
        const direction: "MORE" | "LESS" = edge >= 0 ? "MORE" : "LESS";
        const edgeMag      = Math.abs(edge);
        const confidence: "HIGH" | "MED" | "LOW" =
          edgeMag >= t.high * 2.0 ? "HIGH"
          : edgeMag >= t.med * 2.0 ? "MED" : "LOW";

        const matchupSuffix = acc.mlbOpposingSp
          ? ` ${acc.mlbOpposingSp.matchupNote}`
          : "";

        predictions.push({
          id: `espn-mlb-${acc.eventId}-${acc.athleteId}-${combo.statType}`,
          game_id: acc.eventId, player_id: acc.athleteId, player_name: acc.name,
          sport: "MLB", team: acc.team, opponent: acc.opponent, game_time: acc.gameTime,
          stat_type: combo.statType, line_value: lineValue, projected_value: projected,
          prediction_direction: direction, edge: Math.round(edge * 10) / 10, confidence,
          reason_1: `${combo.unit} season avg ${sumVal.toFixed(1)} — projected vs ${acc.opponent}.`,
          reason_2: `Combines ${combo.parts.join(" + ")} — combined props are noisier than singles.${matchupSuffix}`,
          risk_factor: `Combined-stat lines move with lineup spot and pitcher matchup; monitor late SP confirmation.`,
          game_sort: sortBase + predictions.length,
          confidence_score_0_100: confidence === "HIGH" ? 72 : confidence === "MED" ? 58 : 44,
          risk_tier: confidence === "HIGH" ? "safe" : confidence === "MED" ? "balanced" : "longshot",
          is_home: acc.isHome, opponent_win_pct: acc.oppWinPct,
          recent_form: undefined, // see #177 — synthetic field removed; bound async by enrichWithRealRecentForm
          prop_source: acc.propSource,
          consistency_label: edgeMag >= t.high * 2.0 ? "stable" : edgeMag >= t.med * 2.0 ? "medium" : "volatile",
          matchup_quality: acc.mlbOpposingSp?.matchupQuality,
          matchup_note:    acc.mlbOpposingSp?.matchupNote,
        });
      }
    }
  }

  // Apply sessionStorage opening-line tracking, attach line_delta to each prediction
  const openings = mergePropOpenings(predictions.map((p) => ({ id: p.id, line: p.line_value })));
  return predictions.map((p) => {
    const opening = openings[p.id];
    const raw     = opening != null ? Math.round((p.line_value - opening) * 10) / 10 : undefined;
    return {
      ...p,
      opening_line_value: opening,
      line_delta:         raw !== undefined && raw !== 0 ? raw : undefined,
    };
  });
}

// ── Public export ─────────────────────────────────────────────────────────────

export async function fetchLivePlayerEdgePredictions(): Promise<PlayerEdgePrediction[]> {
  const [nba, wnba, mlb, nfl] = await Promise.all([
    fetchSportPlayerEdge("NBA", 0).catch(()     => [] as PlayerEdgePrediction[]),
    fetchSportPlayerEdge("WNBA", 500).catch(()  => [] as PlayerEdgePrediction[]),
    fetchSportPlayerEdge("MLB", 1000).catch(()  => [] as PlayerEdgePrediction[]),
    fetchSportPlayerEdge("NFL", 2000).catch(()  => [] as PlayerEdgePrediction[]),
  ]);
  return [...nba, ...wnba, ...mlb, ...nfl];
}
