/**
 * DraftKings label → internal market shape normalizer.
 *
 * Takes a verbatim DraftKings selection label (e.g. "Hits O/U Over
 * 0.5", "Total Bases Over 1.5", "Moneyline", "Points Over 26.5") and
 * extracts the structured fields the resolver needs to settle the bet
 * against ESPN/MLB feeds.
 *
 * Critical: the user-facing label MUST preserve the DraftKings
 * wording. The normalizer only adds structured fields; it does not
 * rewrite the label.
 *
 * Coverage: the most common DK markets across MLB/NBA/NFL.
 * Unknown labels return marketType + raw fields the user can edit
 * by hand in the entry form — we never fabricate stat types.
 */

import type { PaperDirection, PaperMarketType } from "./types";

export interface NormalizedSelection {
  marketType: PaperMarketType;
  /** Internal stat key when applicable (matches espnPlayerStats.ts naming). */
  statType?: string;
  direction?: PaperDirection;
  line?: number;
  /** True if we recognised the label confidently; false → user should
   *  verify the parsed fields before submitting. */
  confident: boolean;
  /** Diagnostic — why we couldn't parse, when confident=false. */
  note?: string;
}

// ── Stat-name aliases ─────────────────────────────────────────────────
// Map DraftKings phrasing to the internal stat keys used elsewhere
// in the app (espnPlayerStats.ts MLB_STAT_MAP, NBA_STAT_MAP, etc.).
// Lower-case left side; right side is the canonical internal key.
const STAT_ALIASES: Record<string, string> = {
  // MLB
  "hits":           "hits",
  "h":              "hits",
  "total bases":    "total_bases",
  "tb":             "total_bases",
  "rbis":           "rbis",
  "rbi":            "rbis",
  "runs":           "runs",
  "home runs":      "home_runs",
  "hr":             "home_runs",
  "stolen bases":   "stolen_bases",
  "sb":             "stolen_bases",
  "walks":          "walks",
  "bb":             "walks",
  "doubles":        "doubles",
  "triples":        "triples",
  "strikeouts":     "strikeouts",
  "k":              "strikeouts",
  "ks":             "strikeouts",

  // NBA / WNBA
  "points":         "points",
  "pts":            "points",
  "rebounds":       "rebounds",
  "reb":            "rebounds",
  "assists":        "assists",
  "ast":            "assists",
  "steals":         "steals",
  "stl":            "steals",
  "blocks":         "blocks",
  "blk":            "blocks",
  "threes":         "threes",
  "3pm":            "threes",
  "three pointers made": "threes",
  "pra":            "pra",
  "p+r+a":          "pra",
  "pts+reb+ast":    "pra",

  // NFL
  "passing yards":   "passing_yards",
  "pass yds":        "passing_yards",
  "rushing yards":   "rushing_yards",
  "rush yds":        "rushing_yards",
  "receiving yards": "receiving_yards",
  "rec yds":         "receiving_yards",
  "receptions":      "receptions",
  "rec":             "receptions",
  "passing tds":     "passing_tds",
  "rushing tds":     "rushing_tds",
  "receiving tds":   "receiving_tds",
};

// Sorted longest-first so "total bases" matches before "tb", etc.
const STAT_ALIAS_KEYS_LONG = Object.keys(STAT_ALIASES).sort(
  (a, b) => b.length - a.length,
);

/**
 * Parse a DraftKings-style selection label. Returns marketType +
 * extracted fields. Falls back to manual edit (confident=false) when
 * the label doesn't match a known shape — never invents data.
 */
