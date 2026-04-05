import { motion } from "framer-motion";
import { GamePrediction } from "@/data/mockGames";
import { TeamLogo } from "./TeamLogo";
import { ConfidenceMeter } from "./ConfidenceMeter";
import { ChevronRight, AlertTriangle, Zap, Shield, Clock } from "lucide-react";

interface GamePredictionCardProps {
  game: GamePrediction;
  index: number;
  onSelect: (game: GamePrediction) => void;
}

export function GamePredictionCard({ game, index, onSelect }: GamePredictionCardProps) {
  const favored = game.winProbability.home >= game.winProbability.away ? "home" : "away";
  const favoredTeam = favored === "home" ? game.homeTeam : game.awayTeam;
  const favoredProb = favored === "home" ? game.winProbability.home : game.winProbability.away;

  const totalInjuries =
    game.injuries.home.filter((i) => i.status === "OUT").length +
    game.injuries.away.filter((i) => i.status === "OUT").length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.1 }}
      onClick={() => onSelect(game)}
      className="card-shine bg-card rounded-lg border border-border hover:border-primary/30 transition-all cursor-pointer group"
    >
      {/* Header */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{game.gameTime}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {game.situationalTags.map((tag) => (
            <span key={tag} className="text-[10px] font-semibold tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">
              {tag}
            </span>
          ))}
        </div>
      </div>

      {/* Teams + Probability */}
      <div className="px-4 py-3 flex items-center gap-4">
        {/* Away */}
        <div className={`flex-1 text-center ${favored === "away" ? "" : "opacity-60"}`}>
          <div className="text-2xl mb-1">{game.awayTeam.logo}</div>
          <div className="text-sm font-display font-bold text-foreground">{game.awayTeam.abbreviation}</div>
          <div className="text-xs text-muted-foreground">{game.awayTeam.record}</div>
          <div className="text-lg font-display font-bold mt-1 text-foreground">{game.winProbability.away}%</div>
        </div>

        {/* Center */}
        <div className="flex flex-col items-center">
          <span className="text-xs text-muted-foreground mb-2">VS</span>
          <ConfidenceMeter level={game.confidence} probability={favoredProb} />
        </div>

        {/* Home */}
        <div className={`flex-1 text-center ${favored === "home" ? "" : "opacity-60"}`}>
          <div className="mb-1 flex justify-center">
            <TeamLogo logo={game.homeTeam.logo} size="sm" />
          </div>
          <div className="text-sm font-display font-bold text-foreground">{game.homeTeam.abbreviation}</div>
          <div className="text-xs text-muted-foreground">{game.homeTeam.record}</div>
          <div className="text-lg font-display font-bold mt-1 text-foreground">{game.winProbability.home}%</div>
        </div>
      </div>

      {/* Quick Insights */}
      <div className="px-4 pb-3 space-y-1.5">
        <div className="flex items-start gap-2 text-xs">
          <Zap className="w-3.5 h-3.5 text-confidence-high shrink-0 mt-0.5" />
          <span className="text-secondary-foreground">{game.topReasons[0]}</span>
        </div>
        <div className="flex items-start gap-2 text-xs">
          <AlertTriangle className="w-3.5 h-3.5 text-risk shrink-0 mt-0.5" />
          <span className="text-secondary-foreground">{game.riskFactors[0]}</span>
        </div>
        {totalInjuries > 0 && (
          <div className="flex items-start gap-2 text-xs">
            <Shield className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
            <span className="text-secondary-foreground">{totalInjuries} player{totalInjuries > 1 ? "s" : ""} OUT</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-border flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {favoredTeam.abbreviation} favored
        </span>
        <span className="text-xs text-primary flex items-center gap-1 group-hover:gap-2 transition-all font-medium">
          Full Breakdown <ChevronRight className="w-3.5 h-3.5" />
        </span>
      </div>
    </motion.div>
  );
}
