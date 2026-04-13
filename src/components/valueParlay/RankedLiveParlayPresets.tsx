import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { GamePrediction } from "@/data/mockGames";
import { useValueParlay } from "@/context/ValueParlayContext";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import type { SmartParlayResult, ValueBetCandidate } from "@/lib/valueParlay/types";
import {
  buildRankedLiveMoneylinePool,
  legSwapHints,
  rankedLiveOptimizedCombos,
} from "@/lib/valueParlay/rankedLiveParlayCombos";
import { legReason, parlayReasons } from "@/lib/valueParlay/parlayReasons";

function cardConfLabel(c: SmartParlayResult["cardConfidence"]): string {
  if (c === "high") return "High";
  if (c === "medium") return "Medium";
  return "Low";
}

function ComboBlock({
  title,
  result,
  candidates,
  onLoad,
  builderLegs,
  replaceValueLeg,
}: {
  title: string;
  result: SmartParlayResult;
  candidates: ValueBetCandidate[];
  onLoad: () => void;
  builderLegs: ValueBetCandidate[];
  replaceValueLeg: (id: string, c: ValueBetCandidate) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/80 p-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div>
          <p className="text-xs font-bold tracking-wide text-emerald-600 dark:text-emerald-400">{title}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            From main-screen ranked live moneylines · max 2 legs / game
          </p>
        </div>
        <Button type="button" size="sm" variant="secondary" className="shrink-0 font-semibold" onClick={onLoad}>
          Load combo
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
        <div className="rounded-lg bg-muted/40 px-2.5 py-2">
          <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Proj. hit</p>
          <p className="font-bold tabular-nums text-foreground">{(result.projectedHitProbability * 100).toFixed(1)}%</p>
        </div>
        <div className="rounded-lg bg-muted/40 px-2.5 py-2">
          <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Payout</p>
          <p className="font-bold tabular-nums text-foreground">{result.projectedPayoutMultiplier.toFixed(2)}x</p>
        </div>
        <div className="rounded-lg bg-muted/40 px-2.5 py-2">
          <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Confidence</p>
          <p className="font-bold text-foreground">{cardConfLabel(result.cardConfidence)}</p>
        </div>
        <div className="rounded-lg bg-muted/40 px-2.5 py-2">
          <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Corr. / Vol.</p>
          <p className="font-bold tabular-nums text-foreground">
            {Math.round(result.correlationPenalty)} / {result.volatilityPenalty}
          </p>
        </div>
      </div>

      {/* Parlay-level reasons */}
      {(() => {
        const reasons = parlayReasons(result);
        if (!reasons.length) return null;
        return (
          <div className="flex flex-wrap gap-1.5 border-t border-border/60 pt-3">
            {reasons.map((r) => (
              <span key={r} className="text-[9px] font-medium text-muted-foreground bg-muted/50 border border-border/60 rounded-full px-2 py-0.5">
                {r}
              </span>
            ))}
          </div>
        );
      })()}

      <ul className="space-y-2 text-xs border-t border-border/60 pt-3">
        {result.legs.map((leg) => {
          const hints = legSwapHints(leg, candidates);
          const onBuilder = builderLegs.some((l) => l.id === leg.id);
          return (
            <li key={leg.id} className="rounded-lg bg-muted/25 px-2.5 py-2 space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-1">
                <span className="font-semibold text-foreground">{leg.selectionLabel}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">{leg.matchupLabel}</span>
              </div>
              <p className="text-[9px] text-muted-foreground/70 italic">{legReason(leg)}</p>
              <div className="flex flex-wrap gap-1.5">
                {hints.lowerRiskAlternative ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-[10px] font-semibold"
                    disabled={!onBuilder}
                    title={onBuilder ? undefined : "Load this combo into the builder first"}
                    onClick={() => {
                      replaceValueLeg(leg.id, hints.lowerRiskAlternative!);
                      toast.success("Swapped for lower-risk leg");
                    }}
                  >
                    Lower risk alt
                  </Button>
                ) : null}
                {hints.higherValueAlternative ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-[10px] font-semibold"
                    disabled={!onBuilder}
                    title={onBuilder ? undefined : "Load this combo into the builder first"}
                    onClick={() => {
                      replaceValueLeg(leg.id, hints.higherValueAlternative!);
                      toast.success("Swapped for higher-value leg");
                    }}
                  >
                    Higher value alt
                  </Button>
                ) : null}
              </div>
              {!hints.lowerRiskAlternative && !hints.higherValueAlternative ? (
                <p className="text-[10px] text-muted-foreground">No same-game ML swap surfaced — replace leg manually from Best value.</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {result.warnings.length ? (
        <ul className="text-[10px] text-amber-700 dark:text-amber-400/90 space-y-0.5 list-disc list-inside">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function RankedLiveParlayPresets({
  games,
  oddsMap,
  candidates,
  gamesLoading,
}: {
  games: GamePrediction[];
  oddsMap: Map<string, GameOddsBundle>;
  candidates: ValueBetCandidate[];
  gamesLoading: boolean;
}) {
  const { setBuilderLegs, replaceValueLeg, builderLegs } = useValueParlay();

  const pool = useMemo(() => buildRankedLiveMoneylinePool(games, oddsMap), [games, oddsMap]);
  const combos = useMemo(() => rankedLiveOptimizedCombos(games, oddsMap), [games, oddsMap]);

  if (gamesLoading || pool.length < 2) return null;
  if (!combos.some((x) => x.result)) return null;

  return (
    <div
      className={cn(
        "rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.06] via-card to-card p-5 sm:p-6 space-y-4"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-emerald-500/15 p-2 text-emerald-600 dark:text-emerald-400 shrink-0">
          <Sparkles className="w-5 h-5" aria-hidden />
        </div>
        <div className="space-y-1 min-w-0">
          <p className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">Ranked live picks</p>
          <h3 className="font-display font-bold text-lg sm:text-xl text-foreground tracking-tight">
            Auto parlay presets
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Built from the same ranked live games as the main screen (after sport checkpoints). Use{" "}
            <span className="text-foreground font-medium">Load combo</span> to drop legs into the builder, then refine with
            swaps or Best value legs.
          </p>
          <p className="text-[11px] text-muted-foreground">
            Pool: <span className="font-semibold text-foreground">{pool.length}</span> ranked live moneyline
            {pool.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {combos.map(({ n, result }) =>
          result ? (
            <ComboBlock
              key={n}
              title={`Best ${n}-leg`}
              result={result}
              candidates={candidates}
              builderLegs={builderLegs}
              replaceValueLeg={replaceValueLeg}
              onLoad={() => {
                setBuilderLegs(result.legs);
                toast.success(`${n}-leg combo loaded`);
              }}
            />
          ) : null
        )}
      </div>
    </div>
  );
}
