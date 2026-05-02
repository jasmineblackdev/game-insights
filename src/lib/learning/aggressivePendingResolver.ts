/**
 * Aggressive pending-parlay resolver — fires from /parlays directly.
 *
 * The existing `resolveRecommendedParlays` resolver requires a
 * `GamePrediction[]` array (loaded from Index.tsx / DailyPlanPage) and
 * has a 7-day window. Result: when the user lands directly on
 * /parlays, nothing settles, and rows older than a week stay
 * "pending" forever even though the games are long final.
 *
 * This resolver fixes both:
 *   - No games-array dependency. Fetches ESPN summary endpoint per
 *     unique gameId on the fly.
 *   - No date cutoff. Walks every pending app_recommended /
 *     user_manual parlay and tries to settle each leg.
 *   - Supports moneyline / spread / total / player_prop. Falls
 *     back to "needs_review" — leaves leg pending — when data is
 *     ambiguous; never invents an outcome.
 *
 * Reuses existing helpers:
 *   - lookupAthleteStat + outcomeForOverUnder for player props
 *   - bridgeParlayLegs for prediction_history sync
 *   - rollupParlayOutcome (replicated locally; matches the original)
 */

import { supabase } from "@/lib/supabase";
import { bridgeParlayLegs } from "@/lib/learning/parlayLegBridge";
import {
  espnLabelsForStat,
  leaguePathFor,
  lookupAthleteStat,
  outcomeForOverUnder,
} from "@/lib/learning/espnBoxScoreLookup";

type LegOutcome = "win" | "loss" | "push" | "pending";

interface PendingLeg {
  id?: string;
  selection?: string;
  sport?: string;
  market_type?: string;
  pick_type?: string;
  stat_type?: string;
  line_value?: number | null;
  direction?: "MORE" | "LESS" | null;
  /** Sometimes spelled this way on legacy rows. */
  side?: "home" | "away" | null;
  team_id?: string | null;
  team_abbr?: string | null;
  american_odds?: number | null;
  leg_outcome?: LegOutcome;
  game_id?: string;
  actual_value?: number | null;
  /**
   * Diagnosis written by the resolver when a leg can't be settled.
   * Lets the user (and a future ML diagnostic) see why each pending
   * leg never resolved. Cleared once the leg actually settles.
   */
  resolution_diagnosis?:
    | "unparseable_id"
    | "missing_direction"
    | "stat_type_unsupported"
    | "game_not_final"
    | "box_score_missing"
    | "team_label_unmatched"
    | null;
}

interface PendingParlay {
  id: string;
  source: string;
  date: string;
  recommended_at: string;
  resolved_at: string | null;
  user_id: string | null;
  legs: PendingLeg[];
  outcome: "pending" | "won" | "lost" | "push" | "partial";
}

export interface AggressiveResolverResult {
  scanned: number;
  resolved: number;          // parlays that flipped from pending → terminal
  legsSettled: number;       // individual legs that flipped
  bridgeInserted: number;
  /** Parlays force-voided via voidStaleBeforeDate. Always 0 unless the option is set. */
  staleVoided: number;
  /** Parlays auto-marked partial because every leg had an unparseable id and date had passed. */
  needsReviewMarked: number;
  errors: string[];
  /**
   * Per-diagnosis tally so the UI can surface "X rows can't resolve
   * because their box scores are missing" / "Y have unparseable
   * legacy IDs" without parsing logs.
   */
  diagnosisCounts: Record<string, number>;
}

interface GameSummary {
  state: "pre" | "in" | "post" | "unknown";
  homeAbbr: string;
  awayAbbr: string;
  homeScore: number | null;
  awayScore: number | null;
}

const summaryCache = new Map<string, Promise<GameSummary | null>>();

