import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { GamePrediction, League, GameDate } from "@/data/mockGames";
import { GamePredictionCard } from "@/components/GamePredictionCard";
import { GameDetailView } from "@/components/GameDetailView";
import { Activity, TrendingUp, Zap } from "lucide-react";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { easternYmd, fetchNbaGamePredictions } from "@/lib/nbaEspn";
import { fetchNflGamePredictions } from "@/lib/nflEspn";

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
        ESPN NBA · NFL
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
      {(["nba", "nfl"] as League[]).map((l) => (
        <button
          key={l}
          onClick={() => onChange(l)}
          className={`px-3 py-1 rounded-full text-xs font-bold tracking-wider transition-colors ${
            value === l
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function DatePicker({ value, onChange, todayLabel, tomorrowLabel }: {
  value: GameDate;
  onChange: (d: GameDate) => void;
  todayLabel: string;
  tomorrowLabel: string;
}) {
  return (
    <div className="flex items-center gap-1 rounded-full bg-muted p-0.5">
      {([["today", todayLabel], ["tomorrow", tomorrowLabel]] as [GameDate, string][]).map(([d, label]) => (
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

const Index = () => {
  const [selectedGame, setSelectedGame] = useState<GamePrediction | null>(null);
  const [league, setLeague] = useState<League>("nba");
  const [dateFilter, setDateFilter] = useState<GameDate>("today");

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

  const activeQuery = league === "nba" ? nbaQuery : nflQuery;
  const leagueGames = league === "nba" ? (nbaQuery.data ?? []) : (nflQuery.data ?? []);

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayLabel = `Today · ${formatDate(today)}`;
  const tomorrowLabel = `Tomorrow · ${formatDate(tomorrow)}`;

  const filteredGames = leagueGames.filter((g) => g.gameDate === dateFilter);

  const highConfCount = filteredGames.filter((g) => g.confidence === "high").length;

  const handleLeagueChange = (l: League) => {
    setLeague(l);
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
            <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
              <Activity className="w-4.5 h-4.5 text-primary" />
            </div>
            <div>
              <h1 className="font-display font-bold text-base text-foreground tracking-tight">
                GameLens
              </h1>
              <p className="text-[11px] text-muted-foreground">AI-powered matchup intelligence</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <DataSourceStatus />
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
              key={`list-${league}-${dateFilter}`}
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
                  {dateFilter === "today" ? "Today's" : "Tomorrow's"}{" "}
                  <span className="text-gradient-primary">Predictions</span>
                </motion.h2>
                <motion.p
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="text-sm text-muted-foreground max-w-lg"
                >
                  {league === "nba" ? (
                    <>
                      Live NBA schedule, team records, and win probabilities from DraftKings moneylines on ESPN
                      (de-vigged). Team ratings are a record-based estimate until your model runs on Supabase.
                    </>
                  ) : (
                    <>
                      Live NFL schedule from ESPN: records, scores, and lines when ESPN exposes them. Yards / points
                      allowed / plays per game are estimates from record — swap in SportsDataIO team stats when ready.
                    </>
                  )}
                </motion.p>

                {/* Quick stats */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="flex items-center gap-6 mt-4"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <TrendingUp className="w-3.5 h-3.5 text-confidence-high" />
                    <span className="text-muted-foreground">Games loaded:</span>
                    <span className="text-confidence-high font-semibold">{leagueGames.length}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <Zap className="w-3.5 h-3.5 text-primary" />
                    <span className="text-muted-foreground">High conf (spread lean):</span>
                    <span className="text-primary font-semibold">
                      {highConfCount} of {filteredGames.length}
                    </span>
                  </div>
                </motion.div>
              </div>

              {/* Date switcher */}
              <div className="mb-5">
                <DatePicker
                  value={dateFilter}
                  onChange={handleDateChange}
                  todayLabel={todayLabel}
                  tomorrowLabel={tomorrowLabel}
                />
              </div>

              {/* Games Grid */}
              {activeQuery.isPending ? (
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
                  Could not load ESPN {league.toUpperCase()} data (
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
                  <div className="text-4xl mb-3">{league === "nfl" ? "🏈" : "📭"}</div>
                  <p className="text-muted-foreground text-sm max-w-md">
                    No {league.toUpperCase()} games on the ESPN board for{" "}
                    {dateFilter === "today" ? "today" : "tomorrow"} (US Eastern). During the NFL offseason this is normal;
                    try the other day tab or check back on game days.
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
