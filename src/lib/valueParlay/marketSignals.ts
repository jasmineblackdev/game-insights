/**
 * Market intelligence — Action Network-style signals.
 *
 * Two signal sources:
 *
 *   1. Public vs Money split — % of TICKETS on this side vs % of
 *      DOLLARS. Requires an external feed (Action Network, BetIQ,
 *      OddsTrader). When unavailable, both fields stay null and the
 *      UI panel hides; never invents numbers.
 *
 *   2. Line movement — open vs current. Today this comes from the
 *      `lineMovementDeltaPp` field already on ValueBetCandidate plus
 *      the `prop_opening_v1` sessionStorage cache in espnPlayerStats.
 *      Closing line gets sealed by the `closing-odds-poller` edge fn.
 *
 * Derived signals (badges):
 *   - sharpSignal       — % money > % bets by ≥10pp ("dollars on
 *                         the unpopular side" = sharps)
 *   - publicHeavy       — % bets ≥ 65% ("everyone is on it")
 *   - reverseLineMove   — public is heavy AND line moved AGAINST
 *                         the public side ("books trust sharps over
 *                         the masses" — strongest fade signal)
 *   - steamMove         — line moved ≥4pp in <60 minutes (sharp wave)
 *
 * Signal strength is bounded — at most one BADGE label per leg in
 * the UI to keep cards scannable. Priority chain handled in
 * `dominantBadge`.
 */

export interface MarketSignalsRaw {
  /**
   * % of placed tickets on this side. 0..100. Source: paid feed.
   * Null when feed unavailable.
   */
  percentBets: number | null;
  /**
   * % of total dollars wagered on this side. 0..100. Source: paid
   * feed. Null when feed unavailable.
   */
  percentMoney: number | null;
  /**
   * Opening line as American odds OR signed point spread, depending
   * on market type. The sign convention matches whatever surfaced
   * the original candidate. Null when not captured.
   */
  openLine: number | null;
  /** Current line in the same shape as openLine. */
  currentLine: number | null;
  /**
   * Optional ISO timestamp of the most recent line move. When
   * populated, the time-since determines whether `steamMove` fires.
   */
  lastMovedAt?: string | null;
}

export type MarketBadgeKind =
  | "sharp_signal"
  | "public_heavy"
  | "reverse_line_move"
  | "steam_move"
  | "neutral";

export interface MarketSignalsDerived {
  /** Pass-through of raw fields so consumers don't need both. */
  raw: MarketSignalsRaw;
  /** Movement = currentLine − openLine. Sign is preserved. Null when either endpoint missing. */
  movement: number | null;
  sharpSignal: boolean;
  publicHeavy: boolean;
  reverseLineMove: boolean;
  steamMove: boolean;
  /** Single badge to render. Priority: reverse_line_move → sharp_signal → steam_move → public_heavy → neutral. */
  dominantBadge: MarketBadgeKind;
  /** Short prose (≤80 chars) for explanation generators. Empty when neutral. */
  signalNote: string;
  /** Did we have enough data to compute any non-neutral signal? */
  hasSignal: boolean;
}

const PUBLIC_HEAVY_THRESHOLD = 65;
const SHARP_DELTA_PP = 10;       // % money exceeds % bets by ≥10pp
const STEAM_WINDOW_MS = 60 * 60_000; // 60 min
const STEAM_MIN_MOVE = 4;        // ≥4pp / 4 cents in price

/**
 * Decide which side the line moved toward — needed to detect
 * "reverse line movement" (line moved against the public).
 *
 * For moneyline: positive direction = price got SHORTER (more
 * favoured). E.g. -150 → -180 is positive movement toward this side.
 *
 * For totals: positive direction = line went UP (more O15.5 → O16.5
 * means books expect more scoring; if you're on the over, that's
 * positive for you).
 *
 * For spreads: depends on which side you're on; the stored line is
 * already signed for THIS side, so any negative movement (line got
 * tougher to cover) is movement against you.
 *
 * Caller passes `direction = "with" | "against"` to make this
 * unambiguous regardless of market type.
 */
