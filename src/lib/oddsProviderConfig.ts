/**
 * Sport-specific configuration for the shared odds provider orchestration layer.
 *
 * The orchestration framework (circuit breakers, health ranking, latency scoring,
 * stale cache, schema-drift alerting) is sport-agnostic and lives in
 * multiOddsProvider.ts / the future generic equivalent.
 *
 * What changes per sport is isolated here:
 *  1. expectedMarkets   — drives normalized completeness scoring
 *  2. cacheTtlMs        — live cache window before re-fetching
 *  3. maxStaleMs        — max age for stale-last-good fallback
 *  4. liveMaxStaleMs    — (future) tighter threshold for in-game/live screens
 *  5. completenessWeight — how much market coverage affects provider ranking
 *
 * ─── Why markets differ by sport ────────────────────────────────────────────
 *
 * MMA / Boxing
 *   Markets are structurally simple and standardized: fight winner (h2h),
 *   rounds over/under (totals), and goes-the-distance (draw equivalent).
 *   Events are posted days or weeks ahead. Lines move but rarely race-condition.
 *   Stale tolerance is high for event listings; tighter near the night of the card.
 *
 * NBA
 *   The UI consumes moneyline + spread + total as core markets. Spreads and
 *   totals are essential to the product (not optional). Lines move significantly
 *   within 2–4 hours of tipoff, especially on injury news. A provider missing
 *   spread data is meaningfully less useful than one with full coverage.
 *   completenessWeight is highest here because spread+total together are
 *   required, not nice-to-have.
 *
 * NFL
 *   Same core market set as NBA. Fewer games per week means each line matters
 *   more individually. Lines are relatively stable until 24–48h before kickoff
 *   (injury reports), then can move fast. Spread and total are table stakes.
 *   Slightly longer stale window than NBA because game pace of line movement
 *   outside the final few hours is slower.
 *
 * MLB
 *   Run line replaces spread (pitcher-adjusted; teams don't get standard -1.5/+1.5
 *   on neutral-field games the way NFL does). Total (over/under runs) is core.
 *   Moneyline drives the model. Most important freshness event: confirmed starters
 *   and lineup drops (usually 3–4h before first pitch), which is why maxStaleMs
 *   is 10 min — a provider serving pre-lineup data after lineups post is misleading.
 *   liveMaxStaleMs is tightest here: in-game MLB odds shift on every at-bat.
 *
 * ─── Completeness scoring guidance ──────────────────────────────────────────
 *
 * Combat sports (MMA/Boxing):
 *   Three markets, all roughly equal weight. A provider missing "distance" is
 *   less harmful because the model doesn't require it for fight-winner predictions.
 *   completenessWeight = 0.8 (good-to-have, not required for core model).
 *
 * Team sports (NBA/NFL/MLB):
 *   Spread and total are required by the prediction model, not optional overlays.
 *   A provider returning only moneyline is substantially less useful.
 *   completenessWeight = 1.0 (full weight; completeness directly affects model quality).
 *   MLB = 0.9 because run line is structurally different from spread and some
 *   providers omit it for early-season or interleague games.
 *
 * ─── Market normalization edge cases ────────────────────────────────────────
 *
 * Across providers, the same market appears under different names:
 *   - "h2h" vs "moneyline" vs "winner" vs "1x2"
 *   - "totals" vs "over_under" vs "total_runs" vs "total_rounds"
 *   - "spreads" vs "spread" vs "handicap" vs "run_line" vs "puck_line"
 *   - "draw" vs "tie" vs "goes_distance"
 *   - Player props: "player_points" vs "points" vs "pts_ou"
 *
 * The inferMarkets() function in multiOddsProvider.ts checks what the
 * normalized CombatOddsEvent shape actually has (homeMoneyline, totalRounds,
 * drawMoneyline) — not raw provider strings — so normalization happens at
 * the provider adapter layer before scoring, not here.
 *
 * For team sports, the equivalent normalization belongs in the sport's
 * provider adapter (the `from*()` functions), not in config.
 *
 * ─── Health state namespacing ────────────────────────────────────────────────
 *
 * Provider health state (avgLatencyMs, avgMarketsCount, etc.) is currently
 * keyed by provider name only (e.g. "TheOddsAPI"). When team sports are added
 * to the same provider framework, use sport-namespaced keys ("TheOddsAPI:nba")
 * so that NBA completeness scores don't bleed into MMA health rankings.
 *
 * One advantage of shared keys: quota circuit breakers do propagate correctly
 * across sports (if TheOddsAPI quota is exhausted for MMA, it's exhausted for
 * NBA too — same API key). This is desirable behavior. The tradeoff is that
 * latency and completeness scores mix sports. Namespace when that causes drift.
 */

