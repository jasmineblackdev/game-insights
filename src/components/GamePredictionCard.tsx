import { motion } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import { GamePrediction } from "@/data/mockGames";
import { TeamLogo } from "./TeamLogo";
import { ConfidenceMeter } from "./ConfidenceMeter";
import { showModelMarketEdgeBadge } from "@/lib/modelMarketEdge";
import { ChevronRight, AlertTriangle, Zap, Shield, Clock } from "lucide-react";

interface GamePredictionCardProps {
  game: GamePrediction;
  index: number;
  onSelect: (game: GamePrediction) => void;
}

export function GamePredictionCard({ game, index, onSelect }: GamePredictionCardProps) {
  const tw = game.threeWay;
  const favored = game.winProbability.home >= game.winProbability.away ? "home" : "away";
  const favoredTeam = favored === "home" ? game.homeTeam : game.awayTeam;
  const favoredProb = favored === "home" ? game.winProbability.home : game.winProbability.away;
  const ringProb = tw ? Math.max(tw.home, tw.away) : favoredProb;

  const totalInjuries =
    game.injuries.home.filter((i) => i.status === "OUT").length +
    game.injuries.away.filter((i) => i.status === "OUT").length;

  const showEdgeBadge = showModelMarketEdgeBadge(game);
  const updatedAgo = formatDistanceToNow(new Date(game.lastUpdated), { addSuffix: true });

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.1 }}
      onClick={() => onSelect(game)}
      className="card-shine bg-card rounded-lg border border-border hover:border-primary/30 transition-all cursor-pointer group touch-manipulation active:scale-[0.99]"
    >
      {/* Header */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground truncate">{game.gameTime}</span>
          </div>
          <span className="text-[10px] text-muted-foreground/90 pl-5">Updated {updatedAgo}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {showEdgeBadge ? (
            <span
              className="text-[10px] font-bold tracking-wide text-amber-600 dark:text-amber-400 bg-amber-500/15 px-2 py-0.5 rounded-full border border-amber-500/25"
              title="Model home win % differs from market (moneyline de-vig and/or spread heuristic) by more than 7 pts"
            >
              ⚡ EDGE
            </span>
          ) : null}
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
          <div className="mb-1 flex justify-center">
            <TeamLogo logo={game.awayTeam.logo} size="sm" />
          </div>
          <div className="text-sm font-display font-bold text-foreground">{game.awayTeam.abbreviation}</div>
          <div className="text-xs text-muted-foreground">{game.awayTeam.record}</div>
          <div className="text-lg font-display font-bold mt-1 text-foreground">
            {tw ? tw.away : game.winProbability.away}%
          </div>
          {tw ? <div className="text-[10px] text-muted-foreground mt-0.5">win</div> : null}
        </div>

        {/* Center */}
        <div className="flex flex-col items-center">
          <span className="text-xs text-muted-foreground mb-2">VS</span>
          {tw ? (
            <>
              <div className="text-center mb-1.5">
                <div className="text-[10px] font-semibold text-muted-foreground tracking-wide">DRAW</div>
                <div className="text-xl font-display font-bold text-foreground leading-tight">{tw.draw}%</div>
              </div>
              <ConfidenceMeter level={game.confidence} probability={ringProb} showRing={false} />
            </>
          ) : (
            <ConfidenceMeter level={game.confidence} probability={favoredProb} />
          )}
        </div>

        {/* Home */}
        <div className={`flex-1 text-center ${favored === "home" ? "" : "opacity-60"}`}>
          <div className="mb-1 flex justify-center">
            <TeamLogo logo={game.homeTeam.logo} size="sm" />
          </div>
          <div className="text-sm font-display font-bold text-foreground">{game.homeTeam.abbreviation}</div>
          <div className="text-xs text-muted-foreground">{game.homeTeam.record}</div>
          <div className="text-lg font-display font-bold mt-1 text-foreground">
            {tw ? tw.home : game.winProbability.home}%
          </div>
          {tw ? <div className="text-[10px] text-muted-foreground mt-0.5">win</div> : null}
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

      {/* Lines row */}
      {game.lines && (game.lines.spread || game.lines.total != null || game.lines.homeMl) && (
        <div className="px-4 py-2 border-t border-border/60 flex items-center flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {game.lines.spread && (
            <span className="whitespace-nowrap">
              Spread <span className="text-foreground font-semibold">{game.lines.spread}</span>
            </span>
          )}
          {game.lines.total != null && (
            <span className="whitespace-nowrap">
              O/U <span className="text-foreground font-semibold">{game.lines.total}</span>
            </span>
          )}
          {game.lines.homeMl && game.lines.awayMl && (
            <span className="ml-auto whitespace-nowrap">
              {game.awayTeam.abbreviation}{" "}
              <span className={`font-semibold ${game.lines.awayMl.startsWith("-") ? "text-confidence-high" : "text-foreground"}`}>
                {game.lines.awayMl}
              </span>
              {" / "}
              {game.lines.drawMl ? (
                <>
                  Draw{" "}
                  <span className="font-semibold text-foreground">{game.lines.drawMl}</span>
                  {" / "}
                </>
              ) : null}
              {game.homeTeam.abbreviation}{" "}
              <span className={`font-semibold ${game.lines.homeMl.startsWith("-") ? "text-confidence-high" : "text-foreground"}`}>
                {game.lines.homeMl}
              </span>
            </span>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-border flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {tw && tw.draw >= Math.max(tw.home, tw.away)
            ? `Draw branch largest (${tw.draw}%)`
            : `${favoredTeam.abbreviation} favored to win`}
        </span>
        <span className="text-xs text-primary flex items-center gap-1 group-hover:gap-2 transition-all font-medium">
          Full Breakdown <ChevronRight className="w-3.5 h-3.5" />
        </span>
      </div>
    </motion.div>
  );
}
