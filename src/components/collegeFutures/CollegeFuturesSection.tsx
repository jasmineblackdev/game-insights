import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { COLLEGE_FUTURES_SPORTS } from "@/lib/collegeFuturesConfig";
import type { CollegeSportId } from "@/lib/collegeFuturesTypes";
import { fetchCollegeFuturesBoard, formatAmericanOdds } from "@/lib/collegeFuturesOddsApi";
import { buildCollegeFuturesIntelRows } from "@/lib/collegeFuturesModel";
import type { CollegeFuturesIntelRow } from "@/lib/collegeFuturesTypes";

const PAGE_SIZE = 16;

function valueBadgeClass(grade: CollegeFuturesIntelRow["valueRating"]): string {
  if (grade === "A") return "bg-emerald-600/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
  if (grade === "B") return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 border-emerald-500/25";
  if (grade === "C") return "bg-muted text-muted-foreground border-border";
  if (grade === "D") return "bg-amber-500/15 text-amber-800 dark:text-amber-200 border-amber-500/25";
  return "bg-destructive/15 text-destructive border-destructive/25";
}

function confidenceLabel(c: CollegeFuturesIntelRow["confidence"]): string {
  if (c === "HIGH") return "High";
  if (c === "MED") return "Med";
  return "Low";
}