export type Sport = "mma" | "boxing" | "nba" | "nfl" | "mlb";

export interface SportConfig {
  /**
   * Markets the UI actually consumes.
   * Used as the denominator for normalized completeness scoring.
   * Keep this list in sync with what the product renders — if a market is
   * added to the UI, add it here or providers covering it will be undervalued.
   */
  expectedMarkets: string[];

  /**
   * Live cache TTL — how long a fresh response is reused before re-fetching.
   * Tighter for fast-moving markets (NBA/MLB near game time), looser for
   * fight cards posted days in advance.
   */
  cacheTtlMs: number;

  /**
   * Max age for the stale-last-good fallback before it is discarded.
   * Set conservatively — stale odds can mislead the prediction model more
   * than having no odds at all (which triggers a neutral prior).
   */
  maxStaleMs: number;

  /**
   * [Future] Tighter stale threshold for live / in-game contexts.
   * Not enforced yet — pass at the call site when live odds screens exist.
   * Pattern: fetchCombatOddsWithMeta(sport, { context: "live" })
   */
  liveMaxStaleMs: number;

  /**
   * Weight (0–1) applied to the market completeness bonus in health scoring.
   * Higher = completeness matters more for provider ranking for this sport.
   * Markets are essential for team sport models; more optional for combat sports.
   */
  completenessWeight: number;
}

export const SPORT_CONFIG: Record<Sport, SportConfig> = {
  // ── Combat sports ────────────────────────────────────────────────────────────
  mma: {
    expectedMarkets:    ["winner", "rounds", "distance"],
    cacheTtlMs:          2 * 60 * 1000,         //  2 min
    maxStaleMs:         24 * 60 * 60 * 1000,    // 24 h  — fight cards posted days ahead
    liveMaxStaleMs:     30 * 60 * 1000,          // 30 min — future: live fight odds
    completenessWeight:  0.8,                    // completeness good-to-have, not required
  },
  boxing: {
    expectedMarkets:    ["winner", "rounds", "distance"],
    cacheTtlMs:          2 * 60 * 1000,
    maxStaleMs:         24 * 60 * 60 * 1000,
    liveMaxStaleMs:     30 * 60 * 1000,
    completenessWeight:  0.8,
  },

  // ── Team sports ──────────────────────────────────────────────────────────────
  nba: {
    // Spread and total are required by the prediction model, not optional.
    // Player props are consumed by the UI but sourced separately — not in this list.
    expectedMarkets:    ["moneyline", "spread", "total"],
    cacheTtlMs:          1 * 60 * 1000,          //  1 min — lines move near tipoff
    maxStaleMs:         15 * 60 * 1000,          // 15 min — injury news → line jump
    liveMaxStaleMs:      2 * 60 * 1000,          //  2 min — in-game (future)
    completenessWeight:  1.0,                    // spread+total required for model
  },
  nfl: {
    expectedMarkets:    ["moneyline", "spread", "total"],
    cacheTtlMs:          2 * 60 * 1000,
    maxStaleMs:         20 * 60 * 1000,          // 20 min — slower line movement outside injury window
    liveMaxStaleMs:      3 * 60 * 1000,
    completenessWeight:  1.0,
  },
  mlb: {
    // Run line (pitcher-adjusted spread) replaces standard spread.
    // Lineup/starter drops ~3–4h before first pitch are the primary freshness event.
    expectedMarkets:    ["moneyline", "runline", "total"],
    cacheTtlMs:          1 * 60 * 1000,
    maxStaleMs:         10 * 60 * 1000,          // 10 min — stale after lineup confirmation is misleading
    liveMaxStaleMs:      1 * 60 * 1000,          //  1 min — in-game MLB shifts on every at-bat
    completenessWeight:  0.9,                    // run line occasionally missing for early-season games
  },
};
