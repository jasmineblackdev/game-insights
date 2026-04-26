/**
 * TomorrowTab — unified AI early-access view for tomorrow's slate.
 *
 * Three sections displayed in a single scrollable page:
 *   1. AI Best Picks Tomorrow  — spreads, totals, moneylines ranked by edge score
 *   2. AI Player Props Tomorrow — top props ranked by hit_probability + edge +
 *                                 confidence + stability (pregame-boosted weight)
 *   3. AI Parlays Tomorrow      — Safe / Balanced / Aggressive using parlayOptimizer
 *                                 with slight sport-diversification boost
 *
 * Supported sports: NBA · NFL · MLB · Boxing · MMA/UFC
 * Excluded: soccer, NHL, tennis, golf, esports, unknown.
 *
 * Pregame-specific adjustments:
 *   - timingUrgency="wait" excluded (pregame context)
 *   - stability_score weighted at 0.20 (vs 0.10 for today) — role certainty matters more
 *   - props with stability < 0.45 shown with a ↯ low-stab warning
 *   - earlyValueTag() labels: OPENING EDGE / EARLY VALUE / LINE VALUE
 *   - line movement signal (↑ MOVING / ↓ CONFIRMED) when line_delta is available
 *   - ParlayBuilderSection receives tomorrowMode=true → +0.02 sport diversity boost
 */

import { useMemo } from "react";
import { Calendar, Sparkles, TrendingUp } from "lucide-react";
import type { GamePrediction } from "@/data/mockGames";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import { BestValuePicksSection } from "@/components/valueParlay/BestValuePicksSection";
import { PropCard, earlyValueTag } from "@/components/PropCard";
import {
  useEarlyValueImpactBySport,
  type EarlyValueImpactBySportRow,
} from "@/hooks/useAnalyticsDashboard";
import { cn } from "@/lib/utils";
import { mlbPropCategory, mlbPropPriorityAdjustment } from "@/lib/valueParlay/mlbPropRanking";

// ── Supported sports ─────────────────────────────────────────────────────────
//
// Only sports with stable models are scanned by the Tomorrow tab.
// Excluded: soccer, NHL, tennis, golf, esports, and any unknown sport.
// Combat sports (boxing, mma/ufc) are included but receive lower ML influence
// until enough resolved outcomes accumulate.

const TOMORROW_ALLOWED_SPORTS = new Set([
  "nba",
  "wnba",
  "nfl",
  "mlb",
  "boxing",
  "mma",
  "ufc",
]);

// ── Early value boost map ─────────────────────────────────────────────────────

/**
 * Boost amounts applied when a sport has full ✓ validation for an early-value label.
 * Kept small and conservative — a nudge, not a rerank.
 */
const EV_VALIDATED_BOOST: Record<string, number> = {
  "LINE VALUE":   0.03,
  "OPENING EDGE": 0.02,
  "EARLY VALUE":  0.01,
};

/**
 * Builds a map from "SPORT:LABEL" → boost amount using the by-sport analytics data.
 *
 * A boost is only emitted when the sport has **full ✓ validation**:
 *   - All three labeled buckets have ≥5 resolved legs
 *   - Hit rates are descending: LINE VALUE ≥ OPENING EDGE ≥ EARLY VALUE
 *   - All three beat the no-label (unlabeled) baseline
 *
 * Partial signal (→) gets no boost yet. Unconfirmed (⚠) gets none.
 * This mirrors the exact validation gate in EarlyValueImpactBySportSection.
 */
