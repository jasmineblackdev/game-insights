import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { GamePrediction, League, GameDate } from "@/data/mockGames";
import { getDraftPicks } from "@/data/draftPicks";
import { GamePredictionCard } from "@/components/GamePredictionCard";
import { PlayerEdgeSection } from "@/components/PlayerEdgeSection";
import { GameDetailView } from "@/components/GameDetailView";
import { DraftPickCard } from "@/components/DraftPickCard";
import { DraftEdgeSection } from "@/components/DraftEdgeSection";
import { UnitSizeCalculator } from "@/components/UnitSizeCalculator";
import { ClipboardList, Layers, TrendingUp, Tv2, User, Zap } from "lucide-react";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { easternYmd, fetchNbaGamePredictions } from "@/lib/nbaEspn";
import { fetchNflGamePredictions } from "@/lib/nflEspn";
import { fetchMlbGamePredictions } from "@/lib/mlbEspn";
import { fetchSoccerGamePredictions } from "@/lib/soccerEspn";
import { cn } from "@/lib/utils";

type ViewMode = "games" | "props" | "draft";

function DataSourceStatus() {
  const health = useQuery({
    queryKey: ["supabase", "health", "teams"],
    queryFn: async () => {
      if (!supabase) throw new Error("Supabase client not configured");
      const { error } = await supabase.from("teams").select("id").limit(1);
      if (error) throw error;
      return true;
    },
    enabled: isSupabaseConfigured && !!supabase,
    staleTime: 60_000,
    retry: 1,
  });

  if (!isSupabaseConfigured) {
    return (
      <span className="text-xs text-muted-foreground" title="Scores & lines load from ESPN; add Supabase for your own backend">
        ESPN NBA · NFL · MLB · Soccer
      </span>
    );
  }
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
      <span className="text-xs text-amber-600 dark:text-amber-500" title="Check .env.local and SQL migration">
        Backend error
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
      {(["nba", "nfl", "mlb", "soccer"] as League[]).map((l) => (
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
          {l === "soccer" ? "SOC" : l.toUpperCase()}
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
  return league === "soccer" ? "EPL" : league.toUpperCase();
}

const Index = () => {
  const [selectedGame, setSelectedGame] = useState<GamePrediction | null>(null);
  const [league, setLeague] = useState<League>("nba");
  const [dateFilter, setDateFilter] = useState<GameDate>("today");
  const [viewMode, setViewMode] = useState<ViewMode>("games");

  const nbaQuery = useQuery({
    queryKey: ["nba-espn-scoreboard", easternYmd()],
    queryFn: fetchNbaGamePredictions,
    staleTime: 2 * 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
  });

  const nflQuery = useQuery({
    queryKey: ["nfl-espn-scoreboard", easternYmd()],
    queryFn: fetchNflGamePredictions,
    staleTime: 2 * 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
  });

  const mlbQuery = useQuery({
    queryKey: ["mlb-espn-scoreboard", easternYmd()],
    queryFn: fetchMlbGamePredictions,
    staleTime: 2 * 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
  });

  const soccerQuery = useQuery({
    queryKey: ["soccer-espn-scoreboard", easternYmd()],
    queryFn: fetchSoccerGamePredictions,
    staleTime: 2 * 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
  });

  const activeQuery =
    league === "nba"
      ? nbaQuery
      : league === "nfl"
        ? nflQuery
        : league === "mlb"
          ? mlbQuery
          : soccerQuery;
  const leagueGames =
    league === "nba"
      ? (nbaQuery.data ?? [])
      : league === "nfl"
        ? (nflQuery.data ?? [])
        : league === "mlb"
          ? (mlbQuery.data ?? [])
          : (soccerQuery.data ?? []);

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayLabel = `Today · ${formatDate(today)}`;
  const tomorrowLabel = `Tomorrow · ${formatDate(tomorrow)}`;

  const filteredGames = leagueGames.filter((g) => g.gameDate === dateFilter);

  const highConfCount = filteredGames.filter((g) => g.confidence === "high").length;

  const draftPicks = getDraftPicks(league);

  const handleLeagueChange = (l: League) => {
    setLeague(l);
    setSelectedGame(null);
    if (l !== "soccer" && dateFilter === "week") setDateFilter("today");
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
                <Link
                  to="/edge"
                  className="inline-flex items-center justify-center min-h-10 min-w-10 rounded-lg border border-border bg-card text-primary touch-manipulation"
                  aria-label="Edge Card"
                >
                  <Layers className="w-4 h-4" />
                </Link>
              </div>
              <div className="hidden sm:flex items-center gap-2">
                <UnitSizeCalculator variant="compact" className="h-9 w-9" />
                <Link
                  to="/edge"
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-2 sm:py-1 text-xs font-semibold text-foreground hover:border-primary/40 hover:bg-primary/5 transition-colors touch-manipulation"
                >
                  <Layers className="w-3.5 h-3.5 text-primary" />
                  Edge Card
                </Link>
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
                  {viewMode === "draft" ? (
                    <>
                      {league === "soccer" ? "Soccer" : leagueLabel(league)}{" "}
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
                  {viewMode === "draft" ? (
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
                    <>Player prop edges across NBA, NFL, MLB, and Soccer — filter by sport and stat type.</>
                  ) : league === "nba" ? (
                    <>Live NBA predictions — win probability, spread lean, injuries, and team trends.</>
                  ) : league === "nfl" ? (
                    <>Live NFL predictions — win probability, spread lean, injuries, weather, and team trends.</>
                  ) : league === "mlb" ? (
                    <>Live MLB predictions — probable starters, runline lean, and lineup trends. Confidence adjusts when pitchers are unconfirmed.</>
                  ) : (
                    <>Premier League predictions — 1X2 win/draw/loss probability, fixture congestion, and goals data. EPL often has no fixtures today — try <span className="text-foreground/80">Next 7 days</span>.</>
                  )}
                </motion.p>

                {/* Quick stats */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6 mt-4"
                >
                  {viewMode === "draft" ? (
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
                          {league === "soccer" ? "In this tab:" : "Games loaded:"}
                        </span>
                        <span className="text-confidence-high font-semibold">
                          {league === "soccer" ? filteredGames.length : leagueGames.length}
                        </span>
                        {league === "soccer" && (
                          <span className="text-muted-foreground font-normal">
                            {" "}
                            ({leagueGames.length} in 7d fetch)
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <Zap className="w-3.5 h-3.5 text-primary" />
                        <span className="text-muted-foreground">
                          {league === "soccer" ? "High conf (rare for 1X2):" : "High conf (spread lean):"}
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
                  </div>
                </div>

                {/* Date switcher only visible in Games mode */}
                {viewMode === "games" && (
                  <div className="overflow-x-auto -mx-1 px-1 pb-0.5 sm:overflow-visible [scrollbar-width:thin] min-w-0 w-full sm:w-auto">
                    <DatePicker
                      value={dateFilter}
                      onChange={handleDateChange}
                      todayLabel={todayLabel}
                      tomorrowLabel={tomorrowLabel}
                      weekLabel={league === "soccer" ? "Next 7 days" : undefined}
                    />
                  </div>
                )}
              </div>

              {/* Content */}
              {viewMode === "props" ? (
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
                        Expandable rows — mock scouting blurbs, separate from Draft Edge cards above.
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
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
                  Could not load ESPN {leagueLabel(league)} data (
                  {activeQuery.error instanceof Error ? activeQuery.error.message : "unknown error"}). Check your network;
                  if the API blocks the browser, proxy through Supabase Edge Functions.
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
                    {league === "nfl" ? "🏈" : league === "mlb" ? "⚾" : league === "soccer" ? "⚽" : "📭"}
                  </div>
                  <p className="text-muted-foreground text-sm max-w-md">
                    {league === "soccer" && dateFilter === "week"
                      ? "No EPL fixtures in the next 7 days on the ESPN board (US Eastern). International breaks or between matchweeks can look like this."
                      : league === "soccer"
                        ? `No EPL games on the ESPN board for ${dateFilter === "today" ? "today" : "tomorrow"} (US Eastern). That’s normal — try Next 7 days for the nearest kickoffs.`
                        : `No ${leagueLabel(league)} games on the ESPN board for ${dateFilter === "today" ? "today" : "tomorrow"} (US Eastern). Off-days and offseason slates are normal — try the other day tab.`}
                  </p>
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
