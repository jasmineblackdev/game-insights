import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEdgeCardOptional } from "@/context/EdgeCardContext";
import { fetchPlayerEdgePredictions, isPlayerEdgeApiConfigured } from "@/lib/playerEdgeApi";
import {
  type PlayerEdgePrediction,
  type PlayerEdgeSportFilter,
  type PlayerEdgeStatFilter,
  type PlayerRiskTier,
  filterPlayerEdgePredictions,
  sortPlayerEdgePredictions,
  statFilterLabel,
} from "@/data/playerEdgeMock";
import type { PlayerPropInput } from "@/lib/edgeCardScoring";

const SPORT_FILTERS: PlayerEdgeSportFilter[] = ["all", "NBA", "NFL", "MLB", "Soccer"];

const STAT_FILTERS: PlayerEdgeStatFilter[] = [
  "all",
  "points",
  "rebounds",
  "assists",
  "passing_yards",
  "rushing_yards",
  "receiving_yards",
  "strikeouts",
  "hits",
  "total_bases",
  "shots",
  "shots_on_target",
];

function toPropInput(p: PlayerEdgePrediction): PlayerPropInput {
  const { game_sort: _gs, ...rest } = p;
  return rest;
}

function statTitle(statType: string): string {
  const f = STAT_FILTERS.find((x) => x === statType);
  return f && f !== "all" ? statFilterLabel(f) : statType.replace(/_/g, " ");
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

const RISK_TIER_BADGE: Record<PlayerRiskTier, string> = {
  safe: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  balanced: "bg-primary/10 text-primary",
  high_upside: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  longshot: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
};

function riskTierClass(t: PlayerRiskTier): string {
  return RISK_TIER_BADGE[t];
}

function riskTierLabel(t: PlayerRiskTier): string {
  const labels: Record<PlayerRiskTier, string> = {
    safe: "Safe",
    balanced: "Balanced",
    high_upside: "High upside",
    longshot: "Longshot",
  };
  return labels[t];
}

function PlayerEdgeCard({ pred }: { pred: PlayerEdgePrediction }) {
  const edge = useEdgeCardOptional();
  const added = edge?.isPlayerPropOnSlip(pred.id) ?? false;
  const full = edge?.slipFull && !added;

  const confClass =
    pred.confidence === "HIGH"
      ? "text-confidence-high bg-confidence-high/15"
      : pred.confidence === "MED"
        ? "text-amber-600 dark:text-amber-400 bg-amber-500/15"
        : "text-muted-foreground bg-muted";

  const dirClass =
    pred.prediction_direction === "MORE"
      ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
      : "bg-red-500/15 text-red-600 dark:text-red-400";

  return (
    <div className="card-shine bg-card rounded-lg border border-border p-4 flex flex-col gap-3 h-full">
      <div className="flex items-start gap-3">
        <div
          className="w-11 h-11 rounded-full bg-primary/10 border border-border flex items-center justify-center shrink-0 text-xs font-bold text-primary"
          aria-hidden
        >
          {initials(pred.player_name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 gap-y-1">
            <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {pred.sport}
            </span>
            <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", confClass)}>
              {pred.confidence}
            </span>
            {pred.risk_tier ? (
              <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", riskTierClass(pred.risk_tier))}>
                {riskTierLabel(pred.risk_tier)}
              </span>
            ) : null}
          </div>
          <p className="font-display font-bold text-sm text-foreground mt-1 truncate">{pred.player_name}</p>
          <p className="text-xs text-muted-foreground">
            {pred.team} vs {pred.opponent} · {pred.game_time}
          </p>
          {pred.trend_note ? (
            <p className="text-[11px] text-primary font-medium mt-0.5">{pred.trend_note}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-2 text-xs border-t border-border pt-3">
        <p className="font-semibold text-foreground">{statTitle(pred.stat_type)}</p>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
          <span>Line</span>
          <span className="text-foreground font-medium tabular-nums text-right">{pred.line_value}</span>
          <span>Projection</span>
          <span className="text-foreground font-medium tabular-nums text-right">{pred.projected_value}</span>
        </div>
        {pred.confidence_score_0_100 != null ? (
          <p className="text-[11px] text-muted-foreground">
            Prediction confidence:{" "}
            <span className="text-foreground font-bold tabular-nums">{pred.confidence_score_0_100}</span>
            <span className="text-muted-foreground">/100</span>
          </p>
        ) : null}
        {pred.consistency_label ? (
          <p className="text-[11px]">
            <span className="text-muted-foreground">Consistency · </span>
            <span
              className={cn(
                "font-semibold capitalize",
                pred.consistency_label === "stable" && "text-confidence-high",
                pred.consistency_label === "medium" && "text-amber-600 dark:text-amber-400",
                pred.consistency_label === "volatile" && "text-risk"
              )}
            >
              {pred.consistency_label === "stable"
                ? "Stable"
                : pred.consistency_label === "medium"
                  ? "Medium"
                  : "Volatile"}
            </span>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", dirClass)}>
            {pred.prediction_direction}
          </span>
          <span className="text-[10px] text-muted-foreground">
            Edge:{" "}
            <span className="text-foreground font-semibold tabular-nums">
              {pred.prediction_direction === "MORE" ? "+" : "−"}
              {Math.abs(pred.edge).toFixed(1)}
            </span>
          </span>
        </div>
      </div>

      <div className="space-y-1.5 text-[11px] flex-1">
        <p className="text-confidence-high font-semibold">Because</p>
        <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
          {(pred.explanations?.length ? pred.explanations : [pred.reason_1, pred.reason_2]).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        <p className="text-risk pt-1">
          <span className="font-semibold">Risk · </span>
          {pred.risk_factor}
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2 pt-1 border-t border-border">
        <Button
          size="sm"
          className="flex-1 font-semibold"
          disabled={!edge || added || full}
          onClick={() => {
            if (!edge) {
              toast.message("Edge Card unavailable");
              return;
            }
            const r = edge.addPlayerProp(toPropInput(pred));
            if (r.ok) toast.success("Added player prop to Edge Card");
            else toast.message(r.message ?? "Could not add");
          }}
        >
          {added ? "On Edge Card" : "Add to Edge Card"}
        </Button>
        <Button variant="outline" size="sm" className="flex-1" asChild>
          <Link to={`/player-edge/${pred.id}`}>View Details</Link>
        </Button>
      </div>
    </div>
  );
}

export function PlayerEdgeSection() {
  const [sport, setSport] = useState<PlayerEdgeSportFilter>("all");
  const [stat, setStat] = useState<PlayerEdgeStatFilter>("all");

  const { data, isPending } = useQuery({
    queryKey: ["player-edge", sport, stat],
    queryFn: () => fetchPlayerEdgePredictions(sport, stat),
    staleTime: 2 * 60 * 1000,
  });

  const rows = useMemo(() => {
    const list = data ?? [];
    const f = filterPlayerEdgePredictions(list, sport, stat);
    return sortPlayerEdgePredictions(f);
  }, [data, sport, stat]);

  return (
    <section className="mt-12 pt-10 border-t border-border space-y-6" aria-labelledby="player-edge-heading">
      <div className="space-y-2">
        <h2 id="player-edge-heading" className="font-display font-bold text-2xl md:text-3xl text-foreground">
          Player Edge
        </h2>
        <p className="text-sm text-muted-foreground max-w-2xl">
          AI-ranked player predictions using recent performance, matchup strength, injuries, and projected role.
        </p>
        <p className="text-[10px] text-muted-foreground max-w-2xl">
          {isPlayerEdgeApiConfigured()
            ? "Live props: VITE_PLAYER_EDGE_API_URL — JSON { items: [...] }. Errors fall back to mock."
            : "Mock props board. Set VITE_PLAYER_EDGE_API_URL to your GET endpoint to wire real data."}
        </p>
      </div>

      <div className="space-y-3">
        <p className="text-[10px] font-semibold tracking-wider text-muted-foreground">SPORT</p>
        <div className="flex flex-wrap gap-1.5">
          {SPORT_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSport(s)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-semibold border transition-colors",
                sport === s
                  ? "bg-card text-foreground border-primary/40 shadow-sm"
                  : "border-transparent bg-muted/60 text-muted-foreground hover:text-foreground"
              )}
            >
              {s === "all" ? "All Sports" : s}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-[10px] font-semibold tracking-wider text-muted-foreground">STAT</p>
        <div className="flex flex-wrap gap-1.5">
          {STAT_FILTERS.map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStat(st)}
              className={cn(
                "px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors",
                stat === st
                  ? "bg-card text-foreground border-primary/40 shadow-sm"
                  : "border-transparent bg-muted/60 text-muted-foreground hover:text-foreground"
              )}
            >
              {statFilterLabel(st)}
            </button>
          ))}
        </div>
      </div>

      {isPending ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-72 rounded-lg border border-border bg-muted/30 animate-pulse" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center rounded-lg border border-border bg-card/40">
          No player props match these filters.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {rows.map((pred) => (
            <PlayerEdgeCard key={pred.id} pred={pred} />
          ))}
        </div>
      )}
    </section>
  );
}
