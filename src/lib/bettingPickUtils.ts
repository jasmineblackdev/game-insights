import type { GamePrediction } from "@/data/mockGames";
import { getFavoredSide, type EdgeSide } from "@/lib/edgeCardScoring";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import { parseAmericanOddsString } from "@/lib/valueParlay/oddsMath";

export type PickSide = EdgeSide | "draw";

/** American price for a side when merging Odds API bundle + ESPN `game.lines`. */
export function americanOddsForPick(
  game: GamePrediction,
  side: PickSide,
  bundle: GameOddsBundle | undefined
): number | null {
  if (side === "draw") {
    const d = parseAmericanOddsString(game.lines?.drawMl ?? undefined);
    if (d != null) return d;
    const bd = bundle?.h2h?.drawAmerican;
    if (bd != null) return bd;
    return null;
  }
  if (bundle?.h2h) {
    return side === "home" ? bundle.h2h.homeAmerican : bundle.h2h.awayAmerican;
  }
  const raw = side === "home" ? game.lines?.homeMl : game.lines?.awayMl;
  return parseAmericanOddsString(raw ?? undefined);
}

export function pickAbbrevForSide(game: GamePrediction, side: PickSide): string {
  if (side === "draw") return "Draw";
  return side === "home" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
}

/** Primary model lean for display: home, away, or draw when 1X2. */
export function primaryPickSide(game: GamePrediction): PickSide {
  if (!game.threeWay) return getFavoredSide(game);
  const { home, away, draw } = game.threeWay;
  if (draw >= home && draw >= away) return "draw";
  return home >= away ? "home" : "away";
}
