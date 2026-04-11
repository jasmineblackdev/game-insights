/**
 * Fetches real player edge predictions from ESPN scoreboard leader data.
 * No mock data — every player, team, opponent, and stat is live from ESPN.
 *
 * How it works:
 *  1. Fetches today's scoreboard for NBA and MLB
 *  2. For each upcoming/live game, extracts team leaders (top scorers, rebounders, etc.)
 *     from competitor.leaders — ESPN populates this with season leaders for all game states
 *  3. Builds a PlayerEdgePrediction using the player's season stat as the baseline "line"
 *  4. Projects above/below the line based on opponent quality (win% proxy)
 *  5. Confidence is derived from edge magnitude
 */

import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";

// ── ESPN endpoints ────────────────────────────────────────────────────────────

const SCOREBOARDS: Record<string, string> = {
  NBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
  MLB: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
};

// ── ESPN stat-category name → our PlayerEdgeStatFilter ────────────────────────

const NBA_STAT_MAP: Record<string, { statType: string; unit: string }> = {
  points:   { statType: "points", unit: "pts" },
  rebounds: { statType: "rebounds", unit: "reb" },
  assists:  { statType: "assists", unit: "ast" },
};

const MLB_STAT_MAP: Record<string, { statType: string; unit: string }> = {
  homeRuns:   { statType: "total_bases", unit: "HR" },
  strikeouts: { statType: "strikeouts", unit: "K" },
  hits:       { statType: "hits", unit: "hits" },
};

const SPORT_STAT_MAP: Record<string, typeof NBA_STAT_MAP> = {
  NBA: NBA_STAT_MAP,
  MLB: MLB_STAT_MAP,
};

// ── ESPN raw types ─────────────────────────────────────────────────────────────

interface EspnLeaderEntry {
  displayValue: string;
  value?: number;
  athlete?: {
    id?: string;
    displayName?: string;
    fullName?: string;
    position?: { abbreviation?: string };
    team?: { id?: string; abbreviation?: string };
  };
}

interface EspnLeaderCategory {
  name?: string;
  displayName?: string;
  leaders?: EspnLeaderEntry[];
}

interface EspnCompetitorRaw {
  homeAway?: string;
  score?: string;
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function overallWinPct(competitor: EspnCompetitorRaw): number {
  const rec = competitor.records?.find((r) => r.type === "total" || r.type === "overall");
  const summary = rec?.summary ?? "0-0";
  const parts = summary.split("-").map(Number);
  const w = parts[0] ?? 0;
  const l = parts[1] ?? 0;
  const total = w + l;
  return total > 0 ? w / total : 0.5;
}

/**
 * Project a player's output above/below their season average
 * based on opponent quality (win% proxy) and home/away context.
 */
function projectValue(seasonAvg: number, opponentWinPct: number, isHome: boolean): number {
  let multiplier: number;
  if (opponentWinPct < 0.35) multiplier = 1.08;
  else if (opponentWinPct < 0.45) multiplier = 1.04;
  else if (opponentWinPct > 0.65) multiplier = 0.92;
  else if (opponentWinPct > 0.55) multiplier = 0.96;
  else multiplier = 1.0;
  if (isHome) multiplier *= 1.025;
  return Math.round(seasonAvg * multiplier * 10) / 10;
}

function edgeToConfidence(edgeMag: number): "HIGH" | "MED" | "LOW" {
  if (edgeMag >= 2.5) return "HIGH";
  if (edgeMag >= 1.0) return "MED";
  return "LOW";
}

function formatGameTime(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }) + " ET";
  } catch {
    return "Today";
  }
}

function buildReasons(
  playerName: string,
  statType: string,
  unit: string,
  seasonAvg: number,
  projected: number,
  opponentAbbr: string,
  opponentWinPct: number,
  direction: "MORE" | "LESS"
): { reason_1: string; reason_2: string; risk_factor: string } {
  const opponentQuality = opponentWinPct < 0.40 ? "weak" : opponentWinPct > 0.60 ? "strong" : "average";
  const trend = direction === "MORE" ? "above" : "below";

  return {
    reason_1: `Season avg ${seasonAvg} ${unit} — projected ${trend} average vs ${opponentAbbr}'s ${opponentQuality} defense.`,
    reason_2: `${opponentAbbr} win rate ${Math.round(opponentWinPct * 100)}% — ${
      opponentQuality === "weak"
        ? "lighter opposition inflates scoring opportunity"
        : opponentQuality === "strong"
        ? "top-tier opponent suppresses output"
        : "matchup projects as neutral"
    }.`,
    risk_factor: `Game script changes or rest decisions can shift ${playerName}'s ${statType} minutes materially.`,
  };
}

