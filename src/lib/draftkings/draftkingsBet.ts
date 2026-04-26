/**
 * DraftKings manual-execution helpers.
 *
 * The app never places bets directly. These helpers turn a parlay
 * ticket into:
 *   - a deep link that opens the DraftKings app / sportsbook
 *   - a clean checklist copied to clipboard so the user can step
 *     through the placement without alt-tabbing
 *   - line-verification deltas so we can warn when the DK price
 *     drifted from the recommendation before the user locks it in.
 */

import type { ValueBetCandidate } from "@/lib/valueParlay/types";

/** Sport → DraftKings web sportsbook section. */
const DK_SECTION_BY_SPORT: Record<string, string> = {
  nba:    "basketball/nba",
  wnba:   "basketball/wnba",
  nfl:    "football/nfl",
  mlb:    "baseball/mlb",
  boxing: "fighting/boxing",
  mma:    "fighting/mma",
};

/**
 * Best-effort web URL into the right DK section. Falls back to the
 * sportsbook home page when sport isn't mapped. The mobile app
 * intercepts sportsbook.draftkings.com on iOS/Android, so this works
 * for both surfaces without a separate scheme.
 */
export function draftkingsUrl(sport?: string): string {
  if (!sport) return "https://sportsbook.draftkings.com";
  const section = DK_SECTION_BY_SPORT[sport.toLowerCase()];
  return section
    ? `https://sportsbook.draftkings.com/leagues/${section}`
    : "https://sportsbook.draftkings.com";
}

function formatAmerican(o: number | undefined): string {
  if (o == null || !Number.isFinite(o)) return "—";
  return o > 0 ? `+${o}` : `${o}`;
}

function legLine(l: ValueBetCandidate): string {
  const market = l.statType
    ? l.statType.replace(/_/g, " ")
    : l.marketType.replace(/_/g, " ");
  const line = l.lineValue != null ? ` ${l.lineValue}` : "";
  return `${l.selectionLabel}${line} (${market}) — ${formatAmerican(l.americanOdds)}`;
}

/**
 * Build the human checklist the user copies to clipboard. Designed to
 * be readable inside the DK app's bet builder so the user can step
 * through it field-by-field.
 */
export function formatBetInstructions(args: {
  legs: ValueBetCandidate[];
  stake?: number;
  combinedOdds?: number;
  payoutMultiplier?: number;
}): string {
  const { legs, stake, combinedOdds, payoutMultiplier } = args;
  if (legs.length === 0) return "No legs on this ticket.";

  const lines: string[] = [];
  lines.push("DraftKings — Manual placement checklist");
  lines.push("");

  const sports = [...new Set(legs.map((l) => String(l.sport).toUpperCase()))];
  lines.push(`Sportsbook: DraftKings`);
  lines.push(`Sport${sports.length === 1 ? "" : "s"}: ${sports.join(", ")}`);
  lines.push(`Legs: ${legs.length}`);
  if (combinedOdds != null) lines.push(`Combined odds: ${formatAmerican(combinedOdds)}`);
  if (payoutMultiplier != null) lines.push(`Payout: ${payoutMultiplier.toFixed(2)}x`);
  if (stake != null) lines.push(`Stake: $${stake}`);
  lines.push("");

  lines.push("Steps:");
  lines.push("1. Open DraftKings");
  legs.forEach((l, i) => {
    lines.push(`${i + 2}. ${legLine(l)}`);
  });
  lines.push(`${legs.length + 2}. Add to bet slip → Parlay${stake != null ? ` → Stake $${stake}` : ""}`);
  lines.push(`${legs.length + 3}. Verify combined odds match ${formatAmerican(combinedOdds)} before placing`);
  lines.push(`${legs.length + 4}. Place bet`);
  lines.push("");
  lines.push("After placing, return to the app and tap 'I placed this bet' to log + track outcomes.");

  return lines.join("\n");
}

/**
 * Compute the line/odds drift between recommendation and DraftKings.
 * Returns null when nothing was provided. Drift is reported as
 * absolute deltas — the UI decides how to color them.
 */
export function lineDrift(args: {
  recommendedOdds?: number;
  draftkingsOdds?: number;
  recommendedLine?: number;
  draftkingsLine?: number;
}): {
  oddsDeltaPoints: number | null;
  lineDelta: number | null;
  warn: boolean;
  reasons: string[];
} {
  const { recommendedOdds, draftkingsOdds, recommendedLine, draftkingsLine } = args;
  const oddsDeltaPoints = recommendedOdds != null && draftkingsOdds != null
    ? draftkingsOdds - recommendedOdds
    : null;
  const lineDelta = recommendedLine != null && draftkingsLine != null
    ? Math.round((draftkingsLine - recommendedLine) * 100) / 100
    : null;

  const reasons: string[] = [];
  // Warn on a meaningful odds shift (≥10 American points) or any
  // line shift on a player prop / spread.
  if (oddsDeltaPoints != null && Math.abs(oddsDeltaPoints) >= 10) {
    reasons.push(`Odds shifted ${oddsDeltaPoints > 0 ? "+" : ""}${oddsDeltaPoints} from the recommendation.`);
  }
  if (lineDelta != null && Math.abs(lineDelta) >= 0.5) {
    reasons.push(`Line shifted ${lineDelta > 0 ? "+" : ""}${lineDelta} from the recommendation.`);
  }
  return {
    oddsDeltaPoints,
    lineDelta,
    warn: reasons.length > 0,
    reasons,
  };
}