function buildEarlyValueBoostMap(
  rows: EarlyValueImpactBySportRow[]
): Map<string, number> {
  const map = new Map<string, number>();
  const sports = [...new Set(rows.map((r) => r.sport))];

  for (const sport of sports) {
    const byLabel = (label: string) =>
      rows.find((r) => r.sport === sport && r.label === label);

    const lv   = byLabel("LINE VALUE");
    const oe   = byLabel("OPENING EDGE");
    const ev   = byLabel("EARLY VALUE");
    const none = byLabel("none");

    const ready = (r: EarlyValueImpactBySportRow | undefined) =>
      r != null && Number(r.resolved_count) >= 5;

    if (!ready(lv) || !ready(oe) || !ready(ev) || !ready(none)) continue;

    const lvHit   = lv!.hit_rate_pct   ?? 0;
    const oeHit   = oe!.hit_rate_pct   ?? 0;
    const evHit   = ev!.hit_rate_pct   ?? 0;
    const noneHit = none!.hit_rate_pct ?? 0;

    const descending   = lvHit >= oeHit && oeHit >= evHit;
    const allAboveNone = lvHit > noneHit && oeHit > noneHit && evHit > noneHit;

    if (!descending || !allAboveNone) continue;

    // Full ✓ — apply boosts for this sport's validated labels
    map.set(`${sport}:LINE VALUE`,   EV_VALIDATED_BOOST["LINE VALUE"]);
    map.set(`${sport}:OPENING EDGE`, EV_VALIDATED_BOOST["OPENING EDGE"]);
    map.set(`${sport}:EARLY VALUE`,  EV_VALIDATED_BOOST["EARLY VALUE"]);
  }

  return map;
}

// ── Pregame prop ranking ──────────────────────────────────────────────────────

/**
 * Pregame-adjusted composite score.
 *
 * Key difference from the default ranking:
 *   stability weight: 0.20 (vs 0.10 for today)
 *   edge weight:      0.25 (vs 0.30) — redistributed to stability
 *
 * Rationale: pregame bets resolve on role certainty as much as edge magnitude.
 * A stable player in a stable role gives the model a more reliable baseline
 * hours before the game than raw edge alone.
 *
 * boostMap: optional per-sport validated early-value boost (capped at +0.03).
 * Only populated for sports that have reached full ✓ validation in the analytics.
 */
function propDisplayScore(
  p: PlayerEdgePrediction,
  boostMap?: Map<string, number>
): number {
  const confScore  = p.confidence === "HIGH" ? 1.0 : p.confidence === "MED" ? 0.6 : 0.3;
  const hitProb    = p.ml_hit_probability ?? 0.5;
  const edgeNorm   = Math.min(1, Math.max(0, p.edge / 15));
  // Pregame: stability weight boosted from 0.10 → 0.20
  const stabScore  = p.ml_debug?.stability_score ?? 0.5;
  const timingMult = p.timing_urgency === "now" ? 1.08 : 1.0;

  const base = (hitProb * 0.35 + edgeNorm * 0.25 + confScore * 0.25 + stabScore * 0.15) * timingMult;

  // MLB player intelligence: boost predictable prop types, lightly penalise
  // weak full-game team bets. p.edge is in percentage points (pp) here;
  // mlbPropPriorityAdjustment expects decimal → divide by 100.
  let mlbAdj = 0;
  if (String(p.sport).toUpperCase() === "MLB") {
    const cat = mlbPropCategory(p.stat_type, "player_prop");
    mlbAdj = mlbPropPriorityAdjustment(cat, p.edge / 100);
  }

  if (boostMap?.size) {
    const sport = String(p.sport).toUpperCase();
    const label = earlyValueTag(p);
    if (label) {
      const boost = boostMap.get(`${sport}:${label}`) ?? 0;
      return Math.min(1, base + mlbAdj + boost);
    }
  }

  return Math.min(1, base + mlbAdj);
}

// ── Stability threshold note ──────────────────────────────────────────────────

/**
 * Returns true for props that pass the pregame stability threshold (0.58).
 * Weak-stability props are still shown but flagged in PropCard.
 */
function meetsStabilityThreshold(p: PlayerEdgePrediction): boolean {
  const stab = p.ml_debug?.stability_score;
  return stab == null || stab >= 0.58; // null = no ML data, shown without penalty
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  count,
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  count?: number;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2 mb-4">
      <div>
        <h2 className="font-display font-bold text-xl text-foreground flex items-center gap-2">
          <Icon className="w-5 h-5 text-primary shrink-0" />
          {title}
        </h2>
        <p className="text-sm text-muted-foreground max-w-xl mt-0.5">{subtitle}</p>
      </div>
      {count != null && (
        <span className="text-xs text-muted-foreground shrink-0">
          {count} game{count !== 1 ? "s" : ""} on the slate
        </span>
      )}
    </div>
  );
}

