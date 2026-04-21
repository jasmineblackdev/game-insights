import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, ChevronUp, Plus, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import type { GamePrediction, League } from "@/data/mockGames";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  bestPropValues,
  buildAllValueCandidates,
  buildEnrichedPropCandidates,
  lineMovementAlerts,
  safestConfirmed,
  topRecommended,
} from "@/lib/valueParlay/buildCandidates";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import { formatMatchupWithAbbrevs } from "@/lib/valueParlay/teamAbbrevNormalize";
import type { ParlayBuildMode, ValueBetCandidate } from "@/lib/valueParlay/types";
import { useValueParlay } from "@/context/ValueParlayContext";
import { useQuery } from "@tanstack/react-query";
import { fetchPlayerEdgePredictions } from "@/lib/playerEdgeApi";
import {
  analyzeExclusionDistribution,
  analyzeTimingBuckets,
  analyzeSafePoolDepth,
  logCandidateAnalytics,
} from "@/lib/valueParlay/candidateAnalytics";
import { logCandidateBuild } from "@/lib/valueParlay/analyticsLogger";

type PickKind = "all" | "team" | "props";
type LeagueFilter = "all" | League;
type RiskPreset = "all" | ParlayBuildMode;

const LEAGUES: League[] = ["nba", "nfl", "mlb", "boxing", "mma"];

