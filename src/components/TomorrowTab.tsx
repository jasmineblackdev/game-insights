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
 * Pregame-specific adjustments:
 *   - timingUrgency="wait" excluded (pregame context)
 *   - stability_score weighted at 0.20 (vs 0.10 for today) — role certainty matters more
 *   - props with stability < 0.45 shown with a ↯ low-stab warning
 *   - earlyValueTag() labels: OPENING EDGE / EARLY VALUE / LINE VALUE
 *   - line movement signal (↑ MOVING / ↓ CONFIRMED) when line_delta is available
 *   - ParlayBuilderSection receives tomorrowMode=true → +0.02 sport diversity boost
 */

import { useMemo } from "react";
import { Calendar, Sparkles, TrendingUp, Wrench } from "lucide-react";
import type { GamePrediction } from "@/data/mockGames";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import { BestValuePicksSection } from "@/components/valueParlay/BestValuePicksSection";
import { ParlayBuilderSection } from "@/components/valueParlay/ParlayBuilderSection";
import { PropCard, earlyValueTag } from "@/components/PropCard";
import { cn } from "@/lib/utils";

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
 */
function propDisplayScore(p: PlayerEdgePrediction): number {
  const confScore  = p.confidence === "HIGH" ? 1.0 : p.confidence === "MED" ? 0.6 : 0.3;
  const hitProb    = p.ml_hit_probability ?? 0.5;
  const edgeNorm   = Math.min(1, Math.max(0, p.edge / 15));
  // Pregame: stability weight boosted from 0.10 → 0.20
  const stabScore  = p.ml_debug?.stability_score ?? 0.5;
  const timingMult = p.timing_urgency === "now" ? 1.08 : 1.0;
  return (hitProb * 0.35 + edgeNorm * 0.25 + confScore * 0.25 + stabScore * 0.15) * timingMult;
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

// ── Empty state ───────────────────────────────────────────────────────────────

function TomorrowEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Calendar className="w-10 h-10 text-muted-foreground/30 mb-4" />
      <p className="text-muted-foreground text-sm max-w-sm">
        No games on tomorrow&apos;s slate yet. Check back later today — schedules
        typically post 12–24 hours in advance.
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
  // ── Tomorrow games ───────────────────────────────────────────────────────────
  const tomorrowGames = useMemo(
    () => allGames.filter((g) => g.gameDate === "tomorrow" && g.status === "upcoming"),
    [allGames]
  );

  const tomorrowGameIds = useMemo(
    () => new Set(tomorrowGames.map((g) => g.id)),
    [tomorrowGames]
  );

  // ── Tomorrow props ───────────────────────────────────────────────────────────
  // Filter: tomorrow games only + exclude "wait" timing (pregame context)
  const tomorrowProps = useMemo(
    () =>
      allProps
        .filter(
          (p) =>
            tomorrowGameIds.has(p.game_id) &&
            p.timing_urgency !== "wait"
        )
        .sort((a, b) => propDisplayScore(b) - propDisplayScore(a)),
    [allProps, tomorrowGameIds]
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
          subtitle="Top-ranked edges across spreads, totals, and moneylines. Scored by the same edge model used today."
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
          subtitle="Pregame ranking: stability weighted higher than intraday. Excludes 'wait' timing. Low stability flagged."
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
          </>
        )}

        {tomorrowProps.length > 9 && (
          <p className="text-xs text-muted-foreground mt-3">
            Showing top 9 of {tomorrowProps.length} props.
            Check the Player Props tab for the full list.
          </p>
        )}
      </section>

      {/* ── SECTION 3: AI Parlays Tomorrow ────────────────────────────────── */}
      <section>
        <SectionHeader
          icon={Wrench}
          title="AI parlays tomorrow"
          subtitle="Safe, Balanced, and Aggressive parlays built from tomorrow's slate. Same optimizer, pregame context."
        />
        <ParlayBuilderSection
          games={tomorrowGames}
          oddsMap={oddsMap}
          gamesLoading={false}
          filterPropsByGameIds={tomorrowGameIds}
          tomorrowMode
        />
      </section>

    </div>
  );
}