export function normalizeDraftKingsLabel(rawLabel: string): NormalizedSelection {
  const label = rawLabel.trim();
  const lc = label.toLowerCase();

  // Moneyline — explicit, no line, no direction.
  if (/^moneyline\b/.test(lc) || lc === "ml") {
    return { marketType: "moneyline", confident: true };
  }

  // Spread — e.g. "+3.5", "-7", "Spread -3.5"
  const spreadMatch = lc.match(/(?:spread\s*)?([+-]?\d+(?:\.\d+)?)\s*(?:spread)?$/);
  if (lc.startsWith("spread") || /\bspread\b/.test(lc)) {
    if (spreadMatch) {
      return {
        marketType: "spread",
        line: Number(spreadMatch[1]),
        confident: true,
      };
    }
    return { marketType: "spread", confident: false, note: "Could not parse spread number." };
  }

  // Total (game total over/under, no player) — "Total Over 215.5", "O/U 8.5 Over"
  if (/\btotal\b/.test(lc) && !/(yards|bases|rebounds|assists|points|hits)/.test(lc)) {
    const dir = /\bover\b/.test(lc) ? "over" : /\bunder\b/.test(lc) ? "under" : undefined;
    const num = lc.match(/(\d+(?:\.\d+)?)/);
    if (dir && num) {
      return {
        marketType: "total",
        direction: dir,
        line: Number(num[1]),
        confident: true,
      };
    }
    return { marketType: "total", confident: false, note: "Could not parse total direction or line." };
  }

  // Player prop O/U — try every stat alias, longest first.
  let direction: PaperDirection | undefined =
    /\bover\b/.test(lc) ? "over" :
    /\bunder\b/.test(lc) ? "under" :
    undefined;
  let line = (() => {
    const m = lc.match(/(\d+(?:\.\d+)?)\s*\+?\s*$/) ?? lc.match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : undefined;
  })();

  // Threshold pattern — DraftKings often books player props as "25+
  // Points" / "Points 25+" / "Banchero 25+ Points" meaning "25 or
  // more". That's equivalent to Over 24.5 in the resolver's
  // direction/line model. Detect the `N+` token and overwrite the
  // direction/line we extracted above (which would otherwise leave
  // line=N and direction=undefined).
  const thresholdMatch = lc.match(/(?:^|\D)(\d+)\+(?!\d)/);
  if (thresholdMatch) {
    const n = Number(thresholdMatch[1]);
    if (Number.isFinite(n) && n > 0) {
      direction = "over";
      // N - 0.5 so the resolver wins on actual ≥ N (the DK semantic
      // for "25+"). Using N alone would push on actual exactly N.
      line = n - 0.5;
    }
  }

  for (const alias of STAT_ALIAS_KEYS_LONG) {
    // Word-boundary match so "h" in "hits" isn't a substring trap.
    const pattern = new RegExp(`(^|\\W)${escapeRegex(alias)}(\\W|$)`);
    if (pattern.test(lc)) {
      const statType = STAT_ALIASES[alias];
      if (direction != null && line != null) {
        return { marketType: "player_prop", statType, direction, line, confident: true };
      }
      // Saw the stat but couldn't extract direction/line — flag for review.
      return {
        marketType: "player_prop",
        statType,
        direction,
        line,
        confident: false,
        note: "Stat recognised; verify direction and line manually.",
      };
    }
  }

  // No stat alias matched, but we DID extract a threshold (e.g.
  // bare "25+"). Surface direction/line so the user only has to
  // pick a stat type — the line and direction are already correct.
  if (thresholdMatch && direction != null && line != null) {
    return {
      marketType: "player_prop",
      direction,
      line,
      confident: false,
      note: "Threshold parsed (Over " + line + "). Pick a stat type from the dropdown.",
    };
  }

  return {
    marketType: "player_prop",
    confident: false,
    note: "Could not match a known stat type — pick one from the dropdown manually.",
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decimal multiplier (NOT decimal odds) — turns American odds into
 * the multiplicative payout factor including stake. Returns 1 for
 * invalid inputs so callers don't multiply by NaN.
 *
 * Example:
 *   americanToPayoutMultiplier(-110) → ~1.909  (bet $1 → return $1.909)
 *   americanToPayoutMultiplier(+150) → 2.5
 */
export function americanToPayoutMultiplier(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 1;
  if (american > 0) return 1 + american / 100;
  return 1 + 100 / Math.abs(american);
}

/**
 * Combine American odds across multiple legs into a single American
 * value for parlay display.
 */
export function combineAmericanOdds(americans: number[]): number {
  if (!americans.length) return 0;
  const decimal = americans.reduce(
    (m, a) => m * americanToPayoutMultiplier(a),
    1,
  );
  if (!Number.isFinite(decimal) || decimal <= 1) return 0;
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return Math.round(-100 / (decimal - 1));
}

/**
 * Implied probability from American odds (vig-included). Used to log
 * "what was the market's view at entry time" for later calibration.
 */
export function impliedProbabilityFromAmerican(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 0;
  if (american > 0) return 100 / (american + 100);
  return Math.abs(american) / (Math.abs(american) + 100);
}