export function CollegeFuturesSection() {
  const [sportId, setSportId] = useState<CollegeSportId>("college_baseball");
  const [expanded, setExpanded] = useState(false);

  const query = useQuery({
    queryKey: ["college-futures-board", sportId],
    queryFn: () => fetchCollegeFuturesBoard(sportId),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });

  const rows = useMemo(() => {
    const data = query.data;
    if (!data?.outcomes.length) return [];
    const intel = buildCollegeFuturesIntelRows(sportId, data.meta.sportKeyUsed, data.outcomes);
    return [...intel].sort((a, b) => b.fairImpliedProbability - a.fairImpliedProbability);
  }, [query.data, sportId]);

  const visibleRows = expanded ? rows : rows.slice(0, PAGE_SIZE);
  const valuePicks = useMemo(
    () => rows.filter((r) => r.valueRating === "A" || r.valueRating === "B"),
    [rows]
  );

  const meta = query.data?.meta;
  const note = meta?.note;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="inline-flex rounded-full bg-muted p-0.5 gap-0.5 flex-wrap">
          {COLLEGE_FUTURES_SPORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setSportId(s.id);
                setExpanded(false);
              }}
              className={cn(
                "min-h-10 px-3 py-2 sm:py-1.5 rounded-full text-xs font-semibold transition-colors touch-manipulation",
                sportId === s.id
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground active:bg-muted"
              )}
            >
              {s.shortLabel}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full border border-border bg-card/50 px-2.5 py-1">Champion</span>
          <span className="text-[11px]">Sorted: shortest implied odds first</span>
        </div>
      </div>

      {query.isPending ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-24 rounded-lg border border-border bg-muted/30 animate-pulse" />
          ))}
        </div>
      ) : query.isError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Could not load futures board.
        </div>
      ) : note === "no_api" ? (
        <div className="rounded-lg border border-border bg-card/60 p-4 text-sm text-muted-foreground">
          Configure The Odds API via the Edge <span className="font-mono text-xs">odds-api-proxy</span> function (server-side <span className="font-mono text-xs">THE_ODDS_API_KEY</span> secret) to load college futures.
        </div>
      ) : !rows.length ? (
        <div className="rounded-lg border border-border bg-card/60 p-4 text-sm text-muted-foreground space-y-1">
          <p>
            {sportId === "college_football"
              ? "College Football championship futures aren't available right now — the season hasn't started yet. Try College Baseball (CWS) instead."
              : sportId === "college_basketball"
                ? "College Basketball championship futures are not currently available. The tournament has ended — check back next season."
                : "College Baseball (CWS) futures aren't posted yet. Check back closer to the College World Series in June."}
          </p>
        </div>
      ) : (
        <>
          {valuePicks.length > 0 ? (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <TrendingUp className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                Value signals (A / B vs devigged market)
              </div>
              <ul className="space-y-2 text-sm">
                {valuePicks.slice(0, 6).map((r) => (
                  <li key={r.selectionName} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-medium text-foreground">{r.selectionName}</span>
                    <Badge variant="outline" className={cn("text-[10px]", valueBadgeClass(r.valueRating))}>
                      {r.valueRating}
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                      edge {(r.edge >= 0 ? "+" : "")}{(r.edge * 100).toFixed(1)} pp · model {(r.modelProbability * 100).toFixed(1)}%
                      vs fair {(r.fairImpliedProbability * 100).toFixed(1)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {meta?.sportsbookTitle ?? "Sportsbook"} · {meta?.marketName ?? "Futures"}
            </span>
            <span className="font-mono text-[10px] opacity-80">{meta?.sportKeyUsed}</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {visibleRows.map((r) => (
              <div
                key={r.selectionName}
                className="rounded-lg border border-border bg-card/80 p-3 sm:p-4 flex flex-col gap-2 shadow-sm"
              >
                <div className="flex items-start justify-between gap-2 min-w-0">
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground text-sm leading-snug truncate">{r.selectionName}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatAmericanOdds(r.americanOdds)}
                      {r.openingOdds != null && r.openingOdds !== r.americanOdds ? (
                        <span className="ml-1.5 opacity-80">open {formatAmericanOdds(r.openingOdds)}</span>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Badge variant="outline" className={cn("text-[10px]", valueBadgeClass(r.valueRating))}>
                      {r.valueRating}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">{confidenceLabel(r.confidence)} conf.</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:text-xs">
                  <div>
                    <span className="text-muted-foreground">Implied</span>{" "}
                    <span className="font-medium text-foreground">{(r.impliedProbability * 100).toFixed(1)}%</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Fair (devig)</span>{" "}
                    <span className="font-medium text-foreground">{(r.fairImpliedProbability * 100).toFixed(1)}%</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Model</span>{" "}
                    <span className="font-medium text-primary">{(r.modelProbability * 100).toFixed(1)}%</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Edge</span>{" "}
                    <span
                      className={cn(
                        "font-medium",
                        r.edge > 0.02 ? "text-emerald-600 dark:text-emerald-400" : r.edge < -0.02 ? "text-amber-600 dark:text-amber-400" : "text-foreground"
                      )}
                    >
                      {(r.edge >= 0 ? "+" : "")}{(r.edge * 100).toFixed(1)} pp
                    </span>
                  </div>
                </div>
                {r.lineMovementDelta != null ? (
                  <p className="text-[10px] text-muted-foreground">
                    Line move (implied): {(r.lineMovementDelta >= 0 ? "+" : "")}{(r.lineMovementDelta * 100).toFixed(1)} pp
                    since first seen this session
                  </p>
                ) : null}
                <div className="pt-1 border-t border-border/60 space-y-1 text-[11px] text-muted-foreground leading-snug">
                  <p>
                    <span className="text-foreground/90 font-medium">Why: </span>
                    {r.reason1}
                  </p>
                  <p>{r.reason2}</p>
                  <p className="text-amber-800/90 dark:text-amber-200/90">
                    <span className="font-medium">Risk: </span>
                    {r.riskFactor}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {rows.length > PAGE_SIZE ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setExpanded((e) => !e)}
              >
                {expanded ? (
                  <>
                    <ChevronUp className="w-4 h-4" />
                    View less
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-4 h-4" />
                    View more ({rows.length - PAGE_SIZE} more)
                  </>
                )}
              </Button>
            </div>
          ) : null}

          <p className="text-[11px] text-muted-foreground text-center max-w-2xl mx-auto leading-relaxed">
            GameLens model = devigged market adjusted by sport-specific heuristics (rotation, paths, guards, etc.).
            Wire real stats into the same layer later; longshots stay low confidence unless edge is extreme.
          </p>
        </>
      )}
    </div>
  );
}
