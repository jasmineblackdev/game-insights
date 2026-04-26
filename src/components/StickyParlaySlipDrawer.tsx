/**
 * StickyParlaySlipDrawer
 *
 * Mounted at app root. A floating action button sits bottom-right and
 * shows the current parlay-slip leg count as a badge. Tapping it opens
 * a right-side sheet that lists every leg currently on the slip with
 * remove + clear actions and a quick "open the builder" link to /.
 *
 * Hidden on the parlay-builder surface itself (Home in parlay_builder
 * mode and the legacy /parlays page) so it doesn't double up with the
 * inline builder UI.
 *
 * Hidden on the analytics page (/edge) since slip-building isn't the
 * point of that surface.
 */

import { Link, useLocation } from "react-router-dom";
import { Layers, X, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useValueParlay } from "@/context/ValueParlayContext";
import {
  getPropRiskLevel,
  riskLevelClass,
  riskLevelLabel,
} from "@/lib/valueParlay/propRiskLevels";

function formatAmerican(o: number): string {
  return o > 0 ? `+${o}` : `${o}`;
}

export function StickyParlaySlipDrawer() {
  const { pathname, search } = useLocation();
  const { builderLegs, builderMetrics, removeValueLeg, clearValueBuilder } = useValueParlay();

  // Hide on routes where the inline builder is the primary surface.
  // Home (/) in parlay_builder view passes ?view=parlay_builder via the
  // tab toggle; we read it here so the drawer doesn't duplicate the
  // visible builder.
  const isAnalytics = pathname === "/edge";
  const isParlaysPage = pathname === "/parlays";
  const isHomeBuilderTab =
    pathname === "/" && new URLSearchParams(search).get("view") === "parlay_builder";

  if (isAnalytics || isParlaysPage || isHomeBuilderTab) return null;

  const count = builderLegs.length;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={count ? `Open parlay slip (${count} legs)` : "Open parlay slip"}
          className="fixed bottom-4 right-4 z-40 flex items-center gap-2 px-4 py-3 rounded-full bg-primary text-primary-foreground shadow-lg hover:shadow-xl active:scale-95 transition-all touch-manipulation safe-pb"
        >
          <Layers className="w-4 h-4" />
          <span className="text-xs font-bold tracking-wide uppercase">Slip</span>
          <span
            className={
              count > 0
                ? "ml-1 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-card text-foreground text-[11px] font-bold"
                : "ml-1 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-primary-foreground/20 text-primary-foreground text-[11px] font-bold"
            }
          >
            {count}
          </span>
        </button>
      </SheetTrigger>

      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-primary" />
            Parlay slip · {count} {count === 1 ? "leg" : "legs"}
          </SheetTitle>
        </SheetHeader>

        {builderMetrics ? (
          <>
            <div className="mt-3 rounded-md border border-border bg-muted/40 p-3 grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Combined</p>
                <p className="text-sm font-bold tabular-nums">{formatAmerican(builderMetrics.combinedAmericanOdds)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Hit prob</p>
                <p className="text-sm font-bold tabular-nums">{Math.round(builderMetrics.projectedHitProbability * 100)}%</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Payout x</p>
                <p className="text-sm font-bold tabular-nums">{builderMetrics.projectedPayoutMultiplier.toFixed(2)}</p>
              </div>
            </div>
            {builderMetrics.riskLevelCounts ? (
              <div className="mt-2 flex items-center justify-center gap-1.5 text-[10px]">
                <span className="text-muted-foreground">Risk mix:</span>
                <span className="inline-flex items-center px-1.5 py-0.5 rounded border bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/20 font-bold">
                  {builderMetrics.riskLevelCounts.low} LOW
                </span>
                <span className="inline-flex items-center px-1.5 py-0.5 rounded border bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/20 font-bold">
                  {builderMetrics.riskLevelCounts.medium} MED
                </span>
                <span className="inline-flex items-center px-1.5 py-0.5 rounded border bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/20 font-bold">
                  {builderMetrics.riskLevelCounts.high} HIGH
                </span>
              </div>
            ) : null}
          </>
        ) : null}

        <div className="mt-4 flex-1 overflow-y-auto space-y-2 -mx-2 px-2">
          {count === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-card/40 p-4 text-center text-xs text-muted-foreground">
              <p>No legs yet.</p>
              <p className="mt-1">Tap "Add to parlay" on any pick to start your slip.</p>
            </div>
          ) : (
            builderLegs.map((l) => {
              const risk = getPropRiskLevel(l);
              return (
                <div
                  key={l.id}
                  className="rounded-md border border-border bg-card/60 p-3 text-xs space-y-1"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-foreground truncate">{l.selectionLabel}</p>
                      <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                        <span className={`inline-flex items-center text-[9px] font-bold px-1.5 py-0.5 rounded border ${riskLevelClass(risk)}`}>
                          {riskLevelLabel(risk)}
                        </span>
                        <p className="text-[11px] text-muted-foreground tabular-nums">
                          {String(l.sport).toUpperCase()} · {formatAmerican(l.americanOdds)} · edge {(l.edge * 100).toFixed(1)}% ·{" "}
                          <span
                            className={
                              l.confidence === "high"
                                ? "text-confidence-high"
                                : l.confidence === "medium"
                                  ? "text-confidence-medium"
                                  : "text-confidence-low"
                            }
                          >
                            {l.confidence}
                          </span>
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => removeValueLeg(l.id)}
                      aria-label="Remove leg"
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  {l.riskNote ? (
                    <p className="text-[10px] text-muted-foreground line-clamp-2">{l.riskNote}</p>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        {builderMetrics?.warnings.length ? (
          <ul className="mt-3 text-[10px] text-amber-600 dark:text-amber-400/90 list-disc list-inside space-y-0.5">
            {builderMetrics.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}

        <div className="mt-4 pt-3 border-t border-border flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="flex-1"
            onClick={() => {
              if (!count) return;
              clearValueBuilder();
              toast.success("Slip cleared");
            }}
            disabled={!count}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear
          </Button>
          <SheetClose asChild>
            <Button
              asChild
              variant="default"
              size="sm"
              className="flex-1"
              disabled={!count}
            >
              <Link to="/?view=parlay_builder">Open builder</Link>
            </Button>
          </SheetClose>
        </div>
      </SheetContent>
    </Sheet>
  );
}
