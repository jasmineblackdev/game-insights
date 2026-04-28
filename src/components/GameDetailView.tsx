import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { GamePrediction } from "@/data/mockGames";
import { useValueParlay } from "@/context/ValueParlayContext";
import { getFavoredSide, type EdgeSide } from "@/lib/edgeCardScoring";
import { buildMoneylineLeg } from "@/lib/valueParlay/buildCandidates";
import { showModelMarketEdgeBadge } from "@/lib/modelMarketEdge";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TeamLogo } from "./TeamLogo";
import { ConfidenceMeter } from "./ConfidenceMeter";
import { InjuryImpactMeter } from "./InjuryImpactMeter";
import { PlayerTrendCard } from "./PlayerTrendCard";
import { ArrowLeft, Zap, AlertTriangle, Target, Swords, Clock, RefreshCw, DollarSign, Info, Cloud, Layers, Plus, TrendingUp, History, ArrowRight } from "lucide-react";
import {
  getBetWindow,
  betWindowClass,
  getUpcomingBetTip,
  getFinalPredictionContext,
  finalPredictionAccuracyClass,
} from "@/lib/liveGameState";
import { buildPredictionVersions, phaseLabel, phaseColor, confColor, type PredictionVersion } from "@/lib/predictionVersions";
import { Switch } from "@/components/ui/switch";
import { isMlbStartersUserConfirmed, setMlbStartersUserConfirmed } from "@/lib/mlbStarterConfirm";
import { stagePendingTeamMoneyline } from "@/lib/predictionLearningIntelligence";
import { pickActionForGame } from "@/lib/dailyPlan/pickAction";
import { useBankroll } from "@/context/BankrollContext";

interface GameDetailViewProps {
  game: GamePrediction;
  onBack: () => void;
  /** Bump after toggling "starters verified" so the home tab can re-run the MLB model. */
  onMlbStartersConfirmChange?: () => void;
}

