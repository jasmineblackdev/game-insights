import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  BarChart3,
  Copy,
  History,
  Layers,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  TrendingUp,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { GamePrediction, League } from "@/data/mockGames";
import { useEdgeCard } from "@/context/EdgeCardContext";
import { ValueParlayProvider, useValueParlay } from "@/context/ValueParlayContext";
import { BestValuePicksSection } from "@/components/valueParlay/BestValuePicksSection";
import { ParlayBuilderSection } from "@/components/valueParlay/ParlayBuilderSection";
import { enrichGamesWithBettingIntelligence } from "@/lib/bettingIntelligence";
import { fetchAllOddsBundles, type GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import { ModelHonestyCallout } from "@/components/ModelHonestyCallout";
import { UnitSizeCalculator } from "@/components/UnitSizeCalculator";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { showModelMarketEdgeBadge } from "@/lib/modelMarketEdge";
import { easternYmd, fetchNbaGamePredictions } from "@/lib/nbaEspn";
import { fetchNflGamePredictions } from "@/lib/nflEspn";
import { fetchMlbEnrichedGames } from "@/lib/mlbEspn";
import { applyMlbPredictionModel } from "@/lib/mlbPredictionModel";
import { mergeMlbStarterConfirmations } from "@/lib/mlbStarterConfirm";
import { fetchSoccerGamePredictions } from "@/lib/soccerEspn";
import { formatBuilderParlayShare } from "@/lib/valueParlay/parlayBotFormatting";
import {
  type EdgeCandidate,
  type EdgeCardSize,
  type EdgeSlipOutcome,
  EDGE_CARD_SIZE_OPTIONS,
  buildCandidate,
  candidateToSlipItem,
  edgeSlipWarningLines,
  groupCandidatesByLeague,
  isDraftEdgeSlipItem,
  isTeamSlipItem,
  rankCandidatesForHub,
  suggestReplacement,
} from "@/lib/edgeCardScoring";

const LEAGUES: League[] = ["nba", "nfl", "mlb", "soccer"];

function leagueShort(l: League) {
  return l === "soccer" ? "EPL" : l.toUpperCase();
}

/** MLB totals (~7–11) vs NBA (~210+) — surfaces board context on hub cards. */
function mlbBoardSummary(lines: GamePrediction["lines"]): string | null {
  if (!lines) return null;
  const parts: string[] = [];
  if (lines.spread) parts.push(lines.spread);
  if (lines.total != null) parts.push(`O/U ${lines.total}`);
  return parts.length ? parts.join(" · ") : null;
}

function HubPickCard({
  c,
  onAdd,
  added,
  disabled,
}: {
  c: EdgeCandidate;
  onAdd: () => void;
  added: boolean;
  disabled: boolean;
}) {
  const g = c.game;
  const picked = c.side === "home" ? g.homeTeam : g.awayTeam;
  const mlbBoard = g.league === "mlb" ? mlbBoardSummary(g.lines) : null;

  return (
    <motion.div
      layout
      className="rounded-lg border border-border bg-card/80 p-4 space-y-3 hover:border-primary/25 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            {leagueShort(g.league)}
          </span>
          {showModelMarketEdgeBadge(g) ? (
            <span
              className="text-[10px] font-bold tracking-wide text-amber-600 dark:text-amber-400 bg-amber-500/15 px-2 py-0.5 rounded-full border border-amber-500/25"
              title="Model vs market disagreement"
            >
              ⚡ EDGE
            </span>
          ) : null}
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {formatDistanceToNow(new Date(g.lastUpdated), { addSuffix: true })}
        </span>
      </div>

      <div>
        <p className="text-sm font-display font-bold text-foreground">
          {g.awayTeam.abbreviation} @ {g.homeTeam.abbreviation}
        </p>
        <p className="text-xs font-semibold text-primary mt-0.5">
          Pick {picked.abbreviation} · {c.winProbability}% model lean
        </p>
        {g.league === "mlb" ? (
          mlbBoard ? (
            <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5">{mlbBoard}</p>
          ) : (
            <p className="text-[10px] text-muted-foreground/80 mt-0.5">MLB · moneyline / run line from ESPN</p>
          )
        ) : null}
        <p className="text-xs text-muted-foreground mt-0.5">
          Edge score {c.pickScore.toFixed(1)} ·{" "}
          <span
            className={cn(
              g.confidence === "high" && "text-confidence-high",
              g.confidence === "medium" && "text-confidence-medium",
              g.confidence === "low" && "text-confidence-low"
            )}
          >
            {g.confidence.toUpperCase()}
          </span>
        </p>
      </div>

      <div className="space-y-1.5 text-xs">
        <p className="text-secondary-foreground">
          <span className="text-confidence-high font-semibold">Why · </span>
          {g.topReasons[0] ?? "—"}
        </p>
        {g.topReasons[1] ? (
          <p className="text-muted-foreground line-clamp-2">{g.topReasons[1]}</p>
        ) : null}
        <p className="text-risk">
          <span className="font-semibold">Risk · </span>
          {g.riskFactors[0] ?? "—"}
        </p>
      </div>

      <div className="flex flex-wrap gap-1">
        {c.flags.injuryUncertainty ? (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-risk/15 text-risk">Injury Q</span>
        ) : null}
        {c.flags.pitcherUnconfirmed ? (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400">SP unconfirmed</span>
        ) : null}
        {c.flags.highVolatility || c.flags.soccerDrawHeavy ? (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Volatile</span>
        ) : null}
      </div>

      <Button
        size="sm"
        className="w-full font-semibold"
        variant={added ? "secondary" : "default"}
        disabled={disabled || added}
        onClick={onAdd}
      >
        {added ? (
          "On Edge Card"
        ) : (
          <>
            <Plus className="w-3.5 h-3.5" />
            Add pick
          </>
        )}
      </Button>
    </motion.div>
  );
}

type EdgeTab = "hub" | "value" | "parlay";

function EdgeCardPageInner() {
  const [edgeTab, setEdgeTab] = useState<EdgeTab>("hub");
  const [oddsMap, setOddsMap] = useState<Map<string, GameOddsBundle>>(new Map());
  const [oddsLoading, setOddsLoading] = useState(false);

  const {
    cardSize,
    setCardSize,
    filters,
    setFilters,
    slip,
    history,
    addPick,
    removePick,
    replacePick,
    clearSlip,
    autoBuild,
    saveSlipToHistory,
    setHistoryOutcome,
    isOnSlip,
    slipFull,
  } = useEdgeCard();

  const {
    builderLegs,
    builderMetrics,
    clearValueBuilder,
    removeValueLeg,
  } = useValueParlay();

  const poll = 2 * 60 * 1000;
  const ymd = easternYmd();

  const coreResults = useQueries({
    queries: [
      {
        queryKey: ["nba-espn-scoreboard", ymd],
        queryFn: fetchNbaGamePredictions,
        staleTime: poll,
        refetchInterval: poll,
        refetchIntervalInBackground: false,
        retry: 2,
      },
      {
        queryKey: ["nfl-espn-scoreboard", ymd],
        queryFn: fetchNflGamePredictions,
        staleTime: poll,
        refetchInterval: poll,
        refetchIntervalInBackground: false,
        retry: 2,
      },
      {
        queryKey: ["soccer-espn-scoreboard", ymd],
        queryFn: fetchSoccerGamePredictions,
        staleTime: poll,
        refetchInterval: poll,
        refetchIntervalInBackground: false,
        retry: 2,
      },
    ],
  });

  const mlbBaseQuery = useQuery({
    queryKey: ["mlb-espn-enriched", ymd],
    queryFn: fetchMlbEnrichedGames,
    staleTime: poll,
    refetchInterval: poll,
    refetchIntervalInBackground: false,
    retry: 2,
  });

  const mlbModeledQuery = useQuery({
    queryKey: ["mlb-modeled", mlbBaseQuery.dataUpdatedAt, 0],
    queryFn: () =>
      applyMlbPredictionModel(mergeMlbStarterConfirmations(mlbBaseQuery.data ?? [])),
    enabled: mlbBaseQuery.isSuccess,
    staleTime: Infinity,
    retry: 2,
  });

  const mlbListPending =
    mlbBaseQuery.isPending || (mlbBaseQuery.isSuccess && mlbModeledQuery.isPending);

  const allGames = useMemo(() => {
    const merged: GamePrediction[] = [];
    for (const q of coreResults) {
      if (q.data) merged.push(...q.data);
    }
    if (mlbModeledQuery.data) merged.push(...mlbModeledQuery.data);
    return merged.filter(
      (g) =>
        g.status === "upcoming" &&
        (g.gameDate === "today" ||
          g.gameDate === "tomorrow" ||
          (g.league === "soccer" && g.gameDate === "week"))
    );
  }, [coreResults, mlbModeledQuery.data]);

  useEffect(() => {
    if (!allGames.length) {
      setOddsMap(new Map());
      setOddsLoading(false);
      return;
    }
    let cancelled = false;
    setOddsLoading(true);
    fetchAllOddsBundles(allGames)
      .then((m) => {
        if (!cancelled) setOddsMap(m);
      })
      .finally(() => {
        if (!cancelled) setOddsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [allGames]);

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [edgeTab]);

  const allGamesWithIntel = useMemo(
    () => enrichGamesWithBettingIntelligence(allGames, oddsMap),
    [allGames, oddsMap]
  );

  const gameById = useMemo(() => new Map(allGamesWithIntel.map((g) => [g.id, g])), [allGamesWithIntel]);

  const ranked = useMemo(() => rankCandidatesForHub(allGamesWithIntel, filters), [allGamesWithIntel, filters]);
  const byLeague = useMemo(() => groupCandidatesByLeague(ranked), [ranked]);
  const trending = useMemo(() => ranked.slice(0, 6), [ranked]);

  /** Full skeleton only while every feed is still pending — one slow sport no longer blocks the whole hub. */
  const loading = coreResults.every((q) => q.isPending) && mlbListPending;
  const hasError =
    coreResults.some((q) => q.isError) || mlbBaseQuery.isError || mlbModeledQuery.isError;
  const coreAnySettled = coreResults.some((q) => q.isSuccess || q.isError);
  const coreAnyPending = coreResults.some((q) => q.isPending);
  const mlbSettled =
    mlbBaseQuery.isSuccess || mlbBaseQuery.isError || mlbModeledQuery.isSuccess || mlbModeledQuery.isError;
  const moreSportsLoading =
    (coreAnySettled || mlbSettled) && (coreAnyPending || mlbListPending);

  const runAuto = (size: EdgeCardSize) => {
    if (!ranked.length) {
      toast.message("No picks match your filters");
      return;
    }
    autoBuild(ranked, size);
    setCardSize(size);
    toast.success(`Auto-built Edge Card ${size}`);
  };

  const toggleLeague = (l: League) => {
    setFilters((prev) => {
      if (prev.leagues === "all") {
        const next = LEAGUES.filter((x) => x !== l);
        return { ...prev, leagues: next.length ? next : "all" };
      }
      const set = new Set(prev.leagues);
      if (set.has(l)) set.delete(l);
      else set.add(l);
      if (set.size === 0 || set.size === 4) return { ...prev, leagues: "all" };
      return { ...prev, leagues: [...set] as League[] };
    });
  };

  const leagueActive = (l: League) => filters.leagues === "all" || filters.leagues.includes(l);

  const aggregateSummary = useMemo(() => {
    if (!slip.length) return null;
    const conf = slip.some((s) => s.snapshot.confidence === "low")
      ? "Low"
      : slip.some((s) => s.snapshot.confidence === "medium")
        ? "Medium"
        : "High";
    let risk = "Controlled";
    if (slip.some((s) => s.snapshot.confidence === "low")) risk = "Elevated";
    else if (
      slip.some(
        (s) =>
          isTeamSlipItem(s) &&
          (s.snapshot.topRisk.toLowerCase().includes("line") || s.snapshot.topRisk.includes("?"))
      )
    ) {
      risk = "Moderate";
    }
    return { conf, risk };
  }, [slip]);

  const slipWarnings = useMemo(() => edgeSlipWarningLines(slip), [slip]);

  const parlayShareText = useMemo(
    () => (builderLegs.length ? formatBuilderParlayShare(builderLegs, builderMetrics) : ""),
    [builderLegs, builderMetrics]
  );

  const copyParlayShare = async () => {
    if (!parlayShareText) {
      toast.message("Add legs from Best Value or Auto build on Parlay builder first");
      return;
    }
    try {
      await navigator.clipboard.writeText(parlayShareText);
      toast.success("Parlay summary copied");
    } catch {
      toast.error("Could not copy");
    }
  };

  const historyRecord = useMemo(() => {
    let w = 0;
    let l = 0;
    let p = 0;
    for (const h of history) {
      if (h.outcome === "win") w++;
      else if (h.outcome === "loss") l++;
      else if (h.outcome === "push") p++;
    }
    const tracked = w + l + p;
    return { w, l, p, tracked };
  }, [history]);

  return (
    <div className="min-h-screen bg-background pb-[calc(9rem+env(safe-area-inset-bottom))] sm:pb-36">
      <header className="border-b border-border surface-glass sticky top-0 z-40 pt-[env(safe-area-inset-top)]">
        <div className="container max-w-6xl mx-auto py-3 sm:py-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <Link
              to="/"
              className="flex items-center gap-2 min-h-10 text-sm text-muted-foreground hover:text-foreground transition-colors touch-manipulation shrink-0"
            >
              <ArrowLeft className="w-4 h-4 shrink-0" />
              Home
            </Link>
            <div className="h-4 w-px bg-border hidden sm:block" />
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-primary" />
              <div>
                <h1 className="font-display font-bold text-base text-foreground">Edge Card</h1>
                <p className="text-[11px] text-muted-foreground">
                  Team picks · best value · parlay builder · Draft Edge
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 overflow-x-auto max-w-full pb-0.5 -mx-1 px-1 sm:mx-0 sm:px-0 sm:pb-0 [scrollbar-width:thin]">
            <UnitSizeCalculator variant="compact" className="h-10 w-10 sm:h-9 sm:w-9 shrink-0 touch-manipulation" />
            <div className="inline-flex items-center gap-1 rounded-full bg-muted p-0.5 shrink-0">
              {EDGE_CARD_SIZE_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setCardSize(n)}
                  className={cn(
                    "min-h-10 min-w-10 sm:min-h-9 sm:min-w-9 px-3 py-2 sm:py-1 rounded-full text-xs font-bold transition-colors touch-manipulation",
                    cardSize === n ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground active:bg-muted"
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="container max-w-6xl mx-auto pb-2 flex gap-1 overflow-x-auto [scrollbar-width:thin] border-t border-border/60 pt-2">
          {(
            [
              ["hub", "Team picks", Layers],
              ["value", "Best value", BarChart3],
              ["parlay", "Parlay builder", Wrench],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setEdgeTab(id)}
              className={cn(
                "flex items-center gap-1.5 shrink-0 px-3 py-2 rounded-full text-xs font-bold transition-colors touch-manipulation",
                edgeTab === id
                  ? "bg-primary/15 text-primary border border-primary/30"
                  : "text-muted-foreground hover:text-foreground border border-transparent"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="container max-w-6xl mx-auto py-5 sm:py-6 space-y-6 sm:space-y-8">
        <ModelHonestyCallout variant="edge" />

        {edgeTab === "value" ? (
          <div className="min-h-[min(55vh,28rem)]">
            <BestValuePicksSection
              games={allGamesWithIntel}
              oddsMap={oddsMap}
              gamesLoading={loading}
              bookOddsLoading={oddsLoading}
            />
          </div>
        ) : null}
        {edgeTab === "parlay" ? (
          <div className="min-h-[min(55vh,28rem)]">
            <ParlayBuilderSection
              games={allGamesWithIntel}
              oddsMap={oddsMap}
              gamesLoading={loading}
              bookOddsLoading={oddsLoading}
            />
          </div>
        ) : null}

        {edgeTab === "hub" ? (
          <>
        <section className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
            <div>
              <h2 className="font-display font-bold text-xl text-foreground flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                Today&apos;s best team picks
              </h2>
              <p className="text-sm text-muted-foreground max-w-xl">
                Ranked by an internal edge score (win %, confidence stability, lineup certainty, volatility). Team
                winners only — no spreads or props.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {EDGE_CARD_SIZE_OPTIONS.map((n) => (
                <Button key={n} variant="outline" size="sm" onClick={() => runAuto(n)} className="gap-1">
                  <Sparkles className="w-3.5 h-3.5" />
                  Auto {n}
                </Button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card/40 p-4 space-y-4">
            <p className="text-[10px] font-semibold tracking-wider text-muted-foreground">FILTERS</p>
            <div className="flex flex-wrap gap-2">
              {LEAGUES.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => toggleLeague(l)}
                  className={cn(
                    "px-3 py-1 rounded-full text-xs font-semibold border transition-colors",
                    leagueActive(l)
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  {leagueShort(l)}
                </button>
              ))}
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Min confidence</Label>
                <select
                  className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={filters.minConfidence}
                  onChange={(e) =>
                    setFilters((p) => ({
                      ...p,
                      minConfidence: e.target.value as typeof filters.minConfidence,
                    }))
                  }
                >
                  <option value="any">Any</option>
                  <option value="medium">Medium+</option>
                  <option value="high">High only</option>
                </select>
              </div>
              <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <Label htmlFor="ex-q" className="text-xs cursor-pointer">
                  Exclude injury Q/GTD
                </Label>
                <Switch
                  id="ex-q"
                  checked={filters.excludeQuestionableInjuries}
                  onCheckedChange={(v) => setFilters((p) => ({ ...p, excludeQuestionableInjuries: v }))}
                />
              </div>
              <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <Label htmlFor="ex-sp" className="text-xs cursor-pointer">
                  Exclude unconfirmed SP (MLB)
                </Label>
                <Switch
                  id="ex-sp"
                  checked={filters.excludeUnconfirmedPitchers}
                  onCheckedChange={(v) => setFilters((p) => ({ ...p, excludeUnconfirmedPitchers: v }))}
                />
              </div>
              <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <Label htmlFor="ex-v" className="text-xs cursor-pointer">
                  Exclude volatile board
                </Label>
                <Switch
                  id="ex-v"
                  checked={filters.excludeHighVolatility}
                  onCheckedChange={(v) => setFilters((p) => ({ ...p, excludeHighVolatility: v }))}
                />
              </div>
            </div>
          </div>
        </section>

        {moreSportsLoading ? (
          <p className="text-[11px] text-muted-foreground flex items-center gap-2">
            <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" aria-hidden />
            Still loading some sports — picks may update as feeds finish.
          </p>
        ) : null}

        {loading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-56 rounded-lg bg-muted/40 animate-pulse" />
            ))}
          </div>
        ) : hasError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive space-y-2">
            <p>Could not load one or more sports feeds after retries.</p>
            <p className="text-xs text-destructive/90">
              Check your connection and refresh. For production, route scoreboards through the{" "}
              <span className="font-medium">espn-proxy</span> Edge Function — set{" "}
              <span className="font-mono">VITE_ENABLE_ESPN_PROXY=1</span> so fetches use a cached server path.
            </p>
          </div>
        ) : null}

        {!loading && trending.length > 0 ? (
          <section className="space-y-3">
            <h3 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-confidence-high" />
              Trending · top edge scores right now
            </h3>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {trending.map((c) => (
                <HubPickCard
                  key={c.game.id}
                  c={c}
                  added={isOnSlip(c.game.id)}
                  disabled={slipFull && !isOnSlip(c.game.id)}
                  onAdd={() => {
                    const r = addPick(c.game, c.side);
                    if (r.ok) toast.success(`Added ${c.side === "home" ? c.game.homeTeam.abbreviation : c.game.awayTeam.abbreviation}`);
                    else toast.message(r.message ?? "Could not add");
                  }}
                />
              ))}
            </div>
          </section>
        ) : null}

        {!loading &&
          LEAGUES.map((l) => {
            const group = byLeague[l];
            if (!group.length) return null;
            return (
              <section key={l} className="space-y-3">
                <h3 className="text-sm font-display font-bold text-foreground border-b border-border pb-2">
                  {leagueShort(l)} · {group.length} pick{group.length === 1 ? "" : "s"}
                </h3>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {group.map((c) => (
                    <HubPickCard
                      key={c.game.id}
                      c={c}
                      added={isOnSlip(c.game.id)}
                      disabled={slipFull && !isOnSlip(c.game.id)}
                      onAdd={() => {
                        const r = addPick(c.game, c.side);
                        if (r.ok) toast.success("Added to Edge Card");
                        else toast.message(r.message ?? "Could not add");
                      }}
                    />
                  ))}
                </div>
              </section>
            );
          })}

        {!loading && !ranked.length ? (
          <p className="text-sm text-muted-foreground text-center py-12">
            No upcoming games today match these filters. Try turning filters off or check tomorrow&apos;s slate from
            Home.
          </p>
        ) : null}

        <section className="space-y-3 border-t border-border pt-8">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h3 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
              <History className="w-4 h-4" />
              Saved Edge Cards
            </h3>
            {historyRecord.tracked > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Tracked:{" "}
                <span className="text-confidence-high font-semibold">{historyRecord.w}W</span> ·{" "}
                <span className="text-red-600 dark:text-red-400 font-semibold">{historyRecord.l}L</span>
                {historyRecord.p > 0 ? (
                  <>
                    {" "}
                    · <span className="text-foreground font-semibold">{historyRecord.p}P</span>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Mark Win / Loss / Push on saved cards to keep a simple record on this device — useful for judging how much
            to trust the model over time. Not shared or published unless you add cloud sync later.
          </p>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">Save your current slip to build a history of cards.</p>
          ) : (
            <ul className="space-y-2">
              {history.slice(0, 8).map((h) => (
                <li
                  key={h.id}
                  className="rounded-md border border-border bg-card/50 px-3 py-2 text-xs text-muted-foreground space-y-2"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold text-foreground">Edge {h.size}</span>
                    <span>·</span>
                    <span>{new Date(h.savedAt).toLocaleString()}</span>
                    <span>·</span>
                    <span>{h.items.length} picks</span>
                    <span>·</span>
                    <span>conf {h.aggregateConfidence}</span>
                    <span>·</span>
                    <span>risk {h.riskLabel}</span>
                    {h.outcome ? (
                      <span
                        className={cn(
                          "ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full",
                          h.outcome === "win" && "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
                          h.outcome === "loss" && "bg-red-500/15 text-red-600 dark:text-red-400",
                          h.outcome === "push" && "bg-muted text-foreground"
                        )}
                      >
                        {h.outcome.toUpperCase()}
                      </span>
                    ) : null}
                  </div>
                  <span className="block text-[11px]">
                    {h.items
                      .map((x) =>
                        isTeamSlipItem(x)
                          ? `${x.snapshot.pickedAbbr} vs ${x.snapshot.opponentAbbr}`
                          : isDraftEdgeSlipItem(x)
                            ? `Draft: ${x.snapshot.label}`
                            : x.snapshot.label
                      )
                      .join(" · ")}
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-[10px] text-muted-foreground mr-1">Result:</span>
                    {(["win", "loss", "push"] as const).map((o) => (
                      <Button
                        key={o}
                        type="button"
                        variant={h.outcome === o ? "default" : "outline"}
                        size="sm"
                        className={cn(
                          "h-7 text-[10px] px-2 capitalize",
                          h.outcome === o && o === "win" && "bg-emerald-600 hover:bg-emerald-600/90",
                          h.outcome === o && o === "loss" && "bg-red-600 hover:bg-red-600/90",
                          h.outcome === o && o === "push" && "bg-muted text-foreground"
                        )}
                        onClick={() => {
                          const next: EdgeSlipOutcome | null = h.outcome === o ? null : o;
                          setHistoryOutcome(h.id, next);
                          if (next) toast.success(`Marked ${next}`);
                        }}
                      >
                        {o}
                      </Button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
          </>
        ) : null}
      </main>

      <div className="fixed bottom-0 inset-x-0 z-50 border-t border-border bg-background/95 backdrop-blur-md shadow-[0_-8px_30px_rgba(0,0,0,0.12)] safe-pb">
        <div className="container max-w-6xl mx-auto py-3 space-y-3">
          {edgeTab === "hub" ? (
            <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="text-xs font-display font-bold text-foreground">
                Edge Card {cardSize} · {slip.length} / {cardSize} selected
              </p>
              {aggregateSummary ? (
                <p className="text-[11px] text-muted-foreground">
                  Card confidence: <span className="text-foreground">{aggregateSummary.conf}</span> · Risk:{" "}
                  <span className="text-foreground">{aggregateSummary.risk}</span>
                </p>
              ) : null}
              {slipWarnings.length > 0 ? (
                <ul className="text-[10px] text-amber-600 dark:text-amber-400/90 list-disc list-inside mt-1 space-y-0.5">
                  {slipWarnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="touch-manipulation min-h-10 sm:min-h-9"
                onClick={clearSlip}
                disabled={!slip.length}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="touch-manipulation min-h-10 sm:min-h-9"
                onClick={saveSlipToHistory}
                disabled={!slip.length}
              >
                Save to history
              </Button>
            </div>
          </div>
          {slip.length > 0 ? (
            <ul className="flex flex-col gap-2 max-h-48 overflow-y-auto">
              {slip.map((item) => {
                if (isDraftEdgeSlipItem(item)) {
                  return (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-[11px]"
                    >
                      <div>
                        <span className="font-bold text-foreground">{leagueShort(item.league)}</span> ·{" "}
                        <span className="text-violet-500 dark:text-violet-400 font-semibold">Draft</span> ·{" "}
                        {item.snapshot.label}
                        <span className="block text-muted-foreground mt-0.5 line-clamp-2">{item.snapshot.cardSummary}</span>
                        <span className="text-[10px] text-muted-foreground">{item.snapshot.confidence} conf</span>
                      </div>
                      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => removePick(item.id)}>
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </li>
                  );
                }
                if (!isTeamSlipItem(item)) {
                  return (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-[11px]"
                    >
                      <div>
                        <span className="font-bold text-foreground">{leagueShort(item.league)}</span> ·{" "}
                        <span className="text-primary font-semibold">Prop</span> · {item.snapshot.label}
                        <span className="block text-muted-foreground mt-0.5">
                          {item.snapshot.predictionDirection} · edge {item.snapshot.edgeDisplay.toFixed(1)} ·{" "}
                          {item.snapshot.confidence}
                        </span>
                      </div>
                      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => removePick(item.id)}>
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </li>
                  );
                }
                const live = gameById.get(item.gameId);
                const dataStale = live && live.lastUpdated !== item.snapshot.lastUpdated;
                const teamGameIds = slip.filter(isTeamSlipItem).map((s) => s.gameId);
                const rep = suggestReplacement(
                  ranked,
                  new Set(teamGameIds.filter((id) => id !== item.gameId))
                );
                return (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-[11px]"
                  >
                    <div>
                      <span className="font-bold text-foreground">{leagueShort(item.league)}</span> · Pick{" "}
                      <span className="text-primary">{item.snapshot.pickedAbbr}</span> vs {item.snapshot.opponentAbbr}{" "}
                      · {item.snapshot.winProb}% · {item.snapshot.confidence}
                      {dataStale ? (
                        <span className="ml-2 text-amber-600 dark:text-amber-400 font-semibold">
                          · Conditions may have changed — review
                        </span>
                      ) : null}
                      <span className="block text-muted-foreground mt-0.5 line-clamp-1">
                        Edge: {item.snapshot.keyEdge}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {rep && dataStale ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-[10px] px-2"
                          onClick={() => {
                            const nc = buildCandidate(rep.game, rep.side);
                            replacePick(item.id, candidateToSlipItem(nc));
                            toast.success(
                              `Swapped in ${nc.game.awayTeam.abbreviation} @ ${nc.game.homeTeam.abbreviation} — ${nc.side === "home" ? nc.game.homeTeam.abbreviation : nc.game.awayTeam.abbreviation}`
                            );
                          }}
                        >
                          <RefreshCw className="w-3 h-3" />
                          Swap
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removePick(item.id)}>
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[11px] text-muted-foreground">Add picks from the hub or use Auto-build.</p>
          )}
            </>
          ) : (
            <>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-xs font-display font-bold text-foreground">Parlay builder · draft legs</p>
                  <p className="text-[11px] text-muted-foreground">
                    <span className="text-foreground font-semibold">{builderLegs.length}</span> / 12 legs
                    {builderMetrics ? (
                      <>
                        {" · Est. payout "}
                        <span className="text-foreground font-semibold tabular-nums">
                          {builderMetrics.projectedPayoutMultiplier.toFixed(2)}x
                        </span>
                        {" · Proj. hit "}
                        <span className="text-foreground font-semibold tabular-nums">
                          {(builderMetrics.projectedHitProbability * 100).toFixed(1)}%
                        </span>
                      </>
                    ) : null}
                  </p>
                  {edgeTab === "value" ? (
                    <p className="text-[10px] text-muted-foreground mt-1 max-w-md">
                      Tap <span className="text-foreground font-medium">Add leg</span> on value cards — your slip shows
                      here. Open Parlay builder to auto-build, rebalance, or copy a share summary.
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {edgeTab === "value" ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="touch-manipulation min-h-10 sm:min-h-9 gap-1"
                      onClick={() => setEdgeTab("parlay")}
                    >
                      <Wrench className="w-3.5 h-3.5" />
                      Parlay builder
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="touch-manipulation min-h-10 sm:min-h-9"
                    onClick={clearValueBuilder}
                    disabled={!builderLegs.length}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Clear legs
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="touch-manipulation min-h-10 sm:min-h-9 gap-1"
                    onClick={copyParlayShare}
                    disabled={!builderLegs.length}
                  >
                    <Copy className="w-3.5 h-3.5" />
                    Copy summary
                  </Button>
                </div>
              </div>
              {builderLegs.length > 0 ? (
                <ul className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
                  {builderLegs.map((l) => (
                    <li
                      key={l.id}
                      className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-[11px]"
                    >
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground">{l.selectionLabel}</p>
                        <p className="text-muted-foreground tabular-nums">
                          {l.americanOdds > 0 ? `+${l.americanOdds}` : l.americanOdds} · edge {(l.edge * 100).toFixed(1)}%
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 shrink-0"
                        onClick={() => removeValueLeg(l.id)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  No legs yet — use Best Value (Add leg) or Parlay builder (Auto build).
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function EdgeCardPage() {
  return (
    <ValueParlayProvider>
      <EdgeCardPageInner />
    </ValueParlayProvider>
  );
}
