/**
 * Top Props ranker — daily slate scan with diversity rules.
 *
 * Replaces the legacy `sortPlayerEdgePredictions` for the "Top Props
 * Today" surface. Walks the full enriched-prop pool, filters to
 * today/tomorrow's slate, applies the spec's weighted score, then
 * enforces caps so the same players/games/sports don't dominate.
 *
 * Scoring formula (per spec):
 *   finalPropScore =
 *       calibratedProbability  * 0.30
 *     + edgeNormalized         * 0.22
 *     + stabilityScore         * 0.16
 *     + recentHitRate          * 0.12
 *     + matchupScore           * 0.10
 *     + timingScore            * 0.06
 *     - volatilityPenalty      * 0.04
 *
 * All inputs normalized to [0, 1] so the weights mean what they say.
 *
 * Diversity caps applied AFTER scoring:
 *   - max 2 props per player
 *   - max 3 props per game
 *   - max 3 props per sport in Top 10 (relaxed when slate is single-sport)
 *   - max 1 high-volatility prop in Top 10
 *
 * Repeat-exposure: yesterday's top players get a small score penalty
 * (−0.05 in score units) UNLESS today's edge clears 8% (strong-enough
 * signal to override). Yesterday's top set persists in localStorage.
 */

import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";

export interface ScanStats {
  total_scanned: number;
  filtered_out: {
    no_game_today: number;
    inactive_player: number;
    low_probability: number;
    high_volatility_blocked: number;
    duplicate_player_capped: number;
    duplicate_game_capped: number;
    duplicate_sport_capped: number;
    high_volatility_in_top_capped: number;
  };
  pool_after_filters: number;
  final_ranked: number;
}

export interface RankerOptions {
  /** Slate date filter. */
  date: "today" | "tomorrow";
  /** Max props in the final ranked list. Default 10. */
  topN?: number;
  /**
   * When true, all candidates pass through but the caller is expected
   * to render a "Data stale — review only" banner. PLACE recommendations
   * should be suppressed at the UI layer.
   */
  oddsStale?: boolean;
  /** Override "now" for testing. */
  now?: Date;
}

export interface RankedProp {
  pred: PlayerEdgePrediction;
  /** Final composite score after diversity post-processing. */
  score: number;
  /** Per-component breakdown for the debug panel. */
  breakdown: {
    calibratedProb: number;
    edgeNorm: number;
    stability: number;
    recentHitRate: number;
    matchup: number;
    timing: number;
    volatilityPenalty: number;
    repeatPenalty: number;
  };
}

const DEFAULT_TOP_N = 10;
const REPEAT_PENALTY = 0.05;
const REPEAT_OVERRIDE_EDGE = 0.08; // 8pp+ edge skips the repeat penalty

const YESTERDAY_KEY = "gamelens-top-props-yesterday-v1";

// ── Date helpers ─────────────────────────────────────────────────────

function toLocalYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function nextYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d + 1);
  return toLocalYmd(dt);
}

function targetDateYmd(date: "today" | "tomorrow", now: Date): string {
  const today = toLocalYmd(now);
  return date === "today" ? today : nextYmd(today);
}

/**
 * Date-match the prediction's game_time against the target slate.
 * Compares LOCAL YMD on both sides — handles ESPN's UTC ISO strings
 * correctly because new Date(iso) localizes automatically.
 */
function gameMatchesDate(pred: PlayerEdgePrediction, targetYmd: string): boolean {
  if (!pred.game_time) return false;
  try {
    const gameDate = new Date(pred.game_time);
    if (Number.isNaN(gameDate.getTime())) return false;
    return toLocalYmd(gameDate) === targetYmd;
  } catch {
    return false;
  }
}

// ── Repeat-exposure cache (localStorage) ──────────────────────────────

interface YesterdayCache {
  date: string;             // YYYY-MM-DD
  playerIds: string[];      // top-10 player ids that day
}

