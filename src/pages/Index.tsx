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
import { ClipboardList, Layers, TrendingUp, Tv2, Zap } from "lucide-react";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { easternYmd, fetchNbaGamePredictions } from "@/lib/nbaEspn";
import { fetchNflGamePredictions } from "@/lib/nflEspn";
import { fetchMlbGamePredictions } from "@/lib/mlbEspn";
import { fetchSoccerGamePredictions } from "@/lib/soccerEspn";

type ViewMode = "games" | "draft";

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

function LeaguePicker({ value, onChange }: { value: League; onChange: (l: League) => void }) {
  return (
    <div className="flex items-center rounded-full bg-muted p-0.5 gap-0.5">
      {(["nba", "nfl", "mlb", "soccer"] as League[]).map((l) => (
        <button
          key={l}
          onClick={() => onChange(l)}
          className={`px-3 py-1 rounded-full text-xs font-bold tracking-wider transition-colors ${
            value === l
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
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
}: {
  value: GameDate;
  onChange: (d: GameDate) => void;
  todayLabel: string;
  tomorrowLabel: string;
  /** EPL: fixtures in the next 7 days (sparse schedule). */
  weekLabel?: string;
}) {
  const tabs = [
    ["today", todayLabel],
    ["tomorrow", tomorrowLabel],
    ...(weekLabel ? [["week", weekLabel] as const] : []),
  ] as [GameDate, string][];
  return (
    <div className="flex items-center gap-1 rounded-full bg-muted p-0.5 flex-wrap">
      {tabs.map(([d, label]) => (
        <button
          key={d}
          onClick={() => onChange(d)}
          className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
            value === d
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
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
      <header className="border-b border-border surface-glass sticky top-0 z-50">
        <div className="container max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/GameLens_logo.png" alt="GameLens" className="w-8 h-8 rounded-lg shrink-0 object-contain" />
            <div className="hidden sm:block">
              <h1 className="font-display font-bold text-base text-foreground tracking-tight">
                GameLens
              </h1>
              <p className="text-[11px] text-muted-foreground">AI-powered matchup intelligence</p>
            </div>
            <span className="sm:hidden font-display font-bold text-base text-foreground tracking-tight">GameLens</span>
            <Link
              to="/edge"
              className="sm:hidden inline-flex items-center justify-center w-8 h-8 rounded-lg border border-border bg-card text-primary shrink-0"
              aria-label="Edge Card"
            >
              <Layers className="w-4 h-4" />
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/edge"
              className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-foreground hover:border-primary/40 hover:bg-primary/5 transition-colors"
            >
              <Layers className="w-3.5 h-3.5 text-primary" />
              Edge Card
            </Link>
            <div className="hidden sm:block">
              <DataSourceStatus />
            </div>
            <LeaguePicker value={league} onChange={handleLeagueChange} />
          </div>
        </div>
      </header>

      <main className="container max-w-6xl mx-auto px-4 py-6">
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
                  className="font-display font-bold text-3xl md:text-4xl text-foreground mb-2"
                >
                  {viewMode === "draft" ? (
                    <>{leagueLabel(league)} <span className="text-gradient-primary">Draft Picks</span></>
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
                  className="text-sm text-muted-foreground max-w-lg"
                >
                  {viewMode === "draft" ? (
                    <>
                      Projected {leagueLabel(league)} Draft order with grades, scouting analysis, and pro comparables.
                      Click any pick to expand the full breakdown.
                    </>
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
                  className="flex items-center gap-6 mt-4"
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
              <div className="flex items-center gap-3 mb-5">
                <div className="flex items-center rounded-full bg-muted p-0.5 gap-0.5">
                  <button
                    onClick={() => handleViewModeChange("games")}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                      viewMode === "games"
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Tv2 className="w-3 h-3" />
                    Games
                  </button>
                  <button
                    onClick={() => handleViewModeChange("draft")}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                      viewMode === "draft"
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <ClipboardList className="w-3 h-3" />
                    Draft
                  </button>
                </div>

                {/* Date switcher only visible in Games mode */}
                {viewMode === "games" && (
                  <DatePicker
                    value={dateFilter}
                    onChange={handleDateChange}
                    todayLabel={todayLabel}
                    tomorrowLabel={tomorrowLabel}
                    weekLabel={league === "soccer" ? "Next 7 days" : undefined}
                  />
                )}
              </div>

              {/* Content */}
              {viewMode === "draft" ? (
                draftPicks.length === 0 ? (
                  <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                    {league === "soccer"
                      ? "No draft board for soccer in this app — use the Games tab for EPL 1X2 and matchup intel."
                      : "No mock MLB draft board in this build — wire SportsDataIO / your rankings when ready."}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {draftPicks.map((pick, i) => (
                      <DraftPickCard key={`${pick.league}-${pick.pickNumber}`} pick={pick} index={i} />
                    ))}
                  </div>
                )
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
              {viewMode === "games" ? <PlayerEdgeSection /> : null}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};

export default Index;
