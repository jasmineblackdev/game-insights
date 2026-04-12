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

// ── ESPN scoreboard endpoints ─────────────────────────────────────────────────

const SCOREBOARDS: Record<string, string> = {
  NBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
  MLB: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
  NFL: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
};

// ── Stat maps ─────────────────────────────────────────────────────────────────

const NBA_STAT_MAP: Record<string, { statType: string; unit: string }> = {
  points:   { statType: "points",   unit: "pts" },
  rebounds: { statType: "rebounds", unit: "reb" },
  assists:  { statType: "assists",  unit: "ast" },
};

const MLB_STAT_MAP: Record<string, { statType: string; unit: string }> = {
  homeRuns:   { statType: "total_bases", unit: "HR"   },
  strikeouts: { statType: "strikeouts",  unit: "K"    },
  hits:       { statType: "hits",        unit: "hits" },
};

const NFL_STAT_MAP: Record<string, { statType: string; unit: string }> = {
  passingYards:   { statType: "passing_yards",   unit: "pass yds" },
  rushingYards:   { statType: "rushing_yards",   unit: "rush yds" },
  receivingYards: { statType: "receiving_yards", unit: "rec yds"  },
  receptions:     { statType: "receptions",      unit: "rec"      },
};

const SPORT_STAT_MAP: Record<string, typeof NBA_STAT_MAP> = {
  NBA: NBA_STAT_MAP,
  MLB: MLB_STAT_MAP,
  NFL: NFL_STAT_MAP,
};

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

interface EspnCompetitionRaw {
  date?: string;
  status?: { type?: { state?: string } };
  competitors?: EspnCompetitorRaw[];
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

// ── MLB weather cache (Open-Meteo, no API key, 15 min TTL) ───────────────────

type WeatherData = { tempF: number | null; windMph: number | null };
const _weatherCache = new Map<string, { data: WeatherData; ts: number }>();
const WEATHER_TTL_MS = 15 * 60 * 1000;

async function fetchMlbWeather(homeAbbr: string): Promise<WeatherData> {
  const cached = _weatherCache.get(homeAbbr);
  if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) return cached.data;

  const park = MLB_OUTDOOR_PARKS[homeAbbr.toUpperCase()];
  if (!park) return { tempF: null, windMph: null };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${park.lat}&longitude=${park.lon}` +
      `&current=temperature_2m,wind_speed_10m&wind_speed_unit=mph&temperature_unit=fahrenheit`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return { tempF: null, windMph: null };
    const j = (await res.json()) as {
      current?: { temperature_2m?: number; wind_speed_10m?: number };
    };
    const data: WeatherData = {
      tempF:   j.current?.temperature_2m  ?? null,
      windMph: j.current?.wind_speed_10m  ?? null,
    };
    _weatherCache.set(homeAbbr, { data, ts: Date.now() });
    return data;
  } catch {
    return { tempF: null, windMph: null };
  }
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

function projectValue(
  seasonAvg: number,
  opponentWinPct: number,
  isHome: boolean,
  sport: string,
  homeAbbr: string,
  weather?: WeatherData
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

  const reason_1 = `Season avg ${seasonAvg} ${unit} — projected ${trend} average vs ${oppAbbr}'s ${oppQ} defense.`;

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

  return {
    reason_1,
    reason_2,
    risk_factor: `Game script changes or usage decisions can shift ${name}'s ${statType} volume materially.`,
  };
}

// ── Core fetch ────────────────────────────────────────────────────────────────

async function fetchSportPlayerEdge(
  sport: "NBA" | "MLB" | "NFL",
  sortBase: number
): Promise<PlayerEdgePrediction[]> {
  const url = SCOREBOARDS[sport];
  const statMap = SPORT_STAT_MAP[sport] ?? {};

  let res: Response;
  try {
    res = await fetch(url);
    if (!res.ok) return [];
  } catch { return []; }

  const data = (await res.json()) as { events?: EspnEventRaw[] };
  const events = data.events ?? [];
  const predictions: PlayerEdgePrediction[] = [];
  const t = edgeThresholds(sport);

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

    // MLB weather fetch (cached per team, per session)
    const weather = sport === "MLB"
      ? await fetchMlbWeather(homeAbbr).catch(() => ({ tempF: null, windMph: null }))
      : undefined;

    for (const competitor of [home, away]) {
      const teamAbbr = competitor.team?.abbreviation ?? "";
      const isHome   = competitor === home;
      const oppAbbr  = isHome ? awayAbbr : homeAbbr;
      const oppComp  = isHome ? away : home;
      const oppWinPct = overallWinPct(oppComp);

      for (const category of competitor.leaders ?? []) {
        const catName = category.name ?? "";
        const mapping = statMap[catName];
        if (!mapping) continue;

        // Top 5 leaders per category for broader coverage
        const leaders = (category.leaders ?? []).slice(0, 5);

        for (const leader of leaders) {
          const name = leader.athlete?.displayName ?? leader.athlete?.fullName;
          if (!name) continue;

          const value = leader.value ?? Number.parseFloat(leader.displayValue);
          if (!Number.isFinite(value) || value <= 0) continue;

          const projected  = projectValue(value, oppWinPct, isHome, sport, homeAbbr, weather);
          const edge       = projected - value;
          const direction: "MORE" | "LESS" = edge >= 0 ? "MORE" : "LESS";
          const edgeMag    = Math.abs(edge);
          const confidence = edgeToConfidence(edgeMag, sport);
          const athleteId  = leader.athlete?.id
            ?? `ath-${catName}-${name.replace(/\s+/g, "-")}`;
          const id = `espn-${sport.toLowerCase()}-${eventId}-${athleteId}-${catName}`;

          const { reason_1, reason_2, risk_factor } = buildReasons(
            name, mapping.statType, mapping.unit, value, projected,
            oppAbbr, oppWinPct, direction, sport, homeAbbr, weather
          );

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
            line_value:         value,
            projected_value:    projected,
            prediction_direction: direction,
            edge:               Math.round(edge * 10) / 10,
            confidence,
            reason_1,
            reason_2,
            risk_factor,
            game_sort:          sortBase + predictions.length,
            confidence_score_0_100: confidence === "HIGH" ? 72 : confidence === "MED" ? 58 : 44,
            risk_tier:   confidence === "HIGH" ? "safe" : confidence === "MED" ? "balanced" : "longshot",
            consistency_label:
              edgeMag >= t.high ? "stable" :
              edgeMag >= t.med  ? "medium" :
              "volatile",
            // Only signal a trend for meaningful edges to preserve scoring signal
            trend_note: edgeMag >= t.high
              ? (direction === "MORE" ? `Trending ↑ vs ${oppAbbr}` : `Fade vs ${oppAbbr}`)
              : undefined,
          });
        }
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
  const [nba, mlb, nfl] = await Promise.all([
    fetchSportPlayerEdge("NBA", 0).catch(()    => [] as PlayerEdgePrediction[]),
    fetchSportPlayerEdge("MLB", 1000).catch(() => [] as PlayerEdgePrediction[]),
    fetchSportPlayerEdge("NFL", 2000).catch(() => [] as PlayerEdgePrediction[]),
  ]);
  return [...nba, ...mlb, ...nfl];
}