function readYesterdaySet(targetYmd: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(YESTERDAY_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as YesterdayCache;
    // "Yesterday" relative to the target slate — when ranking today's
    // pool, the cache should hold yesterday's top; when ranking
    // tomorrow's pool, it should hold today's. Either way the cache's
    // `date` should be exactly one day before the target.
    const expectedYesterday = (() => {
      const [y, m, d] = targetYmd.split("-").map(Number);
      const dt = new Date(y, m - 1, d - 1);
      return toLocalYmd(dt);
    })();
    if (parsed.date !== expectedYesterday) return new Set();
    return new Set(parsed.playerIds);
  } catch {
    return new Set();
  }
}

export function rememberTodaysTopPlayers(targetYmd: string, playerIds: string[]): void {
  if (typeof window === "undefined") return;
  try {
    const payload: YesterdayCache = { date: targetYmd, playerIds };
    window.localStorage.setItem(YESTERDAY_KEY, JSON.stringify(payload));
  } catch {
    /* quota or denial — silently ignore */
  }
}

// ── Score component normalizers ──────────────────────────────────────

/**
 * Normalize edge to [0, 1] using the existing sport-specific maxima.
 * Mirrors the BestPlayerPropToday floor logic so scoring stays
 * consistent across the two surfaces.
 */
function maxEdgeFor(sport: PlayerEdgePrediction["sport"]): number {
  return sport === "NBA" || sport === "WNBA" ? 8
       : sport === "NFL" ? 30
       : sport === "MLB" ? 3
       : 15;
}

function edgeNorm01(pred: PlayerEdgePrediction): number {
  const max = maxEdgeFor(pred.sport);
  const raw = Math.abs(pred.edge ?? 0) / max;
  return Math.max(0, Math.min(1, raw));
}

function calibratedProb01(pred: PlayerEdgePrediction): number {
  // Prefer ml_hit_probability (Platt-calibrated when ml_active);
  // fall back to confidence-tier proxy.
  if (pred.ml_hit_probability != null && pred.ml_active) {
    return Math.max(0, Math.min(1, pred.ml_hit_probability));
  }
  const conf = pred.confidence_score_0_100
    ?? (pred.confidence === "HIGH" ? 72 : pred.confidence === "MED" ? 58 : 44);
  return Math.max(0, Math.min(1, conf / 100));
}

function stability01(pred: PlayerEdgePrediction): number {
  // Prefer ML stability_score when present, else map consistency_label.
  if (typeof pred.stability_score === "number") {
    return Math.max(0, Math.min(1, pred.stability_score));
  }
  if (pred.consistency_label === "stable")  return 0.85;
  if (pred.consistency_label === "medium")  return 0.55;
  if (pred.consistency_label === "volatile") return 0.20;
  return 0.50; // unknown → neutral
}

function recentHitRate01(pred: PlayerEdgePrediction): number {
  // PlayerEdgePrediction doesn't carry an explicit recent_hit_rate field
  // today (that lives on ValueBetCandidate post-enrichment via
  // recentPerformanceEnrichment). Use recent_form as the available
  // proxy. Future: pipe a real recent_hit_rate into this layer when
  // the prop pool is enriched upstream.
  if (pred.recent_form === "hot")    return 0.70;
  if (pred.recent_form === "cold")   return 0.30;
  if (pred.recent_form === "steady") return 0.55;
  return 0.50;
}

function matchup01(pred: PlayerEdgePrediction): number {
  // Map matchup_quality to score. Soft = good for the bettor.
  switch (pred.matchup_quality) {
    case "soft":
    case "soft_pass":
    case "soft_rush":
    case "fast":
      return 0.80;
    case "tough":
    case "tough_pass":
    case "tough_rush":
      return 0.25;
    case "neutral":
      return 0.55;
    default:
      return 0.50;
  }
}