// ── Core fetch ────────────────────────────────────────────────────────────────

async function fetchSportPlayerEdge(
  sport: "NBA" | "MLB",
  sortBase: number
): Promise<PlayerEdgePrediction[]> {
  const url = SCOREBOARDS[sport];
  if (!url) return [];
  const statMap = SPORT_STAT_MAP[sport] ?? {};

  let res: Response;
  try {
    res = await fetch(url);
    if (!res.ok) return [];
  } catch {
    return [];
  }

  const data = (await res.json()) as { events?: EspnEventRaw[] };
  const events = data.events ?? [];
  const predictions: PlayerEdgePrediction[] = [];

  for (const event of events) {
    const comp = event.competitions?.[0];
    if (!comp?.competitors || comp.competitors.length < 2) continue;

    const state = comp.status?.type?.state;
    // Only upcoming or live games
    if (state === "post") continue;

    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    if (!home || !away) continue;

    const homeAbbr = home.team?.abbreviation ?? "HOM";
    const awayAbbr = away.team?.abbreviation ?? "AWY";
    const gameTime = formatGameTime(comp.date ?? "");
    const eventId = event.id ?? `${sport}-${Date.now()}`;

    for (const competitor of [home, away]) {
      const teamAbbr = competitor.team?.abbreviation ?? "";
      const isHome = competitor === home;
      const oppAbbr = isHome ? awayAbbr : homeAbbr;
      const oppCompetitor = isHome ? away : home;
      const opponentWinPct = overallWinPct(oppCompetitor);

      // ESPN populates competitor.leaders with season leaders for all game states
      for (const category of competitor.leaders ?? []) {
        const catName = category.name ?? "";
        const mapping = statMap[catName];
        if (!mapping) continue;

        // Take top 2 leaders per category for better coverage
        const leaders = (category.leaders ?? []).slice(0, 2);
        for (const topLeader of leaders) {
          const name = topLeader.athlete?.displayName ?? topLeader.athlete?.fullName;
          if (!name) continue;

          const value = topLeader.value ?? Number.parseFloat(topLeader.displayValue);
          if (!Number.isFinite(value) || value <= 0) continue;

          const projected = projectValue(value, opponentWinPct, isHome);
          const edge = projected - value;
          const direction: "MORE" | "LESS" = edge >= 0 ? "MORE" : "LESS";
          const edgeMag = Math.abs(edge);
          const confidence = edgeToConfidence(edgeMag);
          const athleteId = topLeader.athlete?.id ?? `ath-${catName}-${name.replace(/\s+/g, "-")}`;
          const id = `espn-${sport.toLowerCase()}-${eventId}-${athleteId}-${catName}`;

          const { reason_1, reason_2, risk_factor } = buildReasons(
            name,
            mapping.statType,
            mapping.unit,
            value,
            projected,
            oppAbbr,
            opponentWinPct,
            direction
          );

          predictions.push({
            id,
            game_id: eventId,
            player_id: athleteId,
            player_name: name,
            sport,
            team: teamAbbr,
            opponent: oppAbbr,
            game_time: gameTime,
            stat_type: mapping.statType,
            line_value: value,
            projected_value: projected,
            prediction_direction: direction,
            edge: Math.round(edge * 10) / 10,
            confidence,
            reason_1,
            reason_2,
            risk_factor,
            game_sort: sortBase + predictions.length,
            confidence_score_0_100: confidence === "HIGH" ? 72 : confidence === "MED" ? 58 : 44,
            // LOW confidence = longshot (uncertain), not high_upside (which implies a real signal)
            risk_tier: confidence === "HIGH" ? "safe" : confidence === "MED" ? "balanced" : "longshot",
            consistency_label: edgeMag >= 2.5 ? "stable" : edgeMag >= 1.0 ? "medium" : "volatile",
            // Only signal a trend when edge is meaningful — avoids inflating recent_form score for every prop
            trend_note: edgeMag >= 2.5 ? (direction === "MORE" ? `Trending ↑ vs ${oppAbbr}` : `Fade vs ${oppAbbr}`) : undefined,
          });
        }
      }
    }
  }

  return predictions;
}

/**
 * Fetch live player edge predictions across all active sports.
 * Returns real players from today's games with real season-stat baselines.
 * Source is always ESPN — no mock data involved.
 */
export async function fetchLivePlayerEdgePredictions(): Promise<PlayerEdgePrediction[]> {
  const [nba, mlb] = await Promise.all([
    fetchSportPlayerEdge("NBA", 0),
    fetchSportPlayerEdge("MLB", 1000),
  ]);
  return [...nba, ...mlb];
}