export function lineMovedToward(
  openLine: number,
  currentLine: number,
  marketType: "moneyline" | "spread" | "total" | "player_prop",
  direction: "over" | "under" | "this_side",
): "with" | "against" | "flat" {
  const delta = currentLine - openLine;
  if (Math.abs(delta) < 0.001) return "flat";

  switch (marketType) {
    case "moneyline":
      // More negative = more favoured. -150 → -180 is "with" if you bet
      // the favourite; "against" if you bet the dog.
      // We assume the leg is on the favoured side when openLine < 0.
      if (openLine < 0) return delta < 0 ? "with" : "against";
      return delta > 0 ? "with" : "against";
    case "spread":
      // Stored line is signed for this side; toward 0 = better cover odds for you.
      // E.g. -7 → -3.5 is "with" if you took the favourite (less to cover).
      if (openLine < 0) return delta > 0 ? "with" : "against";
      return delta < 0 ? "with" : "against";
    case "total":
    case "player_prop":
      if (direction === "over")  return delta > 0 ? "against" : "with";  // higher line = harder to clear over
      if (direction === "under") return delta > 0 ? "with" : "against";  // higher line = easier to clear under
      return delta < 0 ? "with" : "against";
  }
}

/**
 * Run the raw signal payload through the derivation logic and pick
 * a single dominant badge. Always returns an object — when data is
 * thin, `dominantBadge = "neutral"` and the UI hides.
 */
export function deriveMarketSignals(args: {
  raw: MarketSignalsRaw;
  marketType: "moneyline" | "spread" | "total" | "player_prop";
  direction: "over" | "under" | "this_side";
}): MarketSignalsDerived {
  const { raw, marketType, direction } = args;
  const { percentBets, percentMoney, openLine, currentLine, lastMovedAt } = raw;

  const movement = openLine != null && currentLine != null
    ? Math.round((currentLine - openLine) * 100) / 100
    : null;

  const haveBetsAndMoney = percentBets != null && percentMoney != null;
  const sharpSignal = haveBetsAndMoney
    && percentMoney! - percentBets! >= SHARP_DELTA_PP;
  const publicHeavy = percentBets != null && percentBets >= PUBLIC_HEAVY_THRESHOLD;

  // Reverse line movement: public is heavy AND line moved against the
  // public-favoured side. We treat the candidate's leg as the
  // "public side" only when percentBets ≥ 65%.
  let reverseLineMove = false;
  if (publicHeavy && openLine != null && currentLine != null) {
    const moved = lineMovedToward(openLine, currentLine, marketType, direction);
    reverseLineMove = moved === "against";
  }

  // Steam: large movement in a short window.
  let steamMove = false;
  if (movement != null && lastMovedAt && Math.abs(movement) >= STEAM_MIN_MOVE) {
    const ageMs = Date.now() - new Date(lastMovedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs <= STEAM_WINDOW_MS) {
      steamMove = true;
    }
  }

  const dominantBadge: MarketBadgeKind =
    reverseLineMove ? "reverse_line_move"
    : sharpSignal ? "sharp_signal"
    : steamMove ? "steam_move"
    : publicHeavy ? "public_heavy"
    : "neutral";

  const signalNote =
    dominantBadge === "reverse_line_move"
      ? `Public ${percentBets}% on this side but line moved ${movement! > 0 ? "+" : ""}${movement} — sharps are fading.`
    : dominantBadge === "sharp_signal"
      ? `Money ${percentMoney}% vs tickets ${percentBets}% — dollars on the unpopular side.`
    : dominantBadge === "steam_move"
      ? `Steam move: line shifted ${movement! > 0 ? "+" : ""}${movement} in last hour.`
    : dominantBadge === "public_heavy"
      ? `Public ${percentBets}% — heavy chalk; expect line drift.`
    : "";

  return {
    raw,
    movement,
    sharpSignal,
    publicHeavy,
    reverseLineMove,
    steamMove,
    dominantBadge,
    signalNote,
    hasSignal: dominantBadge !== "neutral",
  };
}

/**
 * Convenience: ValueBetCandidate may carry partial market data via
 * its existing fields. Bridge those into MarketSignalsRaw so callers
 * don't have to assemble it manually.
 */
export function rawSignalsFromCandidate(c: {
  marketSignals?: MarketSignalsRaw | null;
  lineMovementDeltaPp?: number | null;
  americanOdds?: number;
}): MarketSignalsRaw {
  if (c.marketSignals) return c.marketSignals;
  // Fallback: only the line-movement piece is reconstructable from
  // existing fields. Public/money stays null.
  if (c.lineMovementDeltaPp != null && Number.isFinite(c.americanOdds)) {
    return {
      percentBets: null,
      percentMoney: null,
      openLine: c.americanOdds! - c.lineMovementDeltaPp,
      currentLine: c.americanOdds!,
      lastMovedAt: null,
    };
  }
  return {
    percentBets: null,
    percentMoney: null,
    openLine: null,
    currentLine: null,
    lastMovedAt: null,
  };
}
