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
import {
  isCombatSport,
  validateCombatProp,
} from "@/lib/playerProps/combatMarketValidation";
import { isDraftKingsAvailable } from "@/lib/draftkings/dkMarketCatalog";
import { getPropRiskLevel } from "@/lib/valueParlay/propRiskLevels";

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
    /** Cap from new high-risk-stat diversity gate (#177 item 7). */
    high_risk_stat_in_top_capped: number;
    /** DK market not booked for this (sport, stat_type) combo. */
    dk_not_supported: number;
    /**
     * Boxing/MMA props whose market shape is invalid — e.g. a
     * fight_winner prop with a numeric Over/Under line, or a
     * binary stat with LESS direction (no inverse market exists).
     * Bumped before scoring so these never reach the user.
     */
    invalid_combat_market: number;
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
 *
 * Strict policy (#177 item 5): only accept the prop when we can
 * confidently parse a date from `game_time` and that date matches
 * the target slate. Either:
 *   • ISO-ish: `YYYY-MM-DD…` parsed via Date()
 *   • Numeric: epoch seconds or millis
 *
 * Display-only labels ("7:30 PM ET", "Final", etc.) and missing
 * `game_time` fall through to a separate `game_date` field check
 * when present; otherwise rejected. The previous lenient default
 * (accept anything we couldn't parse) was a no-op for almost every
 * production row because `formatGameTime` in espnPlayerStats emits
 * display strings.
 *
 * The reject-when-unsure policy is paired with the prop fetcher
 * setting `game_date` to a real YYYY-MM-DD on every emitted row;
 * if upstream forgets to populate it, the user sees an empty Top
 * Props list and we get a loud signal rather than a quiet tomorrow-
 * leakage bug.
 */
function gameMatchesDate(pred: PlayerEdgePrediction, targetYmd: string): boolean {
  // Prefer an explicit YYYY-MM-DD `game_date` when set — this is
  // what the prop fetcher should emit going forward.
  const gd = (pred as { game_date?: string }).game_date;
  if (typeof gd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(gd)) {
    return gd === targetYmd;
  }
  if (!pred.game_time) return false;
  // ISO-ish — let Date() do the work and compare local YMDs.
  if (/^\d{4}-\d{2}-\d{2}/.test(pred.game_time)) {
    const gameDate = new Date(pred.game_time);
    if (!Number.isNaN(gameDate.getTime())) {
      return toLocalYmd(gameDate) === targetYmd;
    }
  }
  // Numeric epoch (sec or ms) — sometimes upstream emits these.
  const asNum = Number(pred.game_time);
  if (Number.isFinite(asNum) && asNum > 0) {
    const ms = asNum > 1e12 ? asNum : asNum * 1000;
    const gameDate = new Date(ms);
    if (!Number.isNaN(gameDate.getTime())) {
      return toLocalYmd(gameDate) === targetYmd;
    }
  }
  // Unparseable display string — reject. Upstream must provide a
  // parseable date if the prop is to enter Top Props.
  return false;
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
  // Combat-market validation runs first — a malformed combat prop
  // shouldn't burn a "no_game_today" slot (and the row will never
  // render anyway, so counting it under the right reason matters
  // for the debug panel).
  if (isCombatSport(pred.sport)) {
    const v = validateCombatProp(pred);
    if (!v.valid) {
      stats.filtered_out.invalid_combat_market++;
      if (typeof console !== "undefined") {
        console.debug(
          `[topPropsRanker] invalid combat market filtered: ${v.reason}`,
          { id: pred.id, sport: pred.sport, stat_type: pred.stat_type },
        );
      }
      return false;
    }
  }

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
  // Probability floor (#177 item 4) — tightened from 0.50 to 0.55.
  // 0.50 is "no information" for a binary prop; 0.55 means the
  // model has at least a 5pp lean. Combined with the synthetic
  // `recent_form` removal, this keeps the bottom of the pool out
  // of Top Props entirely.
  const p = calibratedProb01(pred);
  if (p < 0.55) {
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
  // DraftKings availability (#177 item 6) — applied consistently
  // across surfaces. Hero card already enforces this; Top Props
  // now matches so users don't see picks DK doesn't book and
  // can't actually act on. Combat sports skip the DK gate (the
  // catalog only knows team-sport markets).
  if (!isCombatSport(pred.sport)
      && !isDraftKingsAvailable(pred.sport, pred.stat_type)) {
    stats.filtered_out.dk_not_supported++;
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

  // Repeat-player penalty (#177 item 1 — bug fix).
  // The previous comparator was `edgePct < REPEAT_OVERRIDE_EDGE / 0.10`
  // which evaluated to `0.08 / 0.10 = 0.8`, so the penalty fired
  // unless edge cleared 80% of sport-max — almost never. Players
  // appearing yesterday were biased against regardless of signal
  // strength. Compare edgePct directly against REPEAT_OVERRIDE_EDGE
  // so a strong-enough signal (≥8% of sport-max) waives the penalty.
  let repeatPenalty = 0;
  if (yesterdayPlayers.has(String(pred.player_id))) {
    const edgePct = Math.abs(pred.edge ?? 0) / maxEdgeFor(pred.sport);
    if (edgePct < REPEAT_OVERRIDE_EDGE) {
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
  /** New (#177 item 7): cap how many "high risk" stat-types
   *  (RBIs, HRs, stolen bases, MLB combined picks, KO/TKO) can
   *  reach the final list. Was implicitly unbounded before. */
  maxHighRiskStatInTop: number;
}

const DEFAULT_CAPS: DiversityCaps = {
  maxPerPlayer:         2,
  maxPerGame:           3,
  maxPerSportInTop:     3,
  maxHighVolInTop:      1,
  maxHighRiskStatInTop: 1,
};

function isHighVol(p: PlayerEdgePrediction): boolean {
  return Boolean(p.volatility_flag) || p.consistency_label === "volatile";
}

/**
 * Per-stat-type structural risk classifier (#177 item 7). Reads
 * propRiskLevels — the same source-of-truth the parlay optimizer
 * uses — so the ranker doesn't drift from Sharp Mode's view of
 * which markets are inherently noisy.
 */
function isHighRiskStat(p: PlayerEdgePrediction): boolean {
  return getPropRiskLevel({
    statType:       p.stat_type,
    marketType:     "player_prop",
    selectionLabel: `${p.player_name ?? ""} ${p.stat_type ?? ""}`,
  }) === "high";
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
  let highRiskStatUsed = 0;

  // Sport cap is now hard (#177 item 7 alignment) — the previous
  // single-sport waiver let MLB-only Tuesdays surface 10 MLB
  // combined-stat props in the same Top 10 with no diversity
  // protection. With a hard cap and a fallback that only kicks in
  // when the slate genuinely lacks alternates, the ranker behaves
  // the same on multi-sport days and degrades gracefully on
  // single-sport days.
  const sportCapEffective = caps.maxPerSportInTop;

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
    if (isHighRiskStat(pred) && highRiskStatUsed >= caps.maxHighRiskStatInTop) {
      stats.filtered_out.high_risk_stat_in_top_capped++;
      continue;
    }

    accepted.push(r);
    sportCount.set(sport, (sportCount.get(sport) ?? 0) + 1);
    playerCount.set(player, (playerCount.get(player) ?? 0) + 1);
    gameCount.set(gameId, (gameCount.get(gameId) ?? 0) + 1);
    if (isHighVol(pred))      highVolUsed++;
    if (isHighRiskStat(pred)) highRiskStatUsed++;
  }

  // Single-sport fallback — if the slate genuinely had only one
  // sport on board and we ran out before reaching topN because of
  // the (now hard) sport cap, top up by ignoring sport. Player /
  // game / stat caps still apply so we don't regress to "10 hits
  // props on the same player". Keeps the ranker useful on quiet
  // days without re-introducing the silent waiver.
  if (accepted.length < topN) {
    const distinctSports = new Set(scored.map((s) => s.pred.sport));
    if (distinctSports.size <= 1) {
      for (const r of scored) {
        if (accepted.length >= topN) break;
        if (accepted.includes(r)) continue;
        const pred = r.pred;
        const player = String(pred.player_id);
        const gameId = String(pred.game_id);
        if ((playerCount.get(player) ?? 0) >= caps.maxPerPlayer) continue;
        if ((gameCount.get(gameId)  ?? 0) >= caps.maxPerGame)   continue;
        if (isHighVol(pred)      && highVolUsed      >= caps.maxHighVolInTop)      continue;
        if (isHighRiskStat(pred) && highRiskStatUsed >= caps.maxHighRiskStatInTop) continue;
        accepted.push(r);
        playerCount.set(player, (playerCount.get(player) ?? 0) + 1);
        gameCount.set(gameId, (gameCount.get(gameId) ?? 0) + 1);
        if (isHighVol(pred))      highVolUsed++;
        if (isHighRiskStat(pred)) highRiskStatUsed++;
      }
    }
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
      high_risk_stat_in_top_capped: 0,
      dk_not_supported: 0,
      invalid_combat_market: 0,
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