export function GameDetailView({ game, onBack, onMlbStartersConfirmChange }: GameDetailViewProps) {
  const { addValueLeg, isValueLegAdded, builderLegs } = useValueParlay();
  const tw = game.threeWay;
  const favoredSide = getFavoredSide(game);
  const favored = game.winProbability.home >= game.winProbability.away ? "home" : "away";
  const favoredTeam = favored === "home" ? game.homeTeam : game.awayTeam;
  const favoredProb = favored === "home" ? game.winProbability.home : game.winProbability.away;
  const homeLegId = `vp-${game.id}-ml-home`;
  const awayLegId = `vp-${game.id}-ml-away`;
  const favoredLegId = favored === "home" ? homeLegId : awayLegId;
  const otherLegId = favored === "home" ? awayLegId : homeLegId;
  const ringProb = tw ? Math.max(tw.home, tw.away) : favoredProb;

  const updatedAt = new Date(game.lastUpdated);
  const timeAgo = Math.round((Date.now() - updatedAt.getTime()) / 60000);
  const betWindow = getBetWindow(game);
  const upcomingBetTip = getUpcomingBetTip(game);
  const predictionVersions = buildPredictionVersions(game);
  const finalCtx = getFinalPredictionContext(game);

  const [mlbStartersChecked, setMlbStartersChecked] = useState(() =>
    game.league === "mlb" ? isMlbStartersUserConfirmed(game.id) : false
  );
  useEffect(() => {
    if (game.league === "mlb") setMlbStartersChecked(isMlbStartersUserConfirmed(game.id));
    else setMlbStartersChecked(false);
  }, [game.id, game.league]);

  const mlbCanUserConfirmStarters =
    game.league === "mlb" &&
    game.status === "upcoming" &&
    !!game.mlb?.homeProbablePitcher &&
    !!game.mlb?.awayProbablePitcher;

  // Stage the model's recommended pickSide on first-open of an upcoming
  // game. Idempotent via the unique index on
  // (external_game_id, market_type, pick_side) — covers the case where a
  // user reads the game detail without slip-adding so backtest still has
  // a sample. No-op if bettingIntel hasn't computed a pickSide yet.
  useEffect(() => {
    if (game.status !== "upcoming") return;
    const side = game._meta?.bettingIntel?.pickSide;
    if (side !== "home" && side !== "away" && side !== "draw") return;
    void stagePendingTeamMoneyline(game, side);
  }, [game]);

  // Hard friction — when the per-game action returns SKIP we disable
  // the Add-to-Parlay buttons and surface why. WAIT shows a warning
  // toast but lets the user proceed.
  const { lossStreak, hadLossToday } = useBankroll();
  const pickAction = pickActionForGame(game, { lossStreak, hadLossToday });
  const addBlocked = pickAction === "SKIP";
  const addWarn = pickAction === "WAIT";
  const skipReason =
    pickAction === "SKIP"
      ? game.confidence === "low"
        ? "LOW confidence — add disabled. Override via the parlay builder."
        : "Filters say SKIP. Override via the parlay builder."
      : pickAction === "WAIT"
        ? "Bankroll says WAIT — bet at your own risk."
        : "";

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
        type="button"
        onClick={onBack}
        className="flex items-center gap-2 min-h-10 -ml-1 px-1 text-sm text-muted-foreground hover:text-foreground transition-colors touch-manipulation rounded-md"
      >
        <ArrowLeft className="w-4 h-4 shrink-0" />
        Back to games
      </button>

      {/* Matchup Header */}
      <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-2">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{game.gameTime}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {showModelMarketEdgeBadge(game) ? (
              <span
                className={cn(
                  "text-[10px] font-bold tracking-wide px-2 py-0.5 rounded-full border",
                  "text-amber-600 dark:text-amber-400 bg-amber-500/15 border-amber-500/25"
                )}
                title="Model home win % differs from market (ML de-vig / spread heuristic) by more than 7 pts"
              >
                ⚡ EDGE
              </span>
            ) : null}
            {finalCtx ? (
              <span
                className={cn(
                  "text-[10px] font-bold tracking-wide px-2 py-0.5 rounded-full border",
                  finalPredictionAccuracyClass(finalCtx)
                )}
                title={finalCtx.tip}
              >
                🏁 {finalCtx.badge}
              </span>
            ) : null}
            {game.situationalTags.map((tag) => (
              <span key={tag} className="text-[10px] font-semibold tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-center sm:gap-4 md:gap-6 py-4">
          <div className={`text-center ${favored === "away" ? "" : "opacity-50"}`}>
            <div className="mb-2 flex justify-center">
              <TeamLogo logo={game.awayTeam.logo} size="lg" />
            </div>
            <div className="font-display font-bold text-base sm:text-lg text-foreground px-1">{game.awayTeam.name}</div>
            <div className="text-xs sm:text-sm text-muted-foreground">{game.awayTeam.record} · {game.awayTeam.recentForm}</div>
            <div className="text-xl sm:text-2xl font-display font-bold mt-2 text-foreground">
              {tw ? tw.away : game.winProbability.away}%
            </div>
            {tw ? <div className="text-[11px] text-muted-foreground">win (1X2)</div> : null}
          </div>

          {tw ? (
            <div className="flex flex-row sm:flex-col items-center justify-center gap-4 sm:gap-2 shrink-0 py-2 sm:py-0 border-y border-border/60 sm:border-0">
              <div className="text-center">
                <div className="text-[10px] font-semibold text-muted-foreground tracking-wider">DRAW</div>
                <div className="text-2xl sm:text-3xl font-display font-bold text-foreground">{tw.draw}%</div>
              </div>
              <ConfidenceMeter level={game.confidence} probability={ringProb} showRing={false} />
            </div>
          ) : (
            <div className="flex justify-center py-2 sm:py-0">
              <ConfidenceMeter level={game.confidence} probability={favoredProb} />
            </div>
          )}

          <div className={`text-center ${favored === "home" ? "" : "opacity-50"}`}>
            <div className="mb-2 flex justify-center">
              <TeamLogo logo={game.homeTeam.logo} size="lg" />
            </div>
            <div className="font-display font-bold text-base sm:text-lg text-foreground px-1">{game.homeTeam.name}</div>
            <div className="text-xs sm:text-sm text-muted-foreground">{game.homeTeam.record} · {game.homeTeam.recentForm}</div>
            <div className="text-xl sm:text-2xl font-display font-bold mt-2 text-foreground">
              {tw ? tw.home : game.winProbability.home}%
            </div>
            {tw ? <div className="text-[11px] text-muted-foreground">win (1X2)</div> : null}
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="w-3 h-3" />
          Updated {timeAgo > 0 ? `${timeAgo}m ago` : "just now"}
        </div>

        {game._meta?.bettingIntel ? (
          <div className="mt-4 pt-4 border-t border-border rounded-lg bg-emerald-500/[0.04] border-emerald-500/15 px-4 py-3 space-y-2">
            <div className="flex items-center gap-2 text-xs font-display font-bold text-foreground">
              <DollarSign className="w-4 h-4 text-emerald-500 shrink-0" />
              Betting value — primary pick
            </div>
            <p className="text-sm font-semibold text-foreground">
              {game._meta.bettingIntel.pickAbbrev}{" "}
              <span className="text-muted-foreground font-normal tabular-nums">
                {game._meta.bettingIntel.americanOdds > 0 ? "+" : ""}
                {game._meta.bettingIntel.americanOdds}
              </span>
              {game._meta.bettingIntel.sportsbookKey ? (
                <span className="text-[10px] text-muted-foreground ml-2">({game._meta.bettingIntel.sportsbookKey})</span>
              ) : null}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <div>
                <span className="text-muted-foreground block text-[10px]">Model probability</span>
                <span className="font-semibold tabular-nums">{Math.round(game._meta.bettingIntel.modelProbability * 100)}%</span>
              </div>
              <div>
                <span className="text-muted-foreground block text-[10px]">Implied (book)</span>
                <span className="font-semibold tabular-nums">{Math.round(game._meta.bettingIntel.impliedProbability * 100)}%</span>
              </div>
              <div>
                <span className="text-muted-foreground block text-[10px]">Edge</span>
                <span
                  className={cn(
                    "font-semibold tabular-nums",
                    game._meta.bettingIntel.edge >= 0.04 ? "text-emerald-600 dark:text-emerald-400" : ""
                  )}
                >
                  {game._meta.bettingIntel.edge >= 0 ? "+" : ""}
                  {(game._meta.bettingIntel.edge * 100).toFixed(1)}%
                </span>
              </div>
              <div>
                <span className="text-muted-foreground block text-[10px]">Edge score (pts)</span>
                <span className="font-semibold tabular-nums">{game._meta.bettingIntel.edgeScore}</span>
              </div>
              <div>
                <span className="text-muted-foreground block text-[10px]">Bet quality</span>
                <span className="font-semibold">{game._meta.bettingIntel.betQualityRating}</span>
              </div>
              <div>
                <span className="text-muted-foreground block text-[10px]">Value / parlay</span>
                <span className="font-semibold capitalize">
                  {game._meta.bettingIntel.valueRating} · fit {game._meta.bettingIntel.parlayFitScore} · safety{" "}
                  {game._meta.bettingIntel.parlaySafetyScore}
                </span>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Parlay:{" "}
              <span className={game._meta.bettingIntel.recommendedForParlay ? "text-emerald-600 dark:text-emerald-400 font-medium" : ""}>
                {game._meta.bettingIntel.recommendedForParlay ? "Recommended" : "Not recommended"}
              </span>
              {game._meta.bettingIntel.lineMovementSharpTowardPick ? (
                <span className="block mt-1 text-amber-600 dark:text-amber-400">
                  Line movement aligns with this side (market steam heuristic).
                </span>
              ) : null}
            </p>
            {game._meta.bettingIntel.filterNotes.length > 0 ? (
              <ul className="text-[10px] text-muted-foreground list-disc list-inside space-y-0.5">
                {game._meta.bettingIntel.filterNotes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {game.status === "upcoming" ? (
          <div className="mt-5 pt-4 border-t border-border flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2">
            <Button
              size="sm"
              className="gap-1.5 font-semibold"
              disabled={isValueLegAdded(favoredLegId) || builderLegs.length >= 12 || addBlocked}
              title={addBlocked ? skipReason : undefined}
              onClick={() => {
                if (addWarn) toast.warning(skipReason);
                const leg = buildMoneylineLeg(game, favoredSide);
                if (!leg) {
                  toast.message("No usable line for this side yet");
                  return;
                }
                const r = addValueLeg(leg);
                const abbr = favoredSide === "home" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
                if (r.ok) {
                  toast.success(`Added ${abbr} ML to parlay slip`);
                  void stagePendingTeamMoneyline(game, favoredSide);
                }
                else toast.message(r.message ?? "Could not add");
              }}
            >
              <Plus className="w-3.5 h-3.5" />
              {isValueLegAdded(favoredLegId)
                ? "On parlay slip"
                : addBlocked
                  ? `SKIP — ${favoredSide === "home" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation} blocked`
                  : `Add ${favoredSide === "home" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation} to parlay`}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              disabled={isValueLegAdded(otherLegId) || builderLegs.length >= 12 || addBlocked}
              title={addBlocked ? skipReason : undefined}
              onClick={() => {
                if (addWarn) toast.warning(skipReason);
                const other: EdgeSide = favoredSide === "home" ? "away" : "home";
                const leg = buildMoneylineLeg(game, other);
                if (!leg) {
                  toast.message("No usable line for this side yet");
                  return;
                }
                const r = addValueLeg(leg);
                const abbr = other === "home" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
                if (r.ok) {
                  toast.success(`Added ${abbr} (contrarian)`);
                  void stagePendingTeamMoneyline(game, other);
                }
                else toast.message(r.message ?? "Could not add");
              }}
            >
              Add other side
            </Button>
            <Link
              to="/?view=parlay_builder"
              className="inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-primary hover:underline px-2 py-1.5"
            >
              <Layers className="w-3.5 h-3.5" />
              Open parlay builder
            </Link>
          </div>
        ) : null}
      </div>

      {/* Bet Signal */}
      {(betWindow || upcomingBetTip) && (
        <div className={`card-shine rounded-lg border p-4 sm:p-5 ${betWindow ? betWindowClass(betWindow.phase) : "bg-card border-border"}`}>
          <h3 className="font-display font-bold text-sm flex items-center gap-2 mb-3">
            <TrendingUp className={`w-4 h-4 ${betWindow?.phase === "open" ? "text-confidence-high" : betWindow?.phase === "closing" ? "text-amber-500" : "text-muted-foreground"}`} />
            <span className={betWindow?.phase === "open" ? "text-confidence-high" : betWindow?.phase === "closing" ? "text-amber-600 dark:text-amber-400" : "text-foreground"}>
              Bet Signal
            </span>
          </h3>

          {betWindow ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-bold tracking-wider px-2.5 py-1 rounded-full border ${betWindowClass(betWindow.phase)}`}>
                  {betWindow.phase === "open" && "● "}
                  {betWindow.phase === "closing" && "◑ "}
                  {betWindow.phase === "wait" && "○ "}
                  {betWindow.label}
                </span>
              </div>
              <p className="text-sm text-secondary-foreground leading-relaxed">{betWindow.tip}</p>
              <div className="flex items-center gap-2 text-xs">
                <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className={`font-medium ${betWindow.phase === "open" ? "text-confidence-high" : betWindow.phase === "closing" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
                  {betWindow.timing}
                </span>
              </div>

              {/* Sport-specific guidance */}
              <div className="pt-2 border-t border-current/10">
                {game.league === "nba" && (
                  <div className="space-y-1 text-[11px] text-muted-foreground">
                    <p className="font-semibold text-foreground/70 text-[10px] tracking-wider">NBA TIMING GUIDE</p>
                    <p>Q1 buzzer → check foul counts on star players (2 fouls = significant shift)</p>
                    <p>Halftime → highest accuracy: pace, rotations, and bench depth all visible</p>
                    <p>Q3 tight → live spread still moves meaningfully on runs</p>
                  </div>
                )}
                {game.league === "nfl" && (
                  <div className="space-y-1 text-[11px] text-muted-foreground">
                    <p className="font-semibold text-foreground/70 text-[10px] tracking-wider">NFL TIMING GUIDE</p>
                    <p>After Q1 → check if a team is abandoning the run (desperation signal)</p>
                    <p>Halftime → injury report + adjusted game script = peak accuracy window</p>
                    <p>Q4 within 7 → two-minute drill shifts ATS result significantly</p>
                  </div>
                )}
                {game.league === "mlb" && (
                  <div className="space-y-1 text-[11px] text-muted-foreground">
                    <p className="font-semibold text-foreground/70 text-[10px] tracking-wider">MLB TIMING GUIDE</p>
                    <p>Innings 4–5 (F5) → starter pitch count + WHIP are now readable</p>
                    <p>High pitch count early (80+ through 4) = bullpen window opening soon</p>
                    <p>Innings 6–7 → bullpen matchup data adds an edge before closer usage</p>
                  </div>
                )}
                {game.league === "boxing" && (
                  <div className="space-y-1 text-[11px] text-muted-foreground">
                    <p className="font-semibold text-foreground/70 text-[10px] tracking-wider">BOXING TIMING GUIDE</p>
                    <p>Rounds 1–3 → fighters feeling out each other; avoid live betting</p>
                    <p>Rounds 4–8 → pace, stamina and chin durability become readable</p>
                    <p>Rounds 9+ → late stoppage probability spikes for tiring fighters</p>
                  </div>
                )}
              </div>
            </div>
          ) : upcomingBetTip ? (
            <div className="space-y-2">
              <p className="text-sm text-secondary-foreground">This game hasn't started yet. Come back live for the optimal entry window.</p>
              <div className="flex items-center gap-2 text-xs">
                <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground font-medium">{upcomingBetTip}</span>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Prediction Timeline */}
      {predictionVersions.length > 0 && (
        <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5">
          <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-4">
            <History className="w-4 h-4 text-primary" />
            Prediction Timeline
          </h3>

          <div className="space-y-0">
            {predictionVersions.map((ver, i) => {
              const isLast = i === predictionVersions.length - 1;
              const prev = i > 0 ? predictionVersions[i - 1] : null;
              const shift = prev && ver.phase !== "final"
                ? ver.probability - prev.probability
                : null;

              return (
                <div key={ver.id} className="relative pl-6">
                  {/* Timeline spine */}
                  {!isLast && (
                    <div className="absolute left-[7px] top-6 bottom-0 w-px bg-border" />
                  )}
                  {/* Node dot */}
                  <div className={`absolute left-0 top-1.5 w-3.5 h-3.5 rounded-full border-2 ${
                    ver.phase === "final"
                      ? "bg-muted border-border"
                      : ver.phase === "pregame"
                        ? "bg-primary/20 border-primary"
                        : ver.phase === "late_news"
                          ? "bg-amber-500/20 border-amber-500"
                          : "bg-confidence-high/20 border-confidence-high"
                  }`} />

                  <div className={`pb-5 ${!isLast ? "" : ""}`}>
                    {/* Phase header */}
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <span className={`text-[10px] font-bold tracking-wide px-2 py-0.5 rounded-full border ${phaseColor(ver.phase)}`}>
                        {phaseLabel(ver.phase)}
                      </span>
                      {shift !== null && shift !== 0 && (
                        <span className={`text-[10px] font-semibold flex items-center gap-0.5 ${shift > 0 ? "text-confidence-high" : "text-risk"}`}>
                          {shift > 0 ? "↑" : "↓"} {Math.abs(shift)}pp
                        </span>
                      )}
                    </div>

                    {ver.phase === "final" ? (
                      /* Final result block */
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-foreground">{ver.reasons[0]}</p>
                        {(() => {
                          const fh = game._meta?.finalHomeScore;
                          const fa = game._meta?.finalAwayScore;
                          const pregame = predictionVersions.find(v => v.phase === "pregame");
                          if (!pregame || fh == null || fa == null) return null;
                          const homeWon = fh > fa;
                          const modelPickedHome = pregame.predictedSide === game.homeTeam.abbreviation;
                          const correct = (modelPickedHome && homeWon) || (!modelPickedHome && !homeWon);
                          return (
                            <p className={`text-xs font-medium ${correct ? "text-confidence-high" : "text-amber-600 dark:text-amber-400"}`}>
                              {correct ? "✓ Model prediction matched the winner" : "✗ Model favored the losing side"}
                            </p>
                          );
                        })()}
                      </div>
                    ) : (
                      /* Pregame / Live prediction block */
                      <div className="space-y-2">
                        {/* Probability + confidence */}
                        <div className="flex items-baseline gap-2">
                          <span className="text-lg font-display font-bold text-foreground tabular-nums">
                            {ver.predictedSide} {ver.probability}%
                          </span>
                          <span className={`text-[10px] font-bold ${confColor(ver.confidence)}`}>
                            {ver.confidence}
                          </span>
                        </div>

                        {/* Live state snapshot */}
                        {ver.liveStateSnapshot && (
                          <div className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground bg-muted/40 rounded px-2 py-0.5">
                            <span>{game.awayTeam.abbreviation} {ver.liveStateSnapshot.scoreAway}</span>
                            <span>–</span>
                            <span>{ver.liveStateSnapshot.scoreHome} {game.homeTeam.abbreviation}</span>
                            <span className="text-border">·</span>
                            <span>Period {ver.liveStateSnapshot.period}</span>
                          </div>
                        )}

                        {/* Reasons */}
                        <ul className="space-y-1">
                          {ver.reasons.map((r, ri) => (
                            <li key={ri} className="flex items-start gap-2 text-xs text-secondary-foreground">
                              <span className="text-confidence-high font-bold mt-0.5 shrink-0 text-[10px]">{ri + 1}</span>
                              <span>{r}</span>
                            </li>
                          ))}
                        </ul>

                        {/* Risks */}
                        {ver.risks.length > 0 && (
                          <ul className="space-y-0.5">
                            {ver.risks.map((r, ri) => (
                              <li key={ri} className="flex items-start gap-2 text-xs text-muted-foreground">
                                <span className="text-risk font-bold mt-0.5 shrink-0 text-[10px]">!</span>
                                <span>{r}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Two column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Reasons */}
        <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5">
          <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
            <Zap className="w-4 h-4 text-confidence-high" />
            {tw && tw.draw >= Math.max(tw.home, tw.away)
              ? "Why the draw branch is live"
              : `Why ${favoredTeam.abbreviation} is favored to win`}
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
        <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5">
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
        <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5">
          <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
            <Target className="w-4 h-4 text-primary" />
            Key Matchup
          </h3>
          <p className="text-sm text-foreground font-medium mb-4">{game.keyMatchup}</p>

          <div className="space-y-2.5">
            {game.matchupEdges.map((edge) => (
              <div
                key={edge.label}
                className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between text-sm"
              >
                <span className="text-muted-foreground shrink-0">{edge.label}</span>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end min-w-0">
                  <span className={`text-xs font-semibold shrink-0 ${edge.team === "home" ? "text-confidence-high" : "text-primary"}`}>
                    {edge.team === "home" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation}
                  </span>
                  <span className="text-xs text-secondary-foreground text-left sm:text-right sm:max-w-[12rem] md:max-w-xs">
                    {edge.description}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Boxing-specific model layer */}
        {game.boxing && (
          <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5 lg:col-span-2">
            <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
              <Info className="w-4 h-4 text-primary" />
              Boxing Model · {game.boxing.weightClass}
              {game.boxing.isTitleFight && (
                <span className="ml-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                  {game.boxing.titleDescription ?? "TITLE FIGHT"}
                </span>
              )}
            </h3>
            {game.boxing.modelOutput && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {[
                    { label: "Opp Quality", text: game.boxing.modelOutput.opponentQualityEdge },
                    { label: "Style", text: game.boxing.modelOutput.styleEdge },
                    { label: "Recent Form", text: game.boxing.modelOutput.recentFormEdge },
                    { label: "Reach/Height", text: game.boxing.modelOutput.reachEdge },
                    { label: "Activity", text: game.boxing.modelOutput.activityEdge },
                    { label: "Age Curve", text: game.boxing.modelOutput.ageEdge },
                    { label: "Defense", text: game.boxing.modelOutput.defenseEdge },
                    { label: "Stance", text: game.boxing.modelOutput.stanceEdge },
                  ].map(({ label, text }) => (
                    <div key={label} className="rounded bg-muted/30 px-2 py-1.5">
                      <p className="text-[9px] font-bold tracking-wider text-muted-foreground mb-0.5">{label.toUpperCase()}</p>
                      <p className="text-secondary-foreground leading-tight">{text}</p>
                    </div>
                  ))}
                </div>
                <div className="rounded-lg bg-muted/25 border border-border p-3 text-xs space-y-1 text-secondary-foreground">
                  <p className="font-semibold text-foreground text-[10px] tracking-wider mb-1">METHOD OF VICTORY</p>
                  <div className="flex gap-4">
                    <span>KO/TKO: <strong>{Math.round(game.boxing.modelOutput.methodProbabilities.ko_tko * 100)}%</strong></span>
                    <span>Decision: <strong>{Math.round(game.boxing.modelOutput.methodProbabilities.decision * 100)}%</strong></span>
                    <span>Draw: <strong>{Math.round(game.boxing.modelOutput.methodProbabilities.draw * 100)}%</strong></span>
                  </div>
                  {game.boxing.modelOutput.overUnderRoundsPivot != null && (
                    <p>Model avg rounds: ~<strong>{game.boxing.modelOutput.overUnderRoundsPivot}</strong> of {game.boxing.scheduledRounds} scheduled</p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{game.boxing.modelOutput.koPctNote}</p>
                {game.boxing.modelOutput.riskFlag && (
                  <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{game.boxing.modelOutput.riskFlag}</span>
                  </div>
                )}
              </div>
            )}
            {!game.boxing.modelOutput && game.boxing.modelNotes.length > 0 && (
              <ul className="space-y-2 text-sm text-secondary-foreground list-disc list-inside">
                {game.boxing.modelNotes.map((note, i) => <li key={i}>{note}</li>)}
              </ul>
            )}
            {game.boxing.venue && (
              <p className="text-xs text-muted-foreground mt-3">Venue: {game.boxing.venue}</p>
            )}
          </div>
        )}

        {/* MMA-specific model layer */}
        {game.mma && (
          <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5 lg:col-span-2">
            <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
              <Info className="w-4 h-4 text-primary" />
              MMA Model · {game.mma.weightClass}
              {game.mma.isChampionshipBout && (
                <span className="ml-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                  {game.mma.titleDescription ?? "CHAMPIONSHIP"}
                </span>
              )}
              {game.mma.promotion && (
                <span className="ml-auto text-[10px] font-semibold text-muted-foreground">{game.mma.promotion}</span>
              )}
            </h3>
            {game.mma.modelOutput && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {[
                    { label: "Style Matchup", text: game.mma.modelOutput.styleMatchupEdge },
                    { label: "Opp Quality", text: game.mma.modelOutput.opponentQualityEdge },
                    { label: "Striking", text: game.mma.modelOutput.strikingEfficiencyEdge },
                    { label: "Grappling", text: game.mma.modelOutput.grapplingEdge },
                    { label: "Cardio/Pace", text: game.mma.modelOutput.cardioEdge },
                    { label: "Durability", text: game.mma.modelOutput.durabilityEdge },
                    { label: "Physical", text: game.mma.modelOutput.physicalEdge },
                    { label: "Activity", text: game.mma.modelOutput.activityEdge },
                    { label: "Age Curve", text: game.mma.modelOutput.ageCurveEdge },
                    { label: "Market", text: game.mma.modelOutput.marketEdge },
                  ].map(({ label, text }) => (
                    <div key={label} className="rounded bg-muted/30 px-2 py-1.5">
                      <p className="text-[9px] font-bold tracking-wider text-muted-foreground mb-0.5">{label.toUpperCase()}</p>
                      <p className="text-secondary-foreground leading-tight">{text}</p>
                    </div>
                  ))}
                </div>
                <div className="rounded-lg bg-muted/25 border border-border p-3 text-xs space-y-1 text-secondary-foreground">
                  <p className="font-semibold text-foreground text-[10px] tracking-wider mb-1">METHOD OF VICTORY</p>
                  <div className="flex gap-4 flex-wrap">
                    <span>KO/TKO: <strong>{Math.round(game.mma.modelOutput.methodProbabilities.ko_tko * 100)}%</strong></span>
                    <span>Sub: <strong>{Math.round(game.mma.modelOutput.methodProbabilities.submission * 100)}%</strong></span>
                    <span>Decision: <strong>{Math.round(game.mma.modelOutput.methodProbabilities.decision * 100)}%</strong></span>
                  </div>
                  <div className="flex gap-4 flex-wrap pt-1">
                    <span>Goes distance: <strong>{Math.round(game.mma.modelOutput.goesDistanceProb * 100)}%</strong></span>
                    {game.mma.modelOutput.overUnderRoundsPivot != null && (
                      <span>Model avg rounds: <strong>~{game.mma.modelOutput.overUnderRoundsPivot}</strong> of {game.mma.scheduledRounds}</span>
                    )}
                  </div>
                </div>
                {game.mma.modelOutput.riskFlag && (
                  <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{game.mma.modelOutput.riskFlag}</span>
                  </div>
                )}
              </div>
            )}
            {!game.mma.modelOutput && game.mma.modelNotes.length > 0 && (
              <ul className="space-y-2 text-sm text-secondary-foreground list-disc list-inside">
                {game.mma.modelNotes.map((note, i) => <li key={i}>{note}</li>)}
              </ul>
            )}
            {game.mma.venue && (
              <p className="text-xs text-muted-foreground mt-3">Venue: {game.mma.venue}</p>
            )}
          </div>
        )}

        {/* MLB-specific model layer */}
        {game.mlb && (
          <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5 lg:col-span-2">
            <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-2">
              <Info className="w-4 h-4 text-primary" />
              MLB Weighted Model
            </h3>

            {/* Pitcher header */}
            <p className="text-xs text-muted-foreground mb-3">
              Starter certainty:{" "}
              <span className={cn(
                "font-semibold",
                game.mlb.pitcherCertainty === "probable" ? "text-confidence-high" :
                game.mlb.pitcherCertainty === "partial"  ? "text-amber-500" :
                "text-destructive"
              )}>{game.mlb.pitcherCertainty}</span>
              {(game.mlb.awayProbablePitcher || game.mlb.homeProbablePitcher)
                ? ` · Away: ${game.mlb.awayProbablePitcher ?? "TBD"} (${game.mlb.awayPitcherHand ?? "?"}) · Home: ${game.mlb.homeProbablePitcher ?? "TBD"} (${game.mlb.homePitcherHand ?? "?"})`
                : " · Probable starters not yet announced."}
            </p>

            {mlbCanUserConfirmStarters && (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 mb-3 p-3 rounded-md border border-border bg-muted/30">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Switch
                    id="mlb-starters-confirm"
                    checked={mlbStartersChecked}
                    onCheckedChange={(checked) => {
                      setMlbStartersChecked(checked);
                      setMlbStartersUserConfirmed(game.id, checked);
                      onMlbStartersConfirmChange?.();
                    }}
                  />
                  <label htmlFor="mlb-starters-confirm" className="text-xs text-foreground cursor-pointer leading-snug">
                    I’ve verified both listed starters match the official source (team / park report). Re-run model with
                    confirmed-starter confidence.
                  </label>
                </div>
              </div>
            )}

            {/* Risk flag banner */}
            {game.mlb.modelOutput?.riskFlag && (
              <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/25 rounded-md px-3 py-2 mb-3">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-600 dark:text-amber-400">{game.mlb.modelOutput.riskFlag}</p>
              </div>
            )}

            {/* Factor edge rows */}
            {game.mlb.modelOutput && (() => {
              const mo = game.mlb!.modelOutput!;
              const factors: { label: string; value: string; score: number }[] = [
                { label: "Pitcher (40%)",  value: mo.pitcherEdge,  score: mo._debug.pitcherScore  },
                { label: "Batting (20%)",  value: mo.battingEdge,  score: mo._debug.battingScore  },
                { label: "Bullpen (15%)",  value: mo.bullpenEdge,  score: mo._debug.bullpenScore  },
                { label: "Form (10%)",     value: mo.formEdge,     score: mo._debug.formScore     },
                { label: "Park (context)", value: mo.parkNote,     score: 0                       },
              ];
              return (
                <div className="space-y-2 mb-3">
                  {factors.map(({ label, value, score }) => (
                    <div key={label} className="flex gap-3 items-start">
                      <div className="flex items-center gap-1 w-28 shrink-0 mt-0.5">
                        <span className={cn(
                          "w-1.5 h-1.5 rounded-full shrink-0",
                          score > 0.08  ? "bg-confidence-high" :
                          score < -0.08 ? "bg-destructive" :
                          "bg-muted-foreground"
                        )} />
                        <span className="text-xs font-medium text-muted-foreground">{label}</span>
                      </div>
                      <p className="text-xs text-secondary-foreground leading-relaxed">{value}</p>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Delta summary */}
            {game.mlb.modelOutput && (() => {
              const delta = game.mlb!.modelOutput!._debug.combinedDelta;
              const hasStats = game.mlb!.modelOutput!._debug.hasStats;
              return (
                <div className="flex items-center gap-3 pt-2 border-t border-border/50">
                  <span className="text-xs text-muted-foreground">Model adj:</span>
                  <span className={cn(
                    "text-xs font-semibold tabular-nums",
                    delta > 0 ? "text-confidence-high" : delta < 0 ? "text-destructive" : "text-muted-foreground"
                  )}>
                    {delta > 0 ? "+" : ""}{delta}pp vs base
                  </span>
                  {!hasStats && (
                    <span className="text-xs text-muted-foreground italic">· ERA unavailable — model used record/odds only</span>
                  )}
                </div>
              );
            })()}

            {/* Fallback: show modelNotes when modelOutput not yet available */}
            {!game.mlb.modelOutput && game.mlb.modelNotes.length > 0 && (
              <ul className="space-y-1.5 text-xs text-muted-foreground list-disc list-inside">
                {game.mlb.modelNotes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Enrichment: series, PickCenter, weather, Odds API */}
        {game.enrichmentNotes && game.enrichmentNotes.length > 0 && (
          <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5 lg:col-span-2">
            <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
              <Cloud className="w-4 h-4 text-muted-foreground" />
              Data feed notes
            </h3>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              {game.enrichmentNotes.map((note, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-primary shrink-0">•</span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Injuries */}
        <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5">
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
        <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5">
          <h3 className="font-display font-bold text-sm text-foreground mb-3 flex items-center gap-2">
            <TeamLogo logo={game.awayTeam.logo} size="md" />
            {game.awayTeam.abbreviation} Player Trends
          </h3>
          <div className="divide-y divide-border">
            {game.playerTrends.away.length === 0 ? (
              <p className="text-xs text-muted-foreground py-3">No leader stats in the feed for this game.</p>
            ) : (
              game.playerTrends.away.map((player) => (
                <PlayerTrendCard key={player.name} player={player} />
              ))
            )}
          </div>
        </div>

        {/* Player Trends - Home */}
        <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5">
          <h3 className="font-display font-bold text-sm text-foreground mb-3 flex items-center gap-2">
            <TeamLogo logo={game.homeTeam.logo} size="md" />
            {game.homeTeam.abbreviation} Player Trends
          </h3>
          <div className="divide-y divide-border">
            {game.playerTrends.home.length === 0 ? (
              <p className="text-xs text-muted-foreground py-3">No leader stats in the feed for this game.</p>
            ) : (
              game.playerTrends.home.map((player) => (
                <PlayerTrendCard key={player.name} player={player} />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Betting Lines */}
      {game.lines && (game.lines.spread || game.lines.total != null || game.lines.homeMl) && (() => {
        const { spread, total, homeMl, awayMl, drawMl } = game.lines!;
        const modelHome = game.winProbability.home;
        const modelAway = game.winProbability.away;
        const modelFavorsHome = modelHome >= modelAway;
        const spreadFavorsHome = (game.lines.spreadNum ?? 0) < 0;
        const modelVsMarketAgree = modelFavorsHome === spreadFavorsHome;

        if (game.league === "boxing" && tw) {
          return (
            <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5">
              <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-4">
                <DollarSign className="w-4 h-4 text-confidence-high" />
                Fight Odds (Moneyline)
                <span className="text-[10px] font-normal text-muted-foreground ml-1">via The Odds API</span>
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-4 text-center mb-4">
                <div className="bg-muted/30 rounded-lg p-2 sm:p-3">
                  <div className="text-[10px] text-muted-foreground font-semibold tracking-wider mb-1">{game.awayTeam.abbreviation}</div>
                  <div className="text-base font-display font-bold text-foreground">{awayMl ?? "—"}</div>
                </div>
                <div className="bg-muted/30 rounded-lg p-2 sm:p-3">
                  <div className="text-[10px] text-muted-foreground font-semibold tracking-wider mb-1">{game.homeTeam.abbreviation}</div>
                  <div className="text-base font-display font-bold text-foreground">{homeMl ?? "—"}</div>
                </div>
                {drawMl && (
                  <div className="bg-muted/30 rounded-lg p-2 sm:p-3">
                    <div className="text-[10px] text-muted-foreground font-semibold tracking-wider mb-1">DRAW</div>
                    <div className="text-base font-display font-bold text-foreground">{drawMl}</div>
                  </div>
                )}
              </div>
              <div className="rounded-lg p-3 text-xs flex items-start gap-2 bg-muted/20 border border-border">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                <div className="text-secondary-foreground">
                  <span className="font-semibold text-foreground">Model implied (de-vig): </span>
                  {game.awayTeam.abbreviation} {tw.away}% · Draw {tw.draw}% · {game.homeTeam.abbreviation} {tw.home}%.
                </div>
              </div>
            </div>
          );
        }

        return (
          <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5">
            <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-4">
              <DollarSign className="w-4 h-4 text-confidence-high" />
              Betting Lines
              <span className="text-[10px] font-normal text-muted-foreground ml-1">via DraftKings</span>
            </h3>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-4 text-center mb-4">
              {/* Spread */}
              <div className="bg-muted/30 rounded-lg p-2 sm:p-3">
                <div className="text-[10px] text-muted-foreground font-semibold tracking-wider mb-1">SPREAD</div>
                <div className="text-base font-display font-bold text-foreground">{spread ?? "—"}</div>
              </div>

              {/* Total */}
              <div className="bg-muted/30 rounded-lg p-2 sm:p-3">
                <div className="text-[10px] text-muted-foreground font-semibold tracking-wider mb-1">TOTAL (O/U)</div>
                <div className="text-base font-display font-bold text-foreground">
                  {total != null ? total : "—"}
                </div>
              </div>

              {/* Moneylines */}
              <div className="bg-muted/30 rounded-lg p-2 sm:p-3 col-span-2 sm:col-span-1">
                <div className="text-[10px] text-muted-foreground font-semibold tracking-wider mb-1">MONEYLINE</div>
                <div className="flex items-center justify-center gap-2 text-sm font-bold flex-wrap">
                  <span className="text-muted-foreground text-[11px]">{game.awayTeam.abbreviation}</span>
                  <span className={awayMl?.startsWith("-") ? "text-confidence-high" : "text-foreground"}>
                    {awayMl ?? "—"}
                  </span>
                  <span className="text-muted-foreground text-[10px]">/</span>
                  <span className={homeMl?.startsWith("-") ? "text-confidence-high" : "text-foreground"}>
                    {homeMl ?? "—"}
                  </span>
                  <span className="text-muted-foreground text-[11px]">{game.homeTeam.abbreviation}</span>
                </div>
              </div>
            </div>

            {/* Model vs market insight */}
            <div className={`rounded-lg p-3 text-xs flex items-start gap-2 ${modelVsMarketAgree ? "bg-confidence-high/10 border border-confidence-high/20" : "bg-risk/10 border border-risk/20"}`}>
              <Zap className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${modelVsMarketAgree ? "text-confidence-high" : "text-risk"}`} />
              <div>
                <span className={`font-semibold ${modelVsMarketAgree ? "text-confidence-high" : "text-risk"}`}>
                  {modelVsMarketAgree ? "Model aligns with market" : "Model diverges from market"} —{" "}
                </span>
                <span className="text-secondary-foreground">
                  Our model gives {modelFavorsHome ? game.homeTeam.abbreviation : game.awayTeam.abbreviation}{" "}
                  a {Math.max(modelHome, modelAway)}% win probability.{" "}
                  {!modelVsMarketAgree
                    ? `The market favors ${spreadFavorsHome ? game.homeTeam.abbreviation : game.awayTeam.abbreviation} — investigate before acting.`
                    : "Confidence and market agree on direction."}
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Efficiency Comparison */}
      <div className="card-shine bg-card rounded-lg border border-border p-4 sm:p-5">
        <h3 className="font-display font-bold text-sm text-foreground mb-1">Team Stats Comparison</h3>
        {(game.league === "nfl" || game.league === "mlb") && (
          <p className="text-[11px] text-muted-foreground mb-3">Season team stats from ESPN.</p>
        )}
        {game.league === "nba" && (
          <p className="text-[11px] text-muted-foreground mb-3">
            {game._meta?.nbaRatingsFromStats && game._meta.nbaStatsSeason ? (
              <>
                Offensive rating, defensive rating, and pace — ESPN NBA {game._meta.nbaStatsSeason} regular season.
              </>
            ) : (
              <>
                PPG, opponent PPG, and estimated pace from ESPN.
              </>
            )}
          </p>
        )}
        {game.league === "boxing" && (
          <p className="text-[11px] text-muted-foreground mb-3">
            Fighter physical stats — reach, height, and style from Supabase boxing_fighters.
          </p>
        )}
        <div className="grid grid-cols-3 gap-2 sm:gap-4 text-center">
          {(game.league === "nfl"
            ? [
                { label: "PPG", away: game.awayTeam.offensiveRating, home: game.homeTeam.offensiveRating, lowerBetter: false },
                { label: "Opp PPG", away: game.awayTeam.defensiveRating, home: game.homeTeam.defensiveRating, lowerBetter: true },
                { label: "Plays (est.)", away: game.awayTeam.pace, home: game.homeTeam.pace, lowerBetter: false },
              ]
            : game.league === "mlb"
              ? [
                  { label: "Runs/G", away: game.awayTeam.offensiveRating, home: game.homeTeam.offensiveRating, lowerBetter: false },
                  { label: "Runs allowed", away: game.awayTeam.defensiveRating, home: game.homeTeam.defensiveRating, lowerBetter: true },
                  { label: "Innings", away: game.awayTeam.pace, home: game.homeTeam.pace, lowerBetter: false },
                ]
              : game._meta?.nbaRatingsFromStats
                  ? [
                      { label: "ORtg", away: game.awayTeam.offensiveRating, home: game.homeTeam.offensiveRating, lowerBetter: false },
                      { label: "DRtg", away: game.awayTeam.defensiveRating, home: game.homeTeam.defensiveRating, lowerBetter: true },
                      { label: "Pace", away: game.awayTeam.pace, home: game.homeTeam.pace, lowerBetter: false },
                    ]
                  : [
                      { label: "PPG", away: game.awayTeam.offensiveRating, home: game.homeTeam.offensiveRating, lowerBetter: false },
                      { label: "Opp PPG", away: game.awayTeam.defensiveRating, home: game.homeTeam.defensiveRating, lowerBetter: true },
                      { label: "Pace (est.)", away: game.awayTeam.pace, home: game.homeTeam.pace, lowerBetter: false },
                    ]
          ).map((stat) => {
            const awayBetter = stat.lowerBetter ? stat.away < stat.home : stat.away > stat.home;
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
