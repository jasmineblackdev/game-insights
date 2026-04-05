import { motion, AnimatePresence } from "framer-motion";
import { GamePrediction } from "@/data/mockGames";
import { ConfidenceMeter } from "./ConfidenceMeter";
import { InjuryImpactMeter } from "./InjuryImpactMeter";
import { PlayerTrendCard } from "./PlayerTrendCard";
import { ArrowLeft, Zap, AlertTriangle, Target, Swords, Clock, RefreshCw } from "lucide-react";

interface GameDetailViewProps {
  game: GamePrediction;
  onBack: () => void;
}

export function GameDetailView({ game, onBack }: GameDetailViewProps) {
  const favored = game.winProbability.home >= game.winProbability.away ? "home" : "away";
  const favoredTeam = favored === "home" ? game.homeTeam : game.awayTeam;
  const favoredProb = favored === "home" ? game.winProbability.home : game.winProbability.away;

  const updatedAt = new Date(game.lastUpdated);
  const timeAgo = Math.round((Date.now() - updatedAt.getTime()) / 60000);

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3 }}
      className="space-y-4"
    >
      {/* Back + Header */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to games
      </button>

      {/* Matchup Header */}
      <div className="card-shine bg-card rounded-lg border border-border p-6">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{game.gameTime}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {game.situationalTags.map((tag) => (
              <span key={tag} className="text-[10px] font-semibold tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-6 justify-center py-4">
          <div className={`text-center ${favored === "away" ? "" : "opacity-50"}`}>
            <div className="text-4xl mb-2">{game.awayTeam.logo}</div>
            <div className="font-display font-bold text-lg text-foreground">{game.awayTeam.name}</div>
            <div className="text-sm text-muted-foreground">{game.awayTeam.record} · {game.awayTeam.recentForm}</div>
            <div className="text-2xl font-display font-bold mt-2 text-foreground">{game.winProbability.away}%</div>
          </div>

          <ConfidenceMeter level={game.confidence} probability={favoredProb} />

          <div className={`text-center ${favored === "home" ? "" : "opacity-50"}`}>
            <div className="text-4xl mb-2">{game.homeTeam.logo}</div>
            <div className="font-display font-bold text-lg text-foreground">{game.homeTeam.name}</div>
            <div className="text-sm text-muted-foreground">{game.homeTeam.record} · {game.homeTeam.recentForm}</div>
            <div className="text-2xl font-display font-bold mt-2 text-foreground">{game.winProbability.home}%</div>
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="w-3 h-3" />
          Updated {timeAgo > 0 ? `${timeAgo}m ago` : "just now"}
        </div>
      </div>

      {/* Two column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Reasons */}
        <div className="card-shine bg-card rounded-lg border border-border p-5">
          <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
            <Zap className="w-4 h-4 text-confidence-high" />
            Why {favoredTeam.abbreviation} is Favored
          </h3>
          <div className="space-y-2.5">
            {game.topReasons.map((reason, i) => (
              <div key={i} className="flex items-start gap-3 text-sm">
                <span className="text-confidence-high font-display font-bold text-xs mt-0.5">{i + 1}</span>
                <span className="text-secondary-foreground">{reason}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Risks */}
        <div className="card-shine bg-card rounded-lg border border-border p-5">
          <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4 text-risk" />
            Risk Factors
          </h3>
          <div className="space-y-2.5">
            {game.riskFactors.map((risk, i) => (
              <div key={i} className="flex items-start gap-3 text-sm">
                <span className="text-risk font-display font-bold text-xs mt-0.5">!</span>
                <span className="text-secondary-foreground">{risk}</span>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-border">
            <h4 className="text-xs font-semibold text-muted-foreground mb-1.5">UPSET PATH</h4>
            <p className="text-sm text-secondary-foreground">{game.upsetPath}</p>
          </div>
        </div>

        {/* Key Matchup */}
        <div className="card-shine bg-card rounded-lg border border-border p-5">
          <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
            <Target className="w-4 h-4 text-primary" />
            Key Matchup
          </h3>
          <p className="text-sm text-foreground font-medium mb-4">{game.keyMatchup}</p>

          <div className="space-y-2.5">
            {game.matchupEdges.map((edge) => (
              <div key={edge.label} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{edge.label}</span>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold ${edge.team === "home" ? "text-confidence-high" : "text-primary"}`}>
                    {edge.team === "home" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation}
                  </span>
                  <span className="text-xs text-secondary-foreground max-w-48 text-right">{edge.description}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Injuries */}
        <div className="card-shine bg-card rounded-lg border border-border p-5">
          <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
            <Swords className="w-4 h-4 text-destructive" />
            Injury Report
          </h3>
          <div className="space-y-4">
            <InjuryImpactMeter injuries={game.injuries.away} teamAbbr={game.awayTeam.abbreviation} />
            <InjuryImpactMeter injuries={game.injuries.home} teamAbbr={game.homeTeam.abbreviation} />
          </div>
        </div>

        {/* Player Trends - Away */}
        <div className="card-shine bg-card rounded-lg border border-border p-5">
          <h3 className="font-display font-bold text-sm text-foreground mb-3">
            {game.awayTeam.logo} {game.awayTeam.abbreviation} Player Trends
          </h3>
          <div className="divide-y divide-border">
            {game.playerTrends.away.map((player) => (
              <PlayerTrendCard key={player.name} player={player} />
            ))}
          </div>
        </div>

        {/* Player Trends - Home */}
        <div className="card-shine bg-card rounded-lg border border-border p-5">
          <h3 className="font-display font-bold text-sm text-foreground mb-3">
            {game.homeTeam.logo} {game.homeTeam.abbreviation} Player Trends
          </h3>
          <div className="divide-y divide-border">
            {game.playerTrends.home.map((player) => (
              <PlayerTrendCard key={player.name} player={player} />
            ))}
          </div>
        </div>
      </div>

      {/* Efficiency Comparison */}
      <div className="card-shine bg-card rounded-lg border border-border p-5">
        <h3 className="font-display font-bold text-sm text-foreground mb-4">Team Efficiency Comparison</h3>
        <div className="grid grid-cols-3 gap-4 text-center">
          {[
            { label: "Off Rating", away: game.awayTeam.offensiveRating, home: game.homeTeam.offensiveRating },
            { label: "Def Rating", away: game.awayTeam.defensiveRating, home: game.homeTeam.defensiveRating },
            { label: "Pace", away: game.awayTeam.pace, home: game.homeTeam.pace },
          ].map((stat) => {
            const awayBetter = stat.label === "Def Rating" ? stat.away < stat.home : stat.away > stat.home;
            return (
              <div key={stat.label}>
                <div className="text-xs text-muted-foreground mb-2">{stat.label}</div>
                <div className="flex items-center justify-center gap-3">
                  <span className={`text-sm font-semibold ${awayBetter ? "text-confidence-high" : "text-foreground"}`}>
                    {stat.away}
                  </span>
                  <span className="text-xs text-muted-foreground">vs</span>
                  <span className={`text-sm font-semibold ${!awayBetter ? "text-confidence-high" : "text-foreground"}`}>
                    {stat.home}
                  </span>
                </div>
                <div className="flex justify-center gap-3 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">{game.awayTeam.abbreviation}</span>
                  <span className="text-[10px] text-muted-foreground" />
                  <span className="text-[10px] text-muted-foreground">{game.homeTeam.abbreviation}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
