/**
 * BestPlayerPropToday — Home hero card.
 *
 * As of #177 (Player Prop Ranking Fix item 3), this card is fed by
 * the SAME `rankTopProps` ranker that drives the Top Props list,
 * so the hero's #1 pick can never disagree with the list's #1.
 * Previously the card ran its own `computePlayerEdgeScore` +
 * `dkAwareSort` pipeline (40% edge / 25% confidence / 15% matchup),
 * which produced a different ordering than the Top Props ranker
 * (30% prob / 22% edge / 16% stability …) and routinely disagreed
 * with it.
 *
 * Surface contract:
 *   - Top 6 ranked props (one hero, five alternatives)
 *   - All filters / DK support / probability floor / volatility
 *     gates / diversity caps live in `topPropsRanker`. This card
 *     is presentational.
 */

import { useMemo } from "react";
import { Sparkles, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import {
  pickActionForPrediction,
  pickActionLabel,
  pickActionClass,
} from "@/lib/dailyPlan/pickAction";
import {
  dkLabelFor,
  dkShortLabelFor,
  getDkMapping,
} from "@/lib/draftkings/dkMarketCatalog";
import { rankTopProps } from "@/lib/playerProps/topPropsRanker";
import { cn } from "@/lib/utils";
import { InjuryBadge } from "@/components/InjuryBadge";

export interface BestPlayerPropTodayProps {
  predictions: PlayerEdgePrediction[];
  isPending?: boolean;
}

/** Sport-normalised edge floor (5 %) expressed in raw stat units.
 *  Local to this file because it's display-only — the ranker has
 *  its own normalization that's the source of truth for ordering. */
function maxEdgeFor(sport: PlayerEdgePrediction["sport"]): number {
  return sport === "NBA" || sport === "WNBA" ? 8
       : sport === "NFL" ? 30
       : sport === "MLB" ? 3
       : 15;
}

/** "Over 24.5 Points" using the DK label so the UI matches the sportsbook. */
function dkHeadline(p: PlayerEdgePrediction): string {
  const dir = p.prediction_direction === "MORE" ? "Over" : "Under";
  const label = dkLabelFor(p.sport, p.stat_type);
  if (p.stat_type === "fight_winner") return `${p.player_name} to Win`;
  if (p.stat_type === "anytime_td")   return `${p.player_name} ${label}`;
  return `${dir} ${p.line_value} ${label}`;
}
function edgePct(p: PlayerEdgePrediction): string {
  return `${Math.round((p.edge / maxEdgeFor(p.sport)) * 1000) / 10}%`;
}
function formatOdds(odds?: number): string {
  if (odds == null || !Number.isFinite(odds)) return "—";
  return odds > 0 ? `+${Math.round(odds)}` : `${Math.round(odds)}`;
}
/** Why the engine picked this DK bet type for this player. */
function dkReason(p: PlayerEdgePrediction): string {
  const m = getDkMapping(p.sport, p.stat_type);
  const mkt = m?.dkLabel ?? p.stat_type;
  const dir = p.prediction_direction === "MORE" ? "Over" : "Under";
  const conf = p.confidence_score_0_100
    ?? (p.confidence === "HIGH" ? 72 : p.confidence === "MED" ? 58 : 44);
  return `DK ${mkt} (${dir}) — model ${Math.round((p.projected_value ?? 0) * 10) / 10} vs line ${p.line_value} · edge ${edgePct(p)} · confidence ${conf}/100`;
}

export function BestPlayerPropToday({ predictions, isPending }: BestPlayerPropTodayProps) {
  const ranked = useMemo(() => {
    const { ranked } = rankTopProps(predictions, { date: "today", topN: 6 });
    return ranked.map((r) => r.pred);
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
  const dkMap = getDkMapping(top.sport, top.stat_type);

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h3 className="font-display font-bold text-lg text-foreground">Best Player Prop Today</h3>
          <span className="hidden sm:inline-flex items-center text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            DraftKings
          </span>
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
            <div className="flex items-center gap-2 text-[10px] font-bold tracking-wider text-muted-foreground uppercase mb-1 flex-wrap">
              <span className="px-1.5 py-0.5 rounded bg-primary/20 text-primary">#1 Pick</span>
              <span>{top.sport}</span>
              <span>·</span>
              <span>{top.team} vs {top.opponent}</span>
              {dkMap ? (
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  DK · {dkMap.shortLabel}
                </span>
              ) : null}
            </div>
            <p className="font-display font-bold text-lg text-foreground truncate flex items-center gap-2">
              <span className="truncate">{top.player_name}</span>
              <InjuryBadge playerName={top.player_name} sport={top.sport} size="sm" />
            </p>
            <p className="text-base font-semibold text-foreground/90 mt-0.5">
              {dkHeadline(top)}
            </p>
          </div>
          <span className={cn(
            "shrink-0 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide",
            pickActionClass(action),
          )}>
            {pickActionLabel(action)}
          </span>
        </div>

        <div className="grid grid-cols-4 gap-3 mb-3">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Edge</p>
            <p className="text-base font-bold text-confidence-high">{edgePct(top)}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">DK Line</p>
            <p className="text-base font-bold text-foreground">{top.line_value}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Projected</p>
            <p className="text-base font-bold text-foreground">
              {top.projected_value != null ? Math.round(top.projected_value * 10) / 10 : "—"}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Odds</p>
            <p className="text-base font-bold text-foreground">{formatOdds(top.american_odds)}</p>
          </div>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">{dkReason(top)}</p>
      </Link>

      {/* Alternatives */}
      {alternatives.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
            Top Alternatives
          </p>
          {alternatives.map((p, i) => {
            const altAction = pickActionForPrediction(p);
            return (
              <Link
                key={p.id}
                to="/?view=player_props"
                className="flex items-center gap-3 rounded-lg border border-border bg-card/40 px-3 py-2 hover:bg-card/70 transition-colors"
              >
                <span className="text-xs font-bold text-muted-foreground w-4 shrink-0">#{i + 2}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground truncate">
                    {p.player_name}
                    <InjuryBadge playerName={p.player_name} sport={p.sport} className="ml-1.5" />
                    <span className="text-muted-foreground"> · </span>
                    {dkHeadline(p)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {p.sport} · DK {dkShortLabelFor(p.sport, p.stat_type)} · Edge {edgePct(p)} · {formatOdds(p.american_odds)}
                  </p>
                </div>
                <span className={cn(
                  "shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide",
                  pickActionClass(altAction),
                )}>
                  {pickActionLabel(altAction)}
                </span>
                <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              </Link>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