function leagueShort(l: League) {
  return l.toUpperCase();
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
      className="rounded-lg border border-border bg-card/80 p-4 space-y-3 hover:border-primary/25 transition-colors"
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
          {c.timingScore != null ? (
            <p>
              Timing score{" "}
              <span className={c.timingScore >= 0.75 ? "text-emerald-500" : c.timingScore <= 0.25 ? "text-amber-500" : ""}>
                {(c.timingScore * 100).toFixed(0)}/100
              </span>
              {c.timingUrgency ? ` · ${c.timingUrgency}` : ""}
            </p>
          ) : null}
          {c.exclusionReason ? (
            <p className="text-amber-500/80">
              <span className="font-semibold">Excluded: </span>
              {c.exclusionReason}
            </p>
          ) : null}
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
  loading,
}: {
  games: GamePrediction[];
  oddsMap: Map<string, GameOddsBundle>;
  loading: boolean;
}) {
  const { addValueLeg, isValueLegAdded, setParlayMode } = useValueParlay();
  const [pickKind, setPickKind] = useState<PickKind>("all");
  const [leagueFilter, setLeagueFilter] = useState<LeagueFilter>("all");
  const [riskPreset, setRiskPreset] = useState<RiskPreset>("all");
  const [expandId, setExpandId] = useState<string | null>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);

  const { data: propData } = useQuery({
    queryKey: ["player-edge-v2"],
    queryFn: () => fetchPlayerEdgePredictions("all", "all"),
    staleTime: 3 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  const candidates = useMemo(() => {
    const gameCandidates = buildAllValueCandidates(games, oddsMap);
    const enrichedPropCandidates = buildEnrichedPropCandidates(propData?.items ?? []);
    const seenCorrGroups = new Set(gameCandidates.map((c) => c.correlationGroupId));
    const uniqueEnriched = enrichedPropCandidates.filter(
      (c) => !seenCorrGroups.has(c.correlationGroupId)
    );
    return [...gameCandidates, ...uniqueEnriched].sort((a, b) => b.valueScore - a.valueScore);
  }, [games, oddsMap, propData]);

  // Dev analytics: log to console + persist to Supabase whenever pool changes
  useEffect(() => {
    if (candidates.length > 0) {
      logCandidateAnalytics(candidates, `BestValuePicks (${candidates.length})`);
      logCandidateBuild(candidates).catch(() => {});
    }
  }, [candidates]);

  const exclStats = useMemo(() => analyzeExclusionDistribution(candidates), [candidates]);
  const timingStats = useMemo(() => analyzeTimingBuckets(candidates), [candidates]);
  const safeStats = useMemo(() => analyzeSafePoolDepth(candidates), [candidates]);

  const filtered = useMemo(() => {
    let list = candidates;
    if (pickKind === "team") list = list.filter((c) => c.pickType !== "player_prop");
    if (pickKind === "props") list = list.filter((c) => c.pickType === "player_prop");
    if (leagueFilter !== "all") list = list.filter((c) => c.sport === leagueFilter);
    if (riskPreset === "safe") list = list.filter((c) => c.riskBand === "low" || c.riskBand === "moderate");
    if (riskPreset === "balanced") list = list.filter((c) => c.riskBand !== "high");
    if (riskPreset === "cashout") list = list.filter((c) => c.riskBand === "low" || c.riskBand === "moderate");
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
      <h3 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-emerald-500" />
        {label}
      </h3>
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
      <div className="space-y-2">
        <h2 className="font-display font-bold text-xl text-foreground">Best Value Picks</h2>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Top model edges after odds, volatility, and confirmation filters. Edge = model probability minus book
          implied probability — we only surface recommended legs when filters pass.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card/40 p-4 space-y-3">
        <p className="text-[10px] font-semibold tracking-wider text-muted-foreground">FILTERS</p>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["all", "All"],
              ["team", "Team picks"],
              ["props", "Player props"],
            ] as const
          ).map(([k, lab]) => (
            <button
              key={k}
              type="button"
              onClick={() => setPickKind(k)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-semibold border transition-colors",
                pickKind === k ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"
              )}
            >
              {lab}
            </button>
          ))}
        </div>
        <p className="text-[10px] font-semibold tracking-wider text-muted-foreground">MODE PRESET (PARLAY)</p>
        <div className="flex flex-wrap gap-2">
          {(["all", "safe", "balanced", "aggressive", "cashout"] as const).map((k) => (
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
                "px-3 py-1 rounded-full text-xs font-semibold border transition-colors",
                riskPreset === k ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"
              )}
            >
              {k === "all" ? "All modes" : k.charAt(0).toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {LEAGUES.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLeagueFilter(leagueFilter === l ? "all" : l)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-semibold border transition-colors",
                leagueFilter === l ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"
              )}
            >
              {leagueShort(l)}
            </button>
          ))}
        </div>
      </div>

      {/* Analytics bar — filter health at a glance */}
      {!loading && candidates.length > 0 ? (
        <div className="rounded-lg border border-border bg-card/30 text-[10px]">
          <button
            type="button"
            className="w-full flex items-center justify-between px-4 py-2 text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowAnalytics((v) => !v)}
          >
            <span className="font-semibold tracking-wider">
              POOL ANALYTICS · {exclStats.recommended}/{exclStats.total} recommended
              {exclStats.overfireWarning ? " · ⚠ filter overfire" : ""}
              {safeStats.thinSports.length > 0 ? ` · ⚠ thin safe pool: ${safeStats.thinSports.join(", ")}` : ""}
            </span>
            {showAnalytics ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>

          {showAnalytics ? (
            <div className="px-4 pb-3 space-y-3 border-t border-border">
              {/* Exclusion breakdown */}
              <div>
                <p className="font-semibold tracking-wider text-muted-foreground pt-2 mb-1.5">EXCLUSION BREAKDOWN</p>
                <div className="flex flex-wrap gap-2">
                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                    Recommended {exclStats.recommended} ({exclStats.recommendedPct}%)
                  </span>
                  {Object.entries(exclStats.byReason).sort(([, a], [, b]) => b - a).map(([reason, count]) => (
                    <span
                      key={reason}
                      className={cn(
                        "px-2 py-0.5 rounded-full border",
                        exclStats.overfireWarning && reason === exclStats.topReason
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
                          : "bg-muted/40 text-muted-foreground border-border"
                      )}
                    >
                      {reason} {count}
                    </span>
                  ))}
                </div>
              </div>

              {/* Timing distribution */}
              <div>
                <p className="font-semibold tracking-wider text-muted-foreground mb-1.5">TIMING DISTRIBUTION (ML PROPS)</p>
                <div className="flex flex-wrap gap-2">
                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                    Now {timingStats.now}
                    {timingStats.tooManyNows ? " ⚠" : ""}
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-muted/40 text-muted-foreground border border-border">
                    Monitor {timingStats.monitor}
                  </span>
                  <span className={cn(
                    "px-2 py-0.5 rounded-full border",
                    timingStats.tooManyWaits
                      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
                      : "bg-muted/40 text-muted-foreground border-border"
                  )}>
                    Wait {timingStats.wait}
                    {timingStats.tooManyWaits ? " ⚠" : ""}
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-muted/30 text-muted-foreground border border-border">
                    Untagged {timingStats.untagged}
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-muted/30 text-muted-foreground border border-border tabular-nums">
                    Avg score {(timingStats.avgTimingScore * 100).toFixed(0)}/100
                  </span>
                </div>
              </div>

              {/* Safe pool depth */}
              <div>
                <p className="font-semibold tracking-wider text-muted-foreground mb-1.5">SAFE MODE POOL DEPTH</p>
                <div className="flex flex-wrap gap-2">
                  <span className="px-2 py-0.5 rounded-full bg-muted/40 text-muted-foreground border border-border">
                    Eligible {safeStats.safeEligible}
                  </span>
                  {Object.entries(safeStats.bySport).map(([sport, n]) => (
                    <span
                      key={sport}
                      className={cn(
                        "px-2 py-0.5 rounded-full border uppercase font-bold",
                        safeStats.thinSports.includes(sport)
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
                          : "bg-muted/40 text-muted-foreground border-border"
                      )}
                    >
                      {sport} {n}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-52 rounded-lg bg-muted/40 animate-pulse" />
          ))}
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
