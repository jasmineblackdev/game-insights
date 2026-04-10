import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { BarChart3, ChevronDown, ChevronUp, Layers, Plus, RefreshCw, Sparkles, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import type { GamePrediction, League } from "@/data/mockGames";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  bestPropValues,
  buildAllValueCandidates,
  lineMovementAlerts,
  safestConfirmed,
  topRecommended,
} from "@/lib/valueParlay/buildCandidates";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import { formatMatchupWithAbbrevs } from "@/lib/valueParlay/teamAbbrevNormalize";
import type { ParlayBuildMode, ValueBetCandidate } from "@/lib/valueParlay/types";
import { useValueParlay } from "@/context/ValueParlayContext";

type PickKind = "all" | "team" | "props";
type LeagueFilter = "all" | League;
type RiskPreset = "all" | ParlayBuildMode;

const LEAGUES: League[] = ["nba", "nfl", "mlb", "soccer"];

function leagueShort(l: League) {
  return l === "soccer" ? "EPL" : l.toUpperCase();
}

function formatPct(x: number) {
  return `${Math.round(x * 100)}%`;
}

function formatEdge(x: number) {
  const s = x >= 0 ? "+" : "";
  return `${s}${(x * 100).toFixed(1)}%`;
}

function ValuePickCard({
  c,
  onAdd,
  added,
  expanded,
  onToggleExpand,
}: {
  c: ValueBetCandidate;
  onAdd: () => void;
  added: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  return (
    <motion.div
      layout
      className="rounded-xl border border-border/80 bg-card/90 p-4 space-y-3 shadow-sm hover:border-primary/30 hover:shadow-md transition-all"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            {leagueShort(c.sport)}
          </span>
          <span className="text-[10px] font-bold tracking-wide text-emerald-600 dark:text-emerald-400 bg-emerald-500/15 px-2 py-0.5 rounded-full border border-emerald-500/25">
            VALUE {c.valueGrade}
          </span>
          {c.pickType === "player_prop" ? (
            <span className="text-[10px] font-bold tracking-wide text-violet-500 dark:text-violet-400 bg-violet-500/10 px-2 py-0.5 rounded-full">
              PROP
            </span>
          ) : null}
        </div>
      </div>

      <div>
        <p className="text-sm font-display font-bold text-foreground">
          {formatMatchupWithAbbrevs(c.matchupLabel, c.sport)}
        </p>
        <p className="text-xs font-semibold text-primary mt-0.5">{c.selectionLabel}</p>
        <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
          Odds {c.americanOdds > 0 ? `+${c.americanOdds}` : c.americanOdds}
          {c.sportsbookKey ? ` · ${c.sportsbookKey}` : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <p className="text-muted-foreground">
          Model <span className="text-foreground font-semibold tabular-nums">{formatPct(c.modelProbability)}</span>
        </p>
        <p className="text-muted-foreground">
          Implied{" "}
          <span className="text-foreground font-semibold tabular-nums">{formatPct(c.impliedProbability)}</span>
        </p>
        <p className="text-muted-foreground">
          Edge{" "}
          <span
            className={cn(
              "font-semibold tabular-nums",
              c.edge >= 0.03 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
            )}
          >
            {formatEdge(c.edge)}
          </span>
        </p>
        <p className="text-muted-foreground">
          Conf{" "}
          <span
            className={cn(
              c.confidence === "high" && "text-confidence-high",
              c.confidence === "medium" && "text-confidence-medium",
              c.confidence === "low" && "text-confidence-low",
              "font-semibold uppercase"
            )}
          >
            {c.confidence}
          </span>
        </p>
      </div>

      <p className="text-[10px] text-risk">
        <span className="font-semibold">Risk · </span>
        {c.riskNote}
      </p>

      {expanded ? (
        <div className="text-[10px] text-muted-foreground space-y-1 border-t border-border pt-2">
          <p>
            Value score {c.valueScore.toFixed(2)} · Risk index {c.riskScore.toFixed(0)} (
            {c.riskBand})
          </p>
          <p>Correlation bucket: {c.correlationGroupId}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="flex-1 min-w-[7rem] font-semibold"
          variant={added ? "secondary" : "default"}
          disabled={added}
          onClick={onAdd}
        >
          <Plus className="w-3.5 h-3.5" />
          {added ? "In parlay" : "Add leg"}
        </Button>
        <Button size="sm" variant="outline" className="shrink-0" onClick={onToggleExpand}>
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          Breakdown
        </Button>
      </div>
    </motion.div>
  );
}

export function BestValuePicksSection({
  games,
  oddsMap,
  gamesLoading,
  bookOddsLoading = false,
}: {
  games: GamePrediction[];
  oddsMap: Map<string, GameOddsBundle>;
  gamesLoading: boolean;
  /** The Odds API pass — do not block the whole page on this. */
  bookOddsLoading?: boolean;
}) {
  const { addValueLeg, isValueLegAdded, setParlayMode } = useValueParlay();
  const [pickKind, setPickKind] = useState<PickKind>("all");
  const [leagueFilter, setLeagueFilter] = useState<LeagueFilter>("all");
  const [riskPreset, setRiskPreset] = useState<RiskPreset>("all");
  const [expandId, setExpandId] = useState<string | null>(null);

  const candidates = useMemo(() => buildAllValueCandidates(games, oddsMap), [games, oddsMap]);

  const filtered = useMemo(() => {
    let list = candidates;
    if (pickKind === "team") list = list.filter((c) => c.pickType !== "player_prop");
    if (pickKind === "props") list = list.filter((c) => c.pickType === "player_prop");
    if (leagueFilter !== "all") list = list.filter((c) => c.sport === leagueFilter);
    if (riskPreset === "safe") list = list.filter((c) => c.riskBand === "low" || c.riskBand === "moderate");
    if (riskPreset === "balanced") list = list.filter((c) => c.riskBand !== "high");
    return list;
  }, [candidates, pickKind, leagueFilter, riskPreset]);

  const top5 = useMemo(() => {
    const rec = topRecommended(filtered, 5);
    if (rec.length >= 2) return rec;
    return [...filtered].filter((c) => c.edge >= 0.04).sort((a, b) => b.valueScore - a.valueScore).slice(0, 5);
  }, [filtered]);
  const safest = useMemo(() => safestConfirmed(candidates, 5), [candidates]);
  const props = useMemo(() => bestPropValues(candidates, 5), [candidates]);
  const lineAlerts = useMemo(() => lineMovementAlerts(candidates, 5), [candidates]);

  const renderRow = (label: string, list: ValueBetCandidate[]) => (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border/60 pb-2">
        <h3 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-emerald-500 shrink-0" />
          {label}
        </h3>
        <span className="text-[10px] font-semibold tabular-nums text-muted-foreground px-2 py-0.5 rounded-full bg-muted/80">
          {list.length} pick{list.length === 1 ? "" : "s"}
        </span>
      </div>
      {list.length === 0 ? (
        <p className="text-xs text-muted-foreground">No picks in this bucket right now.</p>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {list.map((c) => (
            <ValuePickCard
              key={c.id}
              c={c}
              added={isValueLegAdded(c.id)}
              expanded={expandId === c.id}
              onToggleExpand={() => setExpandId((x) => (x === c.id ? null : c.id))}
              onAdd={() => {
                const r = addValueLeg(c);
                if (r.ok) toast.success("Added to parlay builder");
                else toast.message(r.message ?? "Could not add");
              }}
            />
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="space-y-8">
      <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/[0.06] via-card to-card p-5 sm:p-6 space-y-4">
        <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-emerald-500/10 blur-2xl pointer-events-none" aria-hidden />
        <div className="relative flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="space-y-2 max-w-2xl">
            <div className="flex items-center gap-2 text-primary">
              <BarChart3 className="w-6 h-6 shrink-0" />
              <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">Value board</span>
            </div>
            <h2 className="font-display font-bold text-2xl sm:text-3xl text-foreground tracking-tight">Best value picks</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Ranked by model edge vs book implied probability, with volatility and confirmation baked in. Add legs to the{" "}
              <span className="text-foreground font-medium">Parlay builder</span> tab — filters here only affect this list.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 lg:flex-col lg:items-stretch shrink-0">
            <div className="flex items-center gap-2 rounded-xl border border-border/80 bg-background/60 px-4 py-3 min-w-[10rem]">
              <Sparkles className="w-4 h-4 text-emerald-500 shrink-0" />
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Slate</p>
                <p className="text-lg font-bold tabular-nums text-foreground leading-none">{candidates.length}</p>
                <p className="text-[10px] text-muted-foreground">candidates</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-border/80 bg-background/60 px-4 py-3 min-w-[10rem]">
              <Layers className="w-4 h-4 text-primary shrink-0" />
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Filtered</p>
                <p className="text-lg font-bold tabular-nums text-foreground leading-none">{filtered.length}</p>
                <p className="text-[10px] text-muted-foreground">visible now</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card/50 p-4 sm:p-5 space-y-5 shadow-sm">
        <div className="flex items-center gap-2">
          <p className="text-[10px] font-semibold tracking-wider text-muted-foreground">BOARD FILTERS</p>
          <span className="h-px flex-1 bg-border/80" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Pick type</p>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["all", "All"],
                  ["team", "Team"],
                  ["props", "Props"],
                ] as const
              ).map(([k, lab]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setPickKind(k)}
                  className={cn(
                    "px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors",
                    pickKind === k ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  {lab}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Parlay mode preset</p>
            <div className="flex flex-wrap gap-1.5">
              {(["all", "safe", "balanced", "aggressive"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    if (k === "all") setRiskPreset("all");
                    else {
                      setRiskPreset(k);
                      setParlayMode(k);
                    }
                  }}
                  className={cn(
                    "px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors capitalize",
                    riskPreset === k ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  {k === "all" ? "All" : k}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">League (this tab)</p>
            <div className="flex flex-wrap gap-1.5">
              {LEAGUES.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLeagueFilter(leagueFilter === l ? "all" : l)}
                  className={cn(
                    "px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors",
                    leagueFilter === l ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  {leagueShort(l)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {bookOddsLoading && !gamesLoading ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" aria-hidden />
          Loading sportsbook lines — spreads/totals and some edges update when Odds API finishes.
        </p>
      ) : null}

      {gamesLoading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-52 rounded-lg bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : candidates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-6 py-12 text-center space-y-2 max-w-xl mx-auto">
          <p className="text-sm text-muted-foreground leading-relaxed">
            No value legs for this slate yet. When games and lines are available, ranked edges appear here. Use{" "}
            <span className="text-foreground font-medium">Team picks</span> for model-only leans on the hub anytime.
          </p>
        </div>
      ) : (
        <>
          {renderRow("Top 5 best value picks", top5)}
          {renderRow("Safest confirmed picks", safest)}
          {renderRow("Best player prop values", props)}
          {lineAlerts.length > 0 ? renderRow("Line movement alerts", lineAlerts) : null}
        </>
      )}
    </div>
  );
}
