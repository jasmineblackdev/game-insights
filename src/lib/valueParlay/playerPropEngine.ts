import type { GamePrediction, League, PlayerTrendData } from "@/data/mockGames";
import { americanFromImpliedProb, americanToImpliedProb } from "@/lib/valueParlay/oddsMath";
import type { PlayerPropModelRow } from "@/lib/valueParlay/types";

function slugId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function trendToStatType(league: League, trend: PlayerTrendData): string | null {
  const km = trend.keyMetric.toUpperCase();
  if (league === "nba") {
    if (km.includes("PTS") || km === "POINTS") return "points";
    if (km.includes("REB")) return "rebounds";
    if (km.includes("AST")) return "assists";
  }
  if (league === "nfl") {
    if (km.includes("PASS")) return "passing_yards";
    if (km.includes("RUSH")) return "rushing_yards";
    if (km.includes("REC")) return "receiving_yards";
  }
  if (league === "mlb") {
    if (km.includes("HIT") || km === "H") return "hits";
    if (km.includes("HR")) return "home_runs";
    if (km.includes("RBI")) return "rbi";
    if (km.includes("R") && !km.includes("HR")) return "runs";
  }
  if (league === "soccer") {
    if (km === "G" || km.includes("GOAL")) return "shots";
    if (km.includes("AST")) return "shots_on_target";
  }
  return null;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Projection-first prop model: baseline from season/last5, adjustments from trend + matchup pace.
 */
function projectStat(
  league: League,
  trend: PlayerTrendData,
  statType: string,
  game: GamePrediction
): { projected: number; line: number; volatility: number; reasons: [string, string] } {
  const base = trend.last5Avg * 0.55 + trend.seasonAvg * 0.45;
  let paceAdj = 0;
  if (league === "nba" || league === "nfl") {
    const hp = game.homeTeam.pace;
    const ap = game.awayTeam.pace;
    const avgP = (hp + ap) / 2;
    paceAdj = (avgP - 100) * 0.04;
  }
  if (league === "soccer" && statType === "shots") {
    const proj = Math.max(0.8, base * 3.2 + paceAdj * 0.1);
    const line = Math.max(0.5, Math.round((proj - 0.35) * 2) / 2);
    return {
      projected: Math.round(proj * 10) / 10,
      line,
      volatility: 38,
      reasons: [
        "Shot volume estimated from attacking role & fixture pace.",
        "SoT props tighten when opponent sits deep — watch confirmed XI.",
      ],
    };
  }
  if (league === "soccer" && statType === "shots_on_target") {
    const proj = Math.max(0.35, base * 1.8);
    const line = Math.max(0.5, Math.round((proj - 0.2) * 2) / 2);
    return {
      projected: Math.round(proj * 10) / 10,
      line,
      volatility: 42,
      reasons: [
        "SoT tied to role and game-state; low-score leagues add variance.",
        "Set-piece involvement not fully modeled here.",
      ],
    };
  }

  const projected = Math.max(0, base + paceAdj * (statType.includes("yards") ? 8 : 1.2));
  const line =
    statType.includes("yards") || statType === "points"
      ? Math.round((projected - (statType.includes("yards") ? 12 : 2.5)) / 0.5) * 0.5
      : Math.round(projected - 1.2);

  const vol =
    league === "mlb" ? 44 : league === "nfl" ? 40 : league === "nba" ? 32 : 36;

  return {
    projected: Math.round(projected * 10) / 10,
    line: Math.max(0.5, line),
    volatility: vol,
    reasons: [
      `${statType.replace(/_/g, " ")} baseline from recent vs season, adjusted for pace.`,
      "Role and blowout risk can swing minutes — monitor late scratches.",
    ],
  };
}

export function buildPlayerPropProjectionsForGame(game: GamePrediction): PlayerPropModelRow[] {
  const sides: { side: "home" | "away"; abbr: string; opp: string; trends: PlayerTrendData[] }[] = [
    {
      side: "home",
      abbr: game.homeTeam.abbreviation,
      opp: game.awayTeam.abbreviation,
      trends: game.playerTrends.home,
    },
    {
      side: "away",
      abbr: game.awayTeam.abbreviation,
      opp: game.homeTeam.abbreviation,
      trends: game.playerTrends.away,
    },
  ];
  const out: PlayerPropModelRow[] = [];
  for (const { abbr, opp, trends } of sides) {
    for (const t of trends) {
      const statType = trendToStatType(game.league, t);
      if (!statType || statType === "anytime_td_proxy") continue;
      const { projected, line, volatility, reasons } = projectStat(game.league, t, statType, game);
      const z = (projected - line) / Math.max(1.2, projected * 0.18);
      const overP = sigmoid(z * 1.4);
      const underP = 1 - overP;
      const sidePick: "OVER" | "UNDER" = overP >= underP ? "OVER" : "UNDER";
      const modelP = Math.max(overP, underP);
      const bookImplied = americanToImpliedProb(-110);
      const edge = modelP - bookImplied;

      let conf: GamePrediction["confidence"] = game.confidence;
      if (edge < 0.04) conf = conf === "high" ? "medium" : "low";

      const inj = [...game.injuries.home, ...game.injuries.away];
      const injRisk = inj.some((i) => i.status === "QUESTIONABLE" || i.status === "GTD") ? 22 : 8;
      const unc = Math.min(
        85,
        (conf === "low" ? 55 : conf === "medium" ? 32 : 18) + injRisk * 0.4
      );

      out.push({
        gameId: game.id,
        sport: game.league,
        playerId: slugId(`${game.id}-${t.name}-${statType}`),
        playerName: t.name,
        teamAbbr: abbr,
        opponentAbbr: opp,
        statType,
        lineValue: line,
        projectedValue: projected,
        overProbability: overP,
        underProbability: underP,
        recommendedSide: sidePick,
        edge,
        confidence: conf,
        volatilityScore: volatility,
        uncertaintyScore: unc,
        reason1: reasons[0],
        reason2: reasons[1],
        riskFactor:
          game.league === "mlb" && game.mlb?.pitcherCertainty !== "confirmed"
            ? "Pitcher/lineup confirmation still moving."
            : inj.some((i) => i.impactScore >= 7)
              ? "Injury table has high-impact names — verify status."
              : "Game script and foul trouble can reshape usage.",
      });
    }
  }
  return out;
}

export function propRowToAmericanOdds(row: PlayerPropModelRow): number {
  const p = row.recommendedSide === "OVER" ? row.overProbability : row.underProbability;
  return americanFromImpliedProb(Math.min(0.93, Math.max(0.07, p + 0.025)));
}