// ── Boost status note ─────────────────────────────────────────────────────────

/**
 * Small internal diagnostic line shown below the props grid when at least one
 * sport has an active validated early-value boost.
 *
 * Answers at a glance:
 *   - Which sports are currently boosted?
 *   - Which labels are active per sport?
 *   - How many of the visible props were actually nudged?
 *
 * Intentionally de-emphasized (10px, muted) — diagnostic only, not user-facing copy.
 * Returns null when no boosts are active (boostMap is empty).
 */
function BoostStatusNote({
  boostMap,
  visibleProps,
}: {
  boostMap: Map<string, number>;
  visibleProps: PlayerEdgePrediction[];
}) {
  if (!boostMap.size) return null;

  // Group active boosts by sport: { NBA: ["LINE VALUE +3%", "OPENING EDGE +2%", ...] }
  const bySport = new Map<string, string[]>();
  for (const [key, boost] of boostMap) {
    const [sport, ...labelParts] = key.split(":");
    const label = labelParts.join(":");
    if (!bySport.has(sport)) bySport.set(sport, []);
    bySport.get(sport)!.push(`${label} +${(boost * 100).toFixed(0)}%`);
  }

  // Count how many visible props actually received a boost
  const boostedCount = visibleProps.filter((p) => {
    const sport = String(p.sport).toUpperCase();
    const label = earlyValueTag(p);
    return label != null && boostMap.has(`${sport}:${label}`);
  }).length;

  const sportSummary = [...bySport.entries()]
    .map(([sport, labels]) => `${sport}: ${labels.join(", ")}`)
    .join(" · ");

  return (
    <p className="text-[10px] text-muted-foreground/50 mt-1.5">
      ↑ Ranking boost active — {sportSummary}
      {boostedCount > 0 && (
        <> · <span className="text-primary/60">{boostedCount} of {visibleProps.length} props ranked higher</span></>
      )}
    </p>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function TomorrowEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Calendar className="w-10 h-10 text-muted-foreground/30 mb-4" />
      <p className="text-muted-foreground text-sm max-w-sm">
        No NBA, WNBA, NFL, MLB, Boxing, or UFC/MMA games scheduled for tomorrow yet.
      </p>
      <p className="text-xs text-muted-foreground/60 mt-2 max-w-xs">
        Schedules typically post 12–24 hours in advance. Tomorrow tab scans
        supported sports only.
      </p>
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function TomorrowLoadingSkeleton() {
  return (
    <div className="space-y-8">
      {[0, 1, 2].map((s) => (
        <div key={s} className="space-y-3">
          <div className="h-7 w-56 rounded bg-muted/40 animate-pulse" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="rounded-lg border border-border bg-card h-40 animate-pulse bg-muted/20" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function TomorrowTab({
  allGames,
  allProps,
  oddsMap,
  loading,
}: {
  /** Full cross-sport game pool (today + tomorrow). Filtering to tomorrow done here. */
  allGames: GamePrediction[];
  /** All fetched player edge predictions. Filtering to tomorrow done here. */
  allProps: PlayerEdgePrediction[];
  oddsMap: Map<string, GameOddsBundle>;
  loading: boolean;
}) {
  // ── Early value boost map ────────────────────────────────────────────────────
  // Fetches by-sport validation data (React Query — deduplicated if dashboard is open).
  // Produces a non-empty map only for sports that have reached full ✓ validation.
  const { data: evBySportData = [] } = useEarlyValueImpactBySport(30);

  const earlyValueBoostMap = useMemo(
    () => buildEarlyValueBoostMap(evBySportData as EarlyValueImpactBySportRow[]),
    [evBySportData]
  );

  // ── Tomorrow games ───────────────────────────────────────────────────────────
  // Only include sports with mature, stable models. Unsupported sports (soccer,
  // NHL, tennis, golf, esports) are excluded to keep ROI trends, calibration,
  // timing buckets, and ML alpha adjustments on a consistent baseline.
  const tomorrowGames = useMemo(
    () =>
      allGames.filter(
        (g) =>
          g.gameDate === "tomorrow" &&
          g.status === "upcoming" &&
          TOMORROW_ALLOWED_SPORTS.has(String(g.league).toLowerCase())
      ),
    [allGames]
  );

  const tomorrowGameIds = useMemo(
    () => new Set(tomorrowGames.map((g) => g.id)),
    [tomorrowGames]
  );

  // ── Tomorrow props ───────────────────────────────────────────────────────────
  // Filter: supported sports + tomorrow game IDs + exclude "wait" timing.
  // Sport filter is explicit (not just via game ID) to guard against orphaned props.
  // Sort: pregame score with optional per-sport validated early-value boost.
  const tomorrowProps = useMemo(
    () =>
      allProps
        .filter(
          (p) =>
            TOMORROW_ALLOWED_SPORTS.has(String(p.sport).toLowerCase()) &&
            tomorrowGameIds.has(p.game_id) &&
            p.timing_urgency !== "wait"
        )
        .sort((a, b) =>
          propDisplayScore(b, earlyValueBoostMap) - propDisplayScore(a, earlyValueBoostMap)
        ),
    [allProps, tomorrowGameIds, earlyValueBoostMap]
  );

  // ── Loading / empty ──────────────────────────────────────────────────────────

  if (loading) return <TomorrowLoadingSkeleton />;

  if (!tomorrowGames.length) return <TomorrowEmptyState />;

  return (
    <div className="space-y-12">

      {/* ── SECTION 1: AI Best Picks Tomorrow ─────────────────────────────── */}
      <section className="space-y-0">
        <SectionHeader
          icon={TrendingUp}
          title="AI best picks tomorrow"
          subtitle="Top-ranked edges across NBA, WNBA, NFL, MLB, Boxing, and UFC/MMA — spreads, totals, and moneylines scored by the same edge model used today."
          count={tomorrowGames.length}
        />
        <BestValuePicksSection
          games={tomorrowGames}
          oddsMap={oddsMap}
          loading={false}
        />
      </section>

      {/* ── SECTION 2: AI Player Props Tomorrow ───────────────────────────── */}
      <section>
        <SectionHeader
          icon={Sparkles}
          title="AI player props tomorrow"
          subtitle="Top props across NBA, WNBA, NFL, MLB, Boxing, and UFC/MMA. Pregame ranking: stability weighted higher than intraday. Excludes 'wait' timing."
        />

        {!tomorrowProps.length ? (
          <p className="text-sm text-muted-foreground py-6">
            No player props found for tomorrow&apos;s games yet.
            Props typically populate 12–18 hours before game time.
          </p>
        ) : (
          <>
            <div className={cn(
              "grid gap-3",
              tomorrowProps.length === 1
                ? "grid-cols-1"
                : tomorrowProps.length <= 2
                  ? "grid-cols-1 sm:grid-cols-2"
                  : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
            )}>
              {tomorrowProps.slice(0, 9).map((pred, i) => (
                <PropCard
                  key={pred.id}
                  pred={pred}
                  rank={i + 1}
                  dateBadge="TOMORROW"
                  earlyValueLabel={earlyValueTag(pred)}
                  showLineMovement
                />
              ))}
            </div>

            {/* Stability threshold note */}
            {tomorrowProps.slice(0, 9).some((p) => !meetsStabilityThreshold(p)) && (
              <p className="text-[11px] text-muted-foreground/60 mt-2">
                ↯ low stab = stability score below pregame threshold (0.58) — role uncertainty higher than ideal.
              </p>
            )}

            {/* Boost status — only visible when at least one sport has validated */}
            <BoostStatusNote
              boostMap={earlyValueBoostMap}
              visibleProps={tomorrowProps.slice(0, 9)}
            />
          </>
        )}

        {tomorrowProps.length > 9 && (
          <p className="text-xs text-muted-foreground mt-3">
            Showing top 9 of {tomorrowProps.length} props.
            Check the Player Props tab for the full list.
          </p>
        )}
      </section>

      {/* Parlay Builder intentionally NOT rendered here — the dedicated
          Parlay Builder page already pulls tomorrow's slate via allGames.
          Showing it twice (once here, once on the Builder page) confused
          users who thought they were looking at separate builders. */}

    </div>
  );
}
