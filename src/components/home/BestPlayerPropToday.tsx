/**
 * BestPlayerPropToday — Home hero card.
 *
 * Surfaces the single highest-ranked player prop across all sports
 * using the existing `computePlayerEdgeScore` (weights: edge .40,
 * volume .25, matchup .15, trend .10, line .10 − variance).
 *
 * Eligibility gates applied here (in addition to the engine's own):
 *   - model probability  ≥ 0.57   (proxied via confidence_score_0_100 ≥ 57
 *                                  or ml_hit_probability ≥ 0.57)
 *   - |edge|             ≥ 5 %    (sport-normalised via maxEdge in scorer)
 *   - role stability     ≥ 70/100 (consistency_label !== "volatile")
 *   - high-variance props (volatility_flag) only when edge ≥ 10 %
 *
 * Action verdict: Bet now / Monitor / Pass — derived from
 * `pickActionForPrediction` so it stays in lockstep with the rest of
 * the app.
 */

import { useMemo } from "react";
import { Sparkles, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import {
  computePlayerEdgeScore,
  sortPlayerEdgePredictions,
  type PlayerEdgePrediction,
} from "@/data/playerEdgeMock";
import {
  pickActionForPrediction,
  pickActionLabel,
  pickActionClass,
} from "@/lib/dailyPlan/pickAction";
import { cn } from "@/lib/utils";

export interface BestPlayerPropTodayProps {
  predictions: PlayerEdgePrediction[];
  isPending?: boolean;
}

/** Sport-normalised edge floor (5 %) expressed in raw stat units. */
function meetsEdgeFloor(p: PlayerEdgePrediction): boolean {
  // computePlayerEdgeScore uses these maxEdge anchors; 5% of max keeps
  // the gate consistent across sports without re-implementing units.
  const maxEdge =
    p.sport === "NBA" ? 8 :
    p.sport === "NFL" ? 30 :
    p.sport === "MLB" ? 3 :
    15;
  return Math.abs(p.edge) / maxEdge >= 0.05;
}

function meetsProbabilityFloor(p: PlayerEdgePrediction): boolean {
  if (p.ml_hit_probability != null && p.ml_active) {
    return p.ml_hit_probability >= 0.57;
  }
  const conf = p.confidence_score_0_100
    ?? (p.confidence === "HIGH" ? 72 : p.confidence === "MED" ? 58 : 44);
  return conf >= 57;
}

function meetsRoleFloor(p: PlayerEdgePrediction): boolean {
  return p.consistency_label !== "volatile";
}

function passesVarianceRule(p: PlayerEdgePrediction): boolean {
  if (!p.volatility_flag) return true;
  // High-variance props only when edge ≥ 10 %
  const maxEdge =
    p.sport === "NBA" ? 8 :
    p.sport === "NFL" ? 30 :
    p.sport === "MLB" ? 3 :
    15;
  return Math.abs(p.edge) / maxEdge >= 0.10;
}

function eligible(p: PlayerEdgePrediction): boolean {
  return meetsEdgeFloor(p) && meetsProbabilityFloor(p) && meetsRoleFloor(p) && passesVarianceRule(p);
}

function formatHeadline(p: PlayerEdgePrediction): string {
  const dir = p.prediction_direction === "MORE" ? "Over" : "Under";
  const stat = p.stat_type.replace(/_/g, " ");
  if (p.stat_type === "fight_winner") return `${p.player_name} to Win`;
  return `${dir} ${p.line_value} ${stat}`;
}

function edgePct(p: PlayerEdgePrediction): string {
  const maxEdge =
    p.sport === "NBA" ? 8 :
    p.sport === "NFL" ? 30 :
    p.sport === "MLB" ? 3 :
    15;
  return `${Math.round((p.edge / maxEdge) * 1000) / 10}%`;
}

export function BestPlayerPropToday({ predictions, isPending }: BestPlayerPropTodayProps) {
  const ranked = useMemo(() => {
    const filtered = predictions.filter(eligible);
    return sortPlayerEdgePredictions(filtered).slice(0, 6);
  }, [predictions]);

  if (isPending) {
    return (
      <section>
        <div className="rounded-xl border border-border bg-card/40 h-48 animate-pulse" />
      </section>
    );
  }

  if (ranked.length === 0) return null;

  const top = ranked[0];
  const alternatives = ranked.slice(1);
  const action = pickActionForPrediction(top);

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h3 className="font-display font-bold text-lg text-foreground">Best Player Prop Today</h3>
        </div>
        <Link
          to="/?view=player_props"
          className="text-xs text-primary font-semibold hover:opacity-80 shrink-0 inline-flex items-center gap-1"
        >
          See all <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      {/* Hero — top pick */}
      <Link
        to="/?view=player_props"
        className="block rounded-xl border-2 border-primary/40 bg-gradient-to-br from-primary/10 to-primary/[0.02] p-5 hover:brightness-110 transition-all"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-bold tracking-wider text-muted-foreground uppercase mb-1">
              <span className="px-1.5 py-0.5 rounded bg-primary/20 text-primary">#1 Pick</span>
              <span>{top.sport}</span>
              <span>·</span>
              <span>{top.team} vs {top.opponent}</span>
            </div>
            <p className="font-display font-bold text-lg text-foreground truncate">
              {top.player_name}
            </p>
            <p className="text-base font-semibold text-foreground/90 mt-0.5">
              {formatHeadline(top)}
            </p>
          </div>
          <span className={cn(
            "shrink-0 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide",
            pickActionClass(action),
          )}>
            {pickActionLabel(action)}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-3">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Edge</p>
            <p className="text-base font-bold text-confidence-high">{edgePct(top)}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Projected</p>
            <p className="text-base font-bold text-foreground">
              {top.projected_value != null ? Math.round(top.projected_value * 10) / 10 : "—"}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Score</p>
            <p className="text-base font-bold text-primary">
              {Math.round(computePlayerEdgeScore(top))}
            </p>
          </div>
        </div>

        {top.reason_1 ? (
          <p className="text-xs text-muted-foreground leading-relaxed">{top.reason_1}</p>
        ) : null}
      </Link>

      {/* Alternatives */}
      {alternatives.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
            Top Alternatives
          </p>
          {alternatives.map((p, i) => (
            <Link
              key={p.id}
              to="/?view=player_props"
              className="flex items-center gap-3 rounded-lg border border-border bg-card/40 px-3 py-2 hover:bg-card/70 transition-colors"
            >
              <span className="text-xs font-bold text-muted-foreground w-4 shrink-0">#{i + 2}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground truncate">
                  {p.player_name} <span className="text-muted-foreground">·</span> {formatHeadline(p)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {p.sport} · Edge {edgePct(p)}
                </p>
              </div>
              <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            </Link>
          ))}
        </div>
      ) : null}
    </section>
  );
}