function timing01(pred: PlayerEdgePrediction): number {
  if (pred.timing_urgency === "now")     return 0.90;
  if (pred.timing_urgency === "monitor") return 0.55;
  if (pred.timing_urgency === "wait")    return 0.20;
  return 0.50;
}

function volatilityPenalty01(pred: PlayerEdgePrediction): number {
  // 0 = no penalty, 1 = max. ML volatility_flag stacks on top of
  // consistency_label to reach the highest penalty.
  let p = 0;
  if (pred.consistency_label === "volatile") p += 0.6;
  else if (pred.consistency_label === "medium") p += 0.3;
  if (pred.volatility_flag) p += 0.4;
  return Math.max(0, Math.min(1, p));
}

// ── Filter helpers ───────────────────────────────────────────────────

/**
 * Hard filters applied BEFORE scoring. Returns false → exclude with
 * the matching diagnostic counter incremented.
 */
function passesHardFilters(
  pred: PlayerEdgePrediction,
  targetYmd: string,
  stats: ScanStats,
): boolean {
  if (!gameMatchesDate(pred, targetYmd)) {
    stats.filtered_out.no_game_today++;
    return false;
  }
  // "Inactive player" proxy — when the prop_source is "unavailable"
  // it means we couldn't find leader data, often because the
  // athlete is out / not in the lineup.
  if (pred.prop_source === "unavailable") {
    stats.filtered_out.inactive_player++;
    return false;
  }
  // Probability floor — ML hit prob OR confidence proxy.
  const p = calibratedProb01(pred);
  if (p < 0.50) {
    stats.filtered_out.low_probability++;
    return false;
  }
  // High volatility WITH thin edge gets blocked outright.
  // Spec lets one high-vol prop survive into Top 10, so this is just
  // the brutal "high vol + nothing to back it" block.
  if (pred.volatility_flag && edgeNorm01(pred) < 0.05) {
    stats.filtered_out.high_volatility_blocked++;
    return false;
  }
  return true;
}

// ── Score ────────────────────────────────────────────────────────────

function score(
  pred: PlayerEdgePrediction,
  yesterdayPlayers: Set<string>,
): RankedProp {
  const calibratedProb = calibratedProb01(pred);
  const edgeNorm       = edgeNorm01(pred);
  const stability      = stability01(pred);
  const recentHitRate  = recentHitRate01(pred);
  const matchup        = matchup01(pred);
  const timing         = timing01(pred);
  const volatilityPenalty = volatilityPenalty01(pred);

  const base =
      calibratedProb * 0.30
    + edgeNorm       * 0.22
    + stability      * 0.16
    + recentHitRate  * 0.12
    + matchup        * 0.10
    + timing         * 0.06
    - volatilityPenalty * 0.04;

  // Repeat-player penalty. Player IDs may be sport-prefixed, so we
  // lookup the bare id. Strong-enough edge waives the penalty.
  let repeatPenalty = 0;
  if (yesterdayPlayers.has(String(pred.player_id))) {
    const edgePct = Math.abs(pred.edge ?? 0) / maxEdgeFor(pred.sport);
    if (edgePct < REPEAT_OVERRIDE_EDGE / 0.10) {
      repeatPenalty = REPEAT_PENALTY;
    }
  }

  const finalScore = base - repeatPenalty;

  return {
    pred,
    score: finalScore,
    breakdown: {
      calibratedProb,
      edgeNorm,
      stability,
      recentHitRate,
      matchup,
      timing,
      volatilityPenalty,
      repeatPenalty,
    },
  };
}

// ── Diversity post-processing ────────────────────────────────────────

interface DiversityCaps {
  maxPerPlayer: number;
  maxPerGame: number;
  maxPerSportInTop: number;
  maxHighVolInTop: number;
}

const DEFAULT_CAPS: DiversityCaps = {
  maxPerPlayer:      2,
  maxPerGame:        3,
  maxPerSportInTop:  3,
  maxHighVolInTop:   1,
};

