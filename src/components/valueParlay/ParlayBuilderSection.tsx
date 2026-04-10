import { useMemo, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, Shuffle, Trash2, Wallet, Zap } from "lucide-react";
import { useValueParlay } from "@/context/ValueParlayContext";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildAllValueCandidates } from "@/lib/valueParlay/buildCandidates";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import type { ParlayBuildMode } from "@/lib/valueParlay/types";

const MODE_LABEL: Record<ParlayBuildMode, string> = {
  safe: "Safe (3–5 legs)",
  balanced: "Balanced (4–8)",
  aggressive: "Aggressive (6–12)",
};

const HISTORY_KEY = "gamelens-value-parlay-history-v1";

export function ParlayBuilderSection({
  games,
  oddsMap,
  loading,
}: {
  games: GamePrediction[];
  oddsMap: Map<string, GameOddsBundle>;
  loading: boolean;
}) {
  const {
    parlayMode,
    setParlayMode,
    builderLegs,
    removeValueLeg,
    clearValueBuilder,
    autoBuildFromCandidates,
    rebalance,
    saferSwap,
    higherPayoutSwap,
    triplePreview,
    builderMetrics,
  } = useValueParlay();

  const [tripleOpen, setTripleOpen] = useState(false);

  const candidates = useMemo(() => buildAllValueCandidates(games, oddsMap), [games, oddsMap]);
  const triple = useMemo(() => (tripleOpen ? triplePreview(candidates) : null), [tripleOpen, triplePreview, candidates]);

  const saveSnapshot = () => {
    if (!builderLegs.length) {
      toast.message("Add legs first");
      return;
    }
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const prev = raw ? (JSON.parse(raw) as unknown[]) : [];
      const entry = {
        id: `vp-hist-${Date.now()}`,
        savedAt: new Date().toISOString(),
        mode: parlayMode,
        legs: builderLegs.map((l) => ({ id: l.id, label: l.selectionLabel, edge: l.edge })),
      };
      const next = [entry, ...prev].slice(0, 15);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      toast.success("Saved to parlay history");
    } catch {
      toast.error("Could not save");
    }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h2 className="font-display font-bold text-xl text-foreground">Parlay builder</h2>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Value-first legs with mode presets, payout estimate, hit-rate projection, and correlation warnings.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card/60 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div>
            <p className="text-[10px] font-semibold tracking-wider text-muted-foreground">MODE</p>
            <div className="inline-flex gap-1 rounded-full bg-muted p-0.5 mt-1">
              {(["safe", "balanced", "aggressive"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setParlayMode(m)}
                  className={cn(
                    "px-3 py-1.5 rounded-full text-xs font-bold transition-colors",
                    parlayMode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">{MODE_LABEL[parlayMode]}</p>
          </div>
          <div className="text-right text-xs space-y-0.5">
            <p>
              <span className="text-muted-foreground">Legs </span>
              <span className="font-bold text-foreground">{builderLegs.length}</span>
              <span className="text-muted-foreground"> / 12</span>
            </p>
            {builderMetrics ? (
              <>
                <p className="tabular-nums">
                  <span className="text-muted-foreground">Est. payout </span>
                  <span className="font-semibold text-foreground">
                    {builderMetrics.projectedPayoutMultiplier.toFixed(2)}x
                  </span>
                </p>
                <p className="tabular-nums">
                  <span className="text-muted-foreground">Proj. hit </span>
                  <span className="font-semibold text-foreground">
                    {(builderMetrics.projectedHitProbability * 100).toFixed(1)}%
                  </span>
                </p>
                <p>
                  <span className="text-muted-foreground">Card conf </span>
                  <span className="font-semibold capitalize">{builderMetrics.cardConfidence}</span>
                </p>
                <p className="tabular-nums text-risk">
                  Corr. {builderMetrics.correlationPenalty} · Vol {builderMetrics.volatilityPenalty}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">Add legs for estimates</p>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="default"
          size="sm"
          className="gap-1"
          disabled={loading || !candidates.length}
          onClick={() => {
            autoBuildFromCandidates(candidates);
            toast.success("Auto-built from value board");
          }}
        >
          <Zap className="w-3.5 h-3.5" />
          Auto build
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="gap-1"
          disabled={loading || !candidates.length}
          onClick={() => {
            rebalance(candidates);
            toast.success("Rebalanced");
          }}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Rebalance
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || !candidates.length}
          onClick={() => {
            saferSwap(candidates);
            toast.success("Applied safer mix");
          }}
        >
          Safer swap
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || !candidates.length}
          onClick={() => {
            higherPayoutSwap(candidates);
            toast.success("Applied higher payout mix");
          }}
        >
          <Wallet className="w-3.5 h-3.5" />
          Higher payout
        </Button>
        <Button variant="outline" size="sm" className="gap-1" onClick={() => setTripleOpen((v) => !v)}>
          <Shuffle className="w-3.5 h-3.5" />
          {tripleOpen ? "Hide" : "Show"} triple card
        </Button>
        <Button variant="ghost" size="sm" onClick={clearValueBuilder} disabled={!builderLegs.length}>
          <Trash2 className="w-3.5 h-3.5" />
          Clear
        </Button>
        <Button variant="secondary" size="sm" onClick={saveSnapshot}>
          Save to history
        </Button>
      </div>

      {triple ? (
        <div className="grid md:grid-cols-3 gap-3 text-xs">
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1">
            <p className="font-display font-bold text-foreground">Best value parlay</p>
            <p className="text-muted-foreground">{triple.bestValue.legs.length} legs</p>
            <p className="tabular-nums">Score {triple.bestValue.smartParlayScore.toFixed(2)}</p>
            <p className="tabular-nums">Payout {triple.bestValue.projectedPayoutMultiplier.toFixed(2)}x</p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1">
            <p className="font-display font-bold text-foreground">Safer alternative</p>
            <p className="text-muted-foreground">{triple.safer.legs.length} legs</p>
            <p className="tabular-nums">Hit {(triple.safer.projectedHitProbability * 100).toFixed(1)}%</p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1">
            <p className="font-display font-bold text-foreground">Higher payout</p>
            <p className="text-muted-foreground">{triple.higherPayout.legs.length} legs</p>
            <p className="tabular-nums">{triple.higherPayout.projectedPayoutMultiplier.toFixed(2)}x</p>
          </div>
        </div>
      ) : null}

      {builderMetrics && builderMetrics.warnings.length > 0 ? (
        <ul className="text-[11px] text-amber-600 dark:text-amber-400 list-disc list-inside space-y-0.5">
          {builderMetrics.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-sm font-display font-bold text-foreground">Selected legs</h3>
        {builderLegs.length === 0 ? (
          <p className="text-xs text-muted-foreground">Add picks from Best Value or use Auto build.</p>
        ) : (
          <ul className="space-y-2">
            {builderLegs.map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-xs"
              >
                <div>
                  <p className="font-semibold text-foreground">{l.selectionLabel}</p>
                  <p className="text-muted-foreground tabular-nums">
                    {l.americanOdds > 0 ? `+${l.americanOdds}` : l.americanOdds} · edge {(l.edge * 100).toFixed(1)}% ·{" "}
                    {l.confidence} · {l.riskBand} risk
                  </p>
                </div>
                <Button variant="ghost" size="sm" className="h-8 shrink-0" onClick={() => removeValueLeg(l.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {builderMetrics && builderLegs.length > 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-xs space-y-1">
          <p className="font-display font-bold text-foreground">Combined price</p>
          <p className="tabular-nums text-muted-foreground">
            American {builderMetrics.combinedAmericanOdds > 0 ? "+" : ""}
            {builderMetrics.combinedAmericanOdds} · Parlay grade score{" "}
            {builderMetrics.smartParlayScore.toFixed(2)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
