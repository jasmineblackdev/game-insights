import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { GamePrediction, League, GameDate } from "@/data/mockGames";
import { fetchDraftPicks } from "@/data/draftPicks";
import { GamePredictionCard } from "@/components/GamePredictionCard";
import { PlayerEdgeSection } from "@/components/PlayerEdgeSection";
import { GameDetailView } from "@/components/GameDetailView";
import { DraftPickCard } from "@/components/DraftPickCard";
import { DraftEdgeSection } from "@/components/DraftEdgeSection";
import { UnitSizeCalculator } from "@/components/UnitSizeCalculator";
import { ClipboardList, Sparkles, TrendingUp, Trophy, Tv2, User, Zap } from "lucide-react";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { easternYmd, fetchNbaGamePredictions, fetchNbaGamesFast } from "@/lib/nbaEspn";
import { fetchNflGamePredictions } from "@/lib/nflEspn";
import { fetchMlbEnrichedGames, fetchMlbGamesFast } from "@/lib/mlbEspn";
import { applyMlbPredictionModel } from "@/lib/mlbPredictionModel";
import { mergeMlbStarterConfirmations } from "@/lib/mlbStarterConfirm";
import { fetchBoxingPredictions } from "@/lib/boxingFetch";
import { fetchMmaPredictions } from "@/lib/mmaFetch";
import { cn } from "@/lib/utils";
import { enrichGamesWithBettingIntelligence } from "@/lib/bettingIntelligence";
import { fetchAllOddsBundles, type GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import { ParlayEdgeSection } from "@/components/ParlayEdgeSection";
import { CollegeFuturesSection } from "@/components/collegeFutures/CollegeFuturesSection";

type ViewMode = "games" | "props" | "draft" | "college_futures" | "parlay_edge";

function DataSourceStatus() {
  // Supabase health: just verify the connection is live, don't require specific tables
  const health = useQuery({
    queryKey: ["supabase", "health", "v2"],
    queryFn: async () => {
      if (!supabase) throw new Error("Supabase client not configured");
      const { error } = await supabase.from("boxing_fights").select("fight_id").limit(1);
      if (error && error.code !== "42P01" && !error.message?.includes("does not exist")) throw error;
      return true;
    },
    enabled: !!supabase,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 1,
    // Delay health check so it doesn't compete with the primary ESPN fetch on cold load
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  if (health.isPending) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-pulse" />
        Connecting…
      </div>
    );
  }
  if (health.isError) {
    return (
      <span className="text-xs text-muted-foreground" title="ESPN data active; Supabase optional">
        ESPN Live
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="w-2 h-2 rounded-full bg-confidence-high animate-pulse-glow" />
      Live data
    </div>
  );
}

function LeaguePicker({
  value,
  onChange,
  className,
}: {
  value: League;
  onChange: (l: League) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex items-center rounded-full bg-muted p-0.5 gap-0.5 shrink-0", className)}>
      {(["nba", "nfl", "mlb", "boxing", "mma"] as League[]).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => onChange(l)}
          className={cn(
            "min-h-10 sm:min-h-9 min-w-[2.75rem] px-3 py-2 sm:py-1 rounded-full text-xs font-bold tracking-wider transition-colors touch-manipulation",
            value === l
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground active:bg-muted"
          )}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function DatePicker({
  value,
  onChange,
  todayLabel,
  tomorrowLabel,
  weekLabel,
  className,
}: {
  value: GameDate;
  onChange: (d: GameDate) => void;
  todayLabel: string;
  tomorrowLabel: string;
  /** EPL: fixtures in the next 7 days (sparse schedule). */
  weekLabel?: string;
  className?: string;
}) {
  const tabs = [
    ["today", todayLabel],
    ["tomorrow", tomorrowLabel],
    ...(weekLabel ? [["week", weekLabel] as const] : []),
  ] as [GameDate, string][];
  return (
    <div className={cn("inline-flex items-center gap-1 rounded-full bg-muted p-0.5 flex-wrap shrink-0", className)}>
      {tabs.map(([d, label]) => (
        <button
          key={d}
          type="button"
          onClick={() => onChange(d)}
          className={cn(
            "min-h-10 sm:min-h-9 px-3 py-2 sm:py-1 rounded-full text-left text-xs font-semibold transition-colors touch-manipulation max-sm:whitespace-nowrap",
            value === d
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground active:bg-muted"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function leagueLabel(league: League): string {
  return league.toUpperCase();
}

const Index = () => {
  const [selectedGame, setSelectedGame] = useState<GamePrediction | null>(null);
  const [league, setLeague] = useState<League>("nba");
  const [dateFilter, setDateFilter] = useState<GameDate>("today");
  const [viewMode, setViewMode] = useState<ViewMode>("games");
  const [mlbConfirmTick, setMlbConfirmTick] = useState(0);

  // Phase 1: ESPN-only — shows cards in ~200ms
  const nbaFastQuery = useQuery({
    queryKey: ["nba-espn-fast", easternYmd()],
    queryFn: fetchNbaGamesFast,
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  // Phase 2: Full enrichment (odds + Supabase intelligence) — updates cards after fast load
  const nbaQuery = useQuery({
    queryKey: ["nba-espn-scoreboard", easternYmd()],
    queryFn: fetchNbaGamePredictions,
    enabled: nbaFastQuery.isSuccess,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
    refetchIntervalInBackground: false,
  });

  // NFL is offseason Apr–Aug — only fetch when the user explicitly selects it
  const nflQuery = useQuery({
    queryKey: ["nfl-espn-scoreboard", easternYmd()],
    queryFn: fetchNflGamePredictions,
    enabled: league === "nfl",
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: league === "nfl" ? 2 * 60 * 1000 : false,
    refetchIntervalInBackground: false,
  });

  // Phase 1: ESPN + probables only — fast MLB card render
  const mlbFastQuery = useQuery({
    queryKey: ["mlb-espn-fast", easternYmd()],
    queryFn: fetchMlbGamesFast,
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  const mlbBaseQuery = useQuery({
    queryKey: ["mlb-espn-enriched", easternYmd()],
    queryFn: fetchMlbEnrichedGames,
    enabled: mlbFastQuery.isSuccess,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
    refetchIntervalInBackground: false,
  });

  const mlbModeledQuery = useQuery({
    queryKey: ["mlb-modeled", mlbBaseQuery.dataUpdatedAt, mlbConfirmTick],
    queryFn: () => applyMlbPredictionModel(mergeMlbStarterConfirmations(mlbBaseQuery.data ?? [])),
    enabled: mlbBaseQuery.isSuccess,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });

  // Combat sports: only fetch when selected — these hit The Odds API (rate-limited)
  const boxingQuery = useQuery({
    queryKey: ["boxing-predictions"],
    queryFn: fetchBoxingPredictions,
    enabled: league === "boxing",
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    refetchInterval: league === "boxing" ? 5 * 60 * 1000 : false,
    refetchIntervalInBackground: false,
  });

  const mmaQuery = useQuery({
    queryKey: ["mma-predictions"],
    queryFn: fetchMmaPredictions,
    enabled: league === "mma",
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    refetchInterval: league === "mma" ? 5 * 60 * 1000 : false,
    refetchIntervalInBackground: false,
  });

  // Show fast (ESPN-only) data immediately; upgrade to enriched when ready
  const nbaGames = nbaQuery.data ?? nbaFastQuery.data ?? [];
  const mlbGames = mlbModeledQuery.data ?? mlbFastQuery.data ?? [];

  const mlbListPending = mlbFastQuery.isPending;
  const activeQuery =
    league === "nba"
      ? { isPending: nbaFastQuery.isPending, isError: nbaQuery.isError && nbaFastQuery.isError, error: nbaQuery.error }
      : league === "nfl"
        ? nflQuery
        : league === "mlb"
          ? {
              isPending: mlbListPending,
              isError: mlbBaseQuery.isError || mlbModeledQuery.isError,
              error: mlbBaseQuery.error ?? mlbModeledQuery.error,
            }
          : league === "mma"
            ? mmaQuery
            : boxingQuery;
  const leagueGames =
    league === "nba"
      ? nbaGames
      : league === "nfl"
        ? (nflQuery.data ?? [])
        : league === "mlb"
          ? mlbGames
          : league === "mma"
            ? (mmaQuery.data ?? [])
            : (boxingQuery.data ?? []);

  const gameIdsKey = useMemo(() => leagueGames.map((g) => g.id).sort().join(","), [leagueGames]);

  // All-sport pool for Parlay Edge (cross-sport candidates need every league loaded)
  const allGames = useMemo<GamePrediction[]>(
    () => [
      ...nbaGames,
      ...(nflQuery.data ?? []),
      ...mlbGames,
      ...(boxingQuery.data ?? []),
      ...(mmaQuery.data ?? []),
    ],
    [nbaGames, nflQuery.data, mlbGames, boxingQuery.data, mmaQuery.data]
  );

  const [oddsMapHome, setOddsMapHome] = useState<Map<string, GameOddsBundle>>(() => new Map());

  useEffect(() => {
    if (!leagueGames.length) {
      setOddsMapHome(new Map());
      return;
    }
    let cancelled = false;
    fetchAllOddsBundles(leagueGames).then((m) => {
      if (!cancelled) setOddsMapHome(m);
    });
    return () => {
      cancelled = true;
    };
  }, [gameIdsKey, league]);

  // Odds map for the full all-sport pool (used by Parlay Edge)
  const allGamesKey = useMemo(() => allGames.map((g) => g.id).sort().join(","), [allGames]);
  const [oddsMapAll, setOddsMapAll] = useState<Map<string, GameOddsBundle>>(() => new Map());
  useEffect(() => {
    if (viewMode !== "parlay_edge" || !allGames.length) return;
    let cancelled = false;
    fetchAllOddsBundles(allGames).then((m) => {
      if (!cancelled) setOddsMapAll(m);
    });
    return () => { cancelled = true; };
  }, [allGamesKey, viewMode]);

  const leagueGamesWithIntel = useMemo(
    () => enrichGamesWithBettingIntelligence(leagueGames, oddsMapHome),
    [leagueGames, oddsMapHome]
  );

  useEffect(() => {
    if (!selectedGame || selectedGame.league !== "mlb") return;
    const next = leagueGamesWithIntel.find((g) => g.id === selectedGame.id);
    if (!next) return;
    if (
      next.winProbability.home !== selectedGame.winProbability.home ||
      next.confidence !== selectedGame.confidence ||
      next.mlb?.modelOutput?.pendingConfirmation !== selectedGame.mlb?.modelOutput?.pendingConfirmation ||
      next.mlb?.modelOutput?.riskFlag !== selectedGame.mlb?.modelOutput?.riskFlag
    ) {
      setSelectedGame(next);
    }
  }, [leagueGamesWithIntel, selectedGame]);

  useEffect(() => {
    if (!selectedGame) return;
    const next = leagueGamesWithIntel.find((g) => g.id === selectedGame.id);
    if (!next) return;
    const oe = selectedGame._meta?.bettingIntel?.edge;
    const ne = next._meta?.bettingIntel?.edge;
    if (oe !== ne || selectedGame.lastUpdated !== next.lastUpdated) {
      setSelectedGame(next);
    }
  }, [leagueGamesWithIntel, selectedGame]);

  // Auto-advance to "week" if no today fights exist (non-fight nights)
  useEffect(() => {
    const isCombat = league === "mma" || league === "boxing";
    if (!isCombat) return;
    if (activeQuery.isPending) return;
    if (dateFilter !== "today") return;
    if (leagueGamesWithIntel.length === 0) return;
    const hasToday = leagueGamesWithIntel.some((g) => g.gameDate === "today");
    if (!hasToday) setDateFilter("week");
  }, [league, leagueGamesWithIntel, dateFilter, activeQuery.isPending]);

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayLabel = `Today · ${formatDate(today)}`;
  const tomorrowLabel = `Tomorrow · ${formatDate(tomorrow)}`;

  const filteredGames = leagueGamesWithIntel.filter((g) => g.gameDate === dateFilter);

  const highConfCount = filteredGames.filter((g) => g.confidence === "high").length;

  const draftPicksQuery = useQuery({
    queryKey: ["draft-picks", league],
    queryFn: () => fetchDraftPicks(league),
    staleTime: 60 * 60 * 1000, // draft boards don't change minute to minute
    enabled: viewMode === "draft",
  });
  const draftPicks = draftPicksQuery.data ?? [];

  const handleLeagueChange = (l: League) => {
    setLeague(l);
    setSelectedGame(null);
    const isCombat = l === "boxing" || l === "mma";
    const wasCombat = league === "boxing" || league === "mma";
    if (isCombat) {
      // Start on "today" — tonight's card shows as gameDate="today".
      // A useEffect below advances to "week" automatically if no today fights load.
      setDateFilter("today");
    } else if (wasCombat || dateFilter === "week") {
      setDateFilter("today");
    }
  };

  const handleViewModeChange = (m: ViewMode) => {
    setViewMode(m);
    setSelectedGame(null);
  };

  const handleDateChange = (d: GameDate) => {
    setDateFilter(d);
    setSelectedGame(null);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border surface-glass sticky top-0 z-50 pt-[env(safe-area-inset-top)]">
        <div className="container max-w-6xl mx-auto py-3 sm:py-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <img
              src="/GameLens_logo.png"
              alt="GameLens"
              className="h-9 w-auto max-w-[7.25rem] sm:max-w-none sm:h-11 sm:w-[7.75rem] shrink-0 object-contain object-left"
            />
            <div className="flex items-center gap-2 shrink-0">
              <div className="sm:hidden flex items-center gap-1.5">
                <UnitSizeCalculator variant="compact" className="h-10 w-10 shrink-0 touch-manipulation" />
              </div>
              <div className="hidden sm:flex items-center gap-2">
                <UnitSizeCalculator variant="compact" className="h-9 w-9" />
                <DataSourceStatus />
                <LeaguePicker value={league} onChange={handleLeagueChange} />
              </div>
            </div>
          </div>
          <div className="sm:hidden space-y-2">
            <div className="overflow-x-auto -mx-1 px-1 pb-0.5 [scrollbar-width:thin]">
              <LeaguePicker value={league} onChange={handleLeagueChange} />
            </div>
            <DataSourceStatus />
          </div>
        </div>
      </header>

      <main className="container max-w-6xl mx-auto py-4 sm:py-6">
        <AnimatePresence mode="wait">
          {selectedGame ? (
            <GameDetailView
              key="detail"
              game={selectedGame}
              onBack={() => setSelectedGame(null)}
              onMlbStartersConfirmChange={() => setMlbConfirmTick((n) => n + 1)}
            />
          ) : (
            <motion.div
              key={`list-${league}-${viewMode}-${dateFilter}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {/* Hero */}
              <div className="mb-6">
                <motion.h2
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="font-display font-bold text-2xl sm:text-3xl md:text-4xl text-foreground mb-2 break-words"
                >
                  {viewMode === "parlay_edge" ? (
                    <>
                      Parlay <span className="text-gradient-primary">Edge</span>
                    </>
                  ) : viewMode === "college_futures" ? (
                    <>
                      College <span className="text-gradient-primary">Futures</span>
                    </>
                  ) : viewMode === "draft" ? (
                    <>
                      {leagueLabel(league)}{" "}
                      <span className="text-gradient-primary">Draft Edge</span>
                    </>
                  ) : viewMode === "props" ? (
                    <>Player <span className="text-gradient-primary">Props</span></>
                  ) : (
                    <>
                      {dateFilter === "today"
                        ? "Today's"
                        : dateFilter === "tomorrow"
                          ? "Tomorrow's"
                          : "Next 7 days · "}{" "}
                      <span className="text-gradient-primary">Predictions</span>
                    </>
                  )}
                </motion.h2>
                <motion.p
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="text-sm text-muted-foreground max-w-lg leading-relaxed"
                >
                  {viewMode === "parlay_edge" ? (
                    <>
                      AI-built parlays ranked by edge, confidence, and risk tier. Safe 3-leg, Balanced 4-leg, and Aggressive 6-leg cards generated automatically. Learns which sport mixes and market combos perform best over time.
                    </>
                  ) : viewMode === "college_futures" ? (
                    <>
                      Championship futures markets for college football, basketball, and baseball — conference winners, national champions, and award props. Powered by The Odds API.
                    </>
                  ) : viewMode === "draft" ? (
                    <>
                      AI-style outcomes: probability ranges, team fit, positional value, and prop-style cards (O/U, round /
                      window moves, team needs). Add any card to your Edge Card — separate from game markets.
                      {draftPicks.length > 0 ? (
                        <>
                          {" "}
                          Expand <span className="text-foreground/80">Classic pick-by-pick board</span> below for grades and
                          scouting blurbs.
                        </>
                      ) : null}
                    </>
                  ) : viewMode === "props" ? (
                    <>Player prop edges across NBA, NFL, and MLB — filter by sport and stat type.</>
                  ) : league === "nba" ? (
                    <>Live NBA predictions — win probability, spread lean, injuries, and team trends.</>
                  ) : league === "nfl" ? (
                    <>Live NFL predictions — win probability, spread lean, injuries, weather, and team trends.</>
                  ) : league === "mlb" ? (
                    <>Live MLB predictions — probable starters, runline lean, and lineup trends. Confidence adjusts when pitchers are unconfirmed.</>
                  ) : league === "boxing" ? (
                    <>Boxing fight predictions — fighter profiles, reach/age/style edges, and method of victory probabilities. Data from The Odds API; richer model when fighter DB is populated.</>
                  ) : league === "mma" ? (
                    <>UFC/MMA fight predictions — style matchup, grappling vs striking edge, method of victory. Data from The Odds API; richer model when fighter DB is populated.</>
                  ) : (
                    <>Fight predictions — fighter profiles and method of victory probabilities.</>
                  )}
                </motion.p>

                {/* Quick stats */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6 mt-4"
                >
                  {viewMode === "college_futures" ? (
                    <>
                      <div className="flex items-center gap-2 text-xs">
                        <Trophy className="w-3.5 h-3.5 text-confidence-high" />
                        <span className="text-muted-foreground">Markets:</span>
                        <span className="text-confidence-high font-semibold">Champion (V1)</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <Zap className="w-3.5 h-3.5 text-primary" />
                        <span className="text-muted-foreground">Sports:</span>
                        <span className="text-primary font-semibold">CFB · CBB · CWS</span>
                      </div>
                    </>
                  ) : viewMode === "draft" ? (
                    <>
                      <div className="flex items-center gap-2 text-xs">
                        <TrendingUp className="w-3.5 h-3.5 text-confidence-high" />
                        <span className="text-muted-foreground">Projected picks:</span>
                        <span className="text-confidence-high font-semibold">{draftPicks.length}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <Zap className="w-3.5 h-3.5 text-primary" />
                        <span className="text-muted-foreground">A-grade picks:</span>
                        <span className="text-primary font-semibold">
                          {draftPicks.filter((p) => p.grade.startsWith("A")).length} of {draftPicks.length}
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 text-xs">
                        <TrendingUp className="w-3.5 h-3.5 text-confidence-high" />
                        <span className="text-muted-foreground">
                          {(league === "boxing" || league === "mma") ? "Fights loaded (14d):" : "Games loaded:"}
                        </span>
                        <span className="text-confidence-high font-semibold">
                          {leagueGames.length}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <Zap className="w-3.5 h-3.5 text-primary" />
                        <span className="text-muted-foreground">
                          {(league === "boxing" || league === "mma") ? "High conf picks:" : "High conf (spread lean):"}
                        </span>
                        <span className="text-primary font-semibold">
                          {highConfCount} of {filteredGames.length}
                        </span>
                      </div>
                    </>
                  )}
                </motion.div>
              </div>

              {/* View mode toggle */}
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center mb-5">
                <div className="overflow-x-auto -mx-1 px-1 pb-0.5 sm:overflow-visible sm:pb-0 [scrollbar-width:thin]">
                  <div className="inline-flex items-center rounded-full bg-muted p-0.5 gap-0.5">
                    <button
                      type="button"
                      onClick={() => handleViewModeChange("games")}
                      className={cn(
                        "flex items-center gap-1.5 min-h-10 px-3 py-2 sm:py-1.5 rounded-full text-xs font-semibold transition-colors touch-manipulation shrink-0",
                        viewMode === "games"
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground active:bg-muted"
                      )}
                    >
                      <Tv2 className="w-3 h-3 shrink-0" />
                      Games
                    </button>
                    <button
                      type="button"
                      onClick={() => handleViewModeChange("props")}
                      className={cn(
                        "flex items-center gap-1.5 min-h-10 px-3 py-2 sm:py-1.5 rounded-full text-xs font-semibold transition-colors touch-manipulation shrink-0",
                        viewMode === "props"
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground active:bg-muted"
                      )}
                    >
                      <User className="w-3 h-3 shrink-0" />
                      Props
                    </button>
                    <button
                      type="button"
                      onClick={() => handleViewModeChange("draft")}
                      className={cn(
                        "flex items-center gap-1.5 min-h-10 px-3 py-2 sm:py-1.5 rounded-full text-xs font-semibold transition-colors touch-manipulation shrink-0",
                        viewMode === "draft"
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground active:bg-muted"
                      )}
                    >
                      <ClipboardList className="w-3 h-3 shrink-0" />
                      Draft
                    </button>
                    <button
                      type="button"
                      onClick={() => handleViewModeChange("college_futures")}
                      className={cn(
                        "flex items-center gap-1.5 min-h-10 px-3 py-2 sm:py-1.5 rounded-full text-xs font-semibold transition-colors touch-manipulation shrink-0",
                        viewMode === "college_futures"
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground active:bg-muted"
                      )}
                    >
                      <Trophy className="w-3 h-3 shrink-0" />
                      College futures
                    </button>
                    <button
                      type="button"
                      onClick={() => handleViewModeChange("parlay_edge")}
                      className={cn(
                        "flex items-center gap-1.5 min-h-10 px-3 py-2 sm:py-1.5 rounded-full text-xs font-semibold transition-colors touch-manipulation shrink-0",
                        viewMode === "parlay_edge"
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground active:bg-muted"
                      )}
                    >
                      <Sparkles className="w-3 h-3 shrink-0" />
                      Parlay Edge
                    </button>
                  </div>
                </div>

                {/* Date switcher only visible in Games mode.
                    Combat sports show "Next 14 days" as the third option
                    since fights rarely fall on exact today/tomorrow dates. */}
                {viewMode === "games" && (
                  <div className="overflow-x-auto -mx-1 px-1 pb-0.5 sm:overflow-visible [scrollbar-width:thin] min-w-0 w-full sm:w-auto">
                    <DatePicker
                      value={dateFilter}
                      onChange={handleDateChange}
                      todayLabel={todayLabel}
                      tomorrowLabel={tomorrowLabel}
                      weekLabel={
                        league === "boxing" || league === "mma"
                          ? "Next 14 days"
                          : undefined
                      }
                    />
                  </div>
                )}
              </div>

              {/* Content */}
              {viewMode === "parlay_edge" ? (
                <ParlayEdgeSection allGames={allGames} oddsMap={oddsMapAll} currentLeague={league} />
              ) : viewMode === "college_futures" ? (
                <CollegeFuturesSection />
              ) : viewMode === "props" ? (
                <PlayerEdgeSection />
              ) : viewMode === "draft" ? (
                <div className="space-y-10">
                  <DraftEdgeSection league={league} />
                  {draftPicks.length > 0 ? (
                    <details className="rounded-lg border border-border bg-card/40 px-4 py-3 group">
                      <summary className="cursor-pointer text-sm font-semibold text-foreground list-none flex items-center justify-between">
                        <span>Classic pick-by-pick board</span>
                        <span className="text-xs text-muted-foreground group-open:hidden">Expand</span>
                      </summary>
                      <p className="text-xs text-muted-foreground mt-2 mb-4">
                        Live prospect rankings from ESPN — grades derived from consensus board position.
                      </p>
                      <div className="space-y-3 pb-2">
                        {draftPicks.map((pick, i) => (
                          <DraftPickCard key={`${pick.league}-${pick.pickNumber}`} pick={pick} index={i} />
                        ))}
                      </div>
                    </details>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-6 rounded-lg border border-border bg-card/40">
                      No classic pick list for {leagueLabel(league)} in this build — Draft Edge cards above cover window /
                      draft intelligence. Use Games for live fixtures.
                    </p>
                  )}
                </div>
              ) : activeQuery.isPending ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="rounded-lg border border-border bg-card h-64 animate-pulse bg-muted/30"
                    />
                  ))}
                </div>
              ) : activeQuery.isError ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive space-y-1">
                  {(league === "boxing" || league === "mma") ? (
                    <>
                      <p className="font-semibold">Could not load {leagueLabel(league)} fight data.</p>
                      <p className="text-destructive/80">
                        {activeQuery.error instanceof Error && activeQuery.error.message.includes("quota")
                          ? "The Odds API monthly quota is exhausted. Get a new API key at the-odds-api.com and update it via: npx supabase secrets set THE_ODDS_API_KEY=your_key"
                          : "Check your Odds API key or network connection."
                        }
                      </p>
                    </>
                  ) : (
                    `Could not load ESPN ${leagueLabel(league)} data (${activeQuery.error instanceof Error ? activeQuery.error.message : "unknown error"}). Check your network.`
                  )}
                </div>
              ) : filteredGames.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {filteredGames.map((game, i) => (
                    <GamePredictionCard
                      key={game.id}
                      game={game}
                      index={i}
                      onSelect={setSelectedGame}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                  <div className="text-4xl mb-3">
                    {league === "nfl" ? "🏈" : league === "mlb" ? "⚾" : league === "boxing" ? "🥊" : league === "mma" ? "🥋" : "📭"}
                  </div>
                  <p className="text-muted-foreground text-sm max-w-md">
                    {league === "boxing"
                      ? dateFilter === "today"
                        ? "No boxing fights scheduled for today. Most fights are on weekends — try Tomorrow or the date tabs."
                        : dateFilter === "tomorrow"
                          ? "No boxing fights scheduled for tomorrow. Try changing the date or check back closer to fight week."
                          : "No boxing fights in the next 14 days from The Odds API. Check back during active fight weeks."
                      : league === "mma"
                        ? dateFilter === "today"
                          ? "No UFC/MMA fights scheduled for today. Events typically run on Saturday nights — try Tomorrow or the date tabs."
                          : dateFilter === "tomorrow"
                            ? "No UFC/MMA fights scheduled for tomorrow. Try changing the date or check back during UFC fight week."
                            : "No UFC/MMA fights in the next 14 days from The Odds API. Check back closer to the next event."
                        : `No ${leagueLabel(league)} games on the ESPN board for ${dateFilter === "today" ? "today" : "tomorrow"} (US Eastern). Off-days and offseason slates are normal — try the other day tab.`
                    }
                  </p>
                  {(league === "boxing" || league === "mma") && leagueGames.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-2 opacity-70">
                      {leagueGames.length} fight{leagueGames.length !== 1 ? "s" : ""} loaded — switch date tabs to find them.
                    </p>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};

export default Index;