async function fetchGameSummary(sport: string, gameId: string): Promise<GameSummary | null> {
  const path = leaguePathFor(sport);
  if (!path) return null;
  const key = `${path}:${gameId}`;
  if (summaryCache.has(key)) return summaryCache.get(key)!;
  const p = (async (): Promise<GameSummary | null> => {
    try {
      const res = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${encodeURIComponent(gameId)}`,
      );
      if (!res.ok) return null;
      const j = (await res.json()) as Record<string, unknown>;
      const competitions = (j.header as { competitions?: unknown[] } | undefined)?.competitions
        ?? (j as { competitions?: unknown[] }).competitions;
      const comp = (competitions?.[0] ?? null) as Record<string, unknown> | null;
      if (!comp) return null;
      const stateRaw = (comp.status as { type?: { state?: string } } | undefined)?.type?.state ?? "unknown";
      const competitors = (comp.competitors as Array<Record<string, unknown>>) ?? [];
      const home = competitors.find((c) => c.homeAway === "home");
      const away = competitors.find((c) => c.homeAway === "away");
      return {
        state: stateRaw as GameSummary["state"],
        homeAbbr: ((home?.team as { abbreviation?: string } | undefined)?.abbreviation) ?? "",
        awayAbbr: ((away?.team as { abbreviation?: string } | undefined)?.abbreviation) ?? "",
        homeScore: home?.score != null ? Number(home.score) : null,
        awayScore: away?.score != null ? Number(away.score) : null,
      };
    } catch {
      return null;
    }
  })();
  summaryCache.set(key, p);
  return p;
}

/**
 * Extract { gameId, side } from a moneyline leg id. The optimizer
 * emits two patterns over the project's history; both are handled.
 */
function parseMoneylineLeg(leg: PendingLeg): { gameId: string; side: "home" | "away" } | null {
  if (leg.market_type !== "moneyline") return null;
  const id = leg.id ?? "";
  // Modern: vp-{gameId}-ml-{side}
  let m = /^vp-(.+)-ml-(home|away)$/.exec(id);
  if (m) return { gameId: m[1], side: m[2] as "home" | "away" };
  // Legacy: ml-{gameId}-{side}
  m = /^ml-(.+)-(home|away)$/.exec(id);
  if (m) return { gameId: m[1], side: m[2] as "home" | "away" };
  // Last resort: leg carries side directly
  if (leg.side && leg.game_id) return { gameId: leg.game_id, side: leg.side };
  return null;
}

/**
 * Extract { gameId, side } from a spread leg.
 * buildCandidates emits id `vp-{gameId}-spr-{coverSide}` (NOT
 * `-spread-`). Both patterns accepted for forward-compat.
 */
function parseSpreadLeg(leg: PendingLeg): { gameId: string; side: "home" | "away" } | null {
  if (leg.market_type !== "spread") return null;
  const id = leg.id ?? "";
  let m = /^vp-(.+)-spr-(home|away)$/.exec(id);
  if (m) return { gameId: m[1], side: m[2] as "home" | "away" };
  m = /^vp-(.+)-spread-(home|away)$/.exec(id);
  if (m) return { gameId: m[1], side: m[2] as "home" | "away" };
  if (leg.side && leg.game_id) return { gameId: leg.game_id, side: leg.side };
  return null;
}

function parseTotalLeg(leg: PendingLeg): { gameId: string; side: "over" | "under" } | null {
  if (leg.market_type !== "total") return null;
  const id = leg.id ?? "";
  // Real pattern is `vp-{gameId}-tot-{over|under}`; legacy `-total-`
  // accepted as fallback.
  let m = /^vp-(.+)-tot-(over|under)$/.exec(id);
  if (m) return { gameId: m[1], side: m[2] as "over" | "under" };
  m = /^vp-(.+)-total-(over|under)$/.exec(id);
  if (m) return { gameId: m[1], side: m[2] as "over" | "under" };
  if (leg.direction && leg.game_id) {
    const side = leg.direction === "MORE" ? "over" : "under";
    return { gameId: leg.game_id, side };
  }
  return null;
}

/**
 * Player-prop ID parsers. Three patterns observed across the
 * codebase's history:
 *   1. ml-prop-espn-{sport}-{gameId}-{athleteId}-{cat}    (enriched)
 *   2. pe-espn-{sport}-{gameId}-{athleteId}-{cat}         (legacy enriched)
 *   3. vp-{gameId}-prop-{playerId}-{statType}             (rules-built)
 *
 * Pattern 3 doesn't carry sport in the id — fall back to leg.sport
 * when present.
 */
function parsePropLeg(leg: PendingLeg): { sport: string; gameId: string; athleteId: string } | null {
  if (leg.market_type !== "player_prop") return null;
  const id = leg.id ?? "";
  const m1 = /^(?:ml-prop|pe)-espn-([a-z]+)-(\d+)-(\d+)-/i.exec(id);
  if (m1) return { sport: m1[1].toLowerCase(), gameId: m1[2], athleteId: m1[3] };
  const m2 = /^vp-(.+)-prop-([^-]+)-(.+)$/.exec(id);
  if (m2) {
    const sport = (leg.sport ?? "").toLowerCase();
    if (!sport) return null;
    return { sport, gameId: m2[1], athleteId: m2[2] };
  }
  return null;
}

/**
 * When the leg row was logged before legPayload wrote `direction`,
 * derive it from the selection label text. Returns null only when
 * neither source is usable.
 */
function legDirection(leg: PendingLeg): "MORE" | "LESS" | null {
  if (leg.direction === "MORE" || leg.direction === "LESS") return leg.direction;
  const lc = (leg.selection ?? "").toUpperCase();
  if (lc.includes("OVER") || lc.includes("O/U")) return "MORE";
  if (lc.includes("UNDER")) return "LESS";
  return null;
}

function legOutcomeFromMoneyline(g: GameSummary, side: "home" | "away"): LegOutcome | null {
  if (g.state !== "post") return null;
  if (g.homeScore == null || g.awayScore == null) return null;
  if (g.homeScore === g.awayScore) return "push";
  const homeWon = g.homeScore > g.awayScore;
  return (side === "home" && homeWon) || (side === "away" && !homeWon) ? "win" : "loss";
}

function legOutcomeFromSpread(g: GameSummary, side: "home" | "away", line: number | null | undefined): LegOutcome | null {
  if (g.state !== "post") return null;
  if (g.homeScore == null || g.awayScore == null) return null;
  if (line == null || !Number.isFinite(line)) return null;
  // line is signed for THIS side. side=home + line=-3.5 means home is -3.5.
  const teamScore = side === "home" ? g.homeScore : g.awayScore;
  const oppScore = side === "home" ? g.awayScore : g.homeScore;
  const margin = teamScore - oppScore;
  const adjusted = margin + line;
  if (Math.abs(adjusted) < 0.001) return "push";
  return adjusted > 0 ? "win" : "loss";
}

function legOutcomeFromTotal(g: GameSummary, side: "over" | "under", line: number | null | undefined): LegOutcome | null {
  if (g.state !== "post") return null;
  if (g.homeScore == null || g.awayScore == null) return null;
  if (line == null || !Number.isFinite(line)) return null;
  const total = g.homeScore + g.awayScore;
  if (total === line) return "push";
  const isOver = total > line;
  return (isOver && side === "over") || (!isOver && side === "under") ? "win" : "loss";
}

function rollupParlayOutcome(legs: PendingLeg[]): "pending" | "won" | "lost" | "push" {
  let anyPending = false;
  let anyLoss = false;
  let allPush = true;
  for (const l of legs) {
    if (!l.leg_outcome || l.leg_outcome === "pending") { anyPending = true; allPush = false; continue; }
    if (l.leg_outcome === "loss") anyLoss = true;
    if (l.leg_outcome !== "push") allPush = false;
  }
  if (anyLoss) return "lost";
  if (anyPending) return "pending";
  if (allPush) return "push";
  return "won";
}

interface ResolveOptions {
  /**
   * Filter by source. Defaults to ["app_recommended", "user_manual"]
   * — settles both the optimizer's auto-saved variants AND parlays
   * the user logged manually on /parlays.
   */
  sources?: string[];
  /** Cap how many pending parlays we touch per call (network polite). */
  maxParlays?: number;
  /** Optional progress callback for UI surfaces. */
  onProgress?: (done: number, total: number) => void;
  /**
   * When set (YYYY-MM-DD), any parlay still "pending" after the
   * resolution attempt AND whose `date` (game date) is strictly
   * earlier than this cutoff gets force-voided. Game-date semantic.
   */
  voidStaleBeforeDate?: string;
  /**
   * When set (ISO timestamp), any parlay still "pending" after the
   * resolution attempt AND whose `recommended_at` (row logged_at)
   * is strictly earlier than this cutoff gets force-voided. Used by
   * the System Health "Resolve stale" action so the sweep targets
   * the SAME rows Health's count flags (which is also based on
   * recommended_at). Either of the two cutoffs triggers a void —
   * they're an OR, not an AND.
   */
  voidStaleBeforeRecommendedAt?: string;
}

export async function aggressivelyResolvePendingParlays(
  options: ResolveOptions = {},
): Promise<AggressiveResolverResult> {
  const result: AggressiveResolverResult = {
    scanned: 0,
    resolved: 0,
    legsSettled: 0,
    bridgeInserted: 0,
    staleVoided: 0,
    needsReviewMarked: 0,
    errors: [],
    diagnosisCounts: {},
  };
  if (!supabase) {
    result.errors.push("Supabase not configured.");
    return result;
  }

  const sources = options.sources;
  const maxParlays = options.maxParlays ?? 500;

  // Pull every pending parlay. Default candidate query is "all
  // pending rows" — same filter Data Health uses for its count, so
  // the sweep can act on every row Health flags. Callers can still
  // narrow with options.sources for backtest scenarios.
  let pending: PendingParlay[] = [];
  try {
    let q = supabase
      .from("recommended_parlays")
      .select("id, source, date, recommended_at, resolved_at, user_id, legs, outcome")
      .eq("outcome", "pending")
      .order("recommended_at", { ascending: false })
      .limit(maxParlays);
    if (sources && sources.length > 0) q = q.in("source", sources);
    const { data, error } = await q;
    if (error) {
      result.errors.push(error.message);
      return result;
    }
    pending = (data as PendingParlay[]) ?? [];
  } catch (e) {
    result.errors.push(String(e));
    return result;
  }

  result.scanned = pending.length;

  // Debug — surfaces the candidate count and first 5 ids so the
  // System Health "Resolve stale" path can compare against the
  // health-side count and detect any future filter drift early.
  if (typeof console !== "undefined") {
    console.debug("[aggressivePendingResolver] candidates:", {
      sweepCandidateCount: pending.length,
      sourcesFilter: sources ?? null,
      voidStaleBeforeDate: options.voidStaleBeforeDate ?? null,
      voidStaleBeforeRecommendedAt: options.voidStaleBeforeRecommendedAt ?? null,
      first5: pending.slice(0, 5).map((p) => ({
        id: p.id,
        source: p.source,
        date: p.date,
        recommended_at: p.recommended_at,
      })),
    });
  }

  if (pending.length === 0) return result;

  let progressDone = 0;
  for (const parlay of pending) {
    progressDone++;
    options.onProgress?.(progressDone, pending.length);

    const updatedLegs: PendingLeg[] = parlay.legs.map((l) => ({ ...l }));
    let touchedAnyLeg = false;

    for (const leg of updatedLegs) {
      if (leg.leg_outcome && leg.leg_outcome !== "pending") continue;
      const sport = (leg.sport ?? "").toLowerCase();

      // ── Moneyline ───────────────────────────────────────────────
      const ml = parseMoneylineLeg(leg);
      if (ml) {
        const summary = await fetchGameSummary(sport, ml.gameId);
        if (!summary) { leg.resolution_diagnosis = "box_score_missing"; continue; }
        if (summary.state !== "post") { leg.resolution_diagnosis = "game_not_final"; continue; }
        const out = legOutcomeFromMoneyline(summary, ml.side);
        if (out) {
          leg.leg_outcome = out;
          leg.game_id = ml.gameId;
          leg.resolution_diagnosis = null;
          touchedAnyLeg = true;
          result.legsSettled++;
        } else {
          leg.resolution_diagnosis = "team_label_unmatched";
        }
        continue;
      }

      // ── Spread ──────────────────────────────────────────────────
      const sp = parseSpreadLeg(leg);
      if (sp) {
        const summary = await fetchGameSummary(sport, sp.gameId);
        if (!summary) { leg.resolution_diagnosis = "box_score_missing"; continue; }
        if (summary.state !== "post") { leg.resolution_diagnosis = "game_not_final"; continue; }
        const out = legOutcomeFromSpread(summary, sp.side, leg.line_value);
        if (out) {
          leg.leg_outcome = out;
          leg.game_id = sp.gameId;
          leg.resolution_diagnosis = null;
          touchedAnyLeg = true;
          result.legsSettled++;
        } else {
          leg.resolution_diagnosis = "missing_direction";
        }
        continue;
      }

      // ── Total ───────────────────────────────────────────────────
      const tot = parseTotalLeg(leg);
      if (tot) {
        const summary = await fetchGameSummary(sport, tot.gameId);
        if (!summary) { leg.resolution_diagnosis = "box_score_missing"; continue; }
        if (summary.state !== "post") { leg.resolution_diagnosis = "game_not_final"; continue; }
        const out = legOutcomeFromTotal(summary, tot.side, leg.line_value);
        if (out) {
          leg.leg_outcome = out;
          leg.game_id = tot.gameId;
          leg.resolution_diagnosis = null;
          touchedAnyLeg = true;
          result.legsSettled++;
        } else {
          leg.resolution_diagnosis = "missing_direction";
        }
        continue;
      }

      // ── Player prop ─────────────────────────────────────────────
      const prop = parsePropLeg(leg);
      if (prop) {
        const dir = legDirection(leg);
        if (!dir) { leg.resolution_diagnosis = "missing_direction"; continue; }
        if (leg.line_value == null || !leg.stat_type) {
          leg.resolution_diagnosis = "missing_direction";
          continue;
        }
        if (!espnLabelsForStat(leg.stat_type)) {
          leg.resolution_diagnosis = "stat_type_unsupported";
          continue;
        }
        try {
          const lookup = await lookupAthleteStat({
            sport: prop.sport,
            gameId: prop.gameId,
            athleteId: prop.athleteId,
            playerName: playerNameFromSelection(leg.selection),
            statType: leg.stat_type,
          });
          if (lookup.value == null) {
            leg.resolution_diagnosis = "box_score_missing";
            continue;
          }
          const out = outcomeForOverUnder(lookup.value, leg.line_value, dir);
          leg.leg_outcome = out;
          leg.game_id = prop.gameId;
          leg.actual_value = lookup.value;
          leg.resolution_diagnosis = null;
          touchedAnyLeg = true;
          result.legsSettled++;
        } catch {
          leg.resolution_diagnosis = "box_score_missing";
        }
        continue;
      }

      // No parser matched — id format unknown to the resolver.
      leg.resolution_diagnosis = "unparseable_id";
    }

    const rolled = rollupParlayOutcome(updatedLegs);
    let newOutcome: "pending" | "won" | "lost" | "push" = rolled;
    let stalenessVoided = false;
    let unparseableMarked = false;

    // Stale-void path — explicit cleanup. Either cutoff fires the
    // void (game-date OR row-logged-at). System Health's "Resolve
    // stale" passes the recommended_at one because that's the field
    // its count is based on; legacy callers pass the game-date one.
    // Both are honored; never both required.
    const gameStale =
      options.voidStaleBeforeDate
      && parlay.date
      && parlay.date < options.voidStaleBeforeDate;
    const loggedAtStale =
      options.voidStaleBeforeRecommendedAt
      && parlay.recommended_at
      && parlay.recommended_at < options.voidStaleBeforeRecommendedAt;

    if (newOutcome === "pending" && (gameStale || loggedAtStale)) {
      newOutcome = "push";
      stalenessVoided = true;
    }

    // Auto-mark "needs review" path: when EVERY unresolved leg has
    // diagnosis = "unparseable_id" (legacy ID format the resolver
    // can't parse) AND the parlay is older than today, flip to
    // "partial" with a transparent note. Distinct from staleness-
    // void: this is "we know we can't resolve this", not "data may
    // not be available yet".
    const todayYmd = new Date().toISOString().slice(0, 10);
    const allUnresolved = updatedLegs.every(
      (l) => !l.leg_outcome || l.leg_outcome === "pending",
    );
    const allUnparseable = updatedLegs.every(
      (l) =>
        (l.leg_outcome && l.leg_outcome !== "pending") ||
        l.resolution_diagnosis === "unparseable_id",
    );
    if (
      newOutcome === "pending"
      && parlay.date
      && parlay.date < todayYmd
      && allUnresolved
      && allUnparseable
      && updatedLegs.length > 0
    ) {
      newOutcome = "partial"; // schema-allowed value closest to "needs human review"
      unparseableMarked = true;
    }

    if (!touchedAnyLeg && !stalenessVoided && !unparseableMarked) continue;

    const fullySettled = newOutcome !== "pending";

    // Tally diagnoses for the UI summary.
    for (const l of updatedLegs) {
      if (l.resolution_diagnosis) {
        const k = l.resolution_diagnosis;
        result.diagnosisCounts[k] = (result.diagnosisCounts[k] ?? 0) + 1;
      }
    }

    try {
      const updates: Record<string, unknown> = {
        legs: updatedLegs,
        outcome: newOutcome,
        resolved_at: fullySettled ? new Date().toISOString() : null,
      };
      // Tag the resolution path on terminal-state writes only —
      // pending rows leave resolved_via NULL so the column truly
      // represents how a *settled* row got there. Stale-void and
      // unparseable-flag are also auto paths, tagged "espn".
      if (fullySettled || stalenessVoided || unparseableMarked) {
        updates.resolved_via = "espn";
      }
      if (stalenessVoided) {
        updates.user_notes = `Auto-voided ${new Date().toISOString().slice(0, 10)}: data unavailable for resolution after cutoff.`;
      } else if (unparseableMarked) {
        updates.user_notes = `Auto-flagged ${new Date().toISOString().slice(0, 10)}: leg IDs cannot be parsed by the resolver — needs human review.`;
      }
      const { error: upErr } = await supabase
        .from("recommended_parlays")
        .update(updates)
        .eq("id", parlay.id);
      if (upErr) {
        result.errors.push(`${parlay.id}: ${upErr.message}`);
        continue;
      }
      if (fullySettled && !stalenessVoided && !unparseableMarked) result.resolved++;
      if (stalenessVoided) result.staleVoided++;
      if (unparseableMarked) result.needsReviewMarked++;

      // Skip the prediction_history bridge for stale-voided AND
      // needs-review rows — no real outcomes were observed, so writing
      // them in would pollute ML training as artificial pushes.
      if (stalenessVoided || unparseableMarked) continue;

      // Bridge into prediction_history for ML loop. Idempotent.
      const bridge = await bridgeParlayLegs({
        id: parlay.id,
        source: parlay.source,
        date: parlay.date,
        recommended_at: parlay.recommended_at,
        resolved_at: parlay.resolved_at,
        user_id: parlay.user_id,
        legs: updatedLegs,
      });
      result.bridgeInserted += bridge.inserted;
    } catch (e) {
      result.errors.push(`${parlay.id}: ${String(e)}`);
    }
  }

  return result;
}

function playerNameFromSelection(selection: string | undefined | null): string | null {
  if (!selection) return null;
  const m = /^([^\d]+?)\s+(?:Over|Under|O\/U|\d)/i.exec(selection.trim());
  return m ? m[1].trim() : null;
}