function isHighVol(p: PlayerEdgePrediction): boolean {
  return Boolean(p.volatility_flag) || p.consistency_label === "volatile";
}

/**
 * Walk score-sorted candidates, accept up to topN while respecting
 * the diversity caps. Counts each rejection so the debug panel can
 * show why props were dropped.
 *
 * Sport cap is relaxed when the slate is single-sport — if every
 * candidate in the pool comes from one sport, no point capping on
 * sport diversity.
 */
function applyDiversityCaps(
  scored: RankedProp[],
  topN: number,
  stats: ScanStats,
  caps: DiversityCaps = DEFAULT_CAPS,
): RankedProp[] {
  const sportCount  = new Map<string, number>();
  const playerCount = new Map<string, number>();
  const gameCount   = new Map<string, number>();
  let highVolUsed   = 0;

  // Detect single-sport slate.
  const distinctSports = new Set(scored.map((s) => s.pred.sport));
  const sportCapEffective = distinctSports.size <= 1 ? Infinity : caps.maxPerSportInTop;

  const accepted: RankedProp[] = [];
  for (const r of scored) {
    if (accepted.length >= topN) break;
    const pred = r.pred;
    const sport = String(pred.sport);
    const player = String(pred.player_id);
    const gameId = String(pred.game_id);

    if ((playerCount.get(player) ?? 0) >= caps.maxPerPlayer) {
      stats.filtered_out.duplicate_player_capped++;
      continue;
    }
    if ((gameCount.get(gameId) ?? 0) >= caps.maxPerGame) {
      stats.filtered_out.duplicate_game_capped++;
      continue;
    }
    if ((sportCount.get(sport) ?? 0) >= sportCapEffective) {
      stats.filtered_out.duplicate_sport_capped++;
      continue;
    }
    if (isHighVol(pred) && highVolUsed >= caps.maxHighVolInTop) {
      stats.filtered_out.high_volatility_in_top_capped++;
      continue;
    }

    accepted.push(r);
    sportCount.set(sport, (sportCount.get(sport) ?? 0) + 1);
    playerCount.set(player, (playerCount.get(player) ?? 0) + 1);
    gameCount.set(gameId, (gameCount.get(gameId) ?? 0) + 1);
    if (isHighVol(pred)) highVolUsed++;
  }
  return accepted;
}

// ── Public API ───────────────────────────────────────────────────────

export function rankTopProps(
  items: PlayerEdgePrediction[],
  options: RankerOptions,
): { ranked: RankedProp[]; scanStats: ScanStats } {
  const now = options.now ?? new Date();
  const targetYmd = targetDateYmd(options.date, now);
  const topN = options.topN ?? DEFAULT_TOP_N;

  const stats: ScanStats = {
    total_scanned: items.length,
    filtered_out: {
      no_game_today: 0,
      inactive_player: 0,
      low_probability: 0,
      high_volatility_blocked: 0,
      duplicate_player_capped: 0,
      duplicate_game_capped: 0,
      duplicate_sport_capped: 0,
      high_volatility_in_top_capped: 0,
    },
    pool_after_filters: 0,
    final_ranked: 0,
  };

  // Stage 1: hard filters.
  const survivors: PlayerEdgePrediction[] = [];
  for (const p of items) {
    if (passesHardFilters(p, targetYmd, stats)) survivors.push(p);
  }
  stats.pool_after_filters = survivors.length;

  // Stage 2: score with repeat-exposure penalty.
  const yesterdaySet = readYesterdaySet(targetYmd);
  const scored = survivors.map((p) => score(p, yesterdaySet));
  scored.sort((a, b) => b.score - a.score);

  // Stage 3: diversity caps.
  const ranked = applyDiversityCaps(scored, topN, stats);
  stats.final_ranked = ranked.length;

  return { ranked, scanStats: stats };
}
