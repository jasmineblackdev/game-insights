import { motion } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import { GamePrediction } from "@/data/mockGames";
import { TeamLogo } from "./TeamLogo";
import { ConfidenceMeter } from "./ConfidenceMeter";
import { showModelMarketEdgeBadge } from "@/lib/modelMarketEdge";
import {
  getLiveContext,
  liveAccuracyClass,
  getFinalPredictionContext,
  finalPredictionAccuracyClass,
  getBetWindow,
  betWindowClass,
  getUpcomingBetTip,
} from "@/lib/liveGameState";
import { ChevronRight, AlertTriangle, Zap, Shield, Clock, TrendingUp, ArrowRight } from "lucide-react";
import { buildPredictionVersions, isLiveTriggerMet, phaseColor } from "@/lib/predictionVersions";

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
  const liveCtx = getLiveContext(game);
  const finalCtx = getFinalPredictionContext(game);
  const betWindow = getBetWindow(game);
  const upcomingBetTip = getUpcomingBetTip(game);
  const bi = game._meta?.bettingIntel;

  // Prediction versions
  const versions = buildPredictionVersions(game);
  const pregameVer = versions.find((v) => v.phase === "pregame");
  const liveVer =
    versions.find((v) => v.phase === "live_q1" || v.phase === "live_f5" || v.phase === "live_15min") ??
    versions.find((v) => v.phase === "late_news");
  const liveTriggerMet = isLiveTriggerMet(game);
  const showProbShift =
    liveVer &&
    pregameVer &&
    (Math.abs(liveVer.probability - pregameVer.probability) >= 2 ||
      liveVer.confidence !== pregameVer.confidence);

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
          {finalCtx ? (
            <span
              className={`text-[10px] font-bold tracking-wide px-2 py-0.5 rounded-full border ${finalPredictionAccuracyClass(finalCtx)}`}
              title={finalCtx.tip}
            >
              🏁 {finalCtx.badge}
            </span>
          ) : liveCtx ? (
            <span
              className={`text-[10px] font-bold tracking-wide px-2 py-0.5 rounded-full border ${liveAccuracyClass(liveCtx.accuracy)}`}
              title={liveCtx.tip}
            >
              🔴 {liveCtx.badge}
            </span>
          ) : null}
          {/* Prediction phase badge */}
          {game.status === "upcoming" ? (
            <span className={`text-[10px] font-bold tracking-wide px-2 py-0.5 rounded-full border ${phaseColor("pregame")}`}>
              PREGAME EDGE
            </span>
          ) : game.status === "live" && liveTriggerMet ? (
            <span className={`text-[10px] font-bold tracking-wide px-2 py-0.5 rounded-full border animate-pulse ${phaseColor("live_q1")}`}>
              ● LIVE EDGE ACTIVE
            </span>
          ) : game.status === "live" ? (
            <span className={`text-[10px] font-bold tracking-wide px-2 py-0.5 rounded-full border ${phaseColor("pregame")}`}>
              PREGAME EDGE
            </span>
          ) : null}
          {game.situationalTags
            .filter((tag) => tag !== "LIVE") // replaced by liveCtx badge
            .map((tag) => (
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

      {/* Probability shift row (pregame → live) */}
      {showProbShift && pregameVer && liveVer ? (
        <div className="px-4 pb-1 flex items-center justify-center gap-2 text-[10px]">
          <span className="text-muted-foreground">Pregame</span>
          <span className="font-semibold text-foreground tabular-nums">{pregameVer.probability}%</span>
          <ArrowRight className="w-3 h-3 text-muted-foreground" />
          <span className="font-semibold text-confidence-high tabular-nums">{liveVer.probability}%</span>
          <span className="text-confidence-high">Live</span>
        </div>
      ) : null}

      {/* Quick Insights */}
      <div className="px-4 pb-3 space-y-1.5">
        {finalCtx ? (
          <div className="flex items-start gap-2 text-xs">
            <span className="text-[10px] shrink-0 mt-0.5">🏁</span>
            <span className="text-secondary-foreground">{finalCtx.tip}</span>
          </div>
        ) : liveCtx ? (
          <div className="flex items-start gap-2 text-xs">
            <span className="text-[10px] shrink-0 mt-0.5">🔴</span>
            <span className="text-secondary-foreground">{liveCtx.tip}</span>
          </div>
        ) : (
          <div className="flex items-start gap-2 text-xs">
            <Zap className="w-3.5 h-3.5 text-confidence-high shrink-0 mt-0.5" />
            <span className="text-secondary-foreground">{game.topReasons[0]}</span>
          </div>
        )}
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

      {/* Bet Window Signal */}
      {betWindow && betWindow.phase !== "closed" ? (
        <div className={`mx-4 mb-3 px-3 py-2.5 rounded-lg border flex items-start gap-2.5 ${betWindowClass(betWindow.phase)}`}>
          <TrendingUp className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${betWindow.phase === "open" ? "text-confidence-high" : betWindow.phase === "closing" ? "text-amber-500" : "text-muted-foreground"}`} />
          <div className="min-w-0">
            <p className={`text-[10px] font-bold tracking-wider leading-none mb-1 ${betWindow.phase === "open" ? "text-confidence-high" : betWindow.phase === "closing" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
              {betWindow.label}
            </p>
            <p className="text-[11px] leading-snug line-clamp-2">{betWindow.tip}</p>
            <p className={`text-[10px] mt-1 font-medium ${betWindow.phase === "open" ? "text-confidence-high/80" : "text-muted-foreground"}`}>
              {betWindow.timing}
            </p>
          </div>
        </div>
      ) : upcomingBetTip ? (
        <div className="mx-4 mb-3 px-3 py-2 rounded-lg border border-border/60 bg-muted/30 flex items-center gap-2">
          <Clock className="w-3 h-3 shrink-0 text-muted-foreground/60" />
          <p className="text-[10px] text-muted-foreground/80">{upcomingBetTip}</p>
        </div>
      ) : null}

      {/* Value vs book (primary model pick) */}
      {bi ? (
        <div className="mx-4 mb-2 px-3 py-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] space-y-1">
          <p className="text-[10px] font-bold tracking-wide text-emerald-600 dark:text-emerald-400">
            VALUE CHECK · {bi.recommendedForParlay ? "Parlay-friendly" : "Pass"}
          </p>
          <p className="text-[11px] text-foreground font-semibold tabular-nums">
            Pick {bi.pickAbbrev}{" "}
            <span className="text-muted-foreground font-normal">
              {bi.americanOdds > 0 ? `+${bi.americanOdds}` : bi.americanOdds}
            </span>
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground tabular-nums">
            <span>
              Model <span className="text-foreground font-medium">{Math.round(bi.modelProbability * 100)}%</span>
            </span>
            <span>
              Implied <span className="text-foreground font-medium">{Math.round(bi.impliedProbability * 100)}%</span>
            </span>
            <span>
              Edge{" "}
              <span className={bi.edge >= 0.04 ? "text-emerald-600 dark:text-emerald-400 font-semibold" : "text-foreground"}>
                {bi.edge >= 0 ? "+" : ""}
                {(bi.edge * 100).toFixed(1)}%
              </span>
            </span>
            <span>
              Grade <span className="text-foreground font-medium">{bi.betQualityRating}</span>
            </span>
            <span>
              Fit <span className="text-foreground font-medium">{bi.parlayFitScore}</span>
            </span>
          </div>
        </div>
      ) : null}

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
